-- 0052 — In-app account deletion: the data RPC (Nov 2026, Stream 4).
--
-- App Store Guideline 5.1.1(v) preempt (Anuraj: "let's preempt it").
-- The delete-account Edge Function orchestrates: global session
-- revocation -> realtor-media storage removal -> THIS RPC -> the
-- auth user deleted LAST by the platform admin API. This migration
-- owns step 3: every database row the caller owns, in ONE
-- transaction (a plpgsql function body is a single transaction).
--
-- Auditor conditions baked in (PASS WITH CONDITIONS, Nov 2026):
--   * Identity comes from the orchestrator's JWT check; this RPC
--     takes an explicit uid (and, optionally, the JWT email) and is
--     executable by SERVICE ROLE ONLY — EXECUTE is revoked from
--     public/anon/authenticated below, and the body refuses any
--     JWT role other than service_role as an inner wall.
--   * The manifest is EXPLICIT against the live FK graph (derived
--     from migrations 0001-0049 and verified column by column).
--     Nothing is left to "the cascades will get it": cascades are
--     the backstop, the deletes below are the record (they produce
--     the audit counts).
--   * The outbox purge is LAST inside the transaction, so nothing
--     the earlier deletes could enqueue survives: any
--     pending_event_pushes row for an owned escrow, and any row
--     addressed to the caller on someone else's escrow (a queued
--     team invite naming one of the grants removed below), is gone
--     when the transaction commits.
--   * A minimal audit row (timestamp + per-table counts, NO
--     personal content) is written inside the same transaction.
--   * Idempotent: a retry finds nothing and returns zero counts.
--
-- MANIFEST (caller = p_uid, owned escrows = escrows.user_id = p_uid):
--   push_queue / push_reminder_log .. rows keyed to an owned escrow
--     or to any expo token in the caller's token set (both classes).
--   push_delivery_log ............... owned escrows' delivery rows.
--   push_tokens ..................... BOTH classes: the caller's
--     realtor tokens (user_id) and client registrations bound to
--     links on owned escrows (link_id / escrow_id).
--   reviews ......................... reviews OF the caller
--     (realtor_id) and reviews left through owned escrows' links.
--     (reviews has no reviewer uid column — client_name is text —
--     so there is no "as reviewer" row set to remove.)
--   team_invite_email_log ........... see DISPOSITION below.
--   escrow_team_grants .............. grants on owned escrows, the
--     caller's own seats on other owners' escrows (seat freed; the
--     escrow itself is untouched), and still-pending invites
--     addressed to the caller's email (user_id is null until
--     acceptance, so the email is the only key — the JWT email,
--     passed by the orchestrator, never from a request body).
--   escrow_activity ................. owned escrows only. The
--     caller's actor rows on OTHER owners' escrows stay: their
--     snapshots keep rendering and the name resolution falls back
--     gracefully once the profile is gone (0049).
--   steps / buyer_intakes / tc_intakes / client_links / invites ...
--     owned escrows' dependent rows. The caller's step stamps on
--     other owners' escrows are NOT touched — they dangle by
--     design (no-one-else battery, auditor).
--   escrows ......................... the owned escrows themselves.
--   realtor_profiles ................ the caller's profile row.
--   pending_event_pushes / pending_step_pushes ... the outbox,
--     purged LAST (see above).
--   Quiet-checkin state is escrows.last_quiet_checkin_at — it dies
--   with the owned escrow rows; there is no separate table.
--
-- team_invite_email_log DISPOSITION (explicit, per the auditor):
--   rows follow their grant. The log is a send record keyed by
--   grant_id (FK ON DELETE CASCADE) with owner_id as the 24h
--   rate-cap key. This RPC deletes explicitly, ahead of the grants:
--   every row whose grant is removed by this deletion, plus every
--   row with owner_id = the caller (their own send history). Rows
--   belonging to other owners' grants — including sends addressed
--   to third parties — are untouched, so no other owner's rate-cap
--   accounting is disturbed. Net effect, verified by the residue
--   scan: no log row references the caller, their grants, or their
--   owned escrows after the transaction.
--
-- Paste-ready note: this migration is NEW surface only (one table,
-- one function). No existing object is recreated, so there is no
-- earlier definition to drift from; the FK facts above were read
-- from the live chain (0001-0049) on the disposable harness.

-- ---------------------------------------------------------------- audit --
-- Minimal audit record: when a deletion ran and how many rows it
-- removed per table. No names, no emails, no addresses.
create table if not exists public.account_deletion_log (
  id uuid primary key default gen_random_uuid(),
  deleted_user_id uuid not null,
  deleted_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb
);

alter table public.account_deletion_log enable row level security;

-- Explicit grants (standing rule, Oct 30 2026): service role only.
revoke all on table public.account_deletion_log from public, anon, authenticated;
grant select, insert, update, delete on table public.account_deletion_log to service_role;

