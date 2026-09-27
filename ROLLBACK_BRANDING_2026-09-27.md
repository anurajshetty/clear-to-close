# Clear to Close — branding release rollback runbook (Sept 27, 2026)

## Rollback point
- Pre-release code: local `4f0a7c1` ("Fix test suite: post-em-dash-sweep regen copy...").
  NOTE: the checkpoint recorded remote/live main as `d527ca8e`; the repo's
  API push workflow squashes the local tree, so remote hashes differ. After
  any push, confirm the remote TREE matches local (`git ls-files -s` vs the
  API tree), not the commit hash.
- Pre-release live bundle: `entry-09519a3e13a369936495a3359ace279e.js`
  (SHA-256 `b4165e706397573c878c7bcfdf8bb303f3ea3256d70a2db44783f7e5f1bd8e98`,
  2,703,979 bytes).

## Dry-run (completed 2026-09-27, no push)
1. `git worktree add /tmp/ctc-rollback 4f0a7c1`
2. `cp .env /tmp/ctc-rollback/.env` (worktrees do NOT carry the gitignored .env)
3. `ln -s ~/workspace/realtor-app/node_modules /tmp/ctc-rollback/node_modules`
4. `npx tsc --noEmit` → clean
5. `npm run export:web -- --clear` → clean, produced
   `entry-171bd1d10174e7fe22f9921574dead77.js`
6. `git worktree remove --force /tmp/ctc-rollback`

## Production rollback sequence (code only; migrations are additive-only and stay)
1. `cd ~/workspace/realtor-app && git checkout -b rollback/branding-2026-09-27 4f0a7c1`
   (or `git reset --hard 4f0a7c1` on main if the release never shipped).
2. Copy `.env` into the tree; `npm run export:web -- --clear`; boot-test
   dist/ under `/clear-to-close` (zero JS errors).
3. Fast-forward `main` to the rollback commit; push via the established
   API method:
   `python3 ~/workspace/skills/github/bin/gh-push.py --repo anurajshetty/clear-to-close --branch main --dir ~/workspace/realtor-app`
   Confirm the API reports `updated main -> <sha>` AND a fresh
   `commits/main` lookup returns the new head; verify the remote tree
   matches local.
4. Redeploy `gh-pages` from the rollback `dist/` WITH an empty `.nojekyll`
   (GitHub Pages Jekyll would 404 every `_expo/...` path otherwise).
5. Verify: live HTML references the rollback bundle; local/live bundle
   bytes identical (compare SHA-256).

## Push kill switch (no deploy needed)
```sql
-- Disable all client push notifications instantly:
update push_config set push_enabled = false;
-- Re-enable:
update push_config set push_enabled = true;
-- Or disable a single trigger without touching the flag:
-- alter table steps disable trigger trg_steps_push_notify;
-- alter table escrows disable trigger trg_escrows_push_notify;
```

## What does NOT need rolling back
- Migrations 0008–0011 are additive-only (new tables/columns, no ALTER/DROP
  of existing objects). Pre-release code ignores the new columns; the
  `isMissingColumnError` fallbacks keep it working. Do NOT roll them back
  destructively.
