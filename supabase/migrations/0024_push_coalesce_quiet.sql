-- Clear to Close — migration 0024: push coalescing, quiet hours, quiet check-ins.
--
-- Number note: 0022/0023 are reserved for the multi-escrow stream. This
-- migration does NOT widen the (device_id, escrow_id) token uniqueness —
-- that ships in the multi-escrow stream; this file only adds the
-- timezone capture, buffer/queue/log tables, trigger rewrite, cron ticks,
-- and check-in RPCs.
--
-- Builds on 0008 (push tokens + trigger -> pg_net -> send-client-push) and
-- 0021 (key-date push events). Approved notification rules (Anuraj, Sept 28 2026):
--
--   1. CHECK-OFF PUSHES are server-confirmed by construction: the steps
--      trigger fires in the realtor's own write transaction. Rapid check-offs
--      coalesce: step events now BUFFER in pending_step_pushes instead of
--      POSTing immediately; a per-minute pg_cron tick flushes each escrow's
--      buffer once its oldest row is ~2 minutes old. One buffered check-off
--      -> "Your realtor just completed {step}." (approved Sept 28 2026);
--      several -> "Your realtor completed {N} steps."
--      Unchecks never buffer (the trigger matches transitions only).
--      Structural edits (reorder/title) never buffer.
--   2. QUIET HOURS: no buzzes 9 PM - 8 AM client-local. The flush (and every
--      other send path) checks each token's local hour; quiet-hour pushes go
--      to push_queue with send_after = next 08:00 local instead of sending.
--      push_tokens.timezone is captured at registration (client sends its IANA
--      zone); NULL zones fall back to America/Los_Angeles.
--   3. FIVE-DAY QUIET CHECK-IN (manual nudge is dead): an hourly pg_cron tick
--      calls due_quiet_checkins(). Fires once per quiet stretch: active
--      escrows only, >= 5 days since last check-off activity, open steps
--      remain, no check-in sent since the last activity (next check-off
--      re-arms). Copy: > 7 days to close -> on-track variant; <= 7 days with
--      open steps -> closing-soon variant. Day counting is done in the
--      client's timezone. Revoked/closed/cancelled links get nothing.
--   4. SEND-TIME GUARDS (all paths): revoked links, revoked invites, and
--      closed/cancelled escrows never receive pushes. Push delivery failure is
--      recorded in push_delivery_log and never fails the realtor's write
--      (every send is async to the write that caused it).
--
-- MULTI-ESCROW NOTE (for the multi-escrow worker): until the multi-escrow
-- migration widens push_tokens uniqueness to (device_id, escrow_id), a
-- device can hold only one token row. This file's send paths already detect
-- multi-escrow tokens (token rows for other escrows on the same device) and
-- add the property address to the copy.
-- ADDITIVE-ONLY (rollback requirement, Anuraj Sept 26 2026): new tables,
-- new columns, new RPCs, and CREATE OR REPLACE of the trigger function +
-- register_push_token. Trigger bindings for steps/escrows are dropped and
-- recreated under the same names so the steps half buffers instead of
-- POSTing. No other drops or renames of existing objects. Rolling the app
-- code back leaves the old code working against the migrated DB (the old
-- trigger shape is superseded, not removed).
--
-- KILL SWITCH (unchanged): push_config.push_enabled, or
--   alter table steps   disable trigger trg_steps_push_notify;
--   alter table escrows  disable trigger trg_escrows_push_notify;
-- Cron jobs:  select cron.unschedule('ctc_push_flush');
--             select cron.unschedule('ctc_quiet_checkin');
--
-- Dashboard run notes (paste-ready, one script, AFTER 0021):
--   1. `pg_net` must be enabled (Database -> Extensions -> pg_net) — the
--      create extension below is a no-op when it already is.
--   2. `pg_cron` must be enabled (Database -> Extensions -> pg_cron) — the
--      create extension below is a no-op when it already is. Without pg_cron
--      the coalescing flush and check-in sweep never run; key-date pushes
--      (immediate pg_net path) keep working.
--   3. Redeploy the `send-client-push` Edge Function with the regenerated
--      single file (it handles the new flush_step_pushes /
--      quiet_checkin_sweep events). The regenerated file is at
--      ~/workspace/your_files/send-client-push-single.ts.

