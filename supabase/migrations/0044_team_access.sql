-- 0044_team_access.sql
--
-- Team Access (Anuraj, Oct 20, 2026): per-escrow Associate + TC grants
-- for realtor-side accounts. Sources of truth:
-- goals/realtor-transaction-app-working-title/files/team-access-spec.md
-- (as amended by the Oct 20 brief) and team-access-build-plan.md
-- (auditor design pass complete, R1-R8 folded).
--
-- Shape: escrow_team_grants (one active-or-pending grant per role per
-- escrow), escrow_activity (server-written, actor-stamped, frozen),
-- actor stamp columns, an escrow_access_role() helper every changed
-- policy is expressed through, per-command policy splits, team RPCs,
-- and three new push outbox kinds. CLIENT SURFACES ARE UNTOUCHED:
-- get_client_view, the redeem path, client policies and client push
-- behavior are byte-identical — member step activity fires the same
-- client pushes the owner's does, because ctc_push_notify is not
-- modified at all.
--
-- escrow_private_notes is deliberately NOT referenced here: it does
-- not exist in the repo migrations (if present live, its owner-only
-- posture is unchanged by this migration).

-- ============================================================= tables ==

create table if not exists escrow_team_grants (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  invited_email text not null,
  user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('associate', 'tc')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'removed', 'left', 'cancelled')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  accepted_at timestamptz
);

-- One seat per role per escrow (data layer, per the brief): at most
-- one pending-or-accepted grant per (escrow, role).
create unique index if not exists escrow_team_grants_one_seat
  on escrow_team_grants (escrow_id, role)
  where status in ('pending', 'accepted');

create index if not exists escrow_team_grants_by_user
  on escrow_team_grants (user_id) where user_id is not null;
create index if not exists escrow_team_grants_by_email
  on escrow_team_grants (lower(invited_email)) where status = 'pending';

-- RPC-only surface: RLS on, no client policies, no direct grants.
alter table escrow_team_grants enable row level security;
revoke all on escrow_team_grants from anon, authenticated;

