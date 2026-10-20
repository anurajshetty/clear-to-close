-- 0040_p1_event_pushes.sql
--
-- P1 key action events (Oct 15, 2026; approved phased plan + copy batch).
-- Until now the only pushes were step check-offs, key-date CHANGES, and
-- the 5-day check-in. This migration adds the event OUTBOX the new
-- events flow through; the send-client-push Edge Function drains it on
-- every per-minute flush and delivers through the existing quiet-hours /
-- address-suffix / kill-switch machinery.
--
-- Events added:
--   client_joined      (client_links INSERT)  -> the escrow's realtor
--   review_submitted   (reviews INSERT)       -> the escrow's realtor
--   custom_step_added  (steps INSERT, custom, not done) -> step side + TC
--   escrow_closed      (escrows status open -> closed)  -> all client devices
--   escrow_cancelled   (escrows status open -> cancelled) -> all client devices
--   buyer_intake_submitted (buyer_intakes save) -> the escrow's TC
--   seller_intake_submitted (tc_intakes save)   -> the escrow's TC
--     (Option A, Anuraj Oct 15: both intake forms are authored by the
--     realtor, so the notification goes to the TC — the reader who
--     works from them. tc_intakes holds the listing (seller-side)
--     details, hence the seller copy. Repeated saves within one drain
--     window coalesce to a single push in the Edge Function.)
--
-- DESIGN:
--   * pending_event_pushes is service-role only (RLS on, no policies),
--     mirroring pending_step_pushes. Trigger functions are SECURITY
--     DEFINER so client-context writes (a redeem runs as anon) can
--     record events without any table grant.
--   * closed/cancelled SNAPSHOT the escrow's live tokens into the
--     outbox row. This is deliberate: send-time liveness excludes
--     non-open escrows, and cancelling revokes links (which deletes
--     token rows) — by drain time there would be nobody left to notify.
--     The snapshot trigger is BEFORE UPDATE OF status, so it runs
--     before the AFTER-trigger cancel-revoke chain touches any link.
--     Delivery from the snapshot skips the liveness re-check for these
--     two events only; every other event resolves live tokens as usual.
--   * ctc_push_notify() is re-created with its 0039 body verbatim
--     except the steps branch, which gains the custom-step outbox
--     insert (plus its comment). An insert-as-done custom step fires
--     step_done only — never both pushes for one action.
--   * push_queue gains the 'event' kind for quiet-hours-delayed P1
--     deliveries (drained verbatim, like keydate rows).
--   * The kill switch (push_config.push_enabled) gates every trigger
--     here exactly as it gates ctc_push_notify: while off, no events
--     are recorded.
--
-- Deploy order: run this migration, THEN redeploy send-client-push
-- (the drain ships in the same release). Rows written before the new
-- function deploys simply wait in the outbox.

-- ------------------------------------------------------------- outbox --

create table if not exists pending_event_pushes (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  event text not null check (event in (
    'client_joined', 'review_submitted', 'custom_step_added',
    'escrow_closed', 'escrow_cancelled',
    'buyer_intake_submitted', 'seller_intake_submitted'
  )),
  payload jsonb not null default '{}'::jsonb,
  -- closed/cancelled only: [{token, role, timezone, escrow_count}]
  snapshot_tokens jsonb,
  created_at timestamptz not null default now()
);

create index if not exists pending_event_pushes_created_idx
  on pending_event_pushes (created_at);

alter table pending_event_pushes enable row level security;

-- ------------------------------------------------- queue kind widening --

alter table push_queue drop constraint if exists push_queue_kind_check;
alter table push_queue
  add constraint push_queue_kind_check
  check (kind in ('step', 'keydate', 'checkin', 'event'));

-- ------------------------------------------- steps: custom-step event --

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
    -- Unchecks / reorders / title edits insert nothing (forward progress
    -- only). A checked custom step is a normal completion. A custom
    -- step ADDED (not done) queues a P1 event instead (0040).
    if TG_OP = 'INSERT' and new.custom and not new.done then
      insert into pending_event_pushes (escrow_id, event, payload)
      values (new.escrow_id, 'custom_step_added',
              jsonb_build_object('step_role', new.role));
    end if;
    if TG_OP = 'INSERT' and new.done then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
    elsif TG_OP = 'UPDATE' and old.done = false and new.done = true then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
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
-- ------------------------------------------------------ join + review --

