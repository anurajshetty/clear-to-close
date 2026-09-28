// invite_inline_form.test.ts — REGRESSION: "Invite another buyer/seller"
// did nothing on the native iPhone app (Sept 28, 2026).
// Root cause: the View-clients sheet (ClientList) rendered a second
// Modal-based <InviteSheet> while its own Sheet's Modal was still open.
// iOS presents every RN Modal from the root view controller and silently
// drops the second presentViewController: (verified in react-native
// 0.86.3), so the tap handler fired and state flipped but no invite UI
// ever appeared. The revoke confirmation had the same latent bug (nested
// <ConfirmDialog>, also its own Modal).
// Fix (Anuraj's call, Sept 28, 2026 — inline, not stacked): "Invite
// another" expands an inline form inside the View clients sheet — the
// existing Field + a PrimaryButton "Create code". On success the new
// invite renders in the list above (existing row rendering: code chip +
// Copy) and the form collapses and clears. The revoke confirmation is an
// inline confirmBox (same pattern as the regen confirmation in this
// sheet). One Modal on screen at all times; the standalone InviteSheet
// stays for the first-invite flow from the detail/share screens, which
// never nest it.
// The focused name field stays above the keyboard via the shared Sheet's
// keyboard avoidance (whole-sheet lift), which the app-wide keyboard
// audit pins.
// This test pins the pattern structurally so a future edit cannot
// reintroduce a stacked Modal. It reads component sources as text because
// RN components are not importable in the node suite.
import { assert, summary } from './assert';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');

const ROOT = process.env.CTC_REPO_ROOT ?? process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const listSrc = read('src/components/ClientList.tsx');

// No stacked Modals anywhere in the View-clients sheet.
const sheetOpens = (listSrc.match(/<Sheet[\s>]/g) ?? []).length;
assert(sheetOpens === 1, `ClientList: exactly one <Sheet> (its own), found ${sheetOpens}`);
assert(
  !listSrc.includes('<InviteSheet\n') && !listSrc.includes('<InviteSheet '),
  'ClientList: never renders a nested <InviteSheet> (no stacked Sheet Modal)',
);
assert(
  !listSrc.includes('<ConfirmDialog'),
  'ClientList: no nested <ConfirmDialog> Modal (same stacked-Modal root cause)',
);

// The inline invite form: expanding, field labels, create button.
assert(
  listSrc.includes('inviteOpen'),
  'ClientList: invite mode is inline state (no second sheet)',
);
const openCount = (listSrc.match(/setInviteOpen\(true\)/g) ?? []).length;
assert(
  openCount === 1,
  `ClientList: one shared inline-form button per section (found ${openCount})`,
);
assert(
  listSrc.includes("title={side === 'tc' ? 'Invite TC' : `Invite another ${noun}`}"),
  'ClientList: the shared button carries the role-specific label (Invite another buyer/seller, Invite TC)',
);
assert(
  listSrc.includes("Buyer's name") &&
    listSrc.includes("Seller's name") &&
    listSrc.includes("Coordinator's name"),
  'ClientList: inline form labels the name field per role',
);
assert(
  listSrc.includes("They’ll enter this exact name with the code. It has to\n                    match.") ||
    listSrc.includes("They’ll enter this exact name with the code."),
  'ClientList: inline form keeps the exact-name hint',
);
assert(
  listSrc.includes("title={inviteBusy ? 'Creating…' : 'Create code'}"),
  'ClientList: inline form has the Create code button with busy state',
);
assert(
  listSrc.includes('disabled={inviteName.trim().length === 0 || inviteBusy}'),
  'ClientList: Create code is disabled until the name is non-empty',
);

// Create flow: server write, list refresh (the new invite renders via the
// existing row rendering: code chip + Copy), form collapses and clears.
// Scoped to doInviteCreate so a future edit cannot move the pieces apart.
const createFn = listSrc.slice(
  listSrc.indexOf('const doInviteCreate'),
  listSrc.indexOf('const doInviteCreate') + 1200,
);
assert(
  createFn.includes('store.createInvite(escrowId, side, partyName)'),
  'ClientList: inline form creates the invite for this escrow + side',
);
assert(
  createFn.includes('await refresh()'),
  'ClientList: after create, the list refreshes so the new row appears',
);
assert(
  createFn.includes('setInviteOpen(false)') && createFn.includes("setInviteName('')"),
  'ClientList: on success the inline form collapses and clears',
);

// Cap behavior unchanged: the form only appears under cap.
assert(
  listSrc.includes('invites.length < cap ? ('),
  'ClientList: invite button/form only renders under the per-side cap',
);
assert(
  listSrc.includes('Two invites max per side.'),
  'ClientList: the cap note stays as-is',
);

// Revoke confirmation: inline destructive confirm box (same pattern as the
// regen confirmation), not a stacked dialog.
assert(
  listSrc.includes('dangerBtn'),
  'ClientList: revoke confirmation keeps a destructive (red) Remove action inline',
);

// The focused name field stays above the keyboard: the inline form renders
// inside the shared Sheet, whose keyboard avoidance lifts the whole sheet
// above the keyboard (app-wide audit pattern — whole-sheet lift, not a
// per-field scroll).
const uiSrc = read('src/components/ui.tsx');
assert(
  uiSrc.includes('{ marginBottom: lift }') &&
    uiSrc.includes('const lift = Math.max(0, Math.min(kbHeight,'),
  'ui.tsx: shared Sheet applies a keyboard-height-derived bottom margin (whole-sheet lift)',
);
assert(
  uiSrc.includes('lift the whole sheet above the'),
  'ui.tsx: the whole-sheet keyboard-lift intent is pinned in a comment',
);

// Standalone InviteSheet: unchanged, still available for the first-invite
// flow from the detail/share screens (never nested there).
const inviteSrc = read('src/components/InviteSheet.tsx');
assert(
  inviteSrc.includes('export function InviteSheet'),
  'InviteSheet.tsx: standalone InviteSheet unchanged',
);
assert(
  inviteSrc.includes('<Sheet visible={visible} onClose={handleClose}>'),
  'InviteSheet.tsx: standalone sheet keeps its own Sheet wrapper',
);
for (const file of ['app/escrow/[id].tsx', 'app/share/[id].tsx']) {
  const src = read(file);
  assert(src.includes('<InviteSheet'), `${file}: still uses the standalone InviteSheet`);
}
// Detail screen: invite sheet and client list are mutually exclusive
// (ternary) — they can never stack.
const detailSrc = read('app/escrow/[id].tsx');
assert(
  detailSrc.includes('count > 0 ? setClientSide(r) : setSheetSide(r)'),
  'app/escrow/[id].tsx: invite sheet and client list are mutually exclusive',
);

summary('invite_inline_form');
