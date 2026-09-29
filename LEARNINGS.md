# Clear to Close — Learnings

Issues found while building, with root causes and the practice each one taught.
Updated with every fix. (Anuraj, Sept 27, 2026: every app keeps a learnings doc.)

## Multi-escrow (Sept 29, 2026)

- **The race loser must re-query before failing.** The first cut of migration
  0022's `redeem_invite` returned `already_used` whenever the guarded
  `redeemed_at` update found no row — so two concurrent same-code/same-device
  redeems could resolve to one link for caller A and a dead-end error for
  caller B. The fix re-checks the live `(device_id, escrow_id)` link inside
  the `not found` branch: if it exists, return it (one link, both callers);
  only then report `already_used`. Practice: in any claim-style RPC, losing
  the claim is not the same as losing the resource — always re-read the
  resource's current state before declaring failure.
- **A same-escrow re-redeem is a read, not a write.** The old single-link
  model treated every redeem as a link-minting event. Under multi-escrow the
  same device redeeming the same escrow must return the existing link id
  without a new row — in the RPC (`reused: true`), in the mock server, and in
  `auth.addClientLink` (replace-by-escrow locally). Practice: idempotency
  keys are (device, escrow), not just the invite code — pin the same link id
  coming back on re-redeem, not just "ok".
- **Dead-link handling is per-link, never per-device.** Boot validation,
  the link gate, and the dead screen all used to read one global link and
  wipe it. With a link set, every one of those paths must resolve the link
  for the target escrow and remove/unregister only that one. Practice: when
  a singleton becomes a collection, grep every consumer of the old accessor
  (`getClientLink`) and convert each to the scoped accessor — the compiler
  only catches the ones still typechecking; the semantics shift is the real
  risk.
- **The mock server must model the new index, not the old one.** The
  faithful mock initially kept the one-live-link-per-device gate
  (`device_has_link`), which made the new tests fail for the wrong reason
  and old tests pass for the wrong reason. Practice: when a migration
  changes the server's contract, update the mock's contract in the same
  commit — a faithful mock that encodes yesterday's rules is worse than no
  mock.
- **Push tokens are rows per link, not per device.** The same Expo token
  registers once per link (`register_push_token` upsert on
  `(device_id, link_id)`); per-link unregister deletes by `link_id` only.
  The mock now models this, and `tests/multi_escrow.test.ts` proves adding
  a second escrow does not clobber the first escrow's token row. Practice:
  notification targeting follows the same granularity as access — when
  access goes per-escrow, so must the token lifecycle.

## Key-dates push copy correction (Sept 29, 2026)

- **The trigger implemented "close date wins" instead of "count the changes".**
  Migration 0021 first shipped with `if close_date changed then specific`
  `elsif other dates then generic` — so a single inspection-deadline change
  sent the generic copy, and a close-date-plus-another-date change sent the
  specific copy. Both violated Anuraj's approved rule (one date: specific;
  several together: generic). Practice: when the spec says "count", the
  implementation must count — a precedence chain is not a count, and the
  difference is user-visible copy.
- **Specific copy needs a specific event per field.** The original model had
  only `close_date_changed` (specific) and `key_dates_changed` (generic).
  The fix adds `inspection_deadline_changed`, `appraisal_deadline_changed`,
  and `loan_approval_date_changed`, each carrying the new date in a
  `new_date` payload field. Practice: event names are the contract between
  the trigger and the Edge Function — when the copy rule gains cases, the
  event vocabulary must grow with it.
- **Side locking needs a store backstop, not just a hidden form field.**
  `computeUpdateEscrow` and `computeActivateEscrow` assigned
  `e.side = input.side`, so a direct store call could change the side even
  though the form never offers it. Both now throw on a side mismatch.
  Practice: "the UI doesn't offer it" is not a guarantee — lifecycle
  invariants live in the store, tested by direct calls that bypass the UI.
- **Reactivation must not revive revoked access.** The lifecycle matrix now
  pins that a close-revoked invite stays revoked through reactivation —
  the test asserts `revokedAt` is still set after `activateEscrow`.
  Practice: every state-changing operation's side-effect matrix must include
  the access-revocation state, not just the data fields.
- **Approved renames apply to stored rows, not just new defaults.** The
  "Escrow open" to "Escrow opened" rename shipped with new defaults using
  the new title and a key backfill for old rows — but existing rows still
  displayed the old title. `normalizeStepTitle` now upgrades the visible
  title on load (idempotent; custom steps untouched). Practice: a copy
  rename is a data migration, not just a default change — check what the
  user actually sees on existing records.

## Key dates lifecycle lock (Sept 28, 2026)

- **Two buttons did the same reactivating thing.** The Update sheet's main
  "Activate escrow" button and the locked Key dates section's new "Reactivate
  escrow" button both routed through `activateEscrow` — and worse, an
  ordinary edit (fixing an address on a closed escrow) silently reactivated
  it. Practice: a destructive/state-changing action gets exactly ONE explicit
  entry point; every other path must be provably incapable of triggering it.
  The main button now saves via `updateEscrow` (never reactivates); only the
  locked section's button calls `activateEscrow`.
- **The store must backstop the UI's promises.** The sheet hides key-date
  fields on closed escrows, but a future caller could still pass them —
  so `computeUpdateEscrow` throws when key dates are touched on a
  non-open escrow. Practice: lifecycle gates live in the store, not just
  the form; the UI is the friendly face, the store is the lock.
- **Reactivation preserves, it doesn't write.** `activateEscrow` flips
  status and clears per-side close timestamps but never touches key dates,
  steps, invites, or links — verified field-by-field in
  `tests/update_closed_lifecycle.test.ts`. Practice: every state-changing
  operation ships with an explicit per-field matrix (what changes, what is
  preserved, what is rejected), tested, not just documented.

## Synchronous writes (the rebuild, Sept 28, 2026)

- **The local redeem fallback minted access the server never authorized.**
  The synced-store `redeemInvite` fell back to `local.redeemInvite` when the
  server was unreachable or rejected the code, so an offline client "redeemed"
  an invite into an escrow the server did not recognize — with the realtor
  never seeing the device. Practice: RPC is the single authority for
  cross-identity actions; when it is unavailable, report the retryable error
  and do NOTHING. A success the server didn't confirm is not a success.
- **The branding resolver ran unbounded writes inside a read.** A local-only
  invite fallback in `resolveInviteRealtor` pushed the invite and retried with
  no timeout — unbounded network work outside any timed gate, triggered by a
  screen render. Practice: reads never write; every network call belongs
  inside a timeout. The fallback was deleted; the RPC verdict is final.
- **A "locally created" premise outlived its model.** Both fallbacks above
  were justified by "a local-only invite whose push failed or hasn't run
  yet" — but `createInvite` is confirmed server-first, so a local-only
  invite cannot exist. Practice: when the write model changes, re-audit every
  code path that assumed the old model's states — dead premises in fallback
  code become live bugs.
- **Promise.race doesn't cancel the loser.** Prefetch and redeem races leave
  the late promise running; a late RPC rejection becomes an unhandled
  rejection. Practice: attach a no-op catch to every raced promise, and never
  let a late loser mutate state.
- **Timeout and offline must never produce a verdict.** A redeem timeout
  reported `invalid` before the fix — the user would throw away a perfectly
  good code. Practice: on timeout or transport failure, report the retryable
  network error only; verdicts come exclusively from the authority.
- **Multi-step server effects are sequential, not transactions.** Cancel,
  close, and the bulk checklist save run steps one after another; a partway
  failure leaves the server partially updated. Practice: design the window
  fail-safe — local stays unchanged (the user still sees the pre-action
  state and can retry), retry is idempotent, and the next pull converges.
  Revoke the invite row FIRST so a lookup failure can never strand a live
  link on a live code.
- **Server-authoritative identity data only.** The old convergence enqueued
  `revokeClientLink` ops from locally held link ids — but client_links rows
  are created by the redeem RPC server-side, so local ids could never match.
  Practice: kill server identity rows via a live server query (the invite_id
  convergence), never by trusting locally held ids.
