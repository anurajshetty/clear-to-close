# Clear to Close — Sync Conflict Rules

Set by Anuraj, Sept 27, 2026. Implements ARCHITECTURE.md principle 5
("Designed conflict rules"): every situation where two writers can
disagree gets an explicit, documented resolution rule. "Whichever syncs
first wins" is never acceptable.

The only two writers in this system are the realtor's own devices
(RLS owner-policies: every row belongs to exactly one `auth.uid()`).
There are no realtor-vs-realtor or realtor-vs-client write conflicts —
clients never write; client views are read-only server snapshots.

## The arbiter

**Last committed push wins, with the server's commit order as the
arbiter.** Pushes are whole-row (profile) or whole-unit (escrow + full
step set) upserts; Postgres serializes them, so the last committed write
is the truth. A pull always converges a clean local snapshot to the
server row — never the reverse.

Note on timestamps: `realtor_profiles.updated_at` exists but has no
update trigger (it records insert time), and `escrows` / `steps` /
`invites` have no `updated_at` at all — so wall-clock timestamps are NOT
the arbiter today. If per-row recency ever needs to be auditable on the
server, add `updated_at` + bump triggers in a new migration (Anuraj runs
migrations on the dashboard). Until then, commit order rules and the
conflict log below is the audit trail.

## Rules

### 1. Profile — last committed push wins; server row is always the truth

- Writers: the realtor's devices.
- A pull (`pullProfileFromCloud`, boot; `refreshProfile`, foreground)
  replaces a clean local snapshot with the server row unconditionally.
- A dirty local snapshot (an explicit Save whose push is in flight or
  queued) is NEVER overwritten by a pull — the unconfirmed user intent
  is itself a pending write; once its push confirms, it becomes the new
  "last write".
- Code: `convergeProfileFromCloud` in `src/lib/syncedStore.ts`.
- Test: `tests/conflict_rules.test.ts` — "profile: last committed push wins".

### 2. Escrows — last committed push wins for the whole escrow unit

- Writers: the realtor's devices.
- One escrow + its full buyer/seller step set is ONE write unit:
  `pushEscrowNow` upserts the escrow row and every step; a pull replaces
  the whole unit. There is no per-field merge.
- Sharp edge (documented, accepted): a stale device's push can revert
  another device's newer change — e.g. device A checks a step, device B
  (which hadn't pulled yet) edits the address; B's unit wins and the
  check-off is reverted on the server. The window is bounded by
  foreground-pull frequency, both writers are the same human, and the
  resolution is logged (below).
- Dirty units (in-flight/queued `pushEscrow`) are never overwritten by a
  pull.
- Code: `pullEscrowsFromCloud`, `pushEscrowNow`.
- Test: `tests/conflict_rules.test.ts` — "escrow: last committed unit push wins".

### 3. Steps — state follows the escrow unit's last committed push

- Steps are not independent writers: a step's `done` state is part of
  its parent escrow's write unit. The step state on the server is
  whatever the last committed escrow-unit push carried — including a
  stale device's push reverting a newer check-off (same sharp edge as
  rule 2).
- `completed_at` records the latest check-off; unchecking clears the
  state in the next unit push. There is no per-step last-write-wins.
- Code: `pushEscrowNow` (upserts all steps), `toggleStep` / `reorderSteps`
  / `addCustomStep` (each rewrites the unit and pushes it).
- Test: `tests/conflict_rules.test.ts` — "steps follow the unit's last committed push".

### 4. Invites — terminal states are write-once and monotonic

- Invite lifecycle is a state machine, not last-write-wins:
  `created -> redeemed` or `created -> revoked`. `redeemed_at` /
  `revoked_at`, once set, are NEVER cleared by any client merge.
- The server refuses redeem-after-revoke: the `redeem_invite` RPC
  returns `revoked` when `revoked_at is not null` (migration
  `0002_device_linking.sql`). First terminal transition wins.
- Revoke is idempotent (`pushRevokeNow` updates `revoked_at`; re-pushes
  are harmless). The outbox drain re-pushes queued revokes until one
  lands — a revoke is never silently dropped.
- Client merge (`mergeInvites`) only inserts missing invites and fills
  in `revoked_at` / `redeemed_at` from the server; it never overwrites
  user fields (code, party, role) and never clears a timestamp.
- Code: `mergeInvites` in `src/lib/store.ts`, `redeem_invite` RPC,
  `pushRevokeNow` in `src/lib/cloudSync.ts`.
- Test: `tests/conflict_rules.test.ts` — "invites: terminal states are write-once".

## Audit log

Every pull that resolves a genuine two-writer divergence in the
server's favor appends to the `ctc:conflict-log` KV ring buffer
(cap 50, newest last): `{ at, entity, id, resolution: 'server-wins',
detail }`. Read it with `readConflictLog(kv)` from
`src/lib/cloudSync.ts`. Best-effort diagnostics — it never blocks sync.
Identical snapshots are not logged (a pull that changes nothing is not
a conflict).
