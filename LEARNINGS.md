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
