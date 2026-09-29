# Clear to Close

iOS + web app for the parties in a real-estate transaction. The realtor is the
central user; the buyers and sellers they represent are the other parties.

- **iOS is the real product** — Expo SDK 57, EAS builds → TestFlight.
- **Web is the test surface:** https://anurajshetty.github.io/clear-to-close/

## What it does

**For realtors**

- **Deal list** — a full-bleed banner section at the very top (118px strip,
  the realtor's synced banner image cover-cropped, brand-teal gradient
  fallback when no banner is uploaded; the realtor's photo sits on the
  strip's right side, 88px with a white ring, and opens the profile page
  on tap). Below it, the "Hi {realtor name}" greeting, "Escrows" title, and
  "{N} open · {M} closed · {K} cancelled" summary (the cancelled segment
  appears only when > 0). **+ New escrow** sits above the sections. Three
  collapsible sections — **Active escrows** (expanded), **Closed escrows**
  (collapsed), **Cancelled escrows** (collapsed) — each a bordered
  dropdown-style card header with up/down chevrons and 52px touch height.
  Deal cards (subtle 1px border, same as the section headers) show the side
  chip (**Buy side** / **Sell side** / **Both**) first, then the address,
  then the **buyer/seller name on its own line below**, then the countdown
  chip + step count + mini progress bar. Closed rows carry the **Closed**
  tag; cancelled rows are greyed with a **Cancelled** tag. Each card carries
  a pencil (edit) and X (cancel) icon in the upper-right corner (closed and
  cancelled cards show the pencil only). Empty state with a shortcut to
  create the first escrow.
- **Escrow lifecycle** — the time-tracker card shows the **Opened / Target close
  dates as display-only** (no edit controls on the detail screen — dates are
  changed from the home page's "Update escrow" flow, which covers both dates).
  The only date rule: the target close can't be before the opened date (equal
  is fine). The tracker recomputes day X of Y, the bar, and days-left from
  the dates. Past the target date the tracker turns red. The **"N days left
  to close"** line is centered. When every step is checked, the sage **"Close
  escrow"** banner appears —
  once closed it becomes a **"Closed" indicator** (sage tag + "Closed {date}.",
  no button) and the escrow moves under **Closed escrows**. **Unchecking any
  step moves the escrow back to Active** (indicator hides, banner returns when
  re-completed). **Dual agency closes per side**: each tab has its own
  **"Close buyer side" / "Close seller side"** button and **"Closed"
  indicator** — closing the buyer side leaves the seller side active and vice
  versa; unchecking reopens only that side. **Explicit close revokes client
  access** (Anuraj, Sept 2026): the moment a side closes, that side's live
  buyer/seller device links are revoked (the transaction coordinator's links
  are revoked once the whole escrow is closed). **Invite codes die with the
  close** (Anuraj, Sept 28, 2026): a per-side close revokes that side's
  active invite codes (the other side's codes and the coordinator's code
  stay live); closing the final side revokes the buyer, seller, AND
  coordinator codes. Already-revoked invites are untouched. **No new invites
  on a dead escrow** (Anuraj, Sept 28, 2026): once the whole escrow is closed
  or cancelled, new invite codes cannot be created for any role — the detail
  screen's Invite buttons and the client list's "Invite another" offer are
  hidden, local creation throws, and the server rejects the insert
  (migration 0018). Existing live invites stay visible and revocable. The
  revocation is pushed to
  the cloud immediately — no app restart needed — and a client with the
  escrow already open is re-checked when the app is foregrounded. A revoked
  client fails the link gate and lands on "This code no longer works" (the
  `/link-dead` screen), the same state as an expired or regenerated code. A
  100%-complete escrow that is still open is NOT a close: the client's links
  keep working and the top card shows "Completed" with the confetti burst.
- **New escrow** — open an escrow with open/end dates and a side picker
  (Buy side / Sell side, multi-select for dual agency). Dates use a simple
  date picker (native date input on web, minimal inline picker on native —
  no popup-overlap pattern). Client-name fields
  adapt: one field for a single side, buyer + seller fields when both are
  picked. Two-phase create (Anuraj, Sept 28, 2026): submit validates, then
  shows a confirmation screen summarizing the side, property address,
  client name, and both dates — "Create escrow" creates it, "Back to edit"
  returns to the form with every value preserved.