create table if not exists escrow_activity (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  actor_id uuid,
  actor_name text,
  actor_label text,
  kind text not null check (kind in (
    'escrow_opened', 'step_checked', 'step_unchecked', 'step_added',
    'intake_saved', 'closing_date_changed', 'escrow_closed',
    'escrow_cancelled', 'client_joined', 'team_invited',
    'team_accepted', 'team_declined', 'team_removed', 'team_left',
    'team_invite_cancelled'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists escrow_activity_by_escrow
  on escrow_activity (escrow_id, created_at desc);

alter table escrow_activity enable row level security;
-- (its SELECT policy is created after the helpers, below.)

-- Actor stamps. steps.completed_by rides completed_at (set/cleared
-- together); steps.created_by names the actor on custom-step adds;
-- intakes.updated_by names the saver (owner_id keeps stamping the
-- ESCROW OWNER — get_client_view's joins depend on it).
alter table steps add column if not exists completed_by uuid;
alter table steps add column if not exists created_by uuid;
alter table buyer_intakes add column if not exists updated_by uuid;
alter table tc_intakes add column if not exists updated_by uuid;

-- Invite-email send log for the per-owner cap (R5): written by the
-- send path (service role), read by it before sending. A cap hit
-- suppresses the email silently; the grant and the inviter's response
-- are unaffected.
create table if not exists team_invite_email_log (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references escrow_team_grants(id) on delete cascade,
  owner_id uuid not null,
  sent_at timestamptz not null default now()
);
alter table team_invite_email_log enable row level security;
revoke all on team_invite_email_log from anon, authenticated;

-- The three team kinds join the push outbox.
alter table pending_event_pushes
  drop constraint if exists pending_event_pushes_event_check;
alter table pending_event_pushes
  add constraint pending_event_pushes_event_check
  check (event in (
    'client_joined', 'review_submitted', 'custom_step_added',
    'escrow_closed', 'escrow_cancelled',
    'buyer_intake_submitted', 'seller_intake_submitted',
    'halfway_milestone',
    'team_invite_received', 'team_invite_accepted', 'member_step_activity'
  ));

-- ============================================================ helpers ==

create or replace function escrow_access_role(p_escrow_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from escrows e
      where e.id = p_escrow_id and e.user_id = auth.uid()
    ) then 'owner'
    else (
      select g.role from escrow_team_grants g
      where g.escrow_id = p_escrow_id
        and g.user_id = auth.uid()
        and g.status = 'accepted'
      order by (g.role = 'associate') desc
      limit 1
    )
  end;
$$;

create or replace function ctc_escrow_active(p_escrow_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from escrows e where e.id = p_escrow_id and e.status = 'open'
  );
$$;

-- Display-name snapshot for activity rows (R1(a)): the name as it was
-- when the action happened; later renames never rewrite history.
create or replace function ctc_profile_name_snapshot(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(trim(coalesce(name, '')), '') from realtor_profiles
  where user_id = p_user_id;
$$;

revoke all on function escrow_access_role(uuid) from public, anon;
revoke all on function ctc_escrow_active(uuid) from public, anon;
revoke all on function ctc_profile_name_snapshot(uuid) from public, anon;
grant execute on function escrow_access_role(uuid) to authenticated;
grant execute on function ctc_escrow_active(uuid) to authenticated;
-- ctc_profile_name_snapshot is trigger-internal: no client grant.

-- Activity read policy (needs escrow_access_role to exist first).
alter table escrow_activity enable row level security;
drop policy if exists escrow_activity_select on escrow_activity;
create policy escrow_activity_select on escrow_activity
  for select to authenticated
  using (escrow_access_role(escrow_id) is not null);
revoke all on escrow_activity from anon, authenticated;
grant select on escrow_activity to authenticated;
-- No client insert/update/delete: server triggers (definer) write.

-- ==================================================== policy splits ==

-- escrows: SELECT owner or any accepted grant; INSERT owner only;
-- UPDATE owner, or Associate on an ACTIVE escrow (lifecycle columns
-- are trigger-guarded below); DELETE owner only.
drop policy if exists escrows_owner on escrows;
drop policy if exists escrows_select on escrows;
create policy escrows_select on escrows
  for select to authenticated
  using (escrow_access_role(id) is not null);
drop policy if exists escrows_insert on escrows;
create policy escrows_insert on escrows
  for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists escrows_update on escrows;
create policy escrows_update on escrows
  for update to authenticated
  using (
    escrow_access_role(id) = 'owner'
    or (escrow_access_role(id) = 'associate' and ctc_escrow_active(id))
  )
  with check (
    escrow_access_role(id) = 'owner'
    or (escrow_access_role(id) = 'associate' and ctc_escrow_active(id))
  );
drop policy if exists escrows_delete on escrows;
create policy escrows_delete on escrows
  for delete to authenticated
  using (escrow_access_role(id) = 'owner');

-- Lifecycle guard: RLS cannot split by column, so a non-owner update
-- that touches status or user_id is rejected here even though the
-- UPDATE policy lets Associates edit content. System writes with no
-- session uid (service role, definer maintenance like the check-off
-- stamps in ctc_push_notify — which never touch these columns) pass.
create or replace function guard_escrow_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() = old.user_id then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.user_id is distinct from old.user_id then
    raise exception 'only the escrow owner can change its lifecycle'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists escrows_lifecycle_guard on escrows;
create trigger escrows_lifecycle_guard
  before update on escrows
  for each row
  execute function guard_escrow_lifecycle();

-- steps: read for any accepted role; write for owner, or Associate on
-- an active escrow. TC is read-only here (spec). The stamp checks use
-- the explicit null-admitting form (R1 note): a stamp may be empty
-- (cleared) but may never name another user.
drop policy if exists steps_owner on steps;
drop policy if exists steps_select on steps;
create policy steps_select on steps
  for select to authenticated
  using (escrow_access_role(escrow_id) is not null);
drop policy if exists steps_insert on steps;
create policy steps_insert on steps
  for insert to authenticated
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
    )
    and (completed_by is null or completed_by = auth.uid())
    and (created_by is null or created_by = auth.uid())
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
    and (completed_by is null or completed_by = auth.uid())
    and (created_by is null or created_by = auth.uid())
  );
drop policy if exists steps_delete on steps;
create policy steps_delete on steps
  for delete to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  );
-- steps_client_live (0030/0035) is untouched: clients keep their live view.

-- invites (client codes): owner + Associate ONLY, every command — the
-- TC has zero rights on this table (Q2 correction). The enforce_*
-- trigger guards (caps, side, closed-escrow) apply unchanged.
drop policy if exists invites_owner on invites;
drop policy if exists invites_select on invites;
create policy invites_select on invites
  for select to authenticated
  using (escrow_access_role(escrow_id) in ('owner', 'associate'));
drop policy if exists invites_insert on invites;
create policy invites_insert on invites
  for insert to authenticated
  with check (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  );
drop policy if exists invites_update on invites;
create policy invites_update on invites
  for update to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  )
  with check (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  );
drop policy if exists invites_delete on invites;
create policy invites_delete on invites
  for delete to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) = 'associate' and ctc_escrow_active(escrow_id))
  );

