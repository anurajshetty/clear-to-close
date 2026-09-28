# Synchronous-write side-effect matrix (Anuraj, Sept 28, 2026)

Every user-initiated write is a **synchronous server-first confirmed
write**: the server effect runs inside an awaited, timed server effect;
the local cache commits ONLY after the server confirms. Any failure
(network, timeout, server rejection, missing session) throws a
plain-language error and leaves local state **byte-identical** — the
persisted KV dump before and after a failed write is equal (pinned by
tests). No user action creates an outbox entry; the outbox is retired
(one final legacy drain on upgrade, then gone).

Cross-cutting rules (apply to every row below unless the row says otherwise):

- **Timeout**: 15s per write (`WRITE_TIMEOUT_MS`); 30s for profile-with-media,
  cancel, and close (`WRITE_TIMEOUT_LONG_MS`); redeem 8s; resolve 8s;
  createInvite's server prefetch is separately bounded at 4s.
- **Offline**: "Couldn't reach the server. Your change was not saved. Check
  your connection and try again." Local unchanged.
- **Server rejection**: "The server refused the update. Your change was not
  saved." Local unchanged.
- **Timeout**: same copy as offline. Local unchanged.
- **Missing session / unconfigured**: "Couldn't save. You're signed out or
  the cloud isn't set up. Sign in and try again." Nothing committed.
- **Crash before confirmation**: local unchanged (the preview was never
  committed).
- **Crash after confirmation, before local commit**: the next pull heals —
  the pull rebuilds escrow rows, step lists, invite states, and the profile
  from server truth.
- **Partial server success** (multi-step effects like cancel/close are
  sequential, NOT one DB transaction): local stays unchanged, the user
  still sees the pre-action state, and retry re-runs the idempotent steps
  to convergence. The next pull also converges.
- **Concurrency**: all confirmed writes AND pull merges serialize through
  one exclusive gate; a pull that fetched before a commit skips the written
  rows (commitSeq guard). A pull never clobbers an in-flight write's result.
- **Outbox invariant**: no write in this matrix creates a `ctc:outbox` entry
  (pinned per-write by tests asserting `readOutboxOps` is empty afterwards).
- **Push notifications**: none are sent by any write in this matrix today
  (push-on-checkoff is a queued future epic). Structural edits never notify.

---

## 1. saveProfile (profile form: name, email, phone, Broker, about, years, areas, license, photo, banner)

- **Server rows**: `realtor_profiles` row upserted. Changed photo/banner uploaded
  to UNIQUE per-upload Storage paths (`<uid>/photo-<id>.jpg`,
  `<uid>/banner-<id>.jpg`) — never overwrites a live file; a row failure
  orphans an unreferenced object instead of changing what clients see.
- **Local cache**: profile snapshot replaced only after confirmation. The
  device-local managed files for removed kinds are deleted only after
  confirmation (a failed save keeps them, so a retry still has its upload
  source). Upload fingerprints (`ctc:media-uploaded`) marked only after the
  row confirms, so a retry re-uploads instead of skipping to a stale URL.
- **Invite codes / device links**: untouched.
- **Progress/counts**: untouched.
- **Active/Closed/Cancelled**: untouched.
- **Realtor views**: profile page shows the new data; the top card / branding
  on share screens uses the confirmed row.
- **Buyer/seller/TC views**: client-visible branding (name, photo, Broker)
  comes from `get_client_view` on the confirmed row — clients see the old
  branding until the save confirms, never a half-saved mix.
- **Media-removal ordering** (the safety property): phase 1 nulls the URLs on
  the preview draft only (no server side effects); uploads go to unique
  paths; the row upserts carrying nulled + new URLs; phase 2 deletes the
  removed Storage files ONLY after the row confirmed. A delete failure
  throws — the row is already nulled (clients correct), the next pull heals
  local, and the failure surfaces loudly instead of reporting success.
- **Failure**: any upload/row/delete failure throws; local profile (and the
  displayed photo/banner) unchanged; the form shows the error inline and
  keeps the draft.
- **Legacy**: `writePendingMediaRemovals` has no callers; the drain only
  reads/clears flags the retired model left behind.

## 2. createEscrow

- **Server rows**: `escrows` row upserted; all default step rows upserted.
- **Local cache**: new escrow appended on confirmation.
- **Invite codes / device links**: none yet.
- **Progress/counts**: deal counts recompute from the committed list.
- **Placement**: Active (status open).
- **Realtor views**: deal list shows the new card; detail screen opens.
- **Client views**: nothing until an invite is created and redeemed.
- **Failure**: throws; no local escrow; no server row (or the row exists
  from a partial failure and the next pull converges it locally).

## 3. updateEscrow (address/dates edit) / updateTargetDate / activateEscrow

- **Server rows**: `escrows` row upserted (target date is a column on the row).
- **Local cache**: row replaced on confirmation.
- **Invite codes / device links**: untouched.
- **Progress/counts**: timeline/pace recompute from confirmed dates.
- **Placement**: updateTargetDate never moves placement. activateEscrow moves
  a closed/cancelled escrow back to Active with the supplied dates.