-- ------------------------------------------------------------------ RPC --
create or replace function public.delete_account_data(p_uid uuid, p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrows uuid[] := '{}';
  v_links uuid[] := '{}';
  v_tokens text[] := '{}';
  v_grants uuid[] := '{}';
  v_grants_text text[] := '{}';
  v_counts jsonb := '{}'::jsonb;
  v_n bigint := 0;
begin
  if p_uid is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- Inner wall (the grants below are the outer one): when a JWT is
  -- present, only the service role may run this. A bare database
  -- session (the owner's own dashboard) carries no JWT and is the
  -- operator's path.
  if coalesce(auth.jwt() ->> 'role', '') not in ('', 'service_role') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- Snapshots, taken before any delete: the owned escrows, their
  -- client links, every expo token that must stop receiving pushes,
  -- and every team grant this deletion removes.
  select coalesce(array_agg(id), '{}') into v_escrows
    from escrows where user_id = p_uid;
  select coalesce(array_agg(id), '{}') into v_links
    from client_links where escrow_id = any (v_escrows);
  select coalesce(array_agg(distinct expo_push_token), '{}') into v_tokens
    from push_tokens
    where user_id = p_uid
       or escrow_id = any (v_escrows)
       or link_id = any (v_links);
  select coalesce(array_agg(id), '{}') into v_grants
    from escrow_team_grants
    where escrow_id = any (v_escrows)
       or user_id = p_uid
       or (p_email is not null and invited_email = p_email and user_id is null);
  select coalesce(array_agg(id::text), '{}') into v_grants_text
    from unnest(v_grants) as id;

  -- Outbox sizes are counted now; the purge itself is the LAST step
  -- of the transaction (auditor ordering), after the escrow deletes
  -- have cascade-removed the owned rows.
  v_counts := v_counts || jsonb_build_object(
    'pending_event_pushes',
    (select count(*) from pending_event_pushes
      where escrow_id = any (v_escrows)
         or payload ->> 'grant_id' = any (v_grants_text)),
    'pending_step_pushes',
    (select count(*) from pending_step_pushes
      where escrow_id = any (v_escrows)));

  -- Delivery machinery keyed to the caller's tokens / escrows.
  delete from push_queue
    where escrow_id = any (v_escrows) or expo_push_token = any (v_tokens);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('push_queue', v_n);

  delete from push_reminder_log
    where escrow_id = any (v_escrows) or expo_push_token = any (v_tokens);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('push_reminder_log', v_n);

  delete from push_delivery_log
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('push_delivery_log', v_n);

  -- BOTH push-token classes.
  delete from push_tokens
    where user_id = p_uid
       or escrow_id = any (v_escrows)
       or link_id = any (v_links);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('push_tokens', v_n);

  -- Reviews of the caller + reviews left via owned escrows' links.
  delete from reviews
    where realtor_id = p_uid or link_id = any (v_links);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('reviews', v_n);

  -- Send-log rows follow their grant (disposition in the header).
  delete from team_invite_email_log
    where grant_id = any (v_grants) or owner_id = p_uid;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('team_invite_email_log', v_n);

  -- Team grants: owned escrows' rosters, the caller's seats
  -- elsewhere (freed + re-invitable), pending invites to the
  -- caller's email. Other owners' escrows are untouched.
  delete from escrow_team_grants
    where id = any (v_grants);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('escrow_team_grants', v_n);

  -- Owned escrows' dependent rows (explicit; cascades are backstop).
  delete from escrow_activity
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('escrow_activity', v_n);

  delete from steps
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('steps', v_n);

  delete from buyer_intakes
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('buyer_intakes', v_n);

  delete from tc_intakes
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('tc_intakes', v_n);

  delete from client_links
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('client_links', v_n);

  delete from invites
    where escrow_id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('invites', v_n);

  -- The owned escrows themselves.
  delete from escrows
    where id = any (v_escrows);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('escrows', v_n);

  -- The profile (public profile page dies with this row).
  delete from realtor_profiles
    where user_id = p_uid;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('profile', v_n);

  -- OUTBOX PURGE — LAST inside the transaction (auditor ordering).
  -- Owned-escrow rows are already gone via the escrow cascade; this
  -- removes rows addressed to the caller on OTHER owners' escrows
  -- (queued team invites naming a removed grant) and any straggler
  -- an earlier delete could have enqueued.
  delete from pending_event_pushes
    where escrow_id = any (v_escrows)
       or payload ->> 'grant_id' = any (v_grants_text);

  delete from pending_step_pushes
    where escrow_id = any (v_escrows);

  -- Minimal audit record: timestamp + counts, no personal content.
  insert into account_deletion_log (deleted_user_id, counts)
  values (p_uid, v_counts);

  return jsonb_build_object('ok', true, 'counts', v_counts);
end;
$$;

-- Service role ONLY (auditor): the orchestrator calls this with the
-- service key after verifying the caller's JWT and password itself.
revoke all on function public.delete_account_data(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid, text) to service_role;
