-- 0037_unregister_push_token_device_binding.sql
--
-- M2 staged lockstep, STAGE 1 (DB, backward-compatible) — Oct 1, 2026.
--
-- Context: unregister_push_token_for_link(p_link_id uuid) (0022) deletes a
-- link's push-token rows on presentation of link_id alone (bearer-only): any
-- caller that knows a link id can silence another device's pushes for that
-- escrow. The delete must be bound to the device/link pair, but the app and
-- the DB ship separately, so this rolls out in stages.
--
-- STAGE 1 (this migration): add an OPTIONAL p_device_id (default null).
-- When the caller supplies a device id AND the link has a bound device_id
-- that differs, the delete is rejected (no-op). When p_device_id is null
-- (old app versions), or the link has no bound device (legacy links), or the
-- ids match, behavior is unchanged: the link's token rows are deleted.
--
-- STAGE 2 (app): unregisterPushTokenForLink passes auth.getDeviceId() as
-- p_device_id. STAGE 3 (later, separate SQL, NOT this file): tighten the
-- function to reject when p_device_id is null — only after the Stage 2 app
-- is live on all surfaces.
--
-- Why DROP first: the new signature (uuid, text) differs from the old one
-- (uuid). CREATE OR REPLACE with a different argument list would NOT replace
-- the old function — it would create a second overload, leaving the
-- bearer-only 1-arg version live. DROP-then-CREATE keeps exactly one
-- function; the DEFAULT NULL keeps old 1-arg callers working.

drop function if exists unregister_push_token_for_link(uuid);

create function unregister_push_token_for_link(p_link_id uuid, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bound_device text;
begin
  -- The link's bound device (0002 device linking). NULL for legacy links
  -- minted before device binding existed.
  select device_id into v_bound_device
  from client_links
  where id = p_link_id;

  -- M2 device binding: when the caller identifies its device and the link
  -- is bound to a DIFFERENT device, reject the delete. A caller that cannot
  -- name the bound device cannot silence another device's pushes.
  if p_device_id is not null
     and v_bound_device is not null
     and v_bound_device <> p_device_id then
    return jsonb_build_object('ok', false, 'reason', 'device_mismatch');
  end if;

  -- Otherwise: current behavior (old apps pass no device id; legacy links
  -- have no bound device; matching device passes the check above).
  delete from push_tokens where link_id = p_link_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function unregister_push_token_for_link(uuid, text) to anon, authenticated;