- **Edit escrow** — the pencil opens an "Update escrow" sheet identical to
  the new-escrow form with every value pre-populated and editable, EXCEPT
  the side: the side is locked after creation (Anuraj, Sept 28, 2026) and
  submits unchanged. Saving updates the card in place with an
  "Escrow updated." toast.
- **Activate escrow** — the same pencil on a closed or cancelled escrow opens
  the sheet with an "Activate escrow" submit button: saving the edits flips
  the escrow back to open and moves the card to the Active list ("Escrow
  activated." toast). Checklist state, invites, and client links carry over
  unchanged. The "Cancel this escrow" danger action stays open-escrows only.
- **Cancel escrow** — the X (or the "Cancel this escrow" action inside the
  update sheet) asks for confirmation, then moves the card to a collapsible
  "Cancelled escrows" section, greyed with a Cancelled tag; the header
  counts update ("N open · N closed · N cancelled"). **Cancelling revokes
  every active invite code** for the escrow (buyer, seller, and transaction
  coordinator) — the codes die with the escrow, and any redeemed device
  link is killed at the same moment. Closed and cancelled
  cards show the pencil only.
- **Transaction detail** — per-escrow home with:
  - **Time tracker** — escrow open date, end date (display-only), and where
    today falls between them (day X of Y). Turns red once the end date passes.
  - **Checklist stepper** — default steps per side (13 buyer steps, 12 seller
    steps, mirroring the approved design), plus realtor-added **custom steps**.
    One single list everywhere — no completed/remaining grouping; checked
    steps stay in place and the UP NEXT tag marks the first remaining step.
    Progress ring recalculates against the new total.
  - **Checklist edit mode** — the pencil at the top-right of the checklist
    opens edit mode: the header swaps to a discard X (left) and a teal tick
    (right), rows become inert, every row shows a drag grip and a red remove
    control, and **+ Add a custom step** becomes a sticky pinned footer that
    stays visible while scrolling. The tick saves the whole draft with one
    server-confirmed write ("Checklist updated."); the X discards all draft
    changes. Removing a checked step from a closed side keeps it closed while
    the remaining steps are all complete; adding an unchecked step reopens
    the side. Structural edits never notify clients.
  - Dual-agency escrows get independent **Buyer | Seller** tabs — the two
    checklists are fully separate, each with its own ring and edit draft;
    rows carry Buyer/Seller tags.
- **Realtor profile** — fields in this order: profile pic, banner image,
  full name, email (optional), phone (optional), **broker** (optional, e.g.
  "Compass Realty", shown on the branded client
  surfaces as "Compass Realty · DRE #01998877"), about/bio, years of
  experience, areas served, and optional license number (shown on the
  client-facing profile only if entered). The phone number powers the
  **Call** and **Text** buttons on the client-facing profile (dialer /
  SMS); email stays on the realtor side. Profile
  photos are auto-downscaled at pick time (long edge ≤ 1024px, JPEG ~0.8,
  target ≤ ~1MB) and stored as a single managed file — one fixed filename
  in the app's document directory, overwritten on every pick (one
  localStorage key on web) — so old photo files never pile up and the OS
  can't purge the photo. After picking a photo or banner, an **in-app crop
  editor** opens before saving: drag to position, pinch or use the zoom
  slider, with a circular frame showing exactly what lands in the photo
  circle and a wide ~2.5 : 1 frame showing exactly what lands in the banner
  strip; "Use photo" / "Use banner" saves the cropped result (still
  auto-shrunk to ≤ 1024px), Cancel / Retake backs out without saving. On every profile save the downscaled photo and
  banner upload to the public Supabase Storage bucket `realtor-media`
  (paths `<user_id>/photo.jpg` and `<user_id>/banner.jpg`, single overwrite
  files), so client devices see them on the branded surfaces; the local
  managed files remain the offline source and display fallback, and a failed
  upload quietly keeps the profile local-only. Each upload stamps a fresh
  `?v=<timestamp>` on the stored Storage URL so client devices drop the
  stale cached image and show the new photo/banner right after the realtor
  saves. The upload runs only on the synchronous live save (server first,
  local second — an offline or failed save throws and uploads nothing) and
  only when the image actually changed (a name-only edit never re-uploads
  or churns the `?v=`), so a photo can never strand a half-uploaded state
  on the server. An optional **banner image**
  follows the identical single-file pattern under its own fixed
  filename/key, synced like the photo. The banner upload shows a recommended
  size computed from the celebration card banner strip's actual dimensions
  (`src/lib/bannerSize.ts`, about 2.7 : 1, e.g. 1024 x 386 px) so the
  cover-cropped banner fills the strip with the least cropping. On the
  profile-edit page the photo and banner each get a small X badge at their
  corner, shown only when an image is set: tapping the image still opens
  the picker (change flow), tapping the X clears the image from the draft
  (no confirmation — Save is the commit point). Saving with a cleared
  image deletes the local managed file and the `<user_id>/photo.jpg` or
  `<user_id>/banner.jpg` object from the `realtor-media` bucket, and clears
  `photo_url` / `banner_image` on the profile row so clients fall back to
  the initials and the teal gradient; if the server removal cannot
  complete, the save is not reported as done. Clearing then picking a new
  image before saving uploads the new image (the new image wins). Editable
  anytime via the photo on the deal-list banner strip. A quiet **Change password**
  row below Save opens a bottom sheet (current / new / confirm, masked with
  show/hide toggles; 8+ characters, same rule as sign-up): the current
  password is verified server-side, and success shows a "Password updated."
  toast. A quiet **Log out** row below it signs out immediately (no
  confirmation): web returns to the login screen, native clears the persisted
  session fully and returns to the role picker. **Log out wipes the whole
  local account cache** — profile, photo/banner, escrows, invites, client
  links, cloud-view caches, and queued sync operations are all removed, so a
  different realtor signing in next on the same device starts with a
  fresh/empty account and never sees the previous account's data (local cache
  keys are not per-account, so the wipe is the isolation). The sync outbox is
  dropped, never drained — draining would stamp the new session's user id onto
  the old account's pending operations. The device client link is cleared too
  (a stale link would boot the device straight back into the client view), as
  is any client link when a realtor session is newly established. Device-level
  state (chosen role, device id, push-asked) is kept.