-- ------------------------------------------------- extensions --

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- ------------------------------------------------- token timezone --

-- Client-local quiet hours need the client's IANA timezone, captured at
-- registration. NULL (pre-0022 rows) falls back to America/Los_Angeles.
alter table push_tokens add column if not exists timezone text;

-- One live token row per (device, escrow): the multi-escrow prerequisite.
-- 0008's device-only uniqueness would overwrite a second escrow's row.
-- NOTE: push_tokens uniqueness is NOT widened here. Migration 0008's
-- (device_id) uniqueness stays in force until the multi-escrow stream
-- (0022/0023) widens it to (device_id, escrow_id). The multi-escrow address
-- copy in the send paths already keys off any second token row per device.

-- ------------------------------------------------- check-in state --

-- Last five-day check-in sent for this escrow. NULL = never. A check-off
-- after this timestamp re-arms the quiet stretch (see due_quiet_checkins).
alter table escrows add column if not exists last_quiet_checkin_at timestamptz;

-- Durable server-side check-off activity: stamped ONLY on forward
-- check-offs (insert-as-done / false->true) by the steps trigger, and never
-- cleared by unchecks. The five-day quiet stretch is measured from this —
-- deriving it from max(completed_at) would go stale if a step is later
-- unchecked (completed_at may survive the uncheck, or vice versa).
alter table escrows add column if not exists last_checkoff_activity_at timestamptz;
-- Backfill from existing completed steps: best available history.
update escrows e
set last_checkoff_activity_at = (
  select max(s.completed_at) from steps s where s.escrow_id = e.id and s.done
)
where e.last_checkoff_activity_at is null
  and exists (select 1 from steps s where s.escrow_id = e.id and s.done);

-- ------------------------------------------------- buffer + queue --

-- Coalescing buffer: the steps trigger inserts here (same transaction as
-- the check-off, so rollback discards the intent). The per-minute flush
-- deletes rows only after the push is sent or safely queued.
create table if not exists pending_step_pushes (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  event text not null check (event in ('step_done', 'custom_step_added')),
  step_title text not null,
  created_at timestamptz not null default now()
);
create index if not exists pending_step_pushes_escrow_idx
  on pending_step_pushes (escrow_id, created_at);

-- Delayed deliveries (quiet-hours holds + anything else scheduled).
-- kind: 'step' | 'keydate' | 'checkin'. checkin rows re-validate at drain:
-- a check-off that lands while queued cancels the stale check-in.
create table if not exists push_queue (
  id uuid primary key default gen_random_uuid(),
  expo_push_token text not null,
  title text not null default 'Clear to Close',
  body text not null,
  data jsonb not null default '{}'::jsonb,
  kind text not null check (kind in ('step', 'keydate', 'checkin')),
  escrow_id uuid references escrows(id) on delete cascade,
  queued_at timestamptz not null default now(),
  send_after timestamptz not null
);
create index if not exists push_queue_due_idx on push_queue (send_after);

