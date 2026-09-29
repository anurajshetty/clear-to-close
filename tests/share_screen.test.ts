// share_screen.test.ts — REGRESSION: share screen v1 (mockup 05, Sept 29, 2026).
// The full-screen "Share this escrow" route (app/share/[id].tsx) replaces the
// invite bottom sheet (InviteSheet) and the view-clients overlay (ClientList).
// This test pins the approved structure and copy so a future edit cannot
// regress it: three sections with caps, inline (never Modal/Sheet) invite
// form and confirms, exact confirm/toast/cap-note copy, dead-escrow gating,
// Accepted = redeemedAt, and code+Copy on Invited rows only.
// It reads the component source as text because RN components are not
// importable in the node suite.
import { assert, summary } from './assert';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.cwd());
const SRC = fs.readFileSync(path.join(ROOT, 'app', 'share', '[id].tsx'), 'utf8');

function has(s: string): boolean {
  return SRC.includes(s);
}

// --- Three sections, always shown, with caps ---
assert(has("plural: 'Buyers'") && has("plural: 'Sellers'") && has("plural: 'Transaction coordinator'"),
  'all three sections defined (Buyers, Sellers, Transaction coordinator)');
assert(has("{ role: 'buyer'") && has("cap: 2") && has("{ role: 'tc'") && has("cap: 1"),
  'caps: 2 per buyer/seller side, 1 TC');
assert(has('{s.plural} · {count} of {s.cap}'),
  'section label renders "Plural · X of cap"');

// --- No overlays: full-screen route, inline everything ---
assert(!has('<Sheet'), 'no Sheet component — the screen is a full-screen route, not an overlay');
assert(!has('Modal'), 'no Modal anywhere — the screen is a full-screen route, not an overlay');
assert(!has('<InviteSheet') && !has('<ClientList'),
  'InviteSheet and ClientList are not rendered by the new screen');
assert(has('useFocusEffect'), 'screen refreshes on focus (fresh invite state on return)');

// --- Invite rows ---
assert(has("accepted ? 'Accepted' : 'Invited'"),
  'Invited/Accepted pills driven by redeemedAt');
assert(has('inv.redeemedAt != null'), 'Accepted = redeemedAt != null (no per-invite link lookup)');
assert(has('{!accepted && ('), 'code chip + Copy render on Invited rows only');
assert(has('accessibilityLabel={`Copy invite code for ${inv.partyName}`}'),
  'Copy has an accessible label per row');
assert(has('accessibilityLabel={`Remove invite for ${inv.partyName}`}'),
  'remove (×) has an accessible label per row');
assert(has('accessibilityLabel={`Regenerate code for ${inv.partyName}`}'),
  'Regenerate has an accessible label per row');

// --- Invite buttons + cap note ---
assert(has("s.role === 'tc'\n        ? 'Invite the TC'"), 'TC invite button reads "Invite the TC"');
assert(has('`Invite the ${s.buttonNoun}`') && has('`Invite another ${s.buttonNoun}`'),
  'buyer/seller buttons: "Invite the X" at 0, "Invite another X" after');
assert(has('Two invites max per side. ') && has('Remove one to invite someone new.'),
  'quiet cap note copy at 2 of 2 (buyers/sellers)');
assert(has('count >= s.cap && s.cap > 1'), 'cap note only for the 2-cap sides (TC slot just fills)');

// --- Inline invite form ---
assert(has("They’ll enter this exact name with the code. It has to match."),
  'name-match hint under the name field');
assert(has('setFormName(t.slice(0, 30))'), 'name field capped at 30 chars');
assert(has("Share this code with them. It works once."),
  'code-phase hint copy');
assert(has('testID={`share-name-${s.role}`}'), 'name field has a per-role testID');
assert(has('disabled={!nameOk || formBusy}'), 'Create code disabled until the name is non-empty');
assert(has("Couldn't create the invite. Check your connection and try again."),
  'create-code failure shows an inline error (confirmed-or-loud)');
// Decision (b), final: Anuraj dropped the branded invite link. The code
// phase is exactly the mockup's single Copy (code only) + Done — no link
// button, no placeholder scaffolding.
assert(has('<PrimaryButton title="Copy"'), 'code phase: single Copy button (code only)');
assert(!has('Copy invite link'), 'no "Copy invite link" — branded link dropped by decision');
assert(!has('EXTENSION POINT'), 'no leftover extension scaffolding');

// --- Inline confirms (remove / regenerate) ---
assert(has('Remove {inv.partyName}?'), 'remove confirm title copy');
assert(has('The invite and its code stop working. You can send a fresh one anytime.'),
  'remove confirm body copy');
assert(has('New code for {inv.partyName}?'), 'regenerate confirm title copy');
assert(has('The old code stops working. Any linked device loses access to this escrow.'),
  'regenerate confirm body copy');
assert(has('>Keep</Text>'), 'Keep button dismisses the confirm');
assert(has('setRegenId(null);\n    setRemoveId((cur)'),
  'opening remove closes regenerate');
assert(has('setRemoveId(null);\n    setRegenId((cur)'),
  'opening regenerate closes remove');

// --- Toasts (exact mockup copy, ToastTimer-owned) ---
assert(has("showToast('Code copied.')"), 'toast: "Code copied."');
assert(has("showToast('Invite created.')"), 'toast: "Invite created."');
assert(has("showToast('Invite removed.')"), 'toast: "Invite removed."');
assert(has("showToast('New code created.')"), 'toast: "New code created."');
assert(has('new ToastTimer()'), 'dismiss timer owned by ToastTimer (Sept 28 lesson)');
assert(has('testID="share-toast"'), 'toast has a testID');

// --- Dead-escrow rule (Sept 28, 2026) ---
assert(has("escrow.status === 'open'"), 'escrow open state drives invite-UI gating');
assert(has('escrowOpen && count < s.cap'), 'invite button hidden on closed/cancelled escrows');
assert(has('escrowOpen && count >= s.cap'), 'cap note hidden on closed/cancelled escrows');

// --- Header ---
assert(has('BackChevron') && has("label=\"Details\""), 'back button reads "‹ Details" via BackChevron');
assert(has('>Share this escrow</Text>'), 'title "Share this escrow"');
assert(has('{escrow.address} · {escrow.city}'), 'subtitle is address · city');
assert(has('Invite your clients and your TC. Each person gets a name and a one-time code.'),
  'hint line copy under the header');
assert(!has('ProgressRing') && !has('TimeTrackerCard'),
  'no progress ring or time-tracker card on this screen (mockup 05)');

// --- Keyboard avoidance ---
assert(has('useKeyboardHeight()'), 'shared keyboard-height hook in use');
assert(has('paddingBottom: kbHeight'), 'screen lifts above the keyboard (iOS)');

summary('share_screen');
