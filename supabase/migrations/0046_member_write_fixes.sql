-- 0046 — member write fixes: steps stamp re-send allowance +
-- client_links member visibility.
--
-- Incident (Oct 23, 2026, owner-reproduced live): Team Access members
-- cannot actually work an escrow they were invited to.
--
-- (1) An accepted ASSOCIATE's checklist save fails with the generic
-- "Couldn't save" banner. Live API evidence: the push dies on its
-- first statement (POST /rest/v1/escrows upsert, 403) and never
-- reaches the steps call. Replays of the app's exact shapes, reading
-- the 403 bodies:
--   - escrow upsert stamped user_id = the associate (what the app
--     sends: the session uid) -> 42501 from the 0044 lifecycle guard
--     ("only the escrow owner can change its lifecycle"), because the
--     pushed user_id differs from the stored owner's.
--   - escrow upsert stamped user_id = the owner -> 42501 RLS, the
--     upsert's INSERT-phase check (auth.uid() = user_id). Member
--     escrow-row upserts are owner-only by construction.
-- The app half of that fix is client-side (member escrow writes use
-- targeted UPDATEs that never carry user_id; verified on the
-- disposable chain under the CURRENT policies). The database half is
-- the steps stamp rule below.
--
-- (2) Even with the escrow statement fixed, the steps upsert fails:
-- 0044's steps_insert/steps_update WITH CHECK requires every re-sent
-- row's completed_by/created_by to be null or the caller. The app
-- always re-sends the FULL checklist, so a member saving any step
-- re-sends rows stamped by the escrow OWNER (or another teammate)
-- and is rejected — and symmetrically, once a member has stamped a
-- step, the owner's next full-checklist save is rejected on that
-- row. The rule was written to stop stamp FORGERY; re-sending an
-- UNCHANGED stored stamp is not forgery.
--
-- Fix for (2): the step_stamps_allowed helper (security definer,
-- escrow_access_role pattern; the statement snapshot sees the
-- committed row). A stamp value is allowed when it is:
--   - null (the stamp is cleared, e.g. an uncheck), or
--   - exactly the value already stored on that row (unchanged
--     re-send), or
--   - the caller, when the stored value is null or already the
--     caller's (a fresh check-off, or re-stamping one's own row).
-- Everything else stays forbidden:
--   - INSERT stamped with another user: no stored row exists, the
--     stored value reads null, and the value is neither the caller
--     nor null -> rejected.
--   - A single write that moves a stamp from one person to another
--     (stored = teammate, new = caller): rejected for EVERYONE,
--     owner included. 0044 allowed the owner that direct re-stamp;
--     no app flow uses it (a toggle goes through null: uncheck,
--     then check), and closing it removes an attribution-theft path.
--     This is the one deliberate narrowing in this migration.
--
-- (3) Client invites are invisible to the Associate (Defect 2):
-- invites were widened in 0044 (owner+associate), but client_links
-- still carries migration 0001's owner-only policy
-- (client_links_owner, FOR ALL, escrows.user_id = auth.uid()), so a
-- member's Share screen sees zero redeemed links and renders the
-- seat as unfilled while the owner sees "ACCEPTED". Fix: split the
-- policy in the invites pattern: SELECT for owner+associate;
-- UPDATE (the revoke path) for owner, or associate on an active
-- escrow. TCs stay excluded (spec: TCs are checklist/intake-only,
-- and client-link state is part of neither). No INSERT or DELETE
-- policy is granted: links are created only inside the redeem_invite
-- security-definer RPC, and links are revoked, never deleted. The
-- client-side policy (client_links_client_self, 0030) is untouched.
-- Section 4 adds the auditor-required column guard on link updates:
-- the UPDATE policy is column-blind, so a BEFORE UPDATE trigger
-- (guard_escrow_lifecycle pattern) makes every column except
-- revoked_at immutable for direct user updates, and revoked_at
-- one-way (null -> timestamp only).
--
-- No tables are created, so the explicit-GRANT rule for new tables
-- does not apply; the new function carries explicit grants in the
-- 0044 posture.