-- intakes (buyer + tc): authorized by escrow access, not by the
-- owner_id stamp — owner, Associate AND TC edit intakes. owner_id
-- must keep naming the ESCROW OWNER (integrity check below), and
-- updated_by may only name the writer.
drop policy if exists buyer_intakes_owner on buyer_intakes;
drop policy if exists buyer_intakes_select on buyer_intakes;
create policy buyer_intakes_select on buyer_intakes
  for select to authenticated
  using (escrow_access_role(escrow_id) is not null);
drop policy if exists buyer_intakes_write on buyer_intakes;
create policy buyer_intakes_write on buyer_intakes
  for insert to authenticated
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
    )
    and owner_id = (select e.user_id from escrows e where e.id = escrow_id)
    and (updated_by is null or updated_by = auth.uid())
  );
drop policy if exists buyer_intakes_update on buyer_intakes;
create policy buyer_intakes_update on buyer_intakes
  for update to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
  )
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
    )
    and owner_id = (select e.user_id from escrows e where e.id = escrow_id)
    and (updated_by is null or updated_by = auth.uid())
  );
drop policy if exists buyer_intakes_delete on buyer_intakes;
create policy buyer_intakes_delete on buyer_intakes
  for delete to authenticated
  using (escrow_access_role(escrow_id) = 'owner');

drop policy if exists tc_intakes_owner on tc_intakes;
drop policy if exists tc_intakes_select on tc_intakes;
create policy tc_intakes_select on tc_intakes
  for select to authenticated
  using (escrow_access_role(escrow_id) is not null);
drop policy if exists tc_intakes_write on tc_intakes;
create policy tc_intakes_write on tc_intakes
  for insert to authenticated
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
    )
    and owner_id = (select e.user_id from escrows e where e.id = escrow_id)
    and (updated_by is null or updated_by = auth.uid())
  );
drop policy if exists tc_intakes_update on tc_intakes;
create policy tc_intakes_update on tc_intakes
  for update to authenticated
  using (
    escrow_access_role(escrow_id) = 'owner'
    or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
  )
  with check (
    (
      escrow_access_role(escrow_id) = 'owner'
      or (escrow_access_role(escrow_id) in ('associate', 'tc') and ctc_escrow_active(escrow_id))
    )
    and owner_id = (select e.user_id from escrows e where e.id = escrow_id)
    and (updated_by is null or updated_by = auth.uid())
  );
drop policy if exists tc_intakes_delete on tc_intakes;
create policy tc_intakes_delete on tc_intakes
  for delete to authenticated
  using (escrow_access_role(escrow_id) = 'owner');

-- ================================================= activity writers ==
-- All activity rows are written here, server-side, with the actor
-- taken from auth.uid() (never from row stamps — on an uncheck the
-- row's completed_by names the checker, auth.uid() names the
-- unchecker). Display names are snapshotted at write time (R1(a)).

create or replace function ctc_activity_steps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.done then
      v_kind := 'step_checked';
    elsif new.custom then
      v_kind := 'step_added';
    else
      return new;  -- template rows land silently
    end if;
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.escrow_id, v_actor, ctc_profile_name_snapshot(v_actor), v_kind,
            jsonb_build_object('title', new.title, 'step_id', new.id));
    return new;
  end if;
  if tg_op = 'UPDATE' and new.done is distinct from old.done then
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.escrow_id, v_actor, ctc_profile_name_snapshot(v_actor),
            case when new.done then 'step_checked' else 'step_unchecked' end,
            jsonb_build_object('title', new.title, 'step_id', new.id));
  end if;
  return new;
end;
$$;

drop trigger if exists steps_activity on steps;
create trigger steps_activity
  after insert or update on steps
  for each row
  execute function ctc_activity_steps();

