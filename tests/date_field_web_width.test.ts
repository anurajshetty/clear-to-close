// date_field_web_width.test.ts — REGRESSION: date inputs must not overflow
// the sheet at iPhone widths (Sept 27, 2026).
// Bug: in the New Escrow sheet on mobile web, "Escrow open date" and "Target
// close date" overflowed past the right edge of the sheet. Root cause: iOS
// Safari's native <input type="date"> has a large intrinsic min-width and
// will not shrink to its container, even with width:100% + border-box.
// Fix: the web DateField constrains the input with maxWidth:'100%' and
// minWidth:0 (src/components/DateField.web.tsx). This test pins those two
// properties so a future edit cannot silently drop them.
// The visible-outcome proof (no overflow at 360px/390px) was verified with a
// headless-Chromium render of the shipped CSS; see the release notes.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'DateField.web.tsx');
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
assert(root !== '', 'could not locate the repo root (DateField.web.tsx)');
const sourcePath = path.join(root, 'src', 'components', 'DateField.web.tsx');

const src: string = fs.readFileSync(sourcePath, 'utf8');

const inputStyle = src.match(/<input[\s\S]*?style=\{\{([\s\S]*?)\}\}/);
assert(!!inputStyle, 'DateField.web.tsx still renders the <input> with an inline style object');
const styleBlock: string = inputStyle ? inputStyle[1] : '';

assert(
  /maxWidth\s*:\s*['"]100%['"]/.test(styleBlock),
  "date <input> style pins maxWidth:'100%' so it can never exceed its container",
);
assert(
  /minWidth\s*:\s*0/.test(styleBlock),
  'date <input> style pins minWidth:0 so iOS Safari cannot impose its intrinsic minimum',
);

// The constraint must live on the input itself (not just a parent): the
// intrinsic min-width belongs to the replaced date control.
assert(
  /width\s*:\s*['"]100%['"]/.test(styleBlock),
  "date <input> keeps width:'100%' so it fills the field like the text inputs above it",
);

summary('date_field_web_width');
