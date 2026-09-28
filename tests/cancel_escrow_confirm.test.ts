// cancel_escrow_confirm.test.ts — REGRESSION: tapping "Cancel this escrow"
// in the Update escrow sheet must show the confirmation (Sept 28, 2026).
// Bug (Anuraj's iPhone): the tap did nothing — no confirmation UI appeared.
// CONFIRMED root cause: the tap handler fired and flipped confirmingCancel,
// but CancelEscrowSheet rendered a SECOND stacked Modal while the Update
// sheet's Modal was still open. Verified in the react-native 0.86.3 source
// in this repo (RCTModalHostViewComponentView.mm): every Modal presents
// from [self reactViewController] (the root VC), never the topmost
// presented VC — so iOS silently drops the second present while the first
// Modal is visible.
// Fix: the confirmation renders INSIDE the Update sheet's already-open
// Modal (EscrowFormSheet's confirmBody), so only one Modal is ever visible.
// The deal-list card X still uses the standalone Sheet-wrapped
// CancelEscrowSheet at the screen root (no other Modal open there).
// This test pins the single-Modal structure and the confirm/dismiss flow.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function readFromRoot(rel: string): string {
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const src = (rel: string): string => {
  const s = readFromRoot(rel);
  assert(s !== '', `could not locate ${rel}`);
  return s;
};

const update = src(path.join('src', 'components', 'UpdateEscrowSheet.tsx'));
const form = src(path.join('src', 'components', 'EscrowFormSheet.tsx'));
const cancel = src(path.join('src', 'components', 'CancelEscrowSheet.tsx'));

// 1. No stacked Modal: the Update sheet no longer renders the Sheet-wrapped
// CancelEscrowSheet as a sibling of the form sheet.
assert(
  !/<CancelEscrowSheet/.test(update),
  'UpdateEscrowSheet does not render a stacked <CancelEscrowSheet> Modal',
);
assert(
  !/from '\.\/CancelEscrowSheet'/.test(update) ||
    /CancelEscrowBody/.test(update),
  'UpdateEscrowSheet uses the unwrapped CancelEscrowBody, not the Sheet wrapper',
);

// 2. The confirmation goes through the single open Modal: EscrowFormSheet
// exposes confirmBody and renders it inside its one <Sheet>.
assert(
  /confirmBody\?: React\.ReactNode/.test(form),
  'EscrowFormSheet accepts a confirmBody prop',
);
assert(
  /\{confirmBody \?\? \(/.test(form),
  'EscrowFormSheet renders confirmBody inside its single Sheet Modal',
);
assert(
  /confirmBody=\{/.test(update) && /<CancelEscrowBody/.test(update),
  'UpdateEscrowSheet passes the confirmation as confirmBody',
);

// 3. The shared CancelEscrowSheet still offers the standalone Sheet for the
// deal-list root usage (app/index.tsx), where no other Modal is open.
assert(
  /export function CancelEscrowBody/.test(cancel),
  'CancelEscrowSheet exports the unwrapped CancelEscrowBody',
);
assert(
  /export default function CancelEscrowSheet/.test(cancel) &&
    /<Sheet visible=\{!!escrow\} onClose=\{onClose\}>/.test(cancel),
  'the default CancelEscrowSheet still wraps the body in its own Sheet',
);
const index = src(path.join('app', 'index.tsx'));
assert(
  /<CancelEscrowSheet/.test(index),
  'the deal list keeps its root-level CancelEscrowSheet (single Modal)',
);

// 4. The UX flow: danger action -> confirmation -> confirm cancels,
// dismiss leaves the escrow (and the update sheet) alone.
assert(
  /testID="cancel-this-escrow"/.test(update),
  'the "Cancel this escrow" danger action still renders in the Update sheet',
);
assert(
  /onPress=\{\(\) => setConfirmingCancel\(true\)\}/.test(update),
  'tapping the danger action starts the confirmation',
);
assert(
  /onClose=\{confirmingCancel \? \(\) => setConfirmingCancel\(false\) : onClose\}/.test(update),
  'overlay/back dismissal while confirming only backs out of the confirmation',
);
assert(
  /testID="confirm-cancel-escrow"/.test(cancel),
  'the confirmation has a "Cancel escrow" confirm button',
);
assert(
  /testID="keep-escrow"/.test(cancel),
  'the confirmation has a "Keep it" dismiss button',
);
assert(
  /onCancelled=\{\(updated\) => \{\s*setConfirmingCancel\(false\);\s*onClose\(\);\s*onSaved\(updated\);/.test(update),
  'confirming cancels the escrow, closes the sheet, and reports the update',
);
assert(
  /store\.cancelEscrow\(escrow\.id\)/.test(cancel),
  'the confirm button calls through to store.cancelEscrow',
);

summary('cancel_escrow_confirm');
