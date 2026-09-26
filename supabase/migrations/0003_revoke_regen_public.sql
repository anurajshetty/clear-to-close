-- Clear to Close — migration 0003: lock down regenerate_invite to authenticated.
--
-- 0002 granted EXECUTE to authenticated, but Postgres grants new functions to
-- PUBLIC by default, leaving anon able to CALL regenerate_invite. Its
-- ownership check (escrows.user_id = auth.uid()) still blocks any mutation
-- for anon callers, but the spec is realtor-only, so we revoke PUBLIC here.

revoke execute on function regenerate_invite(uuid) from public;
