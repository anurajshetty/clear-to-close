-- 0045 — escrows SELECT policy: tuple-visible owner disjunct.
--
-- Incident (Oct 22, 2026): escrow CREATE has failed with SQLSTATE
-- 42501 for every account since migration 0044 shipped. Live evidence:
-- POST /rest/v1/escrows upserts from correctly authenticated owners
-- (JWT uid = the account's own uid, body user_id correct) rejected
-- with "new row violates row-level security policy for table
-- escrows", while reads, updates of existing escrows, invites, and
-- profile saves all kept working.
--
-- Root cause (reproduced on the disposable chain with the exact
-- PostgREST statement shape): PostgREST upserts run
-- INSERT ... ON CONFLICT ... RETURNING, and Postgres applies the
-- SELECT policy to the returned rows. 0044's escrows_select resolves
-- access through escrow_access_role(id), whose internal table scan
-- cannot see the row the current statement is inserting (statement
-- snapshot semantics), so the function returns NULL for a brand-new
-- row and the RETURNING check rejects the insert. Committed rows are
-- unaffected — the function sees them normally — which is why only
-- CREATE broke. Oct 21's create failures were doubly determined:
-- the identity bug stamped a wrong user_id (a genuine WITH CHECK
-- failure), masking this defect behind it.
--
-- Fix: add the tuple-visible owner disjunct
--   user_id = auth.uid()
-- which is exactly the set escrow_access_role reports as 'owner',
-- so the visible row set for every committed row is unchanged; the
-- disjunct only lets the row being inserted satisfy the RETURNING
-- check on its own tuple. Verified on the disposable chain: new-row
-- upsert+RETURNING succeeds; a stranger still cannot select the row,
-- conflict-upsert it, or insert a row under another uid; the 0044
-- team-access matrix (47 checks) still passes in full.
--
-- No new tables are created, so the standing explicit-GRANT rule
-- (Oct 20, 2026) has nothing to attach to; this is a policy-only
-- change. No data is touched.

drop policy if exists escrows_select on escrows;
create policy escrows_select on escrows
  for select to authenticated
  using (user_id = auth.uid() or escrow_access_role(id) is not null);
