// sheet_detent_lock.test.ts — REGRESSION: the sheet keeps the size it
// opened with; keyboard appearance never resizes it (Sept 28, 2026).
// Bug (Anuraj's iPhone): the New escrow sheet opened at half-screen height
// but jumped to full screen when a field was tapped. Expected: the sheet
// stays the size it opened with; the keyboard only lifts it; fields below
// the fold are reached by scrolling inside the sheet.
// Fix (src/components/ui.tsx, shared Sheet): the open height is snapshotted
// from the first keyboard-closed layout and applied as a maxHeight on the
// container; the scroll region derives from that locked height (never from
// the keyboard height); the lift is capped so the sheet top never leaves
// the screen. This test pins those structural guarantees.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'ui.tsx');
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
assert(root !== '', 'could not locate the repo root (ui.tsx)');
const src: string = fs.readFileSync(path.join(root, 'src', 'components', 'ui.tsx'), 'utf8');

// 1. The open height is snapshotted from a keyboard-closed layout and reset
// on close so each open re-locks.
assert(
  /const\s*\[\s*openHeight\s*,\s*setOpenHeight\s*\]\s*=\s*useState<number\s*\|\s*null>\(null\)/.test(
    src,
  ),
  'Sheet keeps an openHeight snapshot, reset when the sheet closes',
);
assert(
  /onLayout=\{\(e\)\s*=>\s*\{\s*[^}]*kbHeight\s*===\s*0\s*&&\s*openHeight\s*===\s*null[^}]*setOpenHeight\(e\.nativeEvent\.layout\.height\)/.test(
    src,
  ),
  'the first keyboard-closed layout snapshots the open height',
);

// 2. The container can never grow past the open size.
assert(
  /openHeight\s*!==\s*null\s*&&\s*\{\s*maxHeight:\s*openHeight\s*\}/.test(src),
  'the sheet container applies maxHeight: openHeight (detent lock)',
);

// 3. Keyboard height no longer feeds the sheet/scroll sizing — the keyboard
// only lifts the sheet, never resizes it.
const sizingBlock = src.match(
  /const scrollMaxHeight =[\s\S]*?;/,
);
assert(!!sizingBlock, 'scrollMaxHeight is still computed in Sheet');
assert(
  !/kbHeight/.test(sizingBlock![0]),
  'scrollMaxHeight never references kbHeight (keyboard cannot resize the sheet)',
);

// 4. The lift is capped so the sheet top never leaves the screen.
assert(
  /const lift = Math\.max\(0,\s*Math\.min\(kbHeight,\s*layoutHeight\s*-\s*\(openHeight \?\? layoutHeight\)\)\)/.test(
    src,
  ),
  'the keyboard lift is capped so the sheet top stays onscreen',
);
assert(
  /\{\s*marginBottom:\s*lift\s*\}/.test(src),
  'the sheet still lifts above the keyboard (existing avoidance pattern kept)',
);

summary('sheet_detent_lock');