- **Realtor views**: detail header/dates update.
- **Client views**: time-tracker card dates come from the confirmed row.
- **Failure**: throws; dates on screen stay as before.

## 4. toggleStep (check/uncheck one step)

- **Server rows**: `escrows` row upserted (last_action stamp); all step rows
  upserted (done/completed_at/position).
- **Local cache**: step flipped on confirmation; `completedAt` stamped on
  check, cleared on uncheck.
- **Invite codes / device links**: untouched.
- **Progress/counts**: done/total recompute; the LATEST FROM card's
  "Checked off {step}" / "Reopened {step}" stamps from `last_action`.
- **Placement**: unchecking a step on a closed side reopens THAT side only
  (buyerClosedAt/sellerClosedAt cleared); escrow-level status re-derives.
- **Realtor views**: step row animates; progress ring updates.
- **Buyer/seller views**: read-only checklist reflects the confirmed state on
  next view/pull; the 4h JUST NOW marker derives from the confirmed
  completedAt.
- **Failure**: throws; the checkbox stays as it was; no phantom check.

## 5. addCustomStep / reorderSteps

- **Server rows**: same as toggleStep (escrow row + all step rows upserted).
- **Local cache**: step appended / order rewritten on confirmation.
- **Client views**: custom steps render like any other step on client views
  (no Custom tag there); the realtor view keeps the Custom tag.
- **Structural edits send no push** (future push epic: check-offs notify,
  structural edits never do).
- **Failure**: throws; list unchanged.

## 6. applyChecklistEdits (edit-mode bulk save: add + remove + reorder in one write)

- **Server rows**: `escrows` row upserted; ALL step rows for both sides
  upserted; the rows the edit removed DELETED via `deleteStepRowsNow`
  (idempotent — an already-gone row is converged, not an error).
- **Local cache**: the side's step list replaced wholesale on confirmation.
- **Invite codes / device links**: untouched.
- **Progress/counts**: done/total recompute from the new list.
- **Placement (approved spec)**: removing a checked step from a closed,
  still-complete side keeps it closed; the edit reopens the side only when
  an unchecked step remains. `lastAction` untouched (no push, LATEST FROM
  keeps the last check/uncheck).
- **Realtor views**: edit mode exits with the "Checklist updated." toast on
  success; on failure the draft is KEPT and the error shows.
- **Buyer/seller views**: next pull/view shows the new list; a removed step
  disappears because its server row is deleted (upsert-only would have
  stranded it).
- **Partial failure** (upserts applied, delete failed): local unchanged; the
  user still sees the pre-edit list and can retry — retry re-runs the
  idempotent upserts and finishes the delete. Crash after the delete
  confirmed: the next pull rebuilds the step list from server rows, so the
  removed step stays gone locally.
- **Removed ids** are computed against the snapshot's confirmed state inside
  the preview, so a step added and removed within one draft never produces
  a phantom delete.

## 7. cancelEscrow

- **Server rows**: `escrows` row upserted (status cancelled); EVERY active
  invite revoked (`invites.revoked_at`); every live server device link for
  those invites stamped `revoked_at` via the server-authoritative per-invite
  live-link query (zombie-link convergence — local link ids are never
  trusted, because the redeem RPC mints server rows this device never held).
- **Local cache**: escrow + invites + links mirror only after ALL steps confirm.
- **Invite codes**: all die with the escrow. Existing codes read revoked.
- **Device links**: all killed — clients land on the dead-link screen until
  re-invited.
- **Progress/counts**: deal leaves Active counts; Cancelled section gains one.
- **Placement**: Cancelled. (Closed escrows cannot be cancelled — the UI
  offers only the pencil.)
