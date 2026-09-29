-- Clear to Close — migration 0022: multi-escrow client device links.
--
-- Approved (Anuraj, Sept 28, 2026): one device may hold live links to MANY
-- escrows.
--
--   1. Device linking: the 0002 one-live-link-per-device index becomes
--      one-live-link-per-(device, escrow). Uniqueness on
--      (device_id, escrow_id) where the link is live (device_id present,
--      revoked_at null). Same device + same escrow never duplicates a row.
--   2. redeem_invite: redeeming an invite for an escrow this device already
--      links to returns the EXISTING link (idempotent re-redeem), including
--      under concurrent redeems — the new index is the race backstop: the
--      loser's insert hits unique_violation and returns the winner's link
--      instead of failing. Two concurrent redeems of the same code on the
--      same device still mint exactly one link (the redeemed_at race guard
--      is unchanged).
--   3. Push tokens are link-scoped: one row per (device_id, link_id). The
--      old device-wide unique index made a second redeem OVERWRITE the
--      first escrow's token row, silently killing its pushes. The
--      register_push_token upsert targets (device_id, link_id) now.
--   4. unregister_push_token_for_link: dropping one dead link's token must
--      not kill the device's other escrows' tokens.
--
-- revoke / regenerate / close / cancel keep their per-invite/per-escrow
-- semantics — untouched by this migration (the convergence paths already
-- scope by invite_id / escrow_id).
--
-- Additive-safe for reads: no table or column is dropped. Index-only
-- changes plus create-or-replace functions.

-- --------------------------------------- 1. (device_id, escrow_id) index --

-- The old one-live-link-per-device index: gone. A device may hold many
-- live links now, exactly one per escrow.
drop index if exists client_links_device_live_uidx;

create unique index if not exists client_links_device_escrow_live_uidx
  on client_links (device_id, escrow_id)
  where device_id is not null and revoked_at is null;

-- ----------------------------------------- 2. idempotent redeem_invite --

-- Same single-use, name-bound semantics as 0002, plus multi-escrow
-- idempotency: a live link for (device, escrow) is returned as-is instead
-- of minting a duplicate — whether the client re-redeems the same escrow
-- with a fresh code, or two redeems race each other.
create or replace function redeem_invite(p_code text, p_name text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_device text := nullif(trim(p_device_id), '');
  v_link client_links%rowtype;
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

  -- The name check still runs FIRST: a stray code with the wrong name never
  -- rides an existing link for this escrow.
  if lower(trim(v_invite.party_name)) <> lower(trim(p_name)) then
    return jsonb_build_object('ok', false, 'error', 'name_mismatch');
  end if;

  -- Multi-escrow idempotency: this device already holds a live link for
  -- this escrow — return it, mint nothing.
  if v_device is not null then
    select * into v_link
    from client_links
    where device_id = v_device
      and escrow_id = v_invite.escrow_id
      and revoked_at is null
    limit 1;
    if found then
      return jsonb_build_object(
        'ok', true,
        'escrow_id', v_link.escrow_id,
        'role', v_link.role,
        'party_name', v_link.party_name,
        'link_id', v_link.id,
        'reused', true
      );
    end if;
  end if;

  if v_invite.redeemed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  update invites
  set redeemed_at = now()
  where id = v_invite.id and redeemed_at is null;

  if not found then
    -- Lost the race to another redemption of the same code. The winner's
    -- transaction inserts a live link for this (device, escrow) — or it was
    -- the re-redeem path of another caller on this device. Either way, when
    -- a live link for this (device, escrow) exists, this caller joins it:
    -- two concurrent same-code/same-device redeems resolve to ONE link.
    select * into v_link
    from client_links
    where device_id = v_device
      and escrow_id = v_invite.escrow_id
      and revoked_at is null
    limit 1;

    if found then
      return jsonb_build_object(
        'ok', true,
        'escrow_id', v_link.escrow_id,
        'role', v_link.role,
        'party_name', v_link.party_name,
        'link_id', v_link.id,
        'reused', true
      );
    end if;

    -- No live link for this (device, escrow): the other caller won with a
    -- different escrow or its transaction rolled back — the code is spent.
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  -- Race backstop: two concurrent redeems of DIFFERENT codes for the same
  -- escrow on the same device both pass the check above; exactly one
  -- insert wins, the loser returns the winner's link.
  begin
    insert into client_links (id, escrow_id, invite_id, role, party_name, device_id)
    values (v_link_id, v_invite.escrow_id, v_invite.id, v_invite.role, v_invite.party_name, v_device);
  exception when unique_violation then
    select * into v_link
    from client_links
    where device_id = v_device
      and escrow_id = v_invite.escrow_id
      and revoked_at is null
    limit 1;
    if found then
      return jsonb_build_object(
        'ok', true,
        'escrow_id', v_link.escrow_id,
        'role', v_link.role,
        'party_name', v_link.party_name,
        'link_id', v_link.id,
        'reused', true
      );
    end if;
    -- A conflict we cannot explain is a server problem, never a bad code.
    return jsonb_build_object('ok', false, 'error', 'network');
  end;

  return jsonb_build_object(
    'ok', true,
    'escrow_id', v_invite.escrow_id,
    'role', v_invite.role,
    'party_name', v_invite.party_name,
    'link_id', v_link_id,
    'reused', false
  );
end;
$$;

drop function if exists redeem_invite(text, text);
grant execute on function redeem_invite(text, text, text) to anon, authenticated;

-- ---------------------------------------------- 3. link-scoped push tokens --

-- One live token per (device, link): a second redeem on the same device
-- adds a row instead of overwriting the first escrow's token.
drop index if exists push_tokens_device_uidx;

create unique index if not exists push_tokens_device_link_uidx
  on push_tokens (device_id, link_id);

-- Register (or refresh) this device's Expo push token for one client link.
-- The link must exist and be live (not revoked); a revoked link's device
-- can never receive pushes.
create or replace function register_push_token(p_link_id uuid, p_device_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
begin
  if nullif(trim(p_device_id), '') is null or nullif(trim(p_token), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  -- An invite revoked (regenerated away) kills the link's pushes too.
  if exists (select 1 from invites where id = v_link.invite_id and revoked_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  -- Link-scoped upsert: refreshing this link's token never touches the
  -- device's other escrows' rows.
  insert into push_tokens (escrow_id, device_id, link_id, expo_push_token, updated_at)
  values (v_link.escrow_id, trim(p_device_id), p_link_id, trim(p_token), now())
  on conflict (device_id, link_id) do update
    set escrow_id = excluded.escrow_id,
        expo_push_token = excluded.expo_push_token,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function register_push_token(uuid, text, text) to anon, authenticated;

-- ------------------------------------------------ 4. per-link token drop --

-- Drop ONE link's token (dead link removal). The device-wide
-- unregister_push_token(text) still exists for start-over / opt-out; this
-- one never touches the device's other escrows.
create or replace function unregister_push_token_for_link(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from push_tokens where link_id = p_link_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function unregister_push_token_for_link(uuid) to anon, authenticated;
