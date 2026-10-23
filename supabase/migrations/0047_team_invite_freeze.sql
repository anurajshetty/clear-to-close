-- 0047 — team invite freeze on non-active escrows.
--
-- Anuraj's call (Oct 23, 2026), with the Team sheet redesign: on a
-- closed or cancelled escrow, invites freeze — the Team sheet and the
-- Share screen render read-only, and no membership may change. Two
-- RPCs did not enforce that server-side (verified in the 0044
-- definitions):
--   - create_team_invite checked ownership only, so an invite (and
--     its queued email) could be created on a dead escrow by direct
--     API call.
--   - respond_team_invite checked grant status + caller only, so a
--     pending invite could be ACCEPTED on a dead escrow, minting a
--     live membership on it.
-- Fix: both functions refuse with {ok:false, error:'escrow_not_active'}
-- — create after the ownership check, respond on the accept branch
-- only (declining a dead escrow's invite stays allowed; it is harmless
-- cleanup). Bodies are the 0044 definitions verbatim apart from the
-- marked additions (extracted and diffed programmatically per the
-- paste-ready rule). No tables, no policies; function ACLs carry over
-- on CREATE OR REPLACE and are restated below in the 0044 posture.
-- Step check-offs are NOT frozen by this migration (Anuraj's explicit
-- exception); client invite creation was already refused on
-- closed/cancelled escrows by migration 0018.

create or replace function create_team_invite(
  p_escrow_id uuid, p_email text, p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_owner uuid;
  v_status text;
  v_caller_email text;
  v_user uuid;
  v_grant uuid;
begin
  if p_role not in ('associate', 'tc') or v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select e.user_id, e.status into v_owner, v_status from escrows e where e.id = p_escrow_id;
  if v_owner is null or v_owner is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- 0047: invites freeze on a non-active escrow (Oct 23, 2026).
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'escrow_not_active');
  end if;
  -- R5 self-invite: rejected silently — same success shape, no grant,
  -- so the response never distinguishes the case.
  select lower(u.email) into v_caller_email from auth.users u where u.id = auth.uid();
  if v_email = v_caller_email then
    return jsonb_build_object('ok', true);
  end if;
  -- Pre-link the account when one already exists for the email; the
  -- claim sweep covers accounts created later.
  select u.id into v_user from auth.users u where lower(u.email) = v_email limit 1;
  begin
    insert into escrow_team_grants (escrow_id, invited_email, user_id, role, invited_by)
    values (p_escrow_id, v_email, v_user, p_role, auth.uid())
    returning id into v_grant;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'seat_taken');
  end;
  insert into pending_event_pushes (escrow_id, event, payload)
  values (p_escrow_id, 'team_invite_received', jsonb_build_object('grant_id', v_grant));
  return jsonb_build_object('ok', true, 'grant_id', v_grant);
end;
$$;

create or replace function respond_team_invite(p_grant_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant escrow_team_grants%rowtype;
begin
  select * into v_grant from escrow_team_grants
  where id = p_grant_id and user_id = auth.uid() and status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_accept then
    -- 0047: a pending invite cannot be accepted once the escrow is no
    -- longer active (Oct 23, 2026). Declining stays allowed.
    if not exists (
      select 1 from escrows e
      where e.id = v_grant.escrow_id and e.status = 'open'
    ) then
      return jsonb_build_object('ok', false, 'error', 'escrow_not_active');
    end if;
    update escrow_team_grants
    set status = 'accepted', responded_at = now(), accepted_at = now()
    where id = p_grant_id;
    insert into pending_event_pushes (escrow_id, event, payload)
    values (v_grant.escrow_id, 'team_invite_accepted',
            jsonb_build_object('grant_id', p_grant_id));
  else
    update escrow_team_grants
    set status = 'declined', responded_at = now()
    where id = p_grant_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function create_team_invite(uuid, text, text) from public, anon;
revoke all on function respond_team_invite(uuid, boolean) from public, anon;
grant execute on function create_team_invite(uuid, text, text) to authenticated;
grant execute on function respond_team_invite(uuid, boolean) to authenticated;