- **Unique media paths on upload; delete only after the row confirms.**
  Uploads to fixed filenames race and overwrite live files; a failed row
  after a delete strands the client on a broken URL. Practice: upload to a
  unique per-upload path, carry nulled + new URLs in the row upsert, delete
  the removed file only after the row confirms. A row failure then orphans
  an unreferenced object instead of changing what clients see.
- **Interface conformance follows the preview/direct pattern.** Adding a new
  previewed write (`applyChecklistEdits`) requires the `Store` interface
  method, the local `createStore` direct implementation, the synced-store
  `previewApplyChecklist` pass-through, and the test contract file's
  implementation — tsc's TS2741 errors pin each missing piece, but check the
  whole quartet before running.

## Checklist edit mode (Sept 28, 2026)

- **Upsert-only pushes resurrect deleted rows.** `pushEscrowNow` upserts the
  escrow and every current step — it never deletes. A checklist save that
  only upserts would leave removed steps on the server, and the next pull
  would bring them back from the dead. Practice: any write that can remove
  rows needs an explicit server-side delete (`deleteStepRowsNow`, running
  inside the same confirmed write as the step upserts).
- **The draft must be the only thing an edit mutates.** The edit screen
  keeps its draft in component state; the saved escrow is untouched until
  the tick. Practice: discard is then trivially correct (drop the draft),
  and a failed save keeps the draft in place for retry — no partial local
  state to unwind.
- **Structural edits must not look like activity.** The bulk apply never
  stamps `lastAction`: a reorder/add/remove is not a check-off or a reopen,
  so it must not drive the client LATEST FROM card or a push notification.
  Pinned by a test asserting `lastAction` is byte-identical before/after a
  save. Practice: any new write path gets an explicit "does this count as
  activity?" decision, not the default stamp.
- **Closed-state survival is a lifecycle rule, not UI logic.** Removing a
  checked step from a closed side keeps it closed only when every remaining
  step is complete; any unchecked step (added, left, or unchecked in the
  draft) reopens that side — the same as unchecking today. The other side
  is untouched. Practice: lifecycle transitions live in the store compute,
  tested at the store level (13 -> 12 keeps closed; +1 unchecked reopens).
- **Client-generated ids make retried saves idempotent.** New draft steps
  carry a client-generated id; unknown ids are treated as new steps and keep
  the given id. A save retried after a failure reuses the same ids, so the
  server upsert cannot duplicate the added steps. Practice: never mint the
  row id inside the push — mint it before the first attempt.
- **Sync seam (resolved in the release merge).** The synced store's tick was
  a local-apply + fire-and-forget `bgPush` (TEMP on the feature branch).
  The release merge replaced it with the real `applyChecklistEdits`
  `confirmedWrite`: preview -> `pushEscrowNow` + `deleteStepRowsNow` ->
  `commitPreview`, with failures thrown to the tick so the draft is kept
  for retry. The confirmed-write error surface is plain-language by
  architecture; the tick shows it verbatim with a generic fallback.
  Practice: when building ahead of a sibling branch, mark the seam TEMP and
  document the exact replacement — never silently ship the weaker semantics.
- **Stale browser test.** `tests/rendered/share_button_removed.py` still
  asserts the old view-mode reorder hint and view-mode drag reorder, both
  removed by the edit-mode interaction model (reorder lives in edit mode;
  the hint moved to the sticky footer). Not updated — browser tests are
  Anuraj's pass; flagged for it.

### Side-effect pass (checklist edit mode)
- Removed checked steps: the row is deleted locally and server-side
  (`removedStepIds` -> `deleteStepRowsNow`); the closed side stays closed only
  while every remaining step is complete.
- Progress counts: recomputed from the saved list (13 -> 12 on a pure
  removal); the ring and "N of M" captions read the saved escrow after the
  tick.
- 100%/triumph state: the "All N steps complete" banner renders from the
  saved list — an edit that completes the list surfaces the close banner;
  an edit that breaks completion removes it. No confetti is tied to edits.
- JUST NOW markers: recency markers derive from `completedAt`/`lastAction`;
  the save preserves `completedAt` for steps that stay done and never stamps
  `lastAction`, so no false "just now" appears from a structural edit.
- Client views: update through the existing channel after the save (the
  step rows upsert; removed rows are deleted). Structural edits send no
  push — check-off push behavior is untouched and separate.
- Deal-list counts: the deal list reads the escrow's steps, so counts and
  status follow the save automatically.
- Discard mid-edit: drops the draft; the saved escrow was never touched.
- Save failure: the error shows in the sticky footer in plain language and
  the draft is kept for retry. Under the confirmed-write wiring, the
  local state is untouched until the server confirms.
- Interaction with synchronous writes: the tick is one `confirmedWrite`
  (preview -> push escrow + upsert steps + delete removed steps ->
  commit). If the delete lands but the upsert fails (or vice versa), the
  write throws, the local state is untouched, and the next pull converges
  the server truth — documented, not claimed as a single DB transaction.

## Data sync (the big theme, Sept 27, 2026)

- **Silent RLS rejections.** An upsert can affect zero rows and return no error —
  the app thought saves succeeded while the server dropped them. Practice: every
  write verifies the affected row count and throws `SyncNotAppliedError` on a
  silent no-op. Never trust a push that returns without confirmation.
- **Stray owner IDs were other users, not a leak.** Records owned by unknown UIDs
  turned out to be other people's signups (the app is public). Practice: map
  unknown IDs to their source before assuming a bug — and never delete rows you
  haven't identified; they may be real users' data.
- **Boot pushed the profile up but never pulled it down.** `initCloudSync`
  pushed local → server and pulled escrows/invites, but no profile pull existed —
  so the app showed stale local data forever. Practice: every entity needs both
  directions; a push without a pull is half a sync.
- **A pull that returns the local snapshot isn't a pull.** Even after the profile
  pull was added, `pullProfileFromCloud` returned the local snapshot as-is
  whenever one existed and only fetched when local was missing — so the realtor's
  own profile edit page showed the OLD name/email after a refresh while the
  database held the new values (Anuraj caught it on his screen). The client view
  had the same staleness class. Practice: boot and foreground return converge
  FROM the server. The converge follows a fixed conflict care: a queued local
  edit (outbox-dirty) wins over the server copy; a missing server row never wipes
  the local snapshot; offline fails open and never throws.
- **Foreground refresh must never wipe in-progress typing.** The profile edit
  screen converges on foreground return, but a user mid-edit would lose their
  typing. Practice: an `editedRef` guard (checked again inside the async
  callback) makes the refresh a no-op while unsaved edits are in flight.
- **Queued revocations stayed local until restart.** `closeEscrow` left revoke ops
  in the outbox, so clients kept access until the app restarted. Practice: access
  revocation drains the outbox immediately — security actions never wait for a
  background cycle.
- **Logout must clear everything.** A new signup saw the previous account's
  profile because logout left caches, outbox, links, and media behind. Practice:
  logout wipes all local state: profile cache, escrows, invites, links,
  cloud-view entries, outbox, media caches, in-memory snapshot. Test the
  login → logout → different-login path explicitly.
- **Old-account outbox could run under a new identity.** Queued ops survived
  logout. Practice: drop the outbox on logout, unconditionally.
