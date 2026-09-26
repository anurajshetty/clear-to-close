-- 0005_two_per_side_cap.sql
--
-- Invite-client flow (approved Sept 2026):
--  1. Two active clients per escrow side max, enforced authoritatively in the
--     database (local enforcement in the app store is not enough on its own:
--     synced/direct inserts would otherwise bypass it). Only non-revoked
--     invites count, so revoking frees a slot. The cap check takes a
--     per-(escrow, role) advisory transaction lock so two concurrent inserts
--     cannot both slip under the cap.
--  2. regenerate_invite is reordered to revoke-then-insert: it previously
--     inserted the fresh row BEFORE revoking the old one, which the new cap
--     trigger would reject at 2/2. If no fresh code can be issued
--     (code_collision), the old invite is restored, preserving the original
--     safety property that a failed rotation never strands the party without
--     a code.
--
-- (get_client_view has rejected revoked links and revoked parent invites
-- since 0002 — no change needed there.)

-- ---------------------------------------------------------------- cap -----
create or replace function enforce_two_clients_per_side()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Serialize cap checks per escrow+role: without this, two concurrent
  -- inserts could both count 1 active invite and push the side to 3.
  perform pg_advisory_xact_lock(
    hashtextextended('invites_cap:' || new.escrow_id::text || ':' || new.role, 0)
  );
  if (
    select count(*)
    from invites
    where escrow_id = new.escrow_id
      and role = new.role
      and revoked_at is null
  ) >= 2 then
    raise exception 'two clients per side max — revoke one to invite someone new';
  end if;
  return new;
end;
$$;

drop trigger if exists invites_two_per_side on invites;
create trigger invites_two_per_side
  before insert on invites
  for each row
  execute function enforce_two_clients_per_side();

-- --------------------------------- regenerate_invite (revoke-first) ------
-- Same contract as 0002 (ownership check, unique fresh code, old device link
-- killed, same jsonb shape), but the old invite is revoked BEFORE the fresh
-- row is inserted so the cap trigger never observes 3 active rows at 2/2.
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

  -- Ownership: only the escrow's realtor may regenerate its invites.
  if not exists (
    select 1 from escrows e
    where e.id = v_invite.escrow_id and e.user_id = auth.uid()
  ) then
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