- **Share / invites** — per-escrow, per-party single-use invite codes
  (6 characters, globally unique). Each code is bound to
  (escrow, role, party name); name and code must both match at redeem time.
  Up to **two clients per escrow side** (buyer and seller caps are
  independent), enforced in the app and by a database trigger — revoking
  frees a slot. On the transaction detail, **Invite client** sits at the end
  of the checklist (per side / per dual-agency tab) and becomes **View
  clients** once an invite exists: name + Invited (amber) / Accepted (teal)
  status, code + Copy on invited rows, per-client Regenerate and Revoke.
  **Regenerate** issues a fresh code while atomically killing the old code
  *and* its device link — the old device lands on a clear "this code no
  longer works" state. **Revoke** kills the invite *and* its linked client
  access; the revoked row disappears from the list. **Copy invite link**
  copies a branded deep link
  (`https://anurajshetty.github.io/clear-to-close/invite/<CODE>?name=<PARTY>`):
  opening it shows the single redeem form with the realtor's branded welcome
  (name, photo, realty group, DRE), the invite code and party name pre-filled
  (both editable), and one "Join your escrow" button. The role label reads
  "Transaction Coordinator" for TC invites and "client" for buyer/seller.
  One **transaction coordinator** per escrow (cap of 1, independent of the
  buyer/seller caps): the checklist footer gains **Invite transaction
  coordinator** / **View TC**, managed through the same
  invite sheet and client list with the same code/regenerate/revoke
  lifecycle, including the branded invite link. Tapping the row's remove (x)
  now asks for confirmation in a popup dialog right at the point of action,
  so the Remove button is seen immediately. A redeemed TC invite opens
  the TC's read-only home at `/client/tc/<escrowId>`: on a both-side escrow
  the TC sees **both** the buyer and seller checklists (labeled sections,
  combined progress), on a single-side escrow the active side's — reusing
  the same top card and read-only checklist as the client views.
- **Onboarding / auth** — first launch shows a role picker
  ("I'm a Realtor" / "I'm a client — I have an invite code"). Realtors sign up
  with email + password in two steps: account creation, then profile creation
  (skippable — "Skip for now" goes straight to the deal list). Login is email
  + password; password reset via email — the emailed link opens a
  "Set new password" screen in the browser (expired links get a fresh-link
  path). The session persists on both
  platforms — **web** in localStorage, **native iOS** in its own storage —
  so a refresh keeps the realtor signed in, on the same screen. The session
  ends on Log out, or when the browser/incognito session ends.

**For buyers / sellers (clients)**