create or replace function ctc_activity_intakes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return new;
  end if;
  insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
  values (new.escrow_id, v_actor, ctc_profile_name_snapshot(v_actor),
          'intake_saved',
          jsonb_build_object('intake', case when tg_table_name = 'tc_intakes' then 'tc' else 'buyer' end));
  return new;
end;
$$;

drop trigger if exists buyer_intakes_activity on buyer_intakes;
create trigger buyer_intakes_activity
  after insert or update on buyer_intakes
  for each row
  execute function ctc_activity_intakes();
drop trigger if exists tc_intakes_activity on tc_intakes;
create trigger tc_intakes_activity
  after insert or update on tc_intakes
  for each row
  execute function ctc_activity_intakes();

create or replace function ctc_activity_escrows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.id, new.user_id, ctc_profile_name_snapshot(new.user_id),
            'escrow_opened', '{}'::jsonb);
    return new;
  end if;
  v_actor := coalesce(auth.uid(), new.user_id);
  if new.close_date is distinct from old.close_date then
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.id, v_actor, ctc_profile_name_snapshot(v_actor),
            'closing_date_changed',
            jsonb_build_object('from', old.close_date, 'to', new.close_date));
  end if;
  if new.status is distinct from old.status and new.status in ('closed', 'cancelled') then
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.id, v_actor, ctc_profile_name_snapshot(v_actor),
            case when new.status = 'closed' then 'escrow_closed' else 'escrow_cancelled' end,
            '{}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists escrows_activity on escrows;
create trigger escrows_activity
  after insert or update on escrows
  for each row
  execute function ctc_activity_escrows();

-- Client joins are logged from the invites row itself, so the redeem
-- path (redeem_invite) is NOT modified — constraint 1 (clients
-- untouched) holds byte-for-byte.
create or replace function ctc_activity_invites()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.redeemed_at is null and new.redeemed_at is not null then
    insert into escrow_activity (escrow_id, actor_id, actor_name, actor_label, kind, detail)
    values (new.escrow_id, null, null,
            new.party_name || ' (' || new.role || ')',
            'client_joined',
            jsonb_build_object('role', new.role));
  end if;
  return new;
end;
$$;

drop trigger if exists invites_activity on invites;
create trigger invites_activity
  after update on invites
  for each row
  execute function ctc_activity_invites();

create or replace function ctc_activity_grants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
    values (new.escrow_id, new.invited_by, ctc_profile_name_snapshot(new.invited_by),
            'team_invited',
            jsonb_build_object('role', new.role, 'invited_email', new.invited_email,
                               'invited_name', ctc_profile_name_snapshot(new.user_id)));
    return new;
  end if;
  if new.status is distinct from old.status then
    v_kind := case new.status
      when 'accepted' then 'team_accepted'
      when 'declined' then 'team_declined'
      when 'removed' then 'team_removed'
      when 'left' then 'team_left'
      when 'cancelled' then 'team_invite_cancelled'
      else null end;
    if v_kind is not null then
      v_actor := case
        when new.status in ('accepted', 'declined', 'left') then coalesce(new.user_id, auth.uid())
        else coalesce(auth.uid(), new.invited_by)
      end;
      insert into escrow_activity (escrow_id, actor_id, actor_name, kind, detail)
      values (new.escrow_id, v_actor, ctc_profile_name_snapshot(v_actor), v_kind,
              jsonb_build_object('role', new.role, 'invited_email', new.invited_email));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists grants_activity on escrow_team_grants;
create trigger grants_activity
  after insert or update on escrow_team_grants
  for each row
  execute function ctc_activity_grants();

-- Member step activity -> owner push (Oct 20 rule): an ASSOCIATE's
-- check-off, uncheck, or custom-step add on an invited escrow
-- enqueues a fact row; recipients and validity are decided at drain
-- time (R4). TC activity, intake saves, and date edits never enqueue.
create or replace function ctc_push_member_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;
  if escrow_access_role(coalesce(new.escrow_id, old.escrow_id)) is distinct from 'associate' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.done then
      v_action := 'checked';
    elsif new.custom then
      v_action := 'added';
    else
      return new;
    end if;
  elsif tg_op = 'UPDATE' and new.done is distinct from old.done then
    v_action := case when new.done then 'checked' else 'unchecked' end;
  else
    return new;
  end if;
  insert into pending_event_pushes (escrow_id, event, payload)
  values (new.escrow_id, 'member_step_activity',
          jsonb_build_object('actor_id', v_actor, 'action', v_action,
                             'title', new.title, 'step_id', new.id));
  return new;