- **New sync architecture (Anuraj's directive, Sept 27, 2026).** Server is the
  source of truth. Realtor writes go straight to the server in real time and wait
  for confirmation — no queueing, no background deferral. Any failure shows an
  immediate, plain-words error with Retry. Reads are server-first; local cache is
  offline fallback only. Supabase Realtime keeps realtor and client views live.
- **Boot pushed stale local data over newer server data (production clobber,
  Sept 27, 2026).** `initCloudSync` ran a fire-and-forget "reconcile" that
  unconditionally pushed the local profile, every local escrow + steps, and
  every local invite on boot — so a stale device overwrote Anuraj's newer
  server profile name ("jimmy ola" became "Jimmy" again). The earlier fix had
  only repaired the pull direction and left the inverse clobber path. Practice:
  boot/foreground are pure PULL; PUSH happens only as the direct result of an
  explicit user action. The old boot push-reconcile pattern is deleted as a
  pattern, not repaired. Regression test: real boot issues zero write calls
  while stale "Jimmy" converges to server "jimmy ola".
- **Every multi-writer conflict needs an explicit rule, and resolutions must
  be auditable (Sept 27, 2026).** Documented in `docs/CONFLICT_RULES.md`:
  last committed push wins for profile and escrow units (the server's commit
  order arbitrates — `updated_at` cannot be the arbiter today: only
  `realtor_profiles` has the column and it has no update trigger); steps
  follow their parent escrow unit's last committed push, including the
  documented sharp edge that a stale device's unit push can revert a newer
  check-off; invite terminal states (redeemed/revoked) are write-once and
  monotonic — the server's `redeem_invite` RPC refuses redeem-after-revoke
  and a stale server read never clears a timestamp. Every pull that resolves
  a genuine divergence appends to a bounded local conflict log
  (`ctc:conflict-log`, cap 50, read via `readConflictLog`). Practice: write
  the conflict rule next to the code that writes, with one regression test
  per rule — "whichever syncs first wins" is never acceptable.

## Client-facing data exposure (Sept 27, 2026)

- **`get_client_view` serialized the full profile row**, including the newly added
  email field. Practice: client-facing RPCs use an explicit field allowlist —
  never `select *` into a client payload. Adding a column to a table must trigger
  a review of every RPC that reads it.

## Media (Sept 27, 2026)

- **Overwritten Storage files need cache-busting.** Re-uploading to the same path
  served the old image everywhere. Practice: stamp `?v=<upload timestamp>` on
  media URLs at upload time, on every upload path (including cropper saves).
- **iOS PHPicker confirmation can't be removed.** The "blue checkmark" screen is
  Apple's system UI — no app or API can suppress it. Practice: don't promise to
  remove OS-owned UI; design the flow around it (straight into our editor after
  the tap).
- **Cropper touch bugs.** Taps nudged the image (no drag threshold); the zoom
  slider's touches scrolled the whole page. Practice: pan starts only after a
  movement threshold; the slider's touches are isolated with stopPropagation so
  only the image zooms.

## Auth & invites (Sept 25–26, 2026)

- **Supabase rate limits surface as generic errors.** `over_email_send_rate_limit`
  looked like an app bug. Practice: map known auth error codes to friendly,
  specific messages (too many attempts — try again later).
- **One device per client link; regenerate kills atomically.** Old code and old
  device link die at the same moment the new code is issued; the old device lands
  on "this code no longer works", never a blank screen. Practice: invite
  lifecycle transitions are atomic, and every dead-code path has a designed
  screen.
- **Session behavior is a product decision.** Web went from "sign in every visit"
  to persisted sessions on Anuraj's call. Practice: confirm session semantics
  explicitly; don't assume.
- **Password reset needed its own landing.** The recovery email link redirected
  to the app, but nothing parsed the recovery payload (`type=recovery` in the
  URL fragment) and no screen existed to set the new password — the user landed
  on the home page with a recovery session and no way to act on it (Anuraj
  caught it live). Also: the client runs with `detectSessionInUrl: false`, so
  supabase-js never parses the fragment itself. Practice: an auth email flow
  is only done when the landing URL is handled end to end — detect the link
  type on launch, establish the session from its tokens, route to the designed
  screen, and give expired links a fresh-link path, never a dead end. Recovery
  is web-only by design: the user sets the password in the browser, then signs
  into the iPhone app with it.
- **Every password field gets a show/hide eye.** Password fields were
  dots-only with no way to reveal (Anuraj, Sept 2026). Practice: the shared
  `Field` renders the approved eye toggle on every `secureTextEntry` field —
  one place covers login and signup — and the eye icon lives once in `ui.tsx`
  so the change-password sheet and recovery screen share it with no divergent
  copies.

## Copy & docs (standing)

- No em dashes in user-facing copy — commas, periods, colons, or reword.
- README updated in the same commit as every feature change.
- Use the realtor's actual name instead of "your realtor" when known.

## iOS parity (Sept 27, 2026)

- **Root-level overlays ignore the notch.** The sync-failure error bar was
  mounted above the router stack with no screen chrome of its own, so on iOS
  it rendered under the notch/status bar. Practice: any view mounted outside
  a screen (global bars, banners, overlays) must pad with `useSafeAreaInsets`
  itself — it cannot inherit a screen's SafeAreaView. Web is a no-op (insets
  are 0), so the same code is safe on both platforms. Pin it with a
  structural test on the source.
- **Fixed top padding ignores the notch — and can make buttons untappable.**
  The home header ("Hi {name}" + profile pic) and the escrow details header
  ("‹ Escrows" back button) used a fixed 14pt top padding with no safe-area
  inset, so on native iOS they rendered under the status bar — the back
  button was effectively untappable (Anuraj caught it live). Practice: every
  top-of-screen header adds `useSafeAreaInsets().top` to its existing top
  padding/margin, preserving the deliberate gap; the back button keeps a 44pt
  minimum touch target and a render check must verify it is actually hit by
  `elementFromPoint` at its center (no overlay intercepting), not just
  visually clear of the status bar. expo-router already wraps the app in a
  SafeAreaProvider (ExpoRoot), so `useSafeAreaInsets()` works in any screen
  without adding a new provider.

## Web forms (Sept 27, 2026)

- **iOS Safari date inputs refuse to shrink.** In the New Escrow sheet, the
  "Escrow open date" and "Target close date" inputs overflowed past the right
  edge at iPhone widths while the text inputs fit fine. Root cause: iOS
  Safari's native `<input type="date">` carries a large intrinsic min-width
  and will not shrink to its container — `width: 100%` plus
  `box-sizing: border-box` is not enough on WebKit (headless Chromium does
  not reproduce it). Practice: every native date/time input on web gets
  `maxWidth: '100%'` and `minWidth: 0`; the author's `min-width: 0` overrides
  the UA-imposed intrinsic minimum. Audit every sheet/screen for other date
  inputs when fixing one (here `DateField` was the only one, used only by
  the escrow sheet). Pin the constraint with a source-level regression test
  (`tests/date_field_web_width.test.ts`); the visible outcome (no overflow at
  360px/390px) was verified with a headless render of the shipped CSS.

## Sheets, inputs, and forms (Sept 28, 2026)

- **Date pickers must start collapsed, never pre-opened.** The New Escrow sheet
  auto-rendered the iOS inline `DateTimePicker` calendar on open (Anuraj caught
  it live on his iPhone). Root cause: `DateTimePicker` was mounted
  unconditionally inside `DateField`. Practice: calendar inputs keep the picker
  hidden behind the field — tap to open, select a date to close, Android only
  commits `event.type === 'set'` (dismiss does not clear the date). The field
  container is a `Pressable`; the picker mounts only while `open`. Pinned by
  `tests/date_field_collapsed.test.ts`.
- **Radio-style choices are single-select at the data layer, not just the
  styling.** The realtor-side selector could show both Buy and Sell selected
  (Anuraj caught it live on his iPhone). Root cause: the side-picker toggle
  allowed both sides to be "on" at once while the card styling only dimmed
  unselected sides. Practice: selection state is computed in one pure function
  (`toggleSide` returns exactly one selected side; tapping the selected side is
  a no-op) so the UI can never render two selected cards. Legacy stored
  `side: 'both'` keeps round-tripping until the user taps — never rewrite stored
  data as a side effect of a selection fix. Pinned by `tests/sidepicker.test.ts`.
- **Lock the sheet detent when the keyboard opens.** Tapping a field made the
  sheet jump from half-height to full-screen (Anuraj, Sept 28, 2026). Root
  cause: the shared `Sheet` derived its scroll region from the keyboard-visible
  height, which changed as the keyboard animated in. Practice: snapshot the
  sheet's opening height from the first keyboard-closed layout and apply it as
  `maxHeight`; the keyboard only lifts the sheet (marginBottom, capped so the
  top never leaves the screen) — content below the fold is reached by scrolling
  inside. Lives in the SHARED `Sheet` so every sheet benefits. Pinned by
  `tests/sheet_detent_lock.test.ts`.
