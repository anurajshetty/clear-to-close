-- 0032_invite_side_guard.sql
--
-- NEEDS ANURAJ'S DASHBOARD APPLICATION (Oct 2026) — not yet applied.
--
-- Single-side escrows (Anuraj, Sept 28, 2026: new escrows are buy OR sell;
-- legacy escrows may be 'both'). Belt and suspenders behind the app-level
-- gates (the share screen hides the other side's section and
-- store.createInvite throws on cross-side roles): the server rejects the
-- insert too, so direct API access cannot mint a seller invite on a
-- buy-side escrow or vice versa. The TC role is side-agnostic.
--
-- Also hardens redeem_invite: a legacy cross-side code (minted before this
-- rule) fails redeem with error 'wrong_side' instead of creating a client
-- link for a side the escrow does not have. The app maps 'wrong_side' to
-- "This code is for the other side of the transaction. Ask your realtor
-- for the right code."
--
-- This file re-declares redeem_invite in full, based on 0022_multi_escrow's
-- version (p_device_id + idempotency preserved) with only the side guard
-- added after the name check.
create or replace function enforce_invite_side()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_side text;
begin
  -- TC invites are side-agnostic.
  if new.role = 'tc' then
    return new;
  end if;
  select side into v_side from escrows where id = new.escrow_id;
  if v_side = 'buy' and new.role <> 'buyer' then
    raise exception 'cannot create a % invite on a buy-side escrow', new.role;
  end if;
  if v_side = 'sell' and new.role <> 'seller' then
    raise exception 'cannot create a % invite on a sell-side escrow', new.role;
  end if;
  return new;
end;
$$;

drop trigger if exists invites_side_guard on invites;
create trigger invites_side_guard
  before insert on invites
  for each row
  execute function enforce_invite_side();

create or replace function redeem_invite(p_code text, p_name text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_side text;
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

  -- Cross-side guard (Oct 2026): the invite's role must match the escrow's
  -- side. TC is side-agnostic; 'both' accepts either. A legacy cross-side
  -- code fails here with 'wrong_side' instead of minting a link for a side
  -- the escrow does not have.
  if v_invite.role <> 'tc' then
    select side into v_side from escrows where id = v_invite.escrow_id;
    if (v_side = 'buy' and v_invite.role <> 'buyer')
       or (v_side = 'sell' and v_invite.role <> 'seller') then
      return jsonb_build_object('ok', false, 'error', 'wrong_side');
    end if;
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
    'link_id', v_link_id
  );
end;
$$;
