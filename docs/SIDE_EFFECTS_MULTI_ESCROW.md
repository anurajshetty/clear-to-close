# Multi-escrow side-effect pass (Sept 29, 2026)

Anuraj's standing rule (Sept 28, 2026): every change ships with an explicit
side-effect pass — enumerate everything the action touches and handle each
one. Findings are labeled CONFIRMED (evidence) or ASSUMED (confidence +
what would confirm/refute). CONFIRMED evidence here means: a unit test in
`tests/` that fails without the fix and passes with it, plus the static
migration check where SQL is involved. No browser/UI tests were run
(Anuraj's explicit direction: he does UI testing himself).

## Surface 1: Revoke an invite (per escrow)

Touch points: `client_invites.revoked_at`, the device link for that
(escrow, device), the push-token row for that link, the client home, the
boot router, the link gate, the escrows list row.

- Revoking escrow A's invite kills only escrow A's server link row; escrow
  B's link keeps validating. CONFIRMED:
  `tests/multi_escrow.test.ts` revokes A's invite and asserts B's
  `validateClientLink` stays valid while A's dies.
- On the device, the gate for escrow A's screen removes ONLY escrow A's
  link and unregisters ONLY escrow A's push-token row, then routes to
  `/link-dead`. Escrow B's link and token row are untouched. CONFIRMED:
  per-link unregister assertions in `tests/multi_escrow.test.ts` and the
  dead-link isolation behavior in `src/hooks/useClientLinkGate.ts`.
- `/link-dead` offers "Enter the new code" and "Back to my escrows" when
  other links remain — it never wipes the device's other escrows.
  CONFIRMED by code path review; UI copy/behavior NOT visually verified
  (assumption: low risk, see Surface 12).

## Surface 2: Regenerate a code (per escrow)

Touch points: the old invite row (killed), the old device link (killed),
the new invite row, the re-redeem on the old device, other escrows' links.

- Regeneration is atomic: old code dies and the old link dies at the same
  moment the new code is issued (pre-existing trigger behavior, unchanged).
  The kill targets the link for that invite's escrow only. ASSUMED for the
  new SQL text — the static migration check pins the unique index and the
  RPC signatures, but the trigger interaction was not re-exercised against
  a live database. Confidence: high; the trigger logic was untouched by
  0022 and the pre-existing revoke tests still pass.
- The old device lands on `/link-dead` with the party name pre-filled
  ("Enter the new code"); re-redeeming the fresh code replaces the
  per-escrow link (same escrow id, new link id) — no duplicate, no effect
  on the device's other escrows. CONFIRMED at the app layer:
  `auth.addClientLink` replaces by escrow id (tests/auth.test.ts).

## Surface 3: Close an escrow (per escrow)

Touch points: escrow status, per-side close timestamps, all invites for the
escrow, all links for the escrow, key-dates lock, client view state.

- Closing escrow A revokes its invites and links; escrow B on the same
  device keeps its links and keeps rendering. CONFIRMED:
  `tests/multi_escrow.test.ts` closes A and asserts B's validation and
  view are untouched; the lifecycle suites still pin close-revoke behavior.
- The escrows list sorts closed escrows second, dimmed and read-only.
  CONFIRMED: `tests/escrow_list.test.ts` (ordering + read-only flags).
- ASSUMED: the live server's close trigger kills links the way the mock
  does — the mock was updated to the new contract in this commit
  (see LEARNINGS.md).

## Surface 4: Cancel an escrow (per escrow)

Same touch points as close. Cancelling A kills only A's server link;
B's link validates and opens normally. CONFIRMED:
`tests/multi_escrow.test.ts` cancel-isolation assertions.

## Surface 5: Activate (reactivate) an escrow

Touch points: status flip, per-side close timestamps cleared, links,
invites, steps, key dates.

- Reactivation flips status and clears close timestamps; it never writes
  steps, invites, links, or key dates. The device's per-escrow link set is
  untouched — escrow A reactivating does not resurrect or create links,
  and does not touch escrow B. CONFIRMED: the pre-existing
  `tests/update_closed_lifecycle.test.ts` invariants still pass; the
  multi-escrow suite pins that other-escrow links are untouched by any
  single-escrow lifecycle op.

## Surface 6: Deal-list state per link

The realtor deal list is per-account, unchanged. For clients, the escrows
list badge/progress derives from each escrow's own view (progress ring from
the per-escrow checklist). CONFIRMED: `src/lib/escrowList.ts` builds rows
from per-escrow views; no shared counters. ASSUMED: the rendered progress
ring matches the design (not visually verified — Anuraj's call).

## Surface 7: Refresh / subscription identity per escrow

Touch points: cloud-view caches, foreground refresh, link gate
revalidation, pull-to-refresh.

- Views, profiles, and key dates are cached per escrow id
  (`cloudViewCache` keyed by escrow, `getLinkedProfile(escrowId)`).
  CONFIRMED: `tests/multi_escrow.test.ts` fetches A and B views and
  asserts the caches and profiles are distinct and correct.
- Foreground revalidation validates each screen's own link only; a dead
  link on screen A never triggers a global re-login or a global cache
  clear. CONFIRMED by code path (`useClientLinkGate` scoped to
  `escrowId`); the mock covers validation per link id.

## Surface 8: Per-role, per-realtor branding

Touch points: profile photo/banner, realtor name, teal initials fallback,
escrow list rows, invite welcome, celebration card.

- Branding resolves per escrow: the list row and each escrow home use the
  profile cached for that escrow id. Two escrows from two realtors show two
  different names/photos; nothing bleeds. CONFIRMED:
  `tests/multi_escrow.test.ts` seeds distinct realtor profiles per escrow
  and asserts `getLinkedProfile` returns the right one for each.
- Teal-initials fallback when no photo: exercised in the row component;
  visual rendering ASSUMED (no browser test).

## Surface 9: Offline redeem

Touch points: redeem RPC, local link storage, error copy.

- Redeem stays RPC-authoritative: offline or unreachable server returns a
  retryable `network` error; the app NEVER mints a local link as fallback
  and never shows unconfirmed access. CONFIRMED: `tests/syncedstore.test.ts`
  offline-redeem assertions still pass; `RedeemResult` no longer carries
  any local-mint path. `unexpected RPC 23505` maps to retryable `network`
  in `src/lib/cloudSync.ts`.

## Surface 10: Concurrent redeem races

- Same code + same device, concurrent: the unique index on live
  `(device_id, escrow_id)` plus the race branch in `redeem_invite` returns
  the ONE existing link to both callers (`reused: true`), no duplicate
  row. CONFIRMED structurally: `tests/multi_escrow_migration.py` pins the
  re-check branch, the `v_link.id` return, and the `already_used`
  fallback. ASSUMED under real Postgres concurrency — reasoned from
  `SELECT ... WHERE redeemed_at IS NULL` + partial unique index semantics;
  would be confirmed by a live-DB concurrency test (not run here).
- Different codes (different escrows), same device, concurrent: each
  escrow gets its own link; the `unique_violation` backstop catches the
  cross-code race. CONFIRMED at the mock layer
  (`tests/multi_escrow.test.ts`); static SQL check pins the backstop.

## Surface 11: Link-scoped push tokens

Touch points: `register_push_token`, `push_tokens` rows, unregister on
link death, full opt-out, PushGate.

- The same Expo token registers once PER LINK (upsert on
  `(device_id, link_id)`); adding escrow B does not clobber escrow A's
  row. CONFIRMED: `tests/multi_escrow.test.ts`.
- Link death unregisters that link's row only
  (`unregister_push_token_for_link`); the other escrow keeps receiving
  pushes. CONFIRMED: mock models per-link rows, assertions in the suite.
- Full opt-out / realtor login still clears everything device-wide
  (existing `unregisterPushToken` path, unchanged). CONFIRMED by existing
  push tests.
- ASSUMED: real-device push delivery per link — the app-side send path
  lives in a separate worktree (push-notification plumbing); this branch
  only defines the storage/lifecycle contract.

## Surface 12: No cross-realtor / cross-escrow leakage

- `getClientLinkForEscrow` returns only the matching escrow's link; list
  rows, views, profiles, push rows, and lifecycle kills are all keyed by
  escrow id. CONFIRMED: `tests/multi_escrow.test.ts` "no cross-realtor
  leakage" block — B's realtor profile never appears on A's surfaces and
  vice versa; revokes/cancels are per-escrow.
- Legacy single-link devices: `getClientLinks` migrates `ctc:clientlink`
  into the set on first read (one entry, correct escrow). CONFIRMED:
  `tests/auth.test.ts` migration tests.

## Residual assumptions (all low-to-medium risk)

1. Migration 0022 applies cleanly to a live DB and behaves as the static
   checks claim (Anuraj or the coordinator applies it; SQL pasted
   contract applies: it must be right the first time — re-read the file
   before pasting).
2. UI renders as approved (Anuraj hand-tests; engineering ran unit tests
   only per his standing bar).
3. iOS and web stay in lockstep — verified by identical source + both
   exports green (run below), native binary rebuild is Anuraj's step.