- **Removing a form field is a full-stack audit, not a render change.** The City
  field was removed from the New/Edit escrow forms (Anuraj, Sept 28, 2026).
  Practice: audit the field end to end — DB column, validation, initial-form
  mapping, submit payload, cloud sync consumers, every render site — and decide
  the storage story explicitly: here the NOT NULL column stays, new escrows
  store `''`, updates preserve the stored city, and `ClientTopCard` hides the
  city line when empty (no blank row). The app input is optional; a nullable
  migration is a separate decision. Pinned by `tests/city_removed.test.ts`.
- **When an approved direction changes mid-fix, revert the first
  implementation fully.** The inline "Custom step" field on the transaction
  detail screen slid behind the keyboard when focused (Anuraj's iPhone
  screenshot, Sept 28, 2026). The first fix used a centered ConfirmDialog,
  then a bottom sheet — Anuraj's final decision SUPERSEDED both: keep the
  inline form visually exactly as-is and add keyboard avoidance to the
  screen instead. Practice: revert the superseded implementation's component
  API additions completely (the dialog's `children`/`confirmDisabled`/lift
  props and `Field`'s `autoFocus` were removed again) rather than leaving
  dead API surface; the final fix is `useKeyboardHeight` + bottom padding
  on the screen plus an on-focus scroll of the add-step footer into view.
  Pinned by `tests/keyboard_avoidance.test.ts`.

- **Keyboard avoidance is a whole-app audit, not a per-screen patch
  (Sept 28, 2026, Anuraj: EVERY input stays visible above the keyboard, no
  exceptions).** Audit found the shared avoidance lived only in the `Sheet`
  component — all six bottom sheets were covered, but seven full-screen
  forms (login, signup, redeem, reset password, profile setup/update/create)
  and the transaction detail screen had nothing. Practice: export the one
  shared `useKeyboardHeight()` hook from `ui.tsx`; every screen adds bottom
  padding equal to the keyboard height to its ScrollView content (the same
  lift-by-keyboard-height idea the Sheet uses internally), so the OS can
  scroll the focused field into view above the keyboard. The detail screen
  additionally scrolls its custom-step footer into view on focus via a
  `listRef` on the checklist. Pinned per-surface by
  `tests/keyboard_avoidance.test.ts`.
- **iOS silently drops a second Modal presented while another is visible —
  never stack two Sheets.** Tapping "Cancel this escrow" in the Update
  sheet did nothing on Anuraj's iPhone (Sept 28, 2026): the tap handler fired
  and the state flipped, but the confirmation never appeared. Root cause
  CONFIRMED in the react-native 0.86.3 source in this repo
  (`RCTModalHostViewComponentView.mm`): every Modal presents from
  `[self reactViewController]` (the root VC), never the topmost presented
  VC, so the second `presentViewController:` is ignored by UIKit with no
  error. Practice: only one Modal on screen at a time — the confirmation now
  renders INSIDE the Update sheet's already-open Modal (`EscrowFormSheet`'s
  `confirmBody` prop, fed by the unwrapped `CancelEscrowBody`), so the form
  state survives and "Keep it"/overlay-tap backs out of the confirmation
  only. The deal-list card X keeps the standalone Sheet-wrapped
  `CancelEscrowSheet` at the screen root (no other Modal open there). When
  adding any confirm UI to a sheet, audit every other sheet for the same
  stacking. Pinned by `tests/cancel_escrow_confirm.test.ts`.

## Realtor home banner (Sept 28, 2026)

- **Shared banner strip, one component for two surfaces.** The realtor home
  screen gained the approved banner section (118px full-bleed strip, synced
  banner cover-cropped, brand-teal gradient fallback, 88px photo at right 18
  with a 3px white ring tapping through to /profile-update); the small
  avatar left the header row so there is exactly one photo. Rather than a
  second copy, the strip/photo/gradient block was extracted from
  ClientTopCard into the shared `src/components/BannerStrip.tsx`, used by
  both surfaces with the same testIDs passed as props — the realtor header
  is a pixel-exact preview of what clients see and the two can never drift
  (UI-reuse standing rule). Practice: when two surfaces must look identical,
  extract the shared piece with its instrumentation as props so existing
  source-grep regression tests keep pinning the same testID strings.
- **Banner sits below the safe-area gap.** The banner section renders after
  the `insets.top + 14` gap view from the header-top-gap release, never
  under the status bar; the wrap breaks out of the content's 18px padding
  with negative margins for the full-bleed look. Practice: full-bleed
  sections inside a padded scroll container need `marginHorizontal: -18`
  (and `marginTop: -18` when they start at the top) — and the header-top-gap
  regression test pins the literal `insets.top + 14`, so keep that exact
  expression in the file when restructuring the header.
- **Rendered verification without auth.** The home screen needs a session,
  so the render check seeds localStorage before load (a fake Supabase JWT
  for `getSession` + `ctc:profile`/`ctc:escrows` rows) and serves the built
  dist under /clear-to-close with SPA fallback. The fake JWT makes the
  server-pull sync attempts fail at the network layer — those
  ERR_EMPTY_RESPONSE console errors are seeding artifacts, not app errors;
  the app correctly falls back to the local cache. Assert the visible
  outcome (strip 118px, full-bleed, photo 88px at right 18, tap routes to
  /profile-update) from bounding boxes, not just source pins.

## Activate escrow (Sept 28, 2026)

- **Reactivation is more than a status flip.** The deal list reads "closed"
  from the per-side close dates (`isClosedRow`), not just `status` — flipping
  `status` back to 'open' while `buyerClosedAt`/`sellerClosedAt` stayed set
  would have left the card sitting in Closed. Practice: `activateEscrow`
  clears the per-side close dates too; test the list predicate
  (`!isClosedRow`), not just the status field.
- **A reactivation needs its own store op, not an optional flag on update.**
  `updateEscrow` explicitly never touches status (editing a closed escrow
  keeps it closed) — bolting a status flip onto it would have muddied the
  contract. Practice: separate mutating ops with separate names
  (`updateEscrow` vs `activateEscrow`), keeping the field-write inline in both ops
  so the field rules can never drift.
- **The "already open" guard belongs in the store, not the UI.** The sheet
  routes open escrows to `updateEscrow` and closed/cancelled ones to
  `activateEscrow`, but a stale `editing` snapshot could still race.
  Practice: `activateEscrow` throws on an already-open escrow — the server
  of truth enforces the invariant even if the UI routes wrong.

## 2026-09-28 — "Invite another" opens an inline form inside the View clients sheet (not a nested InviteSheet)

- **Second Modal never presents on iOS.** "Invite another buyer" in the
  View-clients sheet rendered a nested Modal-based `<InviteSheet>` while
  the sheet's own Modal was open. iOS presents every RN Modal from the
  root view controller and silently drops the second
  presentViewController: (verified in react-native 0.86.3) — the tap fired
  and state flipped but no invite UI ever appeared, so the button "did
  nothing" on the iPhone. Anuraj's call: expand an inline form inside the
  existing sheet instead (existing Field, role-specific label,
  exact-name hint, "Create code" disabled until non-empty, "Creating…"
  while busy; on success the list refreshes so the new row renders with
  code/Copy, and the form collapses and clears). The standalone
  InviteSheet stays unchanged for first-invite flows from detail/share
  (never nested there). Practice: one Modal on screen at all times —
  confirm dialogs get the same inline treatment (the revoke
  `<ConfirmDialog>` had the identical latent bug and became an inline
  destructive confirm box). The focused field stays above the keyboard
  through the shared Sheet's whole-sheet lift, not a per-field scroll.
- **Pin the pattern, not the look.** The regression test
  (`tests/invite_inline_form.test.ts`) is structural: exactly one `<Sheet>`,
  no `<InviteSheet` / `<ConfirmDialog` in ClientList, the scoped
  doInviteCreate flow (create → `await refresh()` → collapse + clear),
  role-aware button title, under-cap rendering, the whole-sheet keyboard
  lift in ui.tsx, and the standalone InviteSheet still wired from
  detail/share. A source-grep guard catches a reintroduced nested Modal
  that a render test would only catch on a real device.

