-- 0005_two_per_side_cap_and_revoke_kills_access.sql
--
-- Invite-client flow (approved Sept 2026):
--  1. Two active clients per escrow side max, enforced authoritatively in the
--     database (local enforcement in the app store is not enough on its own:
--     synced/direct inserts would otherwise bypass it). Only non-revoked
--     invites count, so revoking frees a slot — and regenerate_invite (which
--     revokes the old row and inserts a fresh one) never consumes a slot.
--  2. Revoking an invite must kill any linked client access, not merely block
--     future redemption. get_client_view is the cloud authority behind
--     validateClientLink: it now rejects revoked links and links whose invite
--     is revoked, so a revoked client lands on the "this code no longer
--     works" state instead of loading the escrow.

-- ---------------------------------------------------------------- cap -----
create or replace function enforce_two_clients_per_side()
returns trigger
language plpgsql
set search_path = public
as $$
begin
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

-- ------------------------------------------------------- revoke access -----
create or replace function get_client_view(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
  v_invite invites%rowtype;
  v_escrow jsonb;
  v_steps jsonb;
  v_profile jsonb;
begin
  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- A revoked invite kills any linked client access: the old device lands on
  -- "this code no longer works", never a stale or blank escrow view.
  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  select * into v_invite from invites where id = v_link.invite_id;
  if found and v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  select to_jsonb(e) into v_escrow from escrows e where e.id = v_link.escrow_id;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
  into v_steps
  from steps s
  where s.escrow_id = v_link.escrow_id and s.role = v_link.role;

  select to_jsonb(p) into v_profile
  from realtor_profiles p
  where p.user_id = (select e.user_id from escrows e where e.id = v_link.escrow_id);

  if v_link.role = 'buyer' then
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'buyer_steps', v_steps,
      'profile', v_profile
    );
  else
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'seller_steps', v_steps,
      'profile', v_profile
    );
  end if;
end;
$$;
