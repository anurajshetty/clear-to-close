// role_picker_copy.test.ts — the role picker ("How are you joining?")
// carries the app description line Anuraj picked (Oct 14, 2026),
// verbatim, directly under the CLEAR TO CLOSE kicker and above the
// headline, in the screen's muted subtitle treatment. Everything else
// on the screen is unchanged.
//
// Run: see tests/run.sh.
import { assert, summary } from './assert';

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const fs = require('fs') as { readFileSync(p: string, enc: string): string };
const path = require('path') as { join(...parts: string[]): string };
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DESC =
  'Your escrow, step by step. Clear to Close keeps you and your realtor connected and up to date, from accepted offer to closing.';

function main(): void {
  const role = srcFile('app/role.tsx');

  assert(role.includes(DESC), 'role: the app description line is present, verbatim');
  const kickerAt = role.indexOf('<Kicker>Clear to Close</Kicker>');
  const descAt = role.indexOf(DESC);
  const h1At = role.indexOf('<Text style={styles.h1}>How are you joining?</Text>');
  assert(kickerAt >= 0 && descAt > kickerAt, 'role: description sits directly under the kicker');
  assert(h1At > descAt, 'role: description sits above the headline');

  // Muted treatment: the description uses the same styles.sub as the
  // screen's existing subtitle ("Pick the path that fits…").
  const descEl = role.slice(Math.max(0, descAt - 80), descAt);
  assert(descEl.includes('<Text style={styles.sub}>'), 'role: description uses styles.sub (muted subtitle treatment)');

  // Nothing else moved: the existing headline + subtitle copy remains.
  assert(role.includes('Pick the path that fits. You only see this once. The app remembers.'), 'role: existing subtitle unchanged');

  summary('role-picker-copy');
}

try {
  main();
} catch (e) {
  console.log('FAIL - exception: ' + String(e));
  process.exitCode = 1;
}
