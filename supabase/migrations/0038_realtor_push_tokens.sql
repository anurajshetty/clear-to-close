-- 0038_realtor_push_tokens.sql
--
-- P0 notification foundations (Oct 15, 2026): authenticated realtors can
-- register their own devices for push. Today push_tokens rows are bound
-- to client links only, so a realtor can receive nothing.
--
-- Security model (auditor's binding requirements, Oct 15, 2026):
--   1. Identity is DERIVED, never supplied: the realtor registration
--      stamps user_id = auth.uid() server-side. No parameter carries a
--      user id anywhere in this migration.
--   2. The two registration streams stay separated by JWT type: the
--      client overloads of register_push_token keep their anon grants
--      and their link-capability model (M1/M2/H3 untouched, byte-for-byte);
--      the realtor registration is a DISTINCT function,
--      register_push_token_for_user (v2, auditor: never an overload),
--      granted to `authenticated` only (with an explicit revoke from
--      public/anon) and additionally checking the JWT role claim
--      in-function. Mode is selected by function + grant, never by a
--      caller-passed flag.
--   3. Uniqueness: one row per (device_id, user_id) for realtor bindings
--      via a PARTIAL unique index alongside the existing
--      (device_id, link_id) client index; an exactly-one-binding CHECK
--      keeps every row either link-bound or user-bound, never both,
--      never neither. The upsert's conflict target names the partial
--      index WITH its predicate (the H3 lesson: a mismatched target is a
--      runtime 42P10).
--   4. One device <-> one realtor at a time: registration first deletes
--      any user-bound rows for the same device_id owned by a DIFFERENT
--      user (account switch on a shared device). One realtor <-> many
--      devices is fine: targeting joins escrows.user_id = tokens.user_id
--      server-side (arrives with P1; P0 registers tokens only).
--   6. Sign-out unregisters: unregister_push_token_for_user() deletes the
--      caller's own device row while still authenticated; the app queues
--      a boot retry if that call fails (see the possession RPC below,
--      PENDING the auditor's ruling on the retry rail).
--   7. M6b interplay: unregister_push_tokens_except_device() deletes all
--      of the caller's user-bound rows EXCEPT the current device's — the
--      app calls it right after a password change's signOut-others, so a
--      device whose session was revoked stops receiving pushes too.
--   8. No other new functions; everything here is authenticated with
--      derived identity or (the one flagged exception) possession-proved.

-- ------------------------------------------------------------ schema --

alter table push_tokens
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Client rows always carry escrow_id + link_id; realtor rows carry
-- neither (their escrow targeting resolves via user_id at send time).
alter table push_tokens alter column escrow_id drop not null;
alter table push_tokens alter column link_id drop not null;

alter table push_tokens
  add constraint push_tokens_exactly_one_binding check (
    (link_id is not null and escrow_id is not null and user_id is null)
    or (link_id is null and escrow_id is null and user_id is not null)
  );

create unique index if not exists push_tokens_device_user_uidx
  on push_tokens (device_id, user_id)
  where user_id is not null;

create index if not exists push_tokens_user_idx
  on push_tokens (user_id)
  where user_id is not null;

-- ------------------------------------------- realtor registration -----

-- Register (or refresh) this device's Expo push token for the SIGNED-IN
-- realtor. Identity comes from auth.uid() — there is deliberately no
-- user-id parameter. Rebinds the device: any other realtor's row for
-- this device_id is deleted first (shared-device account switch), then
-- this realtor's row upserts on the partial unique index.
--
-- v2 (auditor line-level pass, Oct 15 2026): the realtor registration
-- is a DISTINCT function (register_push_token_for_user), never an
-- overload of the client register_push_token — PostgREST resolves
-- overloads by argument shape, and a same-name overload family invites
-- a future signature collision to silently rebind the wrong stream.
-- Every authenticated function in this migration also carries an
-- EXPLICIT revoke from public/anon: Postgres grants EXECUTE to PUBLIC
-- by default, and the wall must not rest on role checks alone.
create or replace function register_push_token_for_user(
  p_device_id text, p_token text, p_timezone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Authenticated stream only (the grant below is the outer wall; this
  -- is the inner one). An anon JWT in this project never carries a uid
  -- (anonymous sign-ins are disabled), and the role claim must be the
  -- authenticated one regardless.
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if nullif(trim(p_device_id), '') is null or nullif(trim(p_token), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- Rebind: this device belongs to at most one realtor at a time.
  delete from push_tokens
  where device_id = trim(p_device_id)
    and user_id is not null
    and user_id <> v_uid;

  insert into push_tokens (escrow_id, device_id, link_id, user_id, expo_push_token, timezone, updated_at)
  values (null, trim(p_device_id), null, v_uid, trim(p_token),
          nullif(trim(coalesce(p_timezone, '')), ''), now())
  on conflict (device_id, user_id) where user_id is not null do update
    set expo_push_token = excluded.expo_push_token,
        timezone = excluded.timezone,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function register_push_token_for_user(text, text, text) from public, anon;
grant execute on function register_push_token_for_user(text, text, text) to authenticated;

-- ------------------------------------------- sign-out unregister ------

-- Drop the SIGNED-IN realtor's token row for THIS device (sign-out,
-- auditor requirement 6). Called by the app during the logout flow
-- while the session is still live, so identity is derived here too.
-- Never touches client-link rows or other devices.
create or replace function unregister_push_token_for_user(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if nullif(trim(p_device_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  delete from push_tokens
  where user_id = v_uid
    and device_id = trim(p_device_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function unregister_push_token_for_user(text) from public, anon;
grant execute on function unregister_push_token_for_user(text) to authenticated;

-- ------------------------------------------- M6b companion prune ------

-- Delete ALL of the signed-in realtor's user-bound token rows EXCEPT
-- this device's (auditor requirement 7). The app calls this right after
-- a password change's signOut({scope: 'others'}) completes: the other
-- sessions are dead, and now their devices stop receiving pushes too.
create or replace function unregister_push_tokens_except_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if nullif(trim(p_device_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  delete from push_tokens
  where user_id = v_uid
    and device_id <> trim(p_device_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function unregister_push_tokens_except_device(text) from public, anon;
grant execute on function unregister_push_tokens_except_device(text) to authenticated;

-- --------------------------- boot retry (PENDING AUDITOR RULING) -------
--
-- Auditor requirement 6: if the authenticated sign-out unregister call
-- fails, the app retries on next boot using device+token possession as
-- proof. At next boot there is no session, so this function is
-- necessarily callable by anon — in tension with requirement 8's "no
-- new anon-executable functions." Proposed resolution (in the diff sent
-- to the auditor; this block ships only if they approve the shape):
-- authorization is possession of TWO unguessable values — the exact
-- (device_id, expo_push_token) pair — and it can delete at most the one
-- user-bound row matching BOTH. Same trust basis as the client model,
-- where the link id is the capability. Returns a bare ok boolean;
-- enumerates nothing.
create or replace function unregister_push_token_for_user_by_possession(
  p_device_id text, p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_device_id), '') is null or nullif(trim(p_token), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  delete from push_tokens
  where user_id is not null
    and device_id = trim(p_device_id)
    and expo_push_token = trim(p_token);

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function unregister_push_token_for_user_by_possession(text, text) to anon, authenticated;