- No account — one redeem form with **Your name** and **Invite code** fields
  and a single **Join your escrow** button. A branded invite link
  (`/invite/<CODE>?name=<PARTY>`) pre-fills both fields (editable) and shows
  the realtor's branded welcome (name, photo, realty group, DRE) on the same
  form. The confirmation screen is a light **celebration card** (approved
  redesign, Sept 2026): a white card with a subtle border and 24pt radius,
  topped by a 132px banner strip showing the realtor's synced banner
  (cover-cropped; brand-teal gradient fallback when no banner is uploaded).
  No profile photo on the banner. Below the strip: the amber uppercase
  "Congratulations, {client name}" kicker (the redeemed invite's party
  name), the "Your escrow is open!" headline, "{realtor name} has your
  checklist ready." and "Follow your progress right here." A confetti burst
  pops up from below the card on mount (the shared `ConfettiBurst`, skipped
  when the OS reduced-motion setting is on). Below the card: "View my
  escrow" and "Not your escrow? Start over". At the bottom of the screen a
  "YOUR REALTOR" footer shows the realtor's photo (124px, synced with the
  device-local fallback); tapping it opens the realtor's profile **in-app**
  (never a browser tab). Redemption binds
  access to the device; reopening the app goes straight back into the escrow.
- **Read-only checklist** styled exactly like the realtor's stepper (check
  circles, short connector segments, subtitles, UP NEXT tag) but with no tap
  targets, no drag grips, and no "Custom" tag. One single list in the
  realtor's order — checked steps stay in place. No recency markers of any
  kind.
- **Client home top card** — light theme (approved client-home-card
  sample, Anuraj, Sept 2026): solid white card with a subtle border and a
  soft shadow. A banner header strip on top shows the realtor's synced
  banner (cover-cropped; brand-teal gradient fallback); the realtor's photo
  sits on the banner's right side (tappable, opens the realtor profile
  in-app). Bold "Hi {name}" headline, then the "Your transaction"
  kicker plus the escrow status tag, then the address lines. Centered below:
  "N of N steps" above the progress ring (amber-gold #E3B95C on the light
  track), then the days line — "days left: N" (the number is ink normally,
  amber at 7 or fewer days, red at 3 or fewer days), "due today" on the
  target date, red "overdue by N day(s)" past it. Above the step count the
  card reads "{realtor name} completed"; below the days line an escrow
  timeline row shows the start date left, the target close date right, and
  a gold bar on the same line showing time elapsed (hidden when the escrow
  has no dates). The card is responsive and viewport-fitted: the sample pins
  exact sizes at the 390pt and 320pt phones (the `TOPCARD_TOKENS` table in
  `src/lib/topCard.ts`), flipping at a 355pt breakpoint, and a height ladder
  (roomy/compact/ultra) scales the ring, spacing, and type down on shorter
  screens — the whole card always fits the visible screen without scrolling;
  scrolling is only for the content below it.
  - **Escrow status tag** — next to the "Your transaction" kicker,
    a small tag reads **"In progress"** or **"Completed"** (mirrors the
    `get_client_view` escrow status, migration 0015; "Completed" once the
    checklist is 100% done or the escrow is closed). "Completed" fills amber;
    "In progress" is an amber outline.
  - The pace pill and the completion pill are gone (Anuraj, Sept 2026): no
    pace logic anywhere, in any state. The only per-status changes on the
    top card are the status tag flip and the confetti burst.
  - **"LATEST FROM {NAME}" card** — directly below the top card, above the
    checklist, always visible, on the buyer, seller, and transaction
    coordinator homes. Shows the single most recent realtor action:
    "Checked off {step} · {relative time}" with a green check, or the honest,
    neutral "Reopened {step} · {relative time}" when a step is unchecked, or
    "{FirstName} opened your escrow · {relative time}" when nothing is
    checked off yet. On the TC home the action is merged across both sides
    (the most recent of the buyer/seller `lastAction`s wins). Relative time: just now (<5 min), Xm ago, Xh ago,
    Yesterday, Xd ago, then "Mar 3" style dates. The action is stamped on
    every toggle (`Escrow.lastAction`, additive migration
    `supabase/migrations/0009_escrow_last_action.sql`); escrows that predate
    the stamp derive the latest checkoff from `completedAt`.
  - **"KEY DATES" entry + sheet** (Sept 28, 2026, Anuraj-approved) —
    directly below LATEST FROM on the buyer, seller, and TC homes: a
    calendar glyph + "Key dates" + the most urgent date as a quiet hint
    ("Inspection contingency · in 3 days") + chevron. Tapping opens a bottom
    sheet with the four rows (Closing date, Inspection contingency deadline,
    Appraisal deadline, Loan approval date): each row shows "Oct 30" (no
    year) plus "today" / "tomorrow" / "in N days" / "overdue by N days" —
    amber when within 7 days, red when overdue, muted otherwise. Dates are
    set by the realtor on the Update escrow sheet (optional fields, open
    escrows only); unset dates show "Not set". Migrations
    `supabase/migrations/0019_key_dates.sql` (columns),
    `0020_step_template_key.sql` (permanent template keys + explainers),
    `0021_key_dates_push.sql` (key-date changes fire the client push:
    "Your closing date is now Nov 15, 2026." for a single changed date,
    "{First} updated your key dates." for several changed together).
  - **Step explainers** (Sept 28, 2026, Anuraj-approved) — client checklist
    rows with an explainer are tappable: tap reveals a one-line
    plain-language explanation below the title, tap again collapses; rows
    without one stay non-interactive. Default steps resolve by permanent
    template key (never by title — a renamed step keeps its explainer, a
    custom step titled like a default never inherits one); custom steps show
    only the realtor's optional "What does this mean?" line (140 chars max,
    set when the step is added). A quiet "Tap any step to learn what it
    means." sits under the list. Checked steps carry a muted
    "Completed Sep 18, 2026" line (year always shown, from the server
    checkoff timestamp; cleared on uncheck). The LATEST FROM card's step
    name taps to reveal the same one-liner.
  - **Key-date lifecycle lock** (Sept 28, 2026, Anuraj-approved) — key dates
    are editable only on open escrows. On closed/cancelled escrows the
    Update escrow sheet shows the Key dates section locked (current values
    read-only) with a **"Reactivate escrow"** button — the ONLY path that
    reactivates. The main "Update escrow" button saves ordinary edits
    (address, names, open/close dates) without reactivating; the store
    backstop rejects any key-date write on a non-open escrow.
  - **100%** — the top card stays the same card: the status tag flips to
    "Completed" and the unified confetti **burst** pops up from below the
    card (the shared `ConfettiBurst`, reduced-motion aware). There is no
    separate 100% triumph card (removed, Anuraj, Sept 2026): no
    "Just closed!" card, no pace or completion pill in any state.