## 2026-09-28 — Invite codes die with the escrow (cancel / close)

- **Cancel kills every active invite; per-side close kills only that
  side's.** Cancelling revokes all active buyer/seller/TC invites;
  closing the buyer (or seller) side revokes only that side's invites
  (the other side and the TC stay live); the whole-escrow close (last
  side) revokes buyer, seller, AND TC. Already-revoked invites are
  untouched (the helper skips `revokedAt != null`, so timestamps are
  never rewritten). Revocation reuses the exact revokeInvite semantics —
  code invalidated AND the device link killed at the same moment — so
  affected devices land on the existing dead-code state (`redeem`
  returns `revoked`, `validateClientLink` returns invalid), never a
  blank screen. This composes with the Activate escrow release: a
  reactivated escrow starts with zero live codes and the realtor issues
  fresh invites.
- **Sync follows the same shape as the link revocation.** `local`
  returns the killed invites (`CloseEscrowResult.revokedInvites`,
  new `CancelEscrowResult`); the syncedStore wrapper enqueues a
  `pushRevoke` outbox op per invite and drains immediately (the codes
  must die on the server now, not at next boot). `cancelEscrow` changed
  from `Promise<Escrow>` to `Promise<CancelEscrowResult>` — the one UI
  caller (`CancelEscrowSheet`) destructures `.escrow`, and the
  editcancel test was updated the same way. Practice: when a mutation
  gains side effects that must converge to the cloud, return them in the
  result object (the closeEscrow `revokedLinks` precedent) rather than
  re-diffing before/after state.
- **Tests pin each scope.** `tests/invite_expiry.test.ts` covers: cancel
  kills buyer/seller/TC (and the redeemed device link), per-side close
  leaves the other side + TC redeemable, whole close kills all, and a
  revoked code redeems as `revoked`. 27 assertions, all green.

## 2026-09-28 — No new invites on a closed/cancelled escrow (Anuraj)

Decided by Anuraj after the invite-expiry release (which had left this an
open question, see below): once the whole escrow is closed or cancelled,
no new invite codes may be created for any role (buyer, seller, TC).

- **The gate is status-based, not lifecycle-based.** `store.createInvite`
  loads the escrow and throws `cannot create invites for a <status>
  escrow` when status is `closed` or `cancelled`. A per-side close keeps
  status `open`, so the other side can still be invited — deliberate, not
  a hole. Practice: put the rule on the data (status), not on the action
  that set it, so partial states behave consistently.
- **UI hides the offer; the local throw is the backstop.** The detail
  screen's `renderInviteButton`/`renderTcButton` return null when the
  escrow is dead and no live invite exists ("View clients"/"View TC"
  stays for legacy live invites so they can be revoked); `ClientList`
  takes an `escrowClosed` prop and hides the "Invite another" button,
  form, AND the cap note (the note invites creating "someone new", so it
  counts as a creation affordance). The standalone InviteSheet is only
  reachable through those gated buttons; even if reached another way,
  `store.createInvite` throws. Practice: hide the affordance AND guard
  the mutation — the UI is presentation, the store is the rule.
- **The server is the final authority.** Migration 0018 adds
  `invites_no_closed_escrow`, a `BEFORE INSERT` trigger on `invites`
  that raises `cannot create invites for a closed|cancelled escrow`
  (regeneration goes through the same path and is blocked too).
