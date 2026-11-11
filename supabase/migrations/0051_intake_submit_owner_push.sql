-- Clear to Close — 0051: intake-submit owner notification.
--
-- What this does
-- --------------
-- When a TEAM MEMBER (Associate or account-TC) moves an intake INTO
-- its submitted state, the escrow OWNER is told via push. The 0040
-- intake events (buyer_intake_submitted / seller_intake_submitted)
-- notify the client-side TC on EVERY save and are untouched by this
-- migration, byte for byte: 0051 adds a SIBLING producer.
--
-- Why a stored marker
-- -------------------
-- "Submitted" must be state the database can predicate on, so this
-- migration adds the marker to both intake tables:
--
--   buyer_intakes.submitted_at  timestamptz (nullable, no default)
--   tc_intakes.submitted_at     timestamptz (nullable, no default)
--
-- An intake is submitted exactly while submitted_at is not null, in
-- the same shape as the house's other stored markers
-- (client_links.revoked_at, escrows.halfway_push_sent_at). Until an
-- intake is submitted the marker stays null. The producer fires on a
-- TRANSITION of the stored state only:
--
--   * INSERT landing with the marker set ............ fires
--   * UPDATE not-submitted -> submitted ............. fires
--   * UPDATE staying submitted (an edit) ............. does NOT fire
--   * un-submit (marker back to null), then re-submit  fires again
--
-- One push per transition; duplicates are not possible from a single
-- transition, so no dedup is needed (auditor-accepted, Nov 10, 2026).
--
-- Actor discipline (auditor condition)
-- ------------------------------------
-- The actor comes ONLY from the trigger's auth context (auth.uid()).
-- No row column or payload field stands in for it, so a client cannot
-- spoof "who submitted". The producer is silent when:
--   * auth.uid() is null (service-role / backend writes), and
--   * the actor IS the escrow owner (escrows.user_id) — an owner
--     submitting their own intake needs no self-notification.
-- The event inherits the queue wholesale (auditor condition): the
-- same pending_event_pushes outbox, push_queue, quiet hours and the
-- push_enabled kill switch, gated at insert exactly like 0040's
-- producers. The drain routes the new kind EXPLICITLY to the owner's
-- realtor tokens resolved from escrows.user_id.
--
-- Grants posture (standing rule, Oct 20, 2026)
-- --------------------------------------------
-- No new tables. The two new columns ride the existing table grants.
-- The producer function's EXECUTE is revoked from public, anon and
-- authenticated below: it is trigger-only, like the rest of the
-- producer family.
--
-- Deploy order: redeploy send-client-push (from the regenerated
-- dashboard-paste single file, Verify JWT OFF) BEFORE running this
-- migration. The new drain handles every existing kind identically,
-- and a transition that lands while an OLD drain is still live would
-- be consumed without delivery. Rows can only exist after this
-- migration runs, so function-first leaves no gap.

-- ------------------------------------------------------------ markers --
alter table buyer_intakes
  add column if not exists submitted_at timestamptz;
alter table tc_intakes
  add column if not exists submitted_at timestamptz;

-- ------------------------------------------------- widen the outbox kind --
-- Full kind list as of 0044 (the latest migration touching this
-- constraint), plus the new owner-direction kind.
alter table pending_event_pushes
  drop constraint if exists pending_event_pushes_event_check;
alter table pending_event_pushes
  add constraint pending_event_pushes_event_check
  check (event in (
    'client_joined', 'review_submitted', 'custom_step_added',
    'escrow_closed', 'escrow_cancelled', 'buyer_intake_submitted',
    'seller_intake_submitted', 'halfway_milestone',
    'team_invite_received', 'team_invite_accepted',
    'member_step_activity', 'intake_submitted_owner'
  ));

-- ------------------------------------------------------------ producer --
create or replace function ctc_push_intake_submitted_owner()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_actor uuid := auth.uid();
  v_owner uuid;
begin
  -- Actor gate: no auth context (service-role write) -> silent, and
  -- the actor is never read from the row or a payload.
  if v_actor is null then
    return new;
  end if;

  -- Transition predicate on STORED state: only a move INTO the
  -- submitted state fires. Edits that stay submitted do not refire.
  if tg_op = 'INSERT' then
    if new.submitted_at is null then
      return new;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.submitted_at is not null or new.submitted_at is null then
      return new;
    end if;
  else
    return new;
  end if;

  -- Owner gate: the recipient is the escrow owner (escrows.user_id);
  -- the owner's own submit is silent.
  select e.user_id into v_owner from escrows e where e.id = new.escrow_id;
  if v_owner is null or v_owner = v_actor then
    return new;
  end if;

  -- Kill switch, gated at insert exactly like the 0040 producers.
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;

  insert into pending_event_pushes (escrow_id, event, payload)
  values (
    new.escrow_id,
    'intake_submitted_owner',
    jsonb_build_object(
      'actor_id', v_actor,
      'intake', case when tg_table_name = 'buyer_intakes'
                     then 'buyer' else 'seller' end
    )
  );
  return new;
end;
$$;

drop trigger if exists buyer_intakes_owner_submit_push on buyer_intakes;
create trigger buyer_intakes_owner_submit_push
  after insert or update on buyer_intakes
  for each row execute function ctc_push_intake_submitted_owner();

drop trigger if exists tc_intakes_owner_submit_push on tc_intakes;
create trigger tc_intakes_owner_submit_push
  after insert or update on tc_intakes
  for each row execute function ctc_push_intake_submitted_owner();

-- Trigger-only: no role may call the producer directly (same posture
-- as the 0040/0044 producer family).
revoke execute on function ctc_push_intake_submitted_owner() from public, anon, authenticated;
