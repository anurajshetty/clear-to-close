# Clear to Close

iOS + web app for the parties in a real-estate transaction. The realtor is the
central user; the buyers and sellers they represent are the other parties.

- **iOS is the real product** — Expo SDK 57, EAS builds → TestFlight.
- **Web is the test surface:** https://anurajshetty.github.io/clear-to-close/

## What it does

**For realtors**

- **Deal list** — "Hi {realtor name}" greeting, "Escrows" title, and
  "{N} open · {M} closed · {K} cancelled" summary (the cancelled segment
  appears only when > 0). **+ New escrow** sits above the sections. Three
  collapsible sections — **Active escrows** (expanded), **Closed escrows**
  (collapsed), **Cancelled escrows** (collapsed) — each a bordered
  dropdown-style card header with up/down chevrons and 52px touch height.
  Deal cards show the address, the city on its own line, and the
  **buyer/seller name on its own line below**, then the countdown chip + step
  count + mini progress bar. Closed rows carry the **Closed** tag; cancelled
  rows are greyed with a **Cancelled** tag. Each card carries a pencil (edit)
  and X (cancel) icon in the upper-right corner (closed and cancelled cards
  show the pencil only). Empty state with a shortcut to create the first
  escrow.
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
  versa; unchecking reopens only that side.
- **New escrow** — open an escrow with open/end dates and a side picker
  (Buy side / Sell side, multi-select for dual agency). Dates use a simple
  date picker (native date input on web, minimal inline picker on native —
  no popup-overlap pattern). Client-name fields
  adapt: one field for a single side, buyer + seller fields when both are
  picked.
- **Edit escrow** — the pencil opens an "Update escrow" sheet identical to
  the new-escrow form with every value pre-populated and editable, including
  buyer↔seller↔both side switching. Saving updates the card in place with an
  "Escrow updated." toast.
- **Cancel escrow** — the X (or the "Cancel this escrow" action inside the
  update sheet) asks for confirmation, then moves the card to a collapsible
  "Cancelled escrows" section, greyed with a Cancelled tag; the header
  counts update ("N open · N closed · N cancelled"). Closed and cancelled
  cards show the pencil only.
- **Transaction detail** — per-escrow home with:
  - **Time tracker** — escrow open date, end date (display-only), and where
    today falls between them (day X of Y). Turns red once the end date passes.
  - **Checklist stepper** — default steps per side (13 buyer steps, 12 seller
    steps, mirroring the approved design), plus realtor-added **custom steps**
    placeable anywhere via drag reorder. Only the realtor checks steps off,
    in any order. One single list everywhere — no completed/remaining
    grouping; checked steps stay in place and the UP NEXT tag marks the first
    remaining step. Progress ring recalculates against the new total.
  - Dual-agency escrows get independent **Buyer | Seller** tabs — the two
    checklists are fully separate, each with its own ring, reorder, and
    custom steps; rows carry Buyer/Seller tags.
- **Realtor profile** — photo, about/bio, experience, areas served, optional  DRE/license number (shown on the client-facing profile only if entered),
  and an optional **phone number** (syncs to the cloud profile). Profile
  photos are auto-downscaled at pick time (long edge ≤ 1024px, JPEG ~0.8,
  target ≤ ~1MB) and stored as a single managed file — one fixed filename
  in the app's document directory, overwritten on every pick (one
  localStorage key on web) — so old photo files never pile up and the OS
  can't purge the photo. Device-local photos never sync to the cloud.
  Editable
  anytime via the avatar in the deal-list header. A quiet **Change password**
  row below Save opens a bottom sheet (current / new / confirm, masked with
  show/hide toggles; 8+ characters, same rule as sign-up): the current
  password is verified server-side, and success shows a "Password updated."
  toast. A quiet **Log out** row below it signs out immediately (no
  confirmation): web returns to the login screen, native clears the persisted
  session fully and returns to the role picker.
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
  access; the revoked row disappears from the list.
- **Onboarding / auth** — first launch shows a role picker
  ("I'm a Realtor" / "I'm a client — I have an invite code"). Realtors sign up
  with email + password in two steps: account creation, then profile creation
  (skippable — "Skip for now" goes straight to the deal list). Login is email
  + password; password reset via email. The session persists on both
  platforms — **web** in localStorage, **native iOS** in its own storage —
  so a refresh keeps the realtor signed in, on the same screen. The session
  ends on Log out, or when the browser/incognito session ends.

**For buyers / sellers (clients)**

- No account — redeem with **name + invite code**. The confirmation screen is
  headlined **"Hooray! Your escrow is open."** Redemption binds access to
  the device; reopening the app goes straight back into the escrow.
- **Read-only checklist** styled exactly like the realtor's stepper (check
  circles, short connector segments, subtitles, UP NEXT tag) but with no tap
  targets, no drag grips, and no "Custom" tag. One single list in the
  realtor's order — checked steps stay in place. No recency markers of any
  kind.
- **Client home top card** — bold "Hi {name}" headline, "Your purchase" /
  "Your sale" plus the address in non-bold below, with the realtor's photo as
  a circle top-right at the greeting level (tap → realtor profile). Centered
  below: "N of N steps" above a bigger progress ring, then the days line —
  "days left: N", "due today" on the target date, red "overdue by N day(s)"
  past it. When every step is checked, the banner slot shows
  "Congratulations, your checklist is complete".
- **Realtor profile (client view)** — hero card with the 96px photo, name,
  the license line (only when the realtor entered one), and a **tap-to-call
  phone row** (PHONE label, opens the dialer); About / stats / areas cards
  evenly spaced; the "One profile — shown across all escrows" footer note.
  A prominent "Back to my escrow" button returns to the client's home
  screen. No Call / Message actions.
- **Live updates** — every realtor checkoff updates the client home and
  progress bar. Custom steps render like any other step (no "Custom" tag on
  client views).
- Buyer access can never expose seller data and vice versa.

**Sync** — Supabase-backed cloud sync activates under the realtor's
email/password identity. Checklist state lives on the escrow, never on the
device; the device link is only the access key. Per-side close dates sync via
the `buyer_closed_at` / `seller_closed_at` columns on `escrows` (migration
`supabase/migrations/0007_per_side_close_dates.sql` — **apply it on the
Supabase dashboard SQL editor**; until it is applied, escrow pushes fall back
to the pre-migration column set instead of failing, and close dates stay
local-only).

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

## Scripts

```sh
bash tests/run.sh          # unit + auth/invite/sync suites
npx tsc --noEmit           # strict typecheck
npm run export:web       # web export (clears Metro cache)
npx expo export --platform ios   # iOS export must stay green
python3 scripts/deploy_gh_pages.py   # deploy web to gh-pages
```

## iOS release (Anuraj's step)

```sh
eas build --platform ios
eas submit --platform ios
```

This release adds the `@react-native-community/datetimepicker` native module
(inline date picker on New/Edit escrow) — the installed iPhone app needs a
fresh `eas build` to pick it up; the web deploy alone won't include it.

Every web feature/fix ships identically on iOS — the two must never drift.

## Repo conventions

- Build strictly to the approved mockup specs
  (`~/workspace/app-ideas/realtor-app/design/`); shared components are built
  once and reused — no divergent copies.
- Full local verification before every push: typecheck, tests, iOS + web
  exports, real boot test, live-URL verification after deploy.
- **Keep this README current** — every feature added, changed, or removed
  updates this file in the same release.