-- ---------------------------------------------------------------
-- 1. Stamp-change helper (escrow_access_role pattern)
-- ---------------------------------------------------------------

create or replace function step_stamps_allowed(
  p_step_id uuid,
  p_completed_by uuid,
  p_created_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (
      p_completed_by is null
      or p_completed_by = (select completed_by from steps where id = p_step_id)
      or (
        p_completed_by = auth.uid()
        and (
          (select completed_by from steps where id = p_step_id) is null
          or (select completed_by from steps where id = p_step_id) = auth.uid()
        )
      )
    )
    and (
      p_created_by is null
      or p_created_by = (select created_by from steps where id = p_step_id)
      or (
        p_created_by = auth.uid()
        and (
          (select created_by from steps where id = p_step_id) is null
          or (select created_by from steps where id = p_step_id) = auth.uid()
        )
      )
    )
$$;

revoke all on function step_stamps_allowed(uuid, uuid, uuid) from public, anon;
grant execute on function step_stamps_allowed(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------
-- 2. Steps policies: stamp rule via the helper
-- ---------------------------------------------------------------

drop policy if exists steps_insert on steps;
create policy steps_insert on steps
  for insert to authenticated
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
    )
    and step_stamps_allowed(id, completed_by, created_by)
  );

drop policy if exists steps_update on steps;
create policy steps_update on steps
  for update to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  )
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
    )
    and step_stamps_allowed(id, completed_by, created_by)
  );

-- ---------------------------------------------------------------
-- 3. client_links: member visibility (invites pattern)
-- ---------------------------------------------------------------

drop policy if exists client_links_owner on client_links;

drop policy if exists client_links_select on client_links;
create policy client_links_select on client_links
  for select to authenticated
  using (escrow_access_role(escrow_id) in ('owner', 'associate'));

drop policy if exists client_links_update on client_links;
create policy client_links_update on client_links
  for update to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  )
  with check (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  );

-- ---------------------------------------------------------------
-- 4. client_links update guard (auditor's required addition)
-- ---------------------------------------------------------------
-- The UPDATE policy above is column-blind: under it, an accepted
-- associate on an active escrow could, by direct API call, set
-- revoked_at back to null (resurrecting a link the owner killed —
-- the client path revives with it), rewrite device_id (rebinding a
-- live link to a device of their choosing), or flip role across the
-- buyer/seller line. The app never sends those writes, but the
-- policy layer is the enforcement, so a guard trigger in the
-- guard_escrow_lifecycle pattern pins the shape: for direct user
-- updates (auth.uid() present), every column except revoked_at is
-- immutable, and revoked_at may only move null -> non-null (a
-- revoke), never back. Legitimate flows survive by shape:
--   - app revoke (owner/associate): null -> timestamp, only
--     revoked_at changes.
--   - regenerate_invite's link-kill and the cancel chain's
--     revocations: the same null -> timestamp move, even though
--     they run under the caller's uid inside definer functions.
--   - creation is an INSERT inside redeem_invite, untouched by an
--     UPDATE guard; uid-less service paths are not constrained.

create or replace function guard_client_link_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.escrow_id is distinct from old.escrow_id
     or new.invite_id is distinct from old.invite_id
     or new.role is distinct from old.role
     or new.party_name is distinct from old.party_name
     or new.device_id is distinct from old.device_id
     or new.created_at is distinct from old.created_at then
    raise exception 'client link fields other than revoked_at cannot be changed'
      using errcode = '42501';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'a revoked client link cannot be un-revoked'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function guard_client_link_update() from public, anon, authenticated;

drop trigger if exists client_links_update_guard on client_links;
create trigger client_links_update_guard
  before update on client_links
  for each row
  execute function guard_client_link_update();