end;
$$;

drop trigger if exists steps_member_push on steps;
create trigger steps_member_push
  after insert or update on steps
  for each row
  execute function ctc_push_member_activity();

-- ========================================================== team RPCs ==
-- All SECURITY DEFINER with locked search_path; EXECUTE revoked from
-- public/anon, granted to authenticated only (R6 posture). Errors use
-- one shape for unknown-or-foreign grants (no existence oracle).

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
  v_caller_email text;
  v_user uuid;
  v_grant uuid;
begin
  if p_role not in ('associate', 'tc') or v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select e.user_id into v_owner from escrows e where e.id = p_escrow_id;
  if v_owner is null or v_owner is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
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

-- Link pending grants to the caller by VERIFIED email. Claim is not
-- acceptance: the grant stays pending until respond_team_invite.
create or replace function claim_team_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select lower(u.email) into v_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;
  update escrow_team_grants
  set user_id = auth.uid()
  where user_id is null
    and status = 'pending'
    and lower(invited_email) = v_email;
  get diagnostics v_count = row_count;
  return v_count;
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

create or replace function remove_team_member(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant escrow_team_grants%rowtype;
begin
  select g.* into v_grant
  from escrow_team_grants g
  join escrows e on e.id = g.escrow_id
  where g.id = p_grant_id and e.user_id = auth.uid() and g.status = 'accepted';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  update escrow_team_grants set status = 'removed' where id = p_grant_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function cancel_team_invite(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant escrow_team_grants%rowtype;
begin
  select g.* into v_grant
  from escrow_team_grants g
  join escrows e on e.id = g.escrow_id
  where g.id = p_grant_id and e.user_id = auth.uid() and g.status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  update escrow_team_grants set status = 'cancelled' where id = p_grant_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function leave_team_escrow(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant escrow_team_grants%rowtype;
begin
  select * into v_grant from escrow_team_grants
  where id = p_grant_id and user_id = auth.uid() and status = 'accepted';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  update escrow_team_grants set status = 'left' where id = p_grant_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Pending invites addressed to the caller (home's pending card).
create or replace function list_my_team_invites()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'grant_id', g.id,
    'role', g.role,
    'created_at', g.created_at,
    'invited_email', g.invited_email,
    'owner_name', (select p.name from realtor_profiles p where p.user_id = e.user_id),
    'owner_photo_url', (select p.photo_url from realtor_profiles p where p.user_id = e.user_id),
    'escrow', jsonb_build_object(
      'id', e.id, 'address', e.address, 'city', e.city, 'side', e.side,
      'buyer_name', e.buyer_name, 'seller_name', e.seller_name,
      'close_date', e.close_date, 'status', e.status)
  ) order by g.created_at), '[]'::jsonb)
  from escrow_team_grants g
  join escrows e on e.id = g.escrow_id
  where g.user_id = auth.uid() and g.status = 'pending';
$$;

-- Accepted grants with full escrow rows (home's Invited section).
create or replace function list_invited_escrows()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'grant_id', g.id,
    'role', g.role,
    'accepted_at', g.accepted_at,
    'owner_name', (select p.name from realtor_profiles p where p.user_id = e.user_id),
    'owner_photo_url', (select p.photo_url from realtor_profiles p where p.user_id = e.user_id),
    'escrow', to_jsonb(e)
  ) order by g.accepted_at desc), '[]'::jsonb)
  from escrow_team_grants g
  join escrows e on e.id = g.escrow_id
  where g.user_id = auth.uid() and g.status = 'accepted';
$$;