- **Below the top card (100% and not cancelled)** — the review feature
  is **on hold** (Anuraj, Sept 2026): the review/share entry points are not
  surfaced. All review code stays intact (the `canLeaveReview` gate, the
  0015 escrow-status wiring, the review sheet, and the
  `ClientTriumphSection` below), gated by `REVIEWS_ENABLED = false` in
  `src/lib/clientView.ts`; flipping it back to true resurfaces the section:
  the checklist collapses to one
  tappable row ("{N} of {N} steps complete") that expands inline; a gold
  **"Leave {FirstName} a review"** button (opens the review sheet; the wiring
  point is `ClientTriumphSection.onLeaveReviewPress` in
  `src/components/ClientTriumph.tsx`, connected by the merge lead once the
  profile branch's review sheet lands), a **"Share {FirstName}'s profile"**
  button, and the referral line "Know someone buying or selling? Send them
  your realtor." Sharing uses the native share sheet where available,
  `navigator.share` on web, and clipboard copy as the graceful fallback, with
  the approved copy (`src/lib/shareCopy.ts`) pointing at the public profile
  URL `https://anurajshetty.github.io/clear-to-close/realtor/<realtor-id>`.
  Share copy never uses gendered pronouns, never uses em dashes, and never
  mentions a deals-closed count.
- **Realtor profile (client view)** — hero card with the 96px photo, name,
  the branded brokerage/license line ("Compass Realty · DRE #01998877";
  realty group and license each shown only when entered, no dangling
  separators), and a **tap-to-call
  phone row** (PHONE label, opens the dialer); About / stats / areas cards
  evenly spaced; the "One profile — shown across all escrows" footer note.
  A prominent "Back to my escrow" button returns to the client's home
  screen. No Call / Message actions.
- **Public realtor profile** — a shareable page
  (`/realtor/<id>`, opens with no login) with the banner, photo, name,
  branded subline, About, and the public stats: **Years in** and
  **Client rating** (the average of that realtor's client reviews,
  shown only when reviews exist).
- **In-app realtor profile** (`/realtor-profile`, approved v3, Sept 2026) —
  opened by tapping the realtor's photo on the redeem celebration AND on the
  client-home banner photo, always as an
  in-app push (never the public `/realtor/<id>` page; Sept 2026 fix — the
  client-home taps were misrouted to the public page). A 150px banner strip on
  top with the
  back chevron overlaid (no title text; the chevron returns to the previous
  screen, and when there is no in-app history — e.g. a web deep link — it
  falls back to an explicit replace to this device's client home screen).
  The strip shows the realtor's synced
  banner (cover-cropped, synced Storage `banner.jpg` first, device-local
  file offline; the teal gradient renders only when no banner is uploaded).
  The big 140px profile photo overlapping
  below the banner (clipped inside its circular frame), then the shared
  profile content pared down: name,
  branded subline, About, **Years of experience** (section title + chip,
  same styling as Areas I serve — no white card), and Areas I serve — no "What
  clients say" reviews section. **Call** and **Text** buttons below (dialer /
  SMS). The profile body is the shared `RealtorProfileView`
  (`src/components/RealtorProfileView.tsx`) in its `inApp` variant, the same
  component the public page uses, so the content cannot drift.
- **Client reviews** — **on hold** (Anuraj, Sept 2026): the review/share
  entry points are not surfaced (`REVIEWS_ENABLED = false` in
  `src/lib/clientView.ts`); all review code and gating stays intact. When
  re-enabled: after the escrow completes (and only if it was not
  cancelled), the client can leave a review: a star rating plus one line of
  text. Reviews are per-realtor and
  keyed to the client's link, so each client can leave (and later edit or
  delete) exactly one review. The public profile lists them newest first.
