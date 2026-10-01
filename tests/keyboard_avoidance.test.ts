// keyboard_avoidance.test.ts — REGRESSION (Sept 28, 2026, Anuraj):
// EVERY input field in the app must stay visible above the keyboard when
// focused — no exceptions. The original bug: the transaction detail
// screen's inline "Custom step" text field slid behind the keyboard when
// focused (Anuraj's iPhone screenshot). Audit found the same gap on every
// full-screen form: the shared keyboard avoidance lived only in the Sheet
// component, so bottom sheets were covered but plain screens were not.
// Fix: one shared pattern everywhere — the exported useKeyboardHeight()
// hook; screens add bottom padding equal to the keyboard height so the
// focused field can scroll into view above it (the same lift idea the
// shared Sheet uses). The detail screen's custom-step form additionally
// lives in a sticky pinned footer (checklist edit mode, Sept 2026): it is
// always visible above the keyboard, so no scroll-into-view is needed.
// This test pins the inventory.
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

// --- Shared plumbing -------------------------------------------------------
const ui = src(path.join('src', 'components', 'ui.tsx'));
assert(
  /export function useKeyboardHeight\(\): number/.test(ui),
  'ui exports the shared useKeyboardHeight() hook',
);
assert(
  /onFocus\?: \(\) => void/.test(ui) && /onFocus=\{onFocus\}/.test(ui),
  'the shared Field accepts onFocus and forwards it to the TextInput',
);
const checklist = src(path.join('src', 'components', 'Checklist.tsx'));
assert(
  /listRef\?: React\.Ref<any>/.test(checklist),
  'EditableChecklist accepts a listRef prop',
);
assert(
  /<DraggableFlatList[\s\S]*?ref=\{listRef\}/.test(checklist),
  'EditableChecklist forwards listRef to the underlying list',
);

// --- Bottom sheets: covered by the shared Sheet (no per-screen fix) -------
const sheetFiles = [
  ['src/components/EscrowFormSheet.tsx', 'New escrow sheet'],
  ['src/components/EscrowFormSheet.tsx', 'Update escrow sheet'],
  ['src/components/CancelEscrowSheet.tsx', 'Cancel escrow sheet'],
  ['src/components/ChangePasswordSheet.tsx', 'Change password sheet'],
];
for (const [rel, label] of sheetFiles) {
  const s = src(rel);
  assert(
    /<Sheet[\s>]/.test(s),
    `${label} renders inside the shared Sheet (keyboard lift + detent lock)`,
  );
}

// --- Full screens: the shared hook + bottom padding -------------------------
const screens: Array<[string, string]> = [
  ['app/login.tsx', 'Login'],
  ['app/signup.tsx', 'Signup'],
  ['app/redeem.tsx', 'Redeem'],
  ['app/reset-password.tsx', 'Reset password'],
  ['app/profile-setup.tsx', 'Profile setup'],
  ['app/profile-update.tsx', 'Profile update'],
  ['app/profile-create.tsx', 'Profile create'],
];
for (const [rel, label] of screens) {
  const s = src(rel);
  assert(
    /useKeyboardHeight/.test(s) && /const kbHeight = useKeyboardHeight\(\);/.test(s),
    `${label} screen reads the shared useKeyboardHeight() hook`,
  );
  assert(
    /\{\s*paddingBottom:\s*kbHeight\s*\}/.test(s),
    `${label} screen adds bottom padding equal to the keyboard height`,
  );
}

// --- Transaction detail: custom-step field stays above the keyboard ---------
const detail = src(path.join('app', 'escrow', '[id].tsx'));
// The inline form is untouched (Anuraj's final decision: keep it inline).
assert(
  /styles\.addForm/.test(detail),
  'detail screen keeps the inline custom-step form (no dialog, no sheet)',
);
assert(
  /const kbHeight = useKeyboardHeight\(\);/.test(detail),
  'detail screen reads the shared useKeyboardHeight() hook',
);
assert(
  /\{\s*paddingBottom:\s*kbHeight\s*\}/.test(detail),
  'detail screen lifts its content by the keyboard height',
);
// Checklist edit mode (Sept 2026): the add-step form moved from the list
// footer into the sticky pinned footer — it is always visible above the
// keyboard, so the old scroll-into-view is obsolete by design.
assert(
  /renderStickyAdd/.test(detail) && /styles\.stickyAdd/.test(detail),
  'the custom-step form lives in the sticky pinned footer (always visible, no focus scroll)',
);
assert(
  /position:\s*'absolute'/.test(detail),
  'the sticky footer is pinned to the bottom of the list area',
);

summary('keyboard_avoidance');