- **The race is real: create-while-open, push-after-close.** An invite
  created locally moments before the close dies at the server trigger.
  The push path treats it exactly like the cap race: the rejection is
  authoritative and final, so `syncedStore` rolls back the optimistic
  local row (no phantom invite), records a final non-retryable
  `inviteClosed` sync error in plain words ("This escrow is closed or
  cancelled. New invites cannot be created."), and drops the op — never
  retried forever. `cloudSync.ts`'s drain-time drop clause and
  `onOpError` classification both learn the new rejection via the shared
  `isClosedEscrowRejection` / `finalInviteRejection` helpers. Practice:
  every new server rejection reason gets its own final-vs-retryable
  classification from day one; "unknown → retry" would have turned a
  certain failure into an infinite loop.
- **Tests:** `tests/invite_closed_block.test.ts` (46 assertions):
  closed/cancelled block all three roles, open escrows and per-side
  closes unaffected, the synced race rolls back with a final error and
  no retry, structural checks on the gated buttons/ClientList, and the
  migration's trigger/message.

## 2026-09-28 — Side locked after creation + two-phase new-escrow confirmation (Anuraj)

- **The edit flow let the side change, and the picker was the only thing
  standing between a tap and a data contradiction.** `EscrowFormSheet` shared
  one interactive side picker between create and edit, so a buyer→seller
  switch after creation silently contradicted the invites and client links
  already issued on the old side (the ghost-invite class). Fix: a `lockSide`
  prop on `EscrowFormSheet` — the edit/activate flows (both via
  `UpdateEscrowSheet`) render the side cards as non-interactive `View`s
  with the same card styling, and the side value submits unchanged.
  Practice: creation-time choices that downstream data depends on get
  locked at the form level — the picker stays interactive only where the
  choice is still being made.
- **The confirmation step lives inside the same sheet, not in a new one.**
  The two-phase create holds the validated input in state and renders the
  summary (`EscrowConfirmView`) in place of the form body inside the one
  open Modal — the same reason the cancel confirmation moved inside
  (`confirmBody`, Sept 28): iOS silently drops a second stacked Modal.
  "Back to edit" only clears the held input; form state is untouched, so
  every value is preserved by construction. Practice: a confirm-then-commit
  flow belongs in the sheet's own state, never in a second Modal — and the
  cheapest value-preservation is not copying values back and forth but
  never leaving the form.
- **Summary content is pure logic.** The confirmation rows (Side / Property
  address / Client name / Escrow open date / Target close date) are built
  by `src/lib/escrowConfirm.ts` (`confirmSummaryRows`, `sideDisplayLabel`),
  unit-tested like the rest of `src/lib` — the sheet just renders them.
  Practice: keep what the user sees on a confirmation screen in a pure,
  testable function; the component renders, it doesn't decide.
- **Tests pin each scope.** `tests/side_lock_confirm_create.test.ts`
  covers: summary labels/values/order (buy/sell/dual-agency), Update sheet
  passes `lockSide` and not `confirmCreate`, New sheet passes
  `confirmCreate` and not `lockSide`, locked cards are non-interactive
  Views reusing the picker styles, submit holds the input on the
  confirmation, "Back to edit" preserves values, "Create escrow" performs
  the held create through the existing save path. All green.

## 2026-09-28 — Profile/banner image removal (Anuraj)

- **A removal is a detection + convergence, not a flag.** The form's X only
  nulls the draft field; the save pipeline detects the removal by comparing
  the stored profile against the new one (`mediaKindsRemoved`, pure and
  unit-tested) — had-an-image before, nothing now. Clear-then-pick before
  Save reads as "had, still has" and is a normal replace by construction,
  so no special case is needed anywhere. Practice: derive destructive
  intent from state transitions, not from UI events — the UI just edits
  drafts, and the pipeline sees exactly what changed.
- **Durable intent, not a one-shot call.** The removal writes a
  `ctc:media-removed` KV flag before the push, and `pushProfileWithMedia`
  re-reads pending flags on every path (live save, outbox drain, boot
  reconcile): a failed push retries the Storage delete + URL null instead
  of silently keeping the old `photo_url` on the server. The delete is
  idempotent (missing file = already deleted), which makes retries safe.
  Practice: any destructive write needs a durable intent that outlives the
  first attempt — the same pattern the media uploads got for the
  stale-photo fix.
- **Explicit nulls on removal only.** `toProfileRow` still omits the media
  keys when nothing was ever uploaded (an offline name edit can never wipe
  the server's photo), and writes an explicit `photo_url`/`banner_image`
  null only for removed kinds — so clients fall back to the initials and
  the teal gradient instead of the stale Storage URL.
- **Loud, not best-effort.** `deleteProfileMedia` throws on Storage
  failure (the same loudness as the delete-file helper's opposite: local
  cleanup stays best-effort because the server removal is what matters).
  The failure flows into the existing sync-error surface — confirmed or
  loud, never a silent success. A missing Storage file is NOT a failure
  (idempotent), which also keeps the outbox retry safe.
- **The X badge is a sibling, not part of the image button.** `ClearBadge`
  renders after the image `Pressable` in a relative wrapper: absolute
  corner position, its own 44pt target with `hitSlop={8}`, `zIndex` above
  the image — the image tap (change → picker → cropper, untouched) and the
  clear tap can never mis-fire into each other.
- **Tests pin each scope.** `tests/profile_media_removal.test.ts` covers:
  the badge exists / is visible only when an image is set / clears the
  draft field / is a 44pt labelled target; removal detection (photo,
  banner, both, unchanged, no-previous, remote-URL-as-URI, clear-then-pick
  is a replace); the Storage delete hits the right bucket+path, throws on
  failure, tolerates a missing file; `toProfileRow` nulls removed keys and
  omits the rest; `removeProfileMediaNow` deletes the local file, the
  Storage file, the upload fingerprint, and nulls the URL; an end-to-end
  `pushProfileWithMedia` converges a removal; pending flags re-run on
  retry; re-pick after clear re-uploads with a fresh versioned URL; a
  failed Storage delete rejects (loud). 42 assertions, all green.

## View-clients kicker: no property address (Sept 28, 2026)
- **Surgical change, exact scope.** Anuraj's directive with screenshot: the
  View clients sheet kicker read "CLIENTS · <full address>"; it now reads
  just "CLIENTS" (or "TC"). Only the kicker line in
  `src/components/ClientList.tsx` changed; the address stays on the
  escrow-detail and client-home surfaces where it belongs.
- **Unused prop removed at the call site, kept in the interface.** The
  `address` prop was destructured in `ClientList` only for the kicker; the
  destructure was removed while the `address: string` interface field and
  all callers stay untouched — no ripple into call sites.
- **Test pins the kicker text.** `tests/clients_kicker.test.ts` asserts the
  one `<Kicker>` line still shows TC/Clients per side and contains neither
  the address nor a middle-dot separator.

## Zombie device links on single-invite revoke (Sept 28, 2026)
- **CONFIRMED from code:** `syncedStore.revokeInvite` pushed only
  `pushRevokeNow` (invites.revoked_at) and never revoked the
  `client_links` rows. The server-side link stayed live (`revoked_at =
  NULL`), still occupying the device's one-live-link slot in
  `client_links_device_live_uidx` — so a later redeem for a DIFFERENT
  escrow on that device hit the 23505 unique violation and the client saw
  "This device is already linked to another escrow. Ask your realtor to
  release it, then try again." with nothing left for the realtor to
  release. Regenerate and close-escrow were immune because they enqueue
  the `revokeClientLink` outbox op; single-invite revoke was the only
  path that skipped it.
- **Fix mirrors the existing pattern.** `store.revokeInvite` now returns
  `{ revokedLinks }` (the local loop already killed the links; it just
  never surfaced them). `syncedStore.revokeInvite` enqueues a
  `revokeClientLink` op per killed link and drains immediately — the
  exact closeEscrow/regenerateInvite pattern, same "code invalidated +
  device link killed at the same moment" semantics. All existing callers
  ignore the return value, so the signature change is safe.
- **Tests pin each scope.** `tests/revoke_invite_kills_link.test.ts`:
  revokeInvite returns the killed link id + revokedAt; the link reads
  dead after revoke; the same device can redeem a different escrow's code
  afterward; revoking an invite with no redeemed link enqueues nothing;
  the synced wrapper pushes the link revocation to the server
  (pushLinkRevokeNow), the op drains to zero, and the public gate reads
  the link dead. A genuinely-live link on another escrow still maps 23505
  to `device_has_link` (pinned separately in syncedstore.test.ts).

## Outbox enqueue is not concurrency-safe (Sept 28, 2026)
- **CONFIRMED by test:** wiring `revokeInvite` to enqueue a new
  `revokeClientLink` op AFTER `bgPush` broke two existing suites. Root
  cause is a read-then-write race, not the new op itself:
  `enqueueOutbox` reads the outbox, appends, and writes it back. Two
  concurrent enqueues (bgPush's fire-and-forget dormant branch + an
  awaited enqueue) interleave so the last write clobbers the other op.
  Worse, the drain's `finally` reconcile then cleared the clobbered op's
  sync-error record ("retryable records persist only while their op is
  still in the outbox"), so the failure went invisible too.
- **Practice:** one coordinated outbox writer per user action. In
  `syncedStore.revokeInvite`, bgPush now gets `op: null` (immediate push
  attempt + dormant re-init kick, no outbox touch) and the wrapper
  enqueues `pushRevoke` + `revokeClientLink` awaited and in order before
  the single immediate drain. Never run a fire-and-forget enqueue next
  to an awaited one on the same KV.

## Server-created rows are not in the local store: the zombie-link correction (Sept 28, 2026)
- **CONFIRMED by audit, not by a failing test:** the `revoke_invite_kills_link` fix shipped with a full green suite, yet was a no-op in production.
  The `redeem_invite` RPC creates `client_links` rows server-side; the
  redeeming device never stores them locally, and the realtor's device
  never hydrates them at all — the realtor's local `data.links` is written
  ONLY by the offline redeem fallback. The first fix converged link
  revocations from the realtor's LOCAL `data.links`, which is empty in
  production, so every kill-link path (single revoke, cancel, close,
  regenerate) enqueued nothing. The suite passed because it seeded an
  impossible state: a locally-held link for a server-side row.
- **Practice, now enforced by test design:** tests for server-created data
  must seed the SERVER side and assert against it. Every kill-link path now
  queries live server `client_links` per invite
  (`fetchLiveServerLinkIds(client, inviteId)` in `src/lib/cloudSync.ts`,
  converged via `convergeServerLinks` in `syncedStore.ts` for
  `revokeInvite`, `cancelEscrow`, `closeEscrow`, and the regenerate
  fallback), instead of inferring server rows from local state. The
  faithful in-memory Supabase stand-in (`tests/mock_server.ts`) encodes
  the production shape — server-side link creation in `redeem_invite`, the
  one-live-link-per-device unique index (revoked links free the slot,
  live links on other escrows block with `device_has_link`), revoked
  invites rejecting codes — and the suites drive it: single revoke, cancel
  (including cancel freeing a device to redeem a new code afterward, and
  genuinely-live links still blocking), close, and regenerate all
  converge `revoked_at` server-side with local `data.links` EMPTY. Any test
  that seeds local state for server-created rows is a red flag.

## Stale outbox writers clobber newer ops: serialize the outbox (Sept 28, 2026)
- **CONFIRMED by instrumented test run:** after the server-authoritative
  converge fix, `close_revoke_converges.test.ts` failed intermittently —
  the buyer's server link stayed live (`revoked_at` null) while the TC link
  was revoked, the outbox ended empty, and no sync error was recorded. A
  sequence-numbered log of every outbox write pinned it: the buyer's
  converge enqueue completed (`[pushEscrow, pr1, pr2, c-buyer]`), then a
  STALE `dequeueOutboxOp` — from an earlier `bgPush` whose push finished
  late — wrote its stale snapshot (`[pr1, pr2]`, read before the converge
  enqueue), silently dropping the buyer's converge op. The TC converge
  then enqueued onto the clobbered state, the drain executed only what
  remained, and the zombie survived with nothing queued to retry it.
- **Root cause:** every outbox mutation (`enqueueOutbox`,
  `dequeueOutboxOp`, `drainOutbox`'s read-process-write) was an
  uncoordinated read-modify-write. Fire-and-forget drains and bgPush
  completions interleave freely, so any writer's read can go stale between
  another writer's read and write. The earlier fix in this branch (one
  coordinated writer per action) narrowed the window but could not close
  it: the stale writer belongs to a PREVIOUS action.
- **Fix:** a per-KV promise chain (`withOutboxChain` in
  `src/lib/cloudSync.ts`) serializes `enqueueOutbox`, `dequeueOutboxOp`,
  `clearOutbox`, and the entire `drainOutbox` read-process-write cycle.
  The chain survives rejections so one failed op never stalls later
  writers. The drain holds the chain across its network I/O; enqueues
  behind a running drain wait their turn on the fresh state instead of
  racing it. No reentrancy: the drain never calls an outbox writer.
- **Regression test:** `tests/outbox_concurrency.test.ts` uses a rigged KV
  (reads/writes pend until released) to deterministically interleave a
  stale dequeue's read/write around newer enqueues — the exact Sept 28
  shape. It fails without the chain (dropped converge op, zombie link)
  and passes with it, then drains all surviving ops against the mock
  server and asserts every invite/link revoked and the outbox empty.
- **Practice:** any persisted read-modify-write shared by fire-and-forget
  writers must be serialized. A "stale" writer is not a bug in the writer
  — it is the normal shape of bgPush completions — so the coordination
  belongs in the store, not in each caller.

## Side-effect checklist: escrow lifecycle actions (Anuraj hard rule, Sept 28, 2026)
Every lifecycle action enumerated against every surface it touches —
Expected vs Actual (verified from code + tests, not assumed). Two genuine
gaps found and fixed in this branch; the rest verified as handled.

### cancelEscrow
- Active invite codes: EXPECTED all active codes (buyer, seller, TC) die.
  ACTUAL yes — local revokeActiveInvites revokes every role; synced wrapper
  enqueues pushRevoke per invite + immediate drain; server invites.revoked_at
  set, redeem returns 'revoked'.
- Device links: EXPECTED every server client_links row for the escrow's
  invites killed. ACTUAL yes — one retryable convergeLinkRevokes op per
  revoked invite; the drain queries live server links by invite_id and
  stamps revoked_at. Pinned: cancel converges revoked_at; the freed device
  redeems a new code afterward; genuinely-live links on other escrows still
  block (device_has_link).
- Checked items/steps: EXPECTED preserved. ACTUAL yes — untouched.
- Deal list: EXPECTED Active -> Cancelled section, counts update. ACTUAL
  yes — status='cancelled' excluded from the open filter, in the cancelled
  filter; count line shows "N open · M closed · K cancelled".
- Client home views (buyer/seller/TC): EXPECTED all land on the dead-link
  screen ("This code no longer works"). ACTUAL yes — get_client_view
  returns 'revoked', the gate fails closed. (Offline fail-open still renders
  the cached view — by design.)
- Realtor views: EXPECTED Cancelled chip on the card; "View clients"/"View
  TC" flip back to "Invite client"/"Invite TC"; no X on cancelled cards.
  ACTUAL yes — ClientList filters revoked invites; buttons count only
  non-revoked; onCancel is null for non-open escrows.

### closeEscrow — per-side (dual agency, first side)
- Invite codes: EXPECTED only the closed side's codes die; other side + TC
  stay live. ACTUAL yes — rolesToKill=[role]; revokeActiveInvites +
  pushRevoke scoped to that role.
- Device links: EXPECTED closed side's server links killed; other side + TC
  untouched. ACTUAL yes — converge ops only for the revoked invites.
- Steps: EXPECTED preserved (all done — enforced precondition). ACTUAL yes.
- Deal list: EXPECTED stays in Active (not whole-closed). ACTUAL yes —
  isClosedRow is false until every side closes; status stays 'open'. This is
  the approved per-side semantics, not a bug.
- Client home views: EXPECTED closed side's client -> dead-link screen;
  other side + TC -> normal home. ACTUAL yes.
- Realtor views: EXPECTED "Closed <date>" chip on the closed side only.
  ACTUAL yes.

### closeEscrow — whole (single-side close, or second side of dual)
- Invite codes: EXPECTED all die including TC. ACTUAL yes —
  rolesToKill=[role,'tc'] once applyDerivedStatus flips status to 'closed'.
- Device links: EXPECTED all server links including TC killed. ACTUAL yes.
- Steps: preserved. Deal list: EXPECTED Active -> Closed. ACTUAL yes —
  isClosedRow true.
- Client home views: EXPECTED all roles -> dead-link screen. ACTUAL yes.
- Realtor views: EXPECTED Closed chip; review gate still allows review at
  100% on a closed (non-cancelled) escrow. ACTUAL yes.

### revokeInvite (single)
- Invite codes: EXPECTED that code dies; sibling invites stay live. ACTUAL
  yes — local revoke + pushRevoke op + immediate drain.
- Device links: EXPECTED that invite's server links killed (the original
  zombie). ACTUAL yes — convergeLinkRevokes op; the Sept 28 correction
  (server-authoritative, never local data.links) plus the retryable-op fix
  below. Pinned with local data.links EMPTY (the production shape).
- Steps / deal list: untouched; escrow stays Active. Client home: EXPECTED
  revoked client -> dead-link screen, others unaffected. ACTUAL yes.
- Realtor views: EXPECTED "View clients" count drops, flips to "Invite
  client" at zero. ACTUAL yes.

### regenerateInvite
- Invite codes: EXPECTED old code dies atomically as the new code is
  issued (same escrow/role/party). ACTUAL yes — regenerate_invite RPC is
  atomic; the local+outbox fallback kills-then-issues in one critical
  section.
- Device links: EXPECTED old server link killed; old device -> "This code
  no longer works"; new device redeems the fresh code. ACTUAL yes —
  converge op on the old invite id; RPC path kills server-side atomically.
- Steps / deal list: untouched. Client home: new device sees the current
  checklist. Realtor views: share sheet shows the new code.

### activateEscrow
- Invite codes: EXPECTED stay revoked — reactivation starts with ZERO live
  codes (Anuraj-approved). ACTUAL yes — activateEscrow never touches
  invites.
- Device links: EXPECTED stay revoked — old clients do not silently regain
  access. ACTUAL yes — links untouched.
- Steps: EXPECTED preserved ("resumes where it left off"). ACTUAL yes.
- Deal list: EXPECTED back to Active. ACTUAL yes — status='open' AND
  buyerClosedAt/sellerClosedAt cleared (without the clear, isClosedRow
  would keep the card in Closed — the comment in code calls this out).
- Client home views: EXPECTED old links still dead -> dead-link screen
  until the realtor re-invites. ACTUAL yes.
- Realtor views: EXPECTED open state; "Invite client" buttons; address/dates
  updated from the reactivation input and pushed. ACTUAL yes.

### Gaps the side-effect pass caught and fixed in this branch
1. A FAILED server-link converge query stranded the zombie permanently.
   The one-shot query-then-enqueue design recorded a sync error but left
   NO op to retry — boot drain, manual Retry, nothing could recover the
   live server link. Fixed: convergence is now a retryable
   `convergeLinkRevokes` outbox op; the drain runs the live server query
   and stamps revoked_at, so a failure stays queued (attempts/manualOnly),
   surfaces in the sync-error list, and converges on the next drain or
   manual Retry. Pinned by a failure-injection test (failLinkSelect).
2. Direct `revokeClientLink` ops enqueued from LOCAL data.links ids could
   never match a server row — local ids are minted by the offline redeem
   fallback; server rows are created only by the redeem_invite RPC. In
   production they were empty no-ops; in the fallback case they would push
   revokes for nonexistent ids and produce permanent SyncNotAppliedError
   records. Removed; convergence is solely the invite_id query. The
   syncedstore regen test expectation was corrected (it had encoded the
   wrong model).

### Verified non-issues / open product questions (NOT changed — UI/behavior freeze)

## "LATEST FROM {NAME}" card — TC home coverage (Sept 28, 2026)

Side-effect pass (hard rule). The card already lived on the buyer and
seller homes (branding release, Sept 2026); the gap was the transaction
coordinator home, which now renders the same shared `LatestFromCard`
directly below the top card, above the checklist sections — always
visible, in every state. Enumerated surfaces and behavior:

- **Buyer home / seller home:** unchanged — already wired, placement and
  copy untouched.
- **TC home, both-side escrow:** the single card shows the most recent
  realtor action across BOTH sides (`mostRecentAction` in `src/lib/latest`,
  pure and unit-tested) — a seller-side checkoff wins over an older
  buyer-side one and vice versa. The `completedAt` fallback scans the
  combined steps. The opened-escrow fallback uses the buyer side's
  `openedAt`, else the seller's.
- **TC home, single-side escrow:** one side is null; the merge ignores the
  null side and behaves exactly like the buyer/seller card.
- **Closed/completed/cancelled escrows:** the card still renders (always
  visible) — the model derives from `lastAction`/`completedAt` regardless
  of lifecycle status. The existing known behavior (lastAction is not set
  by lifecycle actions) is unchanged.
- **Client-view refresh:** the card re-renders from the view state on the
  existing focus effect and foreground refresh — no new subscription, no
  push changes (notification rules are spec'd separately).
- **Multi-link / cross-escrow:** the card consumes only this escrow's own
  `TcView` — each escrow's view is built through its own device link, so
  no cross-realtor leakage is possible.
- **Realtor views:** untouched. No new component — reuse of
  `LatestFromCard` + `latestModel` (Anuraj's design rule: shared
  components implemented once).

Regression: `tests/latest.test.ts` now covers the TC merge (most-recent
wins, order independence, null-side, all-null fallback, tie) alongside the
existing card model tests.
- ~~Creating a NEW invite on a closed/cancelled escrow is allowed (no status
  gate in createInvite or the detail screen). Plausibly intended for closed
  escrows (client re-access to the completed file); questionable for
  cancelled. Open question for Anuraj.~~ **Decided Sept 28, 2026: BLOCKED.**
  Anuraj said no new invites on closed/cancelled escrows for any role —
  shipped in the "No new invites on a closed/cancelled escrow" release
  above (UI gates + store throw + migration 0018 server trigger +
  race-safe final rejection).
- The `closed` deal-list filter does not exclude cancelled — unreachable
  (cancel of a closed escrow throws; a dual-agency escrow cannot be
  whole-closed then cancelled), noted only.
- lastAction is not set by lifecycle actions — the client "Latest from"
  card keeps showing the last check/uncheck; acceptable because killed
  links route to the dead-link screen anyway.
- Unchecking a step on a closed side reopens the side (approved per-side
  semantics) but the killed client link stays dead until re-invited —
  consistent with explicit-close-kills-access.

## Push notifications: coalescing, quiet hours, check-ins (Sept 28, 2026)

Migration 0024 (0022/0023 reserved for the multi-escrow stream) ships the
full approved notification rules. Lessons:

- **Migration-number coordination matters when streams run in parallel.**
  The draft was written as 0022 before checking the reservation — the
  multi-escrow stream owned 0022+. Renamed to 0024 and documented the
  reservation in the migration header. Release-lead takeaway: reserve
  number ranges in the brief, not in the workstream.
- **Index widening belongs to the stream that changes the invariant.**
  Widening `push_tokens(device_id)` to `(device_id, escrow_id)` was in the
  push draft first, but multi-escrow is what makes it true — so it moved
  out of 0024 and into the multi-escrow stream. 0024's send paths already
  detect multi-escrow rows (address in the body) so nothing in push needs
  rewriting when the widen lands.
- **Quiet-stretch activity must be a durable server stamp, not derived.**
  `max(steps.completed_at)` lies after an uncheck (completed_at can survive
  the uncheck). 0024 stamps `escrows.last_checkoff_activity_at` ONLY on
  forward check-offs; the sweep, the re-arm, and the stale-queued-check-in
  revalidation all read that column.
- **Structural edits and unchecks are not pushes — the trigger encodes it.**
  Only INSERT-with-done and false→true transitions buffer; reorder/title
  edits and unchecks insert nothing. A checked custom step buffers as a
  normal completion (approved: custom steps included).
- **Copy conflicts need flagging, not silent invention.** The approved
  check-in examples used em dashes, contradicting the standing no-em-dash
  rule; shipped with colon/comma and flagged for Anuraj rather than silently
  "fixing" the punctuation.
- **Generator markers guard copy, so they must track copy.** The single-file
  generator's REQUIRED_MARKERS still pinned the old check-off sentence; they
  were updated to the approved copy plus the new cron-event/event-kind
  markers. Stale markers give false green.
- **Time math stays in the client's zone.** Quiet hours (21:00–08:00),
  next-08:00 queueing, and close-date day counting all run through an
  Intl-based zone offset — never the server's local clock. Tokens registered
  before timezone capture fall back to America/Los_Angeles.

Regression: `tests/push_coalesce_quiet.test.ts` (quiet-hour boundaries in
LA and IST, morning-queue targets, zoned day counting, coalesced + check-in
copy with an em-dash sweep, multi-escrow address, internal cron events,
TC/seller/buyer tap routing); `tests/push.test.ts` updated to the approved
check-off copy; `tests/run.sh` wires both.
## Secure realtime for client views (Sept 29, 2026)

- **The anon key proves nothing, so realtime needed its own credential.**
  Client views previously converged only on foreground-focus refetch.
  Supabase Realtime enforces RLS per row on the server, but the stock anon
  key carries no identity — so the `client-realtime-token` Edge Function
  validates (link_id, device_id) against `client_links` (link exists,
  unrevoked, invite unrevoked, device bound) and mints a 15-minute JWT
  signed with the project's JWT secret (`SUPABASE_JWT_SECRET`), claims
  `device_link_id` / `escrow_id` / `link_role`. The client passes it to
  `realtime.setAuth()` on a dedicated supabase client (the shared client
  keeps the realtor session untouched). Forgery requires the JWT secret.
- **Revocation must kill the stream at the database, not just in the app.**
  A revoked link's token stays signature-valid until expiry, so the 0030
  RLS policies on steps/escrows/realtor_profiles additionally require a
  LIVE link (`EXISTS ... revoked_at IS NULL` on both link and invite).
  The client's own `client_links` row is deliberately NOT revoked-filtered
  — that is how the client observes its own revocation and routes to
  /link-dead immediately instead of waiting for a foreground round-trip.
- **Realtime is an invalidation signal, not a data pipe.** On any event the
  client re-pulls `get_client_view` (debounced 750 ms to coalesce rapid
  check-offs). Payloads are never applied directly — no client-side
  conflict surface, no optimistic UI, the synchronous-writes model stands.
- **postgres_changes filters can't scope realtor_profiles by escrow**
  (the table has no escrow_id), so that binding has no filter — the 0030
  RLS policy scopes it server-side to the token escrow's realtor. Verified
  by binding assertion in `tests/client_realtime.test.ts`.
- **Token refresh must beat the heartbeat.** realtime-js closes the channel
  at token expiry with no automatic resubscribe, so the manager refreshes
  2 minutes early via setAuth; any failure falls back to the reconnect
  path, which mints fresh.
- **Migration numbering across parallel streams:** multi-escrow reserved
  0022+, so realtime took 0030 (recorded in the migration header) — the
  merge lead must keep 0030 out of the multi-escrow stream.
- **Test seam, not a mock framework:** `src/lib/clientRealtime.ts` takes
  injected deps (fetch, realtime client factory, timers), so the node
  suite pins the whole wiring contract (mint -> setAuth -> bindings ->
  callbacks -> reconnect -> teardown) without a socket.
- **Merge-time API drift between parallel streams is invisible to git.**
  The realtime stream called `auth.getClientLink()` (singular) while the
  multi-escrow stream had renamed the API to `auth.getClientLinks()`
  (plural, returns `DeviceClientLink[]`). Both streams were green alone;
  the merged tree failed `tsc` in `src/hooks/useClientRealtime.ts`. Git
  merges cleanly when streams touch different files, so the release lead
  must run the FULL typecheck on the merged tree (not just per-stream
  results). Fix: the hook now finds its escrow's link via
  `getClientLinks().find((l) => l.escrowId === escrowId)`.
- **tsconfig without `include` typechecks nested worktrees.** The parent
  tree's `wt/` holds full worktree checkouts (12k+ TS files); a bare
  `npx tsc --noEmit` tried to check them all and got OOM-killed. The
  shipping bar's typecheck must exclude `wt` (release-check config),
  matching what the unit suite already does with explicit file lists.
