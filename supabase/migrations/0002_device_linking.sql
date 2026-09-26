-- Clear to Close — migration 0002: client device linking + DRE/license.
--
-- Approved onboarding/auth (spec §4):
--   * client_links gains device_id (one device per active link) and
--     revoked_at (set when an invite is regenerated or revoked away).
--   * redeem_invite binds the supplied device id at redeem time.
--   * regenerate_invite rotates an invite's code atomically: fresh
--     globally-unique single-use code for the same escrow/role/party, old
--     code revoked and old device link killed in the same transaction.
--   * get_client_view rejects revoked/superseded links so an old device
--     lands on the explicit "this code no longer works" state, never a
--     half-loaded escrow.
--   * realtor_profiles gains dre_license (optional DRE / license number).
--
-- Run AFTER 0001_init.sql. Never edit 0001.

-- ---------------------------------------------------------------- columns --

alter table client_links add column if not exists device_id text;
alter table client_links add column if not exists revoked_at timestamptz;
alter table realtor_profiles add column if not exists dre_license text;

create index if not exists client_links_invite_idx on client_links (invite_id);

-- One device id per live client link: a device may hold at most one
-- unrevoked link. Revoked rows are exempt (history keeps working).
create unique index if not exists client_links_device_live_uidx
  on client_links (device_id)
  where device_id is not null and revoked_at is null;

-- ------------------------------------------------------ invite code maker --

-- Six characters from the no-confusion alphabet (no 0/O/1/I/L).
create or replace function gen_invite_code()
returns text
language plpgsql
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_i int;
begin
  for v_i in 1..6 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
  end loop;
  return v_code;
end;
$$;

-- --------------------------------- redeem_invite (now binds the device) --

-- Replaces the 2-arg version from 0001 (dropped below). Same single-use,
-- name-bound semantics, plus p_device_id binding for 0002 device linking.
-- p_device_id may be null for older clients; the link still redeems.
create or replace function redeem_invite(p_code text, p_name text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_link_id uuid := gen_random_uuid();
begin
  select * into v_invite
  from invites
  where code = upper(trim(p_code));

  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  if v_invite.redeemed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  if lower(trim(v_invite.party_name)) <> lower(trim(p_name)) then
    return jsonb_build_object('ok', false, 'error', 'name_mismatch');
  end if;

  update invites
  set redeemed_at = now()
  where id = v_invite.id and redeemed_at is null;

  if not found then
    -- Lost the race to another redemption of the same code.
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  insert into client_links (id, escrow_id, invite_id, role, party_name, device_id)
  values (v_link_id, v_invite.escrow_id, v_invite.id, v_invite.role, v_invite.party_name, nullif(trim(p_device_id), ''));

  return jsonb_build_object(
    'ok', true,
    'escrow_id', v_invite.escrow_id,
    'role', v_invite.role,
    'party_name', v_invite.party_name,
    'link_id', v_link_id
  );
end;
$$;

drop function if exists redeem_invite(text, text);
grant execute on function redeem_invite(text, text, text) to anon, authenticated;

-- --------------------------------- regenerate_invite (atomic rotation) --

-- Realtor-only (ownership checked via auth.uid()). In ONE transaction:
--   1. mint a fresh, globally-unique single-use code for the same
--      escrow/role/party,
--   2. revoke the old invite (kills the old code),
--   3. kill the old invite's device link (old devices land on the dead-link
--      state via get_client_view below).
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
        return jsonb_build_object('ok', false, 'error', 'code_collision');
      end if;
    end;
  end loop;

  update invites set revoked_at = now() where id = v_invite.id;

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

grant execute on function regenerate_invite(uuid) to authenticated;

-- --------------------------------- get_client_view (link validation) --

-- Same shape as 0001, plus: revoked links — and links whose invite was
-- revoked (regenerated away) — return ok:false 'revoked', so the client
-- device shows "this code no longer works" instead of a stale escrow.
-- The dre_license column now ships in the realtor profile payload.
create or replace function get_client_view(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
  v_escrow jsonb;
  v_steps jsonb;
  v_profile jsonb;
  v_invite_revoked timestamptz;
begin
  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  select revoked_at into v_invite_revoked from invites where id = v_link.invite_id;
  if v_invite_revoked is not null then
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

grant execute on function get_client_view(uuid) to anon, authenticated;
