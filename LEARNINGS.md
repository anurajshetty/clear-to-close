# Clear to Close — Learnings

Issues found while building, with root causes and the practice each one taught.
Updated with every fix. (Anuraj, Sept 27, 2026: every app keeps a learnings doc.)

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
