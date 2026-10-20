-- 0041_p2_date_reminders.sql
--
-- P2 date-based reminders (Oct 15, 2026; approved phased plan + copy).
-- Until now dates only notified when EDITED. This migration adds the
-- candidate machinery for reminders driven by the passage of time:
--   closing_reminder     close_date in 7 / 3 / 1 days -> clients + TC + realtor
--   inspection_reminder  inspection_deadline tomorrow -> buyer + TC + realtor
--   appraisal_reminder   appraisal_deadline tomorrow  -> buyer + TC + realtor
--   loan_reminder        loan_approval_date tomorrow  -> buyer + TC + realtor
--   possession_reminder  buyer-intake possession date in 5 days -> seller
--
-- DESIGN:
--   * due_date_reminders() returns ONE ROW PER RECIPIENT TOKEN whose
--     LOCAL date (the token's registered timezone) hits a threshold.
--     Days are never computed in server time: "tomorrow" must be true
--     where the phone is.
--   * Fire-once state: push_reminder_log, claimed by the Edge Function
--     BEFORE delivery (the check-in precedent). The claim key is
--     (escrow, event, threshold, date_value, token): including the
--     DATE makes a changed date re-arm automatically; including the
--     TOKEN lets each timezone claim on its own local day; the UNIQUE
--     constraint makes concurrent sweep runs idempotent (exactly one
--     claim insert wins).
--   * C1 hardening: due_date_reminders() and its ctc_safe_date()
--     helper are service-role-only FROM BIRTH — EXECUTE revoked from
--     public/anon/authenticated in this same migration.
--   * The sweep is a third pg_cron job on the 0024 pattern (hourly at
--     :23, offset from the flush and the check-in sweep), pinging the
--     same push_cron_ping transport — kill switch included for free.
--   * Quiet-hours-delayed reminders queue with kind 'reminder' and
--     RE-VALIDATE at drain (escrow still open, the date unchanged, the
--     threshold still exact in the recipient's timezone) — the
--     check-in pattern, so a push queued overnight can never land with
--     stale "tomorrow" copy.
--
-- Deploy order: run this migration, THEN redeploy send-client-push.

-- ------------------------------------------------- safe date parsing --

-- The possession date lives in buyer_intakes.data (jsonb, free-form
-- storage). A malformed value must yield NULL, never raise — one bad
-- intake row must not kill the whole sweep.
create or replace function ctc_safe_date(p_text text)
returns date
language plpgsql
immutable
as $$
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end;
$$;

revoke execute on function public.ctc_safe_date(text) from public, anon, authenticated;
grant execute on function public.ctc_safe_date(text) to service_role;

-- Timezone guard (auditor P2 pass, Oct 15 2026): push_tokens.timezone
-- is client-supplied text, and an unrecognized zone string RAISES in
-- AT TIME ZONE — one bad row would kill the entire sweep for everyone.
-- ctc_push_zone degrades any unknown/empty value to the default zone
-- (the ctc_safe_date philosophy, applied to the other untrusted input).
create or replace function ctc_push_zone(p_tz text)
returns text
language sql
stable
as $$
  select case
    when p_tz is not null
     and exists (select 1 from pg_timezone_names where name = p_tz)
      then p_tz
    else 'America/Los_Angeles'
  end;
$$;

revoke execute on function public.ctc_push_zone(text) from public, anon, authenticated;
grant execute on function public.ctc_push_zone(text) to service_role;

-- ------------------------------------------------------ candidate rows --

create or replace function due_date_reminders()
returns table (
  escrow_id uuid,
  address text,
  event text,
  threshold int,
  date_value date,
  expo_push_token text,
  timezone text,
  recipient_role text
)
language sql
security definer
set search_path = public
as $$
  -- Closing countdown -> every live client device on the escrow.
  select e.id, e.address, 'closing_reminder',
         (e.close_date - (now() at time zone ctc_push_zone(pt.timezone))::date),
         e.close_date, pt.expo_push_token,
         ctc_push_zone(pt.timezone), cl.role
    from escrows e
    join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
    join invites i on i.id = cl.invite_id and i.revoked_at is null
    join push_tokens pt on pt.link_id = cl.id
   where e.status = 'open'
     and (e.close_date - (now() at time zone ctc_push_zone(pt.timezone))::date) in (7, 3, 1)

  union all

  -- Inspection deadline tomorrow -> buyer side + TC.
  select e.id, e.address, 'inspection_reminder', 1, e.inspection_deadline,
         pt.expo_push_token, ctc_push_zone(pt.timezone), cl.role
    from escrows e
    join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
    join invites i on i.id = cl.invite_id and i.revoked_at is null
    join push_tokens pt on pt.link_id = cl.id
   where e.status = 'open'
     and cl.role in ('buyer', 'tc')
     and e.inspection_deadline is not null
     and (e.inspection_deadline - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1

  union all

  -- Appraisal deadline tomorrow -> buyer side + TC.
  select e.id, e.address, 'appraisal_reminder', 1, e.appraisal_deadline,
         pt.expo_push_token, ctc_push_zone(pt.timezone), cl.role
    from escrows e
    join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
    join invites i on i.id = cl.invite_id and i.revoked_at is null
    join push_tokens pt on pt.link_id = cl.id
   where e.status = 'open'
     and cl.role in ('buyer', 'tc')
     and e.appraisal_deadline is not null
     and (e.appraisal_deadline - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1

  union all

  -- Loan approval date tomorrow -> buyer side + TC.
  select e.id, e.address, 'loan_reminder', 1, e.loan_approval_date,
         pt.expo_push_token, ctc_push_zone(pt.timezone), cl.role
    from escrows e
    join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
    join invites i on i.id = cl.invite_id and i.revoked_at is null
    join push_tokens pt on pt.link_id = cl.id
   where e.status = 'open'
     and cl.role in ('buyer', 'tc')
     and e.loan_approval_date is not null
     and (e.loan_approval_date - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1

  union all

  -- Possession in 5 days -> the seller only. The date is the buyer
  -- intake's possession field (a validated ISO date or empty).
  select e.id, e.address, 'possession_reminder', 5,
         ctc_safe_date(bi.data->>'possession'),
         pt.expo_push_token, ctc_push_zone(pt.timezone), cl.role
    from escrows e
    join client_links cl on cl.escrow_id = e.id and cl.revoked_at is null
    join invites i on i.id = cl.invite_id and i.revoked_at is null
    join push_tokens pt on pt.link_id = cl.id
    join buyer_intakes bi on bi.escrow_id = e.id
   where e.status = 'open'
     and cl.role = 'seller'
     and ctc_safe_date(bi.data->>'possession') is not null
     and (ctc_safe_date(bi.data->>'possession') - (now() at time zone ctc_push_zone(pt.timezone))::date) = 5

  union all

  -- Closing countdown -> the realtor's own devices.
  select e.id, e.address, 'closing_reminder',
         (e.close_date - (now() at time zone ctc_push_zone(pt.timezone))::date),
         e.close_date, pt.expo_push_token,
         ctc_push_zone(pt.timezone), 'realtor'
    from escrows e
    join push_tokens pt on pt.user_id = e.user_id
   where e.status = 'open'
     and (e.close_date - (now() at time zone ctc_push_zone(pt.timezone))::date) in (7, 3, 1)

  union all

  -- Inspection deadline tomorrow -> the realtor.
  select e.id, e.address, 'inspection_reminder', 1, e.inspection_deadline,
         pt.expo_push_token, ctc_push_zone(pt.timezone), 'realtor'
    from escrows e
    join push_tokens pt on pt.user_id = e.user_id
   where e.status = 'open'
     and e.inspection_deadline is not null
     and (e.inspection_deadline - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1

  union all

  -- Appraisal deadline tomorrow -> the realtor.
  select e.id, e.address, 'appraisal_reminder', 1, e.appraisal_deadline,
         pt.expo_push_token, ctc_push_zone(pt.timezone), 'realtor'
    from escrows e
    join push_tokens pt on pt.user_id = e.user_id
   where e.status = 'open'
     and e.appraisal_deadline is not null
     and (e.appraisal_deadline - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1

  union all

  -- Loan approval date tomorrow -> the realtor.
  select e.id, e.address, 'loan_reminder', 1, e.loan_approval_date,
         pt.expo_push_token, ctc_push_zone(pt.timezone), 'realtor'
    from escrows e
    join push_tokens pt on pt.user_id = e.user_id
   where e.status = 'open'
     and e.loan_approval_date is not null
     and (e.loan_approval_date - (now() at time zone ctc_push_zone(pt.timezone))::date) = 1;
$$;

revoke execute on function public.due_date_reminders() from public, anon, authenticated;
grant execute on function public.due_date_reminders() to service_role;

-- ------------------------------------------------------- fire-once log --

create table if not exists push_reminder_log (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  event text not null,
  threshold int not null,
  date_value date not null,
  expo_push_token text not null,
  claimed_at timestamptz not null default now()
);

-- The claim: exactly one insert wins per (escrow, event, threshold,
-- date, token). A changed date is a new key — the reminder re-arms.
create unique index if not exists push_reminder_log_claim_idx
  on push_reminder_log (escrow_id, event, threshold, date_value, expo_push_token);

alter table push_reminder_log enable row level security;

-- ------------------------------------------------- queue kind widening --

alter table push_queue drop constraint if exists push_queue_kind_check;
alter table push_queue
  add constraint push_queue_kind_check
  check (kind in ('step', 'keydate', 'checkin', 'event', 'reminder'));

-- ----------------------------------------------------------------- cron --

do $$
begin
  perform cron.unschedule('ctc_date_reminders');
exception when others then null;
end $$;

select cron.schedule('ctc_date_reminders', '23 * * * *',
  $$select push_cron_ping('date_reminder_sweep')$$);