- **Live updates** — every realtor checkoff updates the client home and
  progress bar. Custom steps render like any other step (no "Custom" tag on
  client views).
- **Push notifications (iOS native only)** — after redeeming, the client is
  asked once whether to allow notifications ("Stay in the loop": "Get
  notified the moment {first name} checks off a step — you'll never have to
  keep checking"). **Forward progress only**: a push fires when the realtor
  checks off a step, adds a custom step, or moves the target close date;
  **unchecking a step never sends a push**. Tapping a notification opens the
  client's escrow home. While the app is open, no banner appears (the Latest
  card shows the update). Web is out of push scope — no prompt, no tokens.
  Requires a fresh iOS binary (new native module) — see "iOS release".
- Buyer access can never expose seller data and vice versa.

**Sync** — Supabase-backed cloud sync activates under the realtor's
email/password identity. Checklist state lives on the escrow, never on the
device; the device link is only the access key. Per-side close dates sync via
the `buyer_closed_at` / `seller_closed_at` columns on `escrows` (migration
`supabase/migrations/0007_per_side_close_dates.sql` — **apply it on the
Supabase dashboard SQL editor**; until it is applied, escrow pushes fall back
to the pre-migration column set instead of failing, and close dates stay
local-only). **Every user-initiated write is synchronous and server-first**:
the app sends the change to the server and waits for confirmation (15s
timeout; 30s for profile-with-media, cancel, and close), and only then
applies it to the local cache. A failure throws a plain-language error and
leaves local state exactly as it was — nothing may look saved when it
wasn't, and no user action is ever queued for background retry. Boot,
foreground return, and pull-to-refresh are pure PULL: the app never pushes
saved local data on boot or foreground return — PUSH happens only as the
direct result of an explicit user action (tap Save, check a step, generate
an invite, close a deal). The old background outbox is retired: one final
drain of legacy queued operations runs on upgrade, then it is gone. The
local snapshot is never the eternal source of truth: on boot (and when the
app returns to the foreground) the realtor profile is refetched from the
server and replaces the stale local snapshot, and the client side refetches
its linked escrow view the same way. Two-writer conflicts follow explicit
documented rules (see docs/CONFLICT_RULES.md and ARCHITECTURE.md):
last committed push wins for profile and escrow units (server commit order
arbitrates), and invite terminal states (redeemed/revoked) are write-once —
a stale server read never clears them. The full per-write side-effect
matrix lives in `tests/synchronous_write_side_effect_matrix.md`.