create or replace function ctc_push_event_from_link()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;
  insert into pending_event_pushes (escrow_id, event, payload)
  values (new.escrow_id, 'client_joined',
          jsonb_build_object('role', new.role, 'party_name', new.party_name));
  return new;
end;
$$;

drop trigger if exists trg_client_links_event_push on client_links;
create trigger trg_client_links_event_push
  after insert on client_links
  for each row execute function ctc_push_event_from_link();

create or replace function ctc_push_event_from_review()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_escrow_id uuid;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;
  select escrow_id into v_escrow_id from client_links where id = new.link_id;
  if v_escrow_id is null then
    return new;
  end if;
  insert into pending_event_pushes (escrow_id, event, payload)
  values (v_escrow_id, 'review_submitted',
          jsonb_build_object('client_name', new.client_name,
                             'stars', new.stars));
  return new;
end;
$$;

drop trigger if exists trg_reviews_event_push on reviews;
create trigger trg_reviews_event_push
  after insert on reviews
  for each row execute function ctc_push_event_from_review();

-- --------------------------------- closed / cancelled token snapshot --

create or replace function ctc_push_event_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_first text;
  v_snapshot jsonb;
begin
  if old.status is distinct from 'open'
     or new.status not in ('closed', 'cancelled') then
    return new;
  end if;
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;

  select split_part(trim(p.name), ' ', 1) into v_first
  from realtor_profiles p
  where p.user_id = new.user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'token', t.expo_push_token,
           'role', l.role,
           'timezone', t.timezone,
           'escrow_count', (
             select count(distinct t2.escrow_id)
             from push_tokens t2
             where t2.device_id = t.device_id
               and t2.escrow_id is not null
           )
         )), '[]'::jsonb)
    into v_snapshot
    from push_tokens t
    join client_links l on l.id = t.link_id
    join invites i on i.id = l.invite_id
   where t.escrow_id = new.id
     and l.revoked_at is null
     and i.revoked_at is null;

  insert into pending_event_pushes (escrow_id, event, payload, snapshot_tokens)
  values (
    new.id,
    case new.status when 'closed' then 'escrow_closed'
                    else 'escrow_cancelled' end,
    jsonb_build_object('realtor_first', v_first),
    v_snapshot
  );
  return new;
end;
$$;

drop trigger if exists trg_escrows_event_snapshot on escrows;
create trigger trg_escrows_event_snapshot
  before update of status on escrows
  for each row execute function ctc_push_event_snapshot();

-- ------------------------------------------------- intakes -> the TC --

create or replace function ctc_push_event_from_intake()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;
  -- Both intake forms are authored by the realtor; the TC is the
  -- reader (Option A, Anuraj Oct 15, 2026). buyer_intakes is the
  -- buyer-side form; tc_intakes holds the listing (seller-side)
  -- details. A save is an INSERT (first save) or an UPDATE (re-save);
  -- bursts coalesce in the drain.
  if TG_TABLE_NAME = 'buyer_intakes' then
    insert into pending_event_pushes (escrow_id, event, payload)
    values (new.escrow_id, 'buyer_intake_submitted', '{}'::jsonb);
  elsif TG_TABLE_NAME = 'tc_intakes' then
    insert into pending_event_pushes (escrow_id, event, payload)
    values (new.escrow_id, 'seller_intake_submitted', '{}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_buyer_intakes_event_push on buyer_intakes;
create trigger trg_buyer_intakes_event_push
  after insert or update on buyer_intakes
  for each row execute function ctc_push_event_from_intake();

drop trigger if exists trg_tc_intakes_event_push on tc_intakes;
create trigger trg_tc_intakes_event_push
  after insert or update on tc_intakes
  for each row execute function ctc_push_event_from_intake();

-- ------------------------------------------------------- grant posture --
-- Auditor conditional pass (Oct 15, 2026): Postgres grants EXECUTE to
-- PUBLIC by default; trigger functions must never be directly callable
-- by anon/authenticated (PostgREST RPC surface). Trigger firing does
-- not need EXECUTE, so revoke it from every client-visible role. (The
-- service role bypasses grants for the drain's table access; these
-- functions are only ever run by their triggers.)
revoke execute on function ctc_push_event_from_link() from public, anon, authenticated;
revoke execute on function ctc_push_event_from_review() from public, anon, authenticated;
revoke execute on function ctc_push_event_snapshot() from public, anon, authenticated;
revoke execute on function ctc_push_event_from_intake() from public, anon, authenticated;
revoke execute on function ctc_push_notify() from public, anon, authenticated;
