# Notification Re-Ask — Design Spec

**Status:** Approved by Anuraj, Nov 14, 2026 (design chat). Supersedes the ask-once rule for the push pre-prompt.
**Problem it fixes:** the current ask-once pre-prompt (`ctc:pushasked` / `ctc:pushasked:realtor`) permanently buries the ask if the user taps "Not now" — the iOS system prompt never fires, the app never appears in iOS Settings → Notifications, and there is no in-app path back. Verified live on Anuraj's iPhone with the production build (Nov 14, 2026).

## The design

### 1. Cooldown re-ask (replaces ask-once)
- If OS notification permission is not granted, the existing pre-prompt sheet may show again, subject to ALL of:
  - At most once every **14 days** (per role — realtor and client tracked separately, as today).
  - At most **4 total asks** per role. After the 4th, the timed sheet never shows again for that role.
  - Never while the user is mid-task; only on the existing surfaces (realtor: deal list; client: client escrow home), with the existing ~1.2s settle delay.
  - Stops permanently the moment permission is granted (permission is already re-checked on every launch).
- "Not now" = **snooze 14 days** (starts the cooldown), not a permanent dismissal.
- On the **4th (final) ask only**, the sheet adds a tertiary option **"Don't ask again"** → sets a permanent per-role stop flag. The timed sheet never shows again for that role; the Profile row (§4) remains.

### 2. Contextual asks (outside the cooldown)
Each fires **at most once per device per trigger**, independent of the 14-day cooldown, and counts toward the 4-ask cap:
- **Sign-up completion / first login on a device (added Nov 14, 2026, Anuraj's proposal as refined by design):** when a realtor completes sign-up, or logs in on a device where this trigger has never fired, and notifications are not granted — the sheet fires **after the user lands on the deal list**, with the existing ~1.2s settle delay. It is NEVER a blocking step inside the sign-up/login flow itself. Two limits: (a) it fires only when OS permission is **undetermined** (the system prompt is still available) — if permission was previously denied, no login sheet; the denied case is handled by §1/§3 and the Profile row; (b) it is **not** an every-login ask — once per device, ever, for this trigger. Firing it counts as one of the 4 asks and starts the 14-day cooldown, so it replaces (never stacks on) the first timed ask.
- **Realtor — first team invite sent:** after the invite-send success state, sheet with copy: "Your invite is on its way: turn on notifications so you know the moment your team joins and starts checking off steps." Buttons: "Turn on notifications" / "Not now".
- **Client — joins an escrow via invite code:** after the redeem success state, sheet with copy: "You're in! Turn on notifications so you know the moment your realtor checks off a step." Buttons: "Turn on notifications" / "Not now".
- Standard (timed) sheet keeps the existing approved copy unchanged.

### 3. Two-state button behavior
The sheet's primary button depends on the OS permission state at show time:
- **Undetermined** (system prompt never answered): "Turn on notifications" → calls `requestPushPermission()` (the iOS/Android system prompt), as today.
- **Denied** (system prompt previously denied — the OS will never show the dialog again): body line adds "Notifications are turned off for Clear to Close in your device Settings." Primary button becomes **"Open Settings"** → `Linking.openSettings()`. "Not now" unchanged.

### 4. Profile row (persistent, passive)
- Add one row to the realtor profile screen and the client profile screen (`app/client/profile.tsx` and the realtor equivalent): **"Notifications"** with live status — "On" or "Off · Turn on".
- Tapping when Off behaves exactly like §3 (system prompt if undetermined, Settings deep-link if denied). Tapping when On opens Settings (standard iOS pattern).
- Status reflects live permission, re-checked on screen focus / app foreground. The row is always present; it is not dismissible and does not count toward the ask cap.
- NOT included (explicitly out of scope): the deal-list banner idea. No banner in this change.

### 5. Legacy-flag migration
- Existing devices may carry `ctc:pushasked` / `ctc:pushasked:realtor` = '1' from the ask-once era. On first launch of the new build, treat a legacy flag as **"asked long ago"**: ask count = 1, last-asked = epoch (immediately eligible for one fresh ask under the new rules). Do not treat it as "Don't ask again."
- New storage (per role): last-asked timestamp, ask count, don't-ask-again flag, per-trigger fired flags for §2. Exact key names are engineering's call; keep them namespaced like the existing `ctc:` keys.

## Precisely where (engineering map)
- `src/lib/push.ts` — replace `shouldShowPrePrompt` / `shouldShowRealtorPrePrompt` ask-once eligibility with the cooldown + cap + state rules above; new KV accessors for the §5 storage; keep token registration, tap routing, and handler behavior untouched.
- `src/components/PushGate.tsx` — sheet scheduling on the existing surfaces; two-state primary button (§3); contextual triggers (§2) wired from the invite-send success and redeem success paths.
- Profile screens — the §4 row (shared component/token reuse per the standing UI reuse rule; one shared row component used by both profile surfaces, not two copies).
- No server, schema, migration, or Edge Function changes. No change to what pushes are sent, when, or to whom.

## Side-effect analysis (required with this brief)
- **PushGate surfaces:** deal list (realtor sheet), client buyer/seller/TC homes (client sheet) — timing and eligibility change only; no layout change to the sheets beyond the §3 denied-state line/button and the §2 final-ask tertiary option.
- **Sign-up / login flow:** the §2 sign-up/first-login sheet fires only after landing on the deal list — the auth flow itself gains no step, no delay, and no new screen; session restore (returning signed-in users) never triggers it, only an actual sign-up completion or an explicit login on a device where the trigger hasn't fired.
- **Invite flow:** one new sheet after first-invite success; must not block or delay the success state itself — sheet follows it.
- **Client redeem flow:** one new sheet after successful code redeem; must not interfere with landing on the escrow home.
- **Profile screens:** one added row each; no reordering of existing rows.
- **Existing tests:** the ask-once eligibility tests in the push suite encode the old rule and will fail by design — update them to the new eligibility matrix and add regression tests: cooldown not elapsed → no show; cap reached → no show; don't-ask-again → no show; denied state → Settings button; legacy flag → eligible once; granted → never shows; contextual trigger fires once only; sign-up/first-login trigger fires once per device, only in the undetermined state, never on session restore, and counts toward the cap + cooldown.
- **README:** notification behavior is user-facing — update the README in the same commit (standing rule). Add a LEARNINGS.md entry if implementation surfaces a platform surprise.
- **Auditor pass:** route through the security auditor per the standing team rule before merge (permission-prompt UX + Settings deep-link surface).

## Out of scope
- No changes to push content, triggers, quiet hours, or the server pipeline.
- No Android-specific divergence: Android 13+ runtime permission follows the same flow; `openSettings()` equivalent applies.
- No re-ask inside the escrow detail, activity, or chat surfaces.