**Sync failure reporting** — every write fails loudly, right where it
happened: a failed save throws a plain-words error shown on the form
(for example, "Couldn't reach the server. Your change was not saved. Check
your connection and try again." for connection problems, and the specific
next step for each client redeem failure). Local state is unchanged, so
there is nothing to retry in the background. The persistent red bar at the
top of the realtor app now surfaces only **legacy** failures left over from
the retired background-push model: it says what failed and the next step
("Check your connection, then tap Retry."). **Retry** re-runs the legacy
drain; the bar clears the moment the writes land. Once the legacy queue is
empty, the bar goes quiet permanently. Client devices never see this bar.

**Sheets on small screens** — every modal sheet wraps its content in a
height-bounded scroll region (the grabber stays outside it), so lower fields
and the primary button are reachable by scrolling at any viewport. When the
software keyboard opens, the shared sheet lifts above it and the scroll
region shrinks to the visible area — the focused field stays visible and the
save button is never buried behind the keyboard.

## Tech

- Expo SDK 57 + TypeScript (strict) + expo-router, iOS + web from one codebase
- Local state in AsyncStorage; cloud sync via Supabase (Postgres + Auth + RPCs)
- Anonymous auth stays **disabled** — sync runs under the realtor's
  email/password identity from the start

## Setup

```sh
npm install
```

Copy the Supabase project URL and anon key into `.env` (gitignored — never
commit keys):

```sh
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```

Run the migrations in the Supabase dashboard SQL editor, in order:

- `supabase/migrations/0001_init.sql` — base schema: profiles, escrows,
  role-specific steps, globally unique invites, client links, RLS,
  `redeem_invite`, `get_client_view`
- `supabase/migrations/0002_device_linking.sql` — device id on `client_links`,
  atomic `regenerate_invite`, link-validating `get_client_view`, DRE/license
- `supabase/migrations/0003_revoke_regen_public.sql` — `regenerate_invite` is
  realtor-only (authenticated role)
- `supabase/migrations/0004_revoke_regen_anon.sql` — explicit
  `regenerate_invite` revoke from `anon` (belt-and-braces alongside 0003)
- `supabase/migrations/0005_two_per_side_cap.sql` — database trigger
  enforcing the two-active-clients-per-side cap on `invites` inserts
  (per-side advisory lock so concurrent inserts can't slip under the cap);
  `regenerate_invite` reordered to revoke-then-insert so rotation still works
  at 2/2 (revoked links/invites were already rejected by `get_client_view`
  since 0002)
- `supabase/migrations/0006_escrow_cancelled.sql` — widens the `escrows`
  status check to `('open', 'closed', 'cancelled')` for the deal-list
  edit/cancel round
- `supabase/migrations/0007_per_side_close_dates.sql` — adds
  `buyer_closed_at` / `seller_closed_at` date columns on `escrows` for the
  per-side close lifecycle (dual agency closes buyer/seller independently)
- `supabase/migrations/0008_push_tokens.sql` — client push notifications:
  `push_tokens` table (one live Expo token per device), `push_config`
  kill-switch flag, `register_push_token` / `unregister_push_token` RPCs
  (granted to `anon`; clients have no login), and the forward-only DB
  triggers (`steps` checkoff/custom insert, `escrows` target-close-date
  change) that call the `send-client-push` Edge Function via `pg_net`.
  **Additive only** — no existing tables/columns are altered or dropped, so
  the pre-push app keeps working against the migrated DB.
- `supabase/migrations/0009_escrow_last_action.sql` — adds the nullable
  `last_action` JSONB column on `escrows`: the durable "true last action"
  stamp (`{"kind":"checked"|"reopened","stepTitle","at"}`) behind the client
  home's "LATEST FROM" card. Additive-only (`ADD COLUMN IF NOT EXISTS`);
  the app syncs the column defensively and works when it is absent.
- `supabase/migrations/0010_realty_group.sql` — adds the nullable
  `realty_group` and `banner_image` text columns on `realtor_profiles` for
  the realtor's brokerage and banner image (both field names are
  contractual: other surfaces read them by name). Until applied, the app
  still runs: profile upserts/pulls fall back to the pre-migration column
  set (both fields stay local-only) instead of failing.
- `supabase/migrations/0011_public_profile.sql` — adds the nullable
  `avg_days_to_close` (text) and `rating` (numeric) columns plus the
  server-side `reviews` table (one review per client link, keyed by the
  client link id, never publicly readable). Maintains `rating` with a
  trigger on review writes; exposes `get_public_profile` (public realtor
  page), `resolve_invite_realtor` (branded invite welcome, callable by
  anonymous clients), and the `upsert_review` / `delete_review` RPCs
  (client-link ownership enforced server-side). Additive-only: pre-release
  code keeps working against the migrated DB.
