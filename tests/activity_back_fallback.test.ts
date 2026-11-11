// activity_back_fallback.test.ts — REGRESSION: the activity screen is
// a dead end when entered from a push. Its "Details" control (and the
// not-found "Back to escrows") called router.back() unconditionally,
// which is correct for the in-app entry (escrow detail PUSHES the
// activity screen, so a back stack exists) but dead for a push entry:
// PushGate routes taps with router.replace, so cold start lands on
// [activity] alone and warm start swaps the current screen out —
// there is nothing beneath to go back to (Anuraj's repro, Nov 10,
// 2026, on the member_step_activity push). Fix: the route-layer
// decision backFallbackAction — back when a back stack exists
// (in-app behavior unchanged), else replace to the control's target
// (Details -> the escrow detail screen; Back to escrows -> the deal
// list), so the stack is always sane.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { backFallbackAction } from '../src/lib/push';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('app', 'activity', '[id].tsx');
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

// 1. The decision, both entry modes.
const inApp = backFallbackAction(true, '/escrow/abc');
assert(inApp.type === 'back', 'in-app entry (back stack exists) goes back');
const pushEntry = backFallbackAction(false, '/escrow/abc');
assert(
  pushEntry.type === 'replace' && pushEntry.href === '/escrow/abc',
  'push entry (no back stack) replaces to the escrow detail screen',
);
const pushEntryHome = backFallbackAction(false, '/');
assert(
  pushEntryHome.type === 'replace' && pushEntryHome.href === '/',
  'push entry for Back to escrows replaces to the deal list',
);

// 2. The activity screen routes BOTH controls through the decision
// (source pins) and keeps no bare router.back() on either.
const root = findRepoRoot();
assert(root !== '', 'could not locate the repo root');
const src: string = fs.readFileSync(path.join(root, 'app', 'activity', '[id].tsx'), 'utf8');
assert(
  /backFallbackAction\(router\.canGoBack\(\),\s*fallbackHref\)/.test(src),
  'the screen decides via backFallbackAction(router.canGoBack(), ...)',
);
assert(
  /label="Details" onPress=\{\(\) => goBackOr\(`\/escrow\/\$\{escrowId\}`\)\}/.test(src),
  'Details falls back to the escrow detail route',
);
assert(
  /title="Back to escrows" onPress=\{\(\) => goBackOr\('\/'\)\}/.test(src),
  'Back to escrows falls back to the deal list',
);
assert(
  !/onPress=\{\(\) => router\.back\(\)\}/.test(src),
  'no bare router.back() control remains on the activity screen',
);
assert(
  /router\.replace\(action\.href as never\)/.test(src),
  'the replace arm constructs the fallback route',
);

// 3. The in-app entry is untouched: escrow detail still PUSHES the
// activity screen (so the back arm stays the common path).
const detail: string = fs.readFileSync(path.join(root, 'app', 'escrow', '[id].tsx'), 'utf8');
assert(
  /router\.push\(`\/activity\/\$\{escrow\.id\}`\)/.test(detail),
  'escrow detail still pushes the activity screen in-app',
);

// 4. The push entry mode itself is unchanged: PushGate still routes
// taps with replace through pushTapRoute (the fix adapts the landing
// screen to the entry, not the entry to the screen).
const gate: string = fs.readFileSync(
  path.join(root, 'src', 'components', 'PushGate.tsx'),
  'utf8',
);
assert(
  /router\.replace\(pushTapRoute\(escrowId, role, kind\) as never\)/.test(gate),
  'PushGate tap routing (replace via pushTapRoute) is unchanged',
);

summary('activity_back_fallback');
