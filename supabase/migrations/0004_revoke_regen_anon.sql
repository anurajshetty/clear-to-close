-- Clear to Close — migration 0004: explicit anon revoke on regenerate_invite.
--
-- 0003 revoked EXECUTE from public (which covers anon via role membership),
-- and the live project already ran 0003. The direct anon revoke was applied
-- live on the dashboard afterwards; this later migration reproduces it in
-- the repo chain without rewriting the historical 0003.
-- Historical migrations are never edited (project standing rule).

revoke execute on function regenerate_invite(uuid) from anon;