- `supabase/migrations/0012_tc_invite.sql` — widens the `invites`/`client_links`
  role checks to include `tc`; replaces the two-per-side cap trigger with one
  enforcing 2 per buyer/seller side and 1 transaction coordinator per escrow
  (same per-role advisory lock, regeneration revoke-first behavior unchanged);
  re-creates `get_client_view` additively with the TC branch (role `'tc'`,
  both `buyer_steps` and `seller_steps`) on top of the 0011 reviews contract
  (full-row profile + `reviews` + `my_review_id`). Additive-only.
- `supabase/migrations/0017_client_view_profile_fields.sql` — re-creates
  `get_client_view` so the client-view profile is an **explicit field list**
  (`name`, `photo_url`, `banner_image`, `about`, `years_experience`,
  `areas_served`, `phone`, `dre_license`, `realty_group`, `rating`, `reviews`)
  instead of the full `realtor_profiles` row: the `email` column (0016,
  realtor-side only) no longer ships to linked clients. Phone stays (clients
  need it for Call/Text). Every key app code reads from the client-view
  profile is kept, so old and new app builds work unchanged. **Apply it on
  the Supabase dashboard SQL editor** — until it is applied, clients keep
  receiving the full profile row (with email) from the old function.

## Scripts

```sh
bash tests/run.sh          # unit + auth/invite/sync suites
npx tsc --noEmit           # strict typecheck
npm run export:web       # web export (clears Metro cache)
npx expo export --platform ios   # iOS export must stay green
python3 scripts/deploy_gh_pages.py   # deploy web to gh-pages
```

## Push notifications (dashboard steps, Anuraj's)

After the app change ships, pushes need three server-side steps in the
Supabase dashboard (one-time):

1. Run `supabase/migrations/0008_push_tokens.sql` in the SQL editor
   (`pg_net` must be enabled: Database → Extensions). The migration mints a
   trigger shared secret into Vault and prints it once as
   `PUSH_TRIGGER_SECRET` — copy it.
2. Deploy the `send-client-push` Edge Function from the generated single
   file `~/workspace/your_files/send-client-push-single.ts` (regenerate with
   `python3 tools/make_send_client_push_single.py` after any source change —
   never hand-edit the generated file). Set its secrets:
   `PUSH_TRIGGER_SECRET` (from step 1), `EXPO_ACCESS_TOKEN` (expo.dev →
   Access Tokens).
3. Confirm Apple Push credentials for the EAS project, then build + submit
   a fresh iOS binary (`eas build --platform ios` / `eas submit --platform
   ios`) — the `expo-notifications` native module is compiled into the app,
   so pushes cannot work on the currently installed build. Also run
   `eas init` (or add `extra.eas.projectId`) if the project isn't linked:
   without a project ID the client can't mint an Expo push token.

Kill switch (no code deploy needed): pause all pushes with

```sql
update push_config set value = 'false' where key = 'push_enabled';
```

(re-enable with `'true'`), or disable the triggers outright:

```sql
alter table steps   disable trigger trg_steps_push_notify;
alter table escrows disable trigger trg_escrows_push_notify;
```

Physical-iPhone checks (can't be automated): redeem a client code → allow
notifications → background/kill the app → check off a step as the realtor
from another device → push arrives and taps through to the client home; no
banner while the client app is foreground; unchecking sends nothing;
custom-step and target-date pushes arrive; denied permission never re-prompts
(turn it back on in iOS Settings).

## iOS release (Anuraj's step)

```sh
eas build --platform ios
eas submit --platform ios
```

This release adds the `@react-native-community/datetimepicker` native module
(inline date picker on New/Edit escrow) — the installed iPhone app needs a
fresh `eas build` to pick it up; the web deploy alone won't include it.

The push release also adds the `expo-notifications` native module and its
Expo config plugin — it rides the same fresh binary (pushes never work on
the currently installed build).

Every web feature/fix ships identically on iOS — the two must never drift.

## Repo conventions

- Build strictly to the approved mockup specs
  (`~/workspace/app-ideas/realtor-app/design/`); shared components are built
  once and reused — no divergent copies.
- Full local verification before every push: typecheck, tests, iOS + web
  exports, real boot test, live-URL verification after deploy.
- **Keep this README current** — every feature added, changed, or removed
  updates this file in the same release.