-- Loud failure log: every failed Expo delivery lands here (the realtor's
-- write never depends on delivery, so failures must be visible somewhere).
create table if not exists push_delivery_log (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  escrow_id uuid,
  detail text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_delivery_log_created_idx
  on push_delivery_log (created_at);

-- RLS: deny everything direct. The trigger (security definer) and the Edge
-- Function (service role) are the only writers/readers.
alter table pending_step_pushes enable row level security;
alter table push_queue enable row level security;
alter table push_delivery_log enable row level security;

-- ------------------------------------------------- trigger rewrite --

-- Steps half now BUFFERS (no pg_net per check-off); the escrows half is the
-- 0021 key-date logic verbatim (immediate POST — key-date changes are rare
-- and never coalesce).
create or replace function ctc_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_fn_url text;
  v_secret text;
  v_event text := null;
  v_escrow_id uuid;
  v_step_title text := null;
  v_new_close_date date := null;
  v_new_date date := null;
  v_changed_count int := 0;
  v_changed_field text := null;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;

  if TG_TABLE_NAME = 'steps' then
    -- Buffer, don't POST: the per-minute flush coalesces rapid check-offs.
    -- Unchecks / reorders / title edits / structural adds insert nothing
    -- (forward progress only). A checked custom step is a normal
    -- completion — structural edits never push.
    if TG_OP = 'INSERT' and new.done then
      insert into pending_step_pushes (escrow_id, event, step_title)
      values (new.escrow_id, 'step_done', new.title);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
    elsif TG_OP = 'UPDATE' and old.done = false and new.done = true then
      insert into pending_step_pushes (escrow_id, event, step_title)
      values (new.escrow_id, 'step_done', new.title);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
    end if;
    return new;
  elsif TG_TABLE_NAME = 'escrows' then
    v_escrow_id := new.id;
    if TG_OP = 'UPDATE' then
      -- 0021 logic verbatim: count changed key-date fields.
      if old.close_date is distinct from new.close_date then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'close_date';
        v_new_date := new.close_date;
      end if;
      if old.inspection_deadline is distinct from new.inspection_deadline then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'inspection_deadline';
        v_new_date := new.inspection_deadline;
      end if;
      if old.appraisal_deadline is distinct from new.appraisal_deadline then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'appraisal_deadline';
        v_new_date := new.appraisal_deadline;
      end if;
      if old.loan_approval_date is distinct from new.loan_approval_date then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'loan_approval_date';
        v_new_date := new.loan_approval_date;
      end if;

      if v_changed_count = 1 then
        case v_changed_field
          when 'close_date' then
            v_event := 'close_date_changed';
            v_new_close_date := v_new_date;
          when 'inspection_deadline' then
            v_event := 'inspection_deadline_changed';
          when 'appraisal_deadline' then
            v_event := 'appraisal_deadline_changed';
          when 'loan_approval_date' then
            v_event := 'loan_approval_date_changed';
        end case;
      elsif v_changed_count > 1 then
        v_event := 'key_dates_changed';
      end if;
    end if;
  end if;

  if v_event is null then
    return new;
  end if;

  select value into v_fn_url from push_config where key = 'function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_trigger_secret';

  if v_fn_url is not null and v_secret is not null then
    perform net.http_post(
      url := v_fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Trigger-Secret', v_secret
      ),
      body := jsonb_build_object(
        'event', v_event,
        'escrow_id', v_escrow_id,
        'step_title', v_step_title,
        'new_close_date', v_new_close_date,
        'new_date', v_new_date
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_steps_push_notify on steps;
create trigger trg_steps_push_notify
  after insert or update on steps
  for each row execute function ctc_push_notify();

drop trigger if exists trg_escrows_push_notify on escrows;
create trigger trg_escrows_push_notify
  after update on escrows
  for each row execute function ctc_push_notify();

-- ------------------------------------------------- token RPC (tz) --

-- 4-arg form stores the client's IANA timezone for quiet-hours math.
create or replace function register_push_token(
  p_link_id uuid, p_device_id text, p_token text, p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
begin
  if nullif(trim(p_device_id), '') is null or nullif(trim(p_token), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if exists (select 1 from invites where id = v_link.invite_id and revoked_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  insert into push_tokens (escrow_id, device_id, link_id, expo_push_token, timezone, updated_at)
  values (v_link.escrow_id, trim(p_device_id), p_link_id, trim(p_token),
          nullif(trim(coalesce(p_timezone, '')), ''), now())
  -- 0008's unique(device_id) stands until the multi-escrow stream widens it;
  -- one live row per device in the meantime.
  on conflict (device_id) do update
    set escrow_id = excluded.escrow_id,
        link_id = excluded.link_id,
        expo_push_token = excluded.expo_push_token,
        timezone = excluded.timezone,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- 3-arg form (pre-0022 clients): delegates with no timezone.
create or replace function register_push_token(p_link_id uuid, p_device_id text, p_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select register_push_token(p_link_id, p_device_id, p_token, null);
$$;

grant execute on function register_push_token(uuid, text, text, text) to anon, authenticated;
grant execute on function register_push_token(uuid, text, text) to anon, authenticated;

-- ------------------------------------------------- quiet check-in --

-- Candidate five-day check-ins, one row per live token. Called by the Edge
-- Function (service role) on the hourly tick. An escrow qualifies when:
--   * status = 'open' (closed/cancelled get nothing),
--   * at least one step is still open (all-complete gets nothing),
--   * last check-off activity (or escrow creation) is >= 5 days ago,
--   * no check-in has been sent since that activity (a newer check-off
--     re-arms the quiet stretch; a check-off landing while a check-in is
--     queued is re-validated at drain time),
--   * the client link and its invite are live (revoked gets nothing).
--
-- Activity is the durable escrows.last_checkoff_activity_at (stamped by the
-- steps trigger on forward check-offs only), never max(completed_at).
create or replace function due_quiet_checkins()
returns table (
  escrow_id uuid,
  address text,
  close_date date,
  done_count bigint,
  total_count bigint,
  realtor_first text,
  expo_push_token text,
  timezone text,
  link_role text
)
language sql
security definer
set search_path = public
as $$
  with counts as (
    select s.escrow_id as eid,
           count(*) as total,
           count(*) filter (where s.done) as done
    from steps s
    group by s.escrow_id
  )
  select e.id,
         e.address,
         e.close_date,
         c.done,
         c.total,
         (select split_part(rp.name, ' ', 1)
            from realtor_profiles rp where rp.user_id = e.user_id),
         pt.expo_push_token,
         coalesce(pt.timezone, 'America/Los_Angeles'),
         cl.role
  from escrows e
  join counts c on c.eid = e.id
  join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
  join invites i on i.id = cl.invite_id and i.revoked_at is null
  join push_tokens pt on pt.link_id = cl.id
  where e.status = 'open'
    and c.total > c.done
    and coalesce(e.last_checkoff_activity_at, e.created_at) <= now() - interval '5 days'
    and (e.last_quiet_checkin_at is null
         or e.last_quiet_checkin_at < coalesce(e.last_checkoff_activity_at, e.created_at));
$$;

-- Mark the check-in sent (called by the Edge Function after processing an
-- escrow's candidate rows, whether sent now or queued for morning).
create or replace function mark_quiet_checkin_sent(p_escrow_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update escrows set last_quiet_checkin_at = now() where id = p_escrow_id;
$$;

-- ------------------------------------------------- token cleanup --

-- A revoked link or invite must never receive pushes again. The send paths
-- also filter revoked rows at send time, but this drops the token rows
-- outright so nothing can re-arm them:
--   * regenerate_invite kills the old link (revoked_at) — new-device flow,
--   * explicit link/invite revocation does the same.
create or replace function ctc_push_tokens_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_TABLE_NAME = 'client_links' then
    if old.revoked_at is null and new.revoked_at is not null then
      delete from push_tokens where link_id = new.id;
    end if;
  elsif TG_TABLE_NAME = 'invites' then
    if old.revoked_at is null and new.revoked_at is not null then
      delete from push_tokens
      where link_id in (select id from client_links where invite_id = new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_client_links_push_cleanup on client_links;
create trigger trg_client_links_push_cleanup
  after update on client_links
  for each row execute function ctc_push_tokens_cleanup();

drop trigger if exists trg_invites_push_cleanup on invites;
create trigger trg_invites_push_cleanup
  after update on invites
  for each row execute function ctc_push_tokens_cleanup();

-- ------------------------------------------------- cron pings --

-- pg_cron entry point: POSTs an internal event to the Edge Function.
-- Respects the push_enabled kill switch like the trigger does.
create or replace function push_cron_ping(p_event text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_fn_url text;
  v_secret text;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return;
  end if;
  select value into v_fn_url from push_config where key = 'function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_trigger_secret';
  if v_fn_url is not null and v_secret is not null then
    perform net.http_post(
      url := v_fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Trigger-Secret', v_secret
      ),
      body := jsonb_build_object('event', p_event)
    );
  end if;
end;
$$;

-- Schedules (idempotent re-run: unschedule first, then schedule).
do $$
begin
  perform cron.unschedule('ctc_push_flush');
exception when others then null;
end $$;
do $$
begin
  perform cron.unschedule('ctc_quiet_checkin');
exception when others then null;
end $$;

select cron.schedule('ctc_push_flush', '* * * * *',
  $$select push_cron_ping('flush_step_pushes')$$);
select cron.schedule('ctc_quiet_checkin', '7 * * * *',
  $$select push_cron_ping('quiet_checkin_sweep')$$);
