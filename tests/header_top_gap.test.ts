// header_top_gap.test.ts — REGRESSION: top-of-screen headers must clear the
// iOS status bar (Sept 28, 2026).
// Bug: on the native iPhone app, the home header ("Hi {name}" + profile pic)
// and the escrow details header ("‹ Escrows" back button) rendered under the
// status bar — the back button was effectively untappable, and the header
// content crowded the notch. Root cause: those screens used a fixed small
// top padding (14/10/12/20) with no safe-area inset.
// Fix: each top-of-screen header adds useSafeAreaInsets().top to its existing
// top padding/margin, keeping the deliberate gap (0 on web, where the inset
// is 0). This test pins the pattern on every affected screen so a future
// edit cannot silently drop it, and pins the back button's 44pt minimum
// touch target on the two screens with a back button.
// The visible-outcome proof (header clears the status-bar region with a gap,
// back button hittable at its center) was verified with a headless render of
// the shipped styles at a 390px iPhone viewport; see the release notes.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('app', 'index.tsx');
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
  throw new Error('repo root not found');
}

const ROOT = findRepoRoot();
assert(ROOT !== '', 'could not locate the repo root (app/index.tsx)');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// [file, expected top gap added to the safe-area inset]
const SCREENS: Array<[string, number]> = [
  ['app/index.tsx', 14], // home: headRow marginTop
  ['app/escrow/[id].tsx', 14], // escrow details: header paddingTop
  ['app/share/[id].tsx', 14], // share sheet screen: header paddingTop
  ['app/client/buyer/[id].tsx', 10], // client buyer home: content paddingTop
  ['app/client/seller/[id].tsx', 10], // client seller home: content paddingTop
  ['app/client/tc/[id].tsx', 10], // client TC home: content paddingTop
  ['app/client/profile.tsx', 12], // client realtor profile: content paddingTop
];

for (const [file, gap] of SCREENS) {
  const src = read(file);
  assert(
    src.includes("from 'react-native-safe-area-context'"),
    `${file}: imports useSafeAreaInsets from react-native-safe-area-context`,
  );
  assert(src.includes('useSafeAreaInsets()'), `${file}: calls useSafeAreaInsets()`);
  assert(
    src.includes(`insets.top + ${gap}`),
    `${file}: adds insets.top + ${gap} to the top padding/margin`,
  );
}

// Tappability: the two screens with a back button must keep a 44pt minimum
// touch target on it (Anuraj: the escrow back button was untappable).
for (const file of ['app/escrow/[id].tsx', 'app/share/[id].tsx']) {
  const src = read(file);
  const m = src.match(/backBtn:\s*\{([^}]*)\}/);
  assert(m !== null, `${file}: backBtn style exists`);
  const minH = m![1].match(/minHeight:\s*(\d+)/);
  assert(minH !== null, `${file}: backBtn has minHeight`);
  assert(Number(minH![1]) >= 44, `${file}: backBtn minHeight >= 44pt`);
  assert(m![1].includes('justifyContent'), `${file}: backBtn centers its label`);
}

summary('header_top_gap');