-- Owner + live seats for the Team sheet (incl. the pending seat).
create or replace function get_escrow_participants(p_escrow_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_members jsonb;
begin
  if escrow_access_role(p_escrow_id) is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select e.user_id into v_owner from escrows e where e.id = p_escrow_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'grant_id', g.id,
    'user_id', g.user_id,
    'invited_email', g.invited_email,
    'name', (select p.name from realtor_profiles p where p.user_id = g.user_id),
    'photo_url', (select p.photo_url from realtor_profiles p where p.user_id = g.user_id),
    'role', g.role,
    'status', g.status,
    'created_at', g.created_at,
    'accepted_at', g.accepted_at
  ) order by g.created_at), '[]'::jsonb)
  into v_members
  from escrow_team_grants g
  where g.escrow_id = p_escrow_id and g.status in ('pending', 'accepted');
  return jsonb_build_object(
    'ok', true,
    'owner', jsonb_build_object(
      'user_id', v_owner,
      'name', (select p.name from realtor_profiles p where p.user_id = v_owner),
      'photo_url', (select p.photo_url from realtor_profiles p where p.user_id = v_owner)
    ),
    'members', v_members
  );
end;
$$;

create or replace function list_escrow_activity(p_escrow_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when escrow_access_role(p_escrow_id) is null then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'actor_id', a.actor_id,
        'actor_name', a.actor_name, 'actor_label', a.actor_label,
        'detail', a.detail, 'created_at', a.created_at
      ) order by a.created_at desc)
      from (
        select * from escrow_activity
        where escrow_id = p_escrow_id
        order by created_at desc
        limit 200
      ) a
    ), '[]'::jsonb)
  end;
$$;

revoke all on function create_team_invite(uuid, text, text) from public, anon;
revoke all on function claim_team_invites() from public, anon;
revoke all on function respond_team_invite(uuid, boolean) from public, anon;
revoke all on function remove_team_member(uuid) from public, anon;
revoke all on function cancel_team_invite(uuid) from public, anon;
revoke all on function leave_team_escrow(uuid) from public, anon;
revoke all on function list_my_team_invites() from public, anon;
revoke all on function list_invited_escrows() from public, anon;
revoke all on function get_escrow_participants(uuid) from public, anon;
revoke all on function list_escrow_activity(uuid) from public, anon;
grant execute on function create_team_invite(uuid, text, text) to authenticated;
grant execute on function claim_team_invites() to authenticated;
grant execute on function respond_team_invite(uuid, boolean) to authenticated;
grant execute on function remove_team_member(uuid) to authenticated;
grant execute on function cancel_team_invite(uuid) to authenticated;
grant execute on function leave_team_escrow(uuid) to authenticated;
grant execute on function list_my_team_invites() to authenticated;
grant execute on function list_invited_escrows() to authenticated;
grant execute on function get_escrow_participants(uuid) to authenticated;
grant execute on function list_escrow_activity(uuid) to authenticated;

-- --------------------------------- regenerate_invite (grant-aware) --
-- Verbatim from 0005 (the operative definition; 0035 does not touch
-- it) with ONE change: the ownership check now also admits an accepted
-- Associate, mirroring the invites policy (TC excluded — zero invites
-- rights). Everything else (revoke-first, code loop, link kill,
-- return shape) is byte-identical.
create or replace function regenerate_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_code text;
  v_new_id uuid := gen_random_uuid();
  v_attempts int := 0;
begin
  select * into v_invite from invites where id = p_invite_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Ownership: the escrow's realtor, or an accepted Associate on it
  -- (0044). escrow_access_role returns 'owner' for the realtor.
  if coalesce(escrow_access_role(v_invite.escrow_id), '') not in ('owner', 'associate') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_revoked');
  end if;

  -- Revoke the old invite FIRST so the two-per-side trigger never sees a
  -- transient third active row when the side is already at 2/2.
  update invites set revoked_at = now() where id = v_invite.id;

  -- Fresh code, globally unique (DB unique constraint is the backstop).
  loop
    v_code := gen_invite_code();
    begin
      insert into invites (id, code, escrow_id, role, party_name)
      values (v_new_id, v_code, v_invite.escrow_id, v_invite.role, v_invite.party_name);
      exit;
    exception when unique_violation then
      v_attempts := v_attempts + 1;
      if v_attempts >= 5 then
        -- No replacement code could be issued: restore the old invite so the
        -- party is never stranded without a working code.
        update invites set revoked_at = null where id = v_invite.id;
        return jsonb_build_object('ok', false, 'error', 'code_collision');
      end if;
    end;
  end loop;

  update client_links
  set revoked_at = now()
  where invite_id = v_invite.id and revoked_at is null;

  return jsonb_build_object(
    'ok', true,
    'new_code', v_code,
    'new_invite_id', v_new_id,
    'old_code', v_invite.code
  );
end;
$$;
