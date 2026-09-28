// date_field_collapsed.test.ts — REGRESSION: the native date picker must
// stay collapsed until the user taps the field (Sept 28, 2026).
// Bug: in the New escrow sheet on Anuraj's iPhone, the calendar for "Escrow
// open date" rendered EXPANDED inline below the "Select date" field on sheet
// open, with no tap — and the field box itself was not tappable. Root cause:
// the native DateField rendered the iOS inline DateTimePicker
// unconditionally, with no open/closed state.
// Fix: DateField keeps an `open` state (default false); the field box is a
// Pressable that toggles it; the picker only renders when open; picking a
// date (or an Android dismiss) collapses it. This test pins those structural
// guarantees so a future edit cannot silently reintroduce the auto-expanded
// calendar.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'DateField.tsx');
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const root = findRepoRoot();
assert(root !== '', 'could not locate the repo root (DateField.tsx)');
const src: string = fs.readFileSync(
  path.join(root, 'src', 'components', 'DateField.tsx'),
  'utf8',
);

// 1. The picker starts CLOSED: the open state defaults to false.
assert(
  /const\s*\[\s*open\s*,\s*setOpen\s*\]\s*=\s*React\.useState\s*\(\s*false\s*\)/.test(
    src,
  ),
  'DateField keeps an `open` state that defaults to false (calendar collapsed on sheet open)',
);

// 2. The field box is tappable and toggles the picker.
assert(
  /<Pressable[\s\S]*?testID=\{testID\}[\s\S]*?onPress=\{\(\)\s*=>\s*setOpen\(\(o\)\s*=>\s*!o\)\}/.test(
    src,
  ),
  'the field box is a Pressable whose onPress toggles open/closed',
);

// 3. The calendar renders ONLY when open — never unconditionally.
assert(
  /\{open\s*&&\s*\(\s*<DateTimePicker/.test(src),
  'DateTimePicker renders only when open ({open && ...}), never unconditionally',
);
assert(
  !/(?:^|\n)\s*<DateTimePicker(?![\s\S]*?\{open)/.test(
    src.replace(/\{open\s*&&\s*\(\s*<DateTimePicker[\s\S]*?\/>\s*\)\}/, ''),
  ),
  'no second unconditional DateTimePicker remains outside the open guard',
);

// 4. Picking a date collapses the calendar (iOS path).
assert(
  /if\s*\(date\)\s*onChange\(toISODate\(date\)\);\s*\n\s*setOpen\(false\)/.test(
    src,
  ),
  'iOS onPick commits the tapped date and collapses the calendar (setOpen(false))',
);

// 5. Android dismiss also collapses (the platform dialog closing is not a
// pick, but it must not leave the state stuck open).
assert(
  /event\.type\s*===\s*['"]set['"]\s*&&\s*date/.test(src),
  'Android only commits on event.type === "set" (dismiss does not write a date)',
);
assert(
  /Platform\.OS\s*===\s*['"]android['"][\s\S]*?setOpen\(false\)/.test(src),
  'Android dialog close (set or dismiss) collapses the picker',
);

summary('date_field_collapsed');