- **Realtor views**: detail shows cancelled state; deal list moves the card.
- **Buyer/seller/TC views**: dead-link screen on next validate.
- **Partial failure** (escrow row cancelled, one invite's links still live):
  local unchanged — the user still sees the escrow as open and can retry;
  retry is idempotent. The next pull converges (a server-cancelled row
  arrives as cancelled; a server-revoked invite arrives as revoked).
- **Invite ordering**: the invite row revokes FIRST, so `get_client_view`
  locks the client out via the invite check even if the link kill never runs.

## 8. closeEscrow (per side)

- **Server rows**: `escrows` row upserted (buyer_closed_at / seller_closed_at);
  that side's active invites revoked; their live server device links killed
  (same server-authoritative convergence as cancel).
- **Local cache**: side close mirrors only after all steps confirm.
- **Invite codes**: the closed side's codes die; the other side of a
  dual-agency escrow is untouched.
- **Device links**: the closed side's links die (dead-link screen). TC links
  die only when the WHOLE escrow closes.
- **Progress/counts**: side shows 100%; escrow-level status flips to closed
  only when every side is closed.
- **Placement**: side moves to Closed; whole escrow moves when all sides close.
- **Realtor views**: close button only offered when every step on the side is
  checked.
- **Buyer/seller views**: the closed side's client loses access immediately
  on confirmation (link dead); the celebration/closed state renders from the
  confirmed row.
- **Partial failure**: same fail-safe shape as cancel — local unchanged,
  retry idempotent, pull converges.

## 9. createInvite

- **Server rows**: `invites` row inserted (DB trigger enforces the cap:
  2 per side, 1 TC; a 6-char global collision regenerates the code and
  retries).
- **Prefetch (bounded)**: before the write, the full server invite rows are
  pulled with a 4s timeout and merged into the PREVIEW DRAFT ONLY — the cap
  check sees server truth while a prefetch failure still leaves local
  byte-identical. The DB trigger is authoritative regardless.
- **Local cache**: invite row added on confirmation (with the final,
  possibly regenerated code).
- **Device links**: none yet (created at redeem).
- **Client views**: the code becomes redeemable only after confirmation —
  the realtor can never share a code the server doesn't know.
- **Failure**: cap breach throws the plain cap copy
  ("This escrow already has 2 active invite codes..."); no local row.
- **Closed/cancelled escrows**: creation affordances hidden; store backstop
  throws; migration 0018's BEFORE INSERT trigger blocks at the DB.

## 10. revokeInvite

- **Server rows**: `invites.revoked_at` stamped; live server device links for
  the invite killed (server-authoritative query, same as close/cancel).
- **Local cache**: invite + links mirror only after both confirm.
- **Device links**: killed — the client lands on "this code no longer works",
  never a blank screen.
- **Client views**: next validate fails closed.
- **Failure**: throws; the invite stays live locally AND server-side
  (the invite row revokes first, so a link-lookup failure can never strand a
  live link on a live code — the revoke already landed).

## 11. regenerateInvite

- **Server rows**: the `regenerate_invite` RPC atomically kills the old code
  + old device link and issues the fresh code in ONE server transaction.
- **Local cache**: the preview's placeholder id/code are swapped for the
  server's authoritative values before commit; commit only after the RPC
  confirms.
- **Device links**: old link killed at the same moment the new code is
  issued (atomic) — the old device lands on "this code no longer works".
- **Failure**: throws; no half-regenerated invite (no local-only fallback).

## 12. redeemInvite (client; RPC-authoritative)

- **Server rows**: the `redeem_invite` RPC creates the `client_links` row
  (one live link per device id; 23505 maps to `device_has_link`).
- **Local cache**: the returned linkId persisted (`ctc:cloudlinks`) ONLY on
  `ok: true`.
- **No local fallback** (Sept 28 fix): offline/unconfigured/RPC failure
  reports the retryable `network` error ("Something went wrong on our end.
  Check your connection and try again.") — the old local redeem minted a
  device link the server never authorized and is deleted. A genuine bad
  code reports the server's verdict (`invalid` / `revoked` /
  `already_used` / `name_mismatch`), each with its specific next step.
- **Timeout**: 8s race; a late RPC rejection is swallowed (no unhandled
  rejection); timeout reports `network`, never `invalid`.
- **Crash**: the RPC is atomic server-side; a crash before the response is
  a normal retry (single-use codes: the retry reports `already_used` with
  the same link, or `device_has_link` — never a duplicate).

## 13. Legacy: the retired outbox (final drain + manual Retry)

- **One final drain** on upgrade (`initCloudSync` when `ctc:outbox-retired`
  is absent): legacy ops push with the old per-op retry semantics, then the
  marker is set and the user-action outbox is retired forever.
- **Manual Retry** (`retrySync`, surfaced on the SyncErrorBar) drains only
  legacy failures — new user actions never enqueue, so this path goes quiet
  once legacy ops are gone.
- **Ordering**: the drain's read-process-write, the logout wipe
  (`clearOutbox`), and `readOutboxOps` serialize on the per-KV promise chain
  (pinned by the reworked concurrency regression test).
- **Identity boundary**: logout clears the queue — ops carry the old uid and
  must never run under a new identity.
- **No production enqueue API exists**: `enqueueOutbox`/`dequeueOutboxOp`
  were deleted; tests seed legacy rows via the test-only `outbox_seed`
  helper.

---

## Failure-copy reference (what the user actually sees)

| Situation | Copy |
|---|---|
| Offline / timeout | Couldn't reach the server. Your change was not saved. Check your connection and try again. |
| Server rejection | The server refused the update. Your change was not saved. |
| Missing session / unconfigured | Couldn't save. You're signed out or the cloud isn't set up. Sign in and try again. |
| Invite cap | This escrow already has 2 active invite codes. Revoke an unused code first, then create a new one. |
| Client redeem network | Something went wrong on our end. Check your connection and try again. |
| Unknown | Couldn't save. Your change was not saved. Please try again. |

No em dashes in any user-facing copy, per the standing copy rule.
