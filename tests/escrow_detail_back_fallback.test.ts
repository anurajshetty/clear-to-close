// escrow_detail_back_fallback.test.ts — the escrow detail screen is
// the primary push LANDING (team_invite_accepted, realtor/client
// kinds, and member_step_activity since Nov 10, 2026), and PushGate
// routes taps with router.replace — so on a push entry there is no
// back stack and the screen's three bare router.back() controls were
// dead: the "‹ Escrows" header Pressable, the not-found "Back to
// escrows", and the error boundary's "Back to escrows" action. All
// three now decide via backFallbackAction toward '/' (the deal list):
// back when a stack exists (in-app behavior unchanged), replace to
// the deal list when it does not. Briefed by the coordinator
// (Nov 10, 2026) as the same-pattern companion to the activity fix.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('app', 'escrow', '[id].tsx');
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
assert(root !== '', 'could not locate the repo root');
const src: string = fs.readFileSync(path.join(root, 'app', 'escrow', '[id].tsx'), 'utf8');

// 1. The screen imports and uses the shared decision toward '/'.
assert(
  /import \{[^}]*backFallbackAction[^}]*\} from '\.\.\/\.\.\/src\/lib\/push'/.test(src),
  'escrow detail imports backFallbackAction from lib/push',
);
assert(
  /backFallbackAction\(router\.canGoBack\(\),\s*'\/'\)/.test(src),
  'escrow detail decides via backFallbackAction toward the deal list',
);

// 2. All three former dead controls route through the guarded helper.
assert(
  /accessibilityLabel="Back to escrows"[\s\S]{0,200}?onPress=\{\(\) => goBackOr\('\/'\)\}/.test(src) ||
    /onPress=\{\(\) => goBackOr\('\/'\)\}[\s\S]{0,400}?accessibilityLabel="Back to escrows"/.test(src),
  'the header back Pressable uses the guarded navigation',
);
assert(
  /<SecondaryButton title="Back to escrows" onPress=\{\(\) => goBackOr\('\/'\)\} \/>/.test(src),
  'the not-found Back to escrows uses the guarded navigation',
);
assert(
  /onAction=\{\(\) => \{[\s\S]{0,220}?backFallbackAction\(router\.canGoBack\(\),\s*'\/'\)/.test(src),
  'the error boundary action uses the guarded navigation',
);

// 3. No UNGUARDED router.back() control remains: every onPress /
// onAction that used to call it directly now goes through goBackOr
// or the inline guarded decision.
assert(!/onPress=\{\(\) => router\.back\(\)\}/.test(src), 'no bare onPress router.back() remains');
assert(!/onAction=\{\(\) => router\.back\(\)\}/.test(src), 'no bare onAction router.back() remains');

// 4. The replace arm constructs the fallback route (shared shape with
// the activity screen).
assert(
  /router\.replace\(action\.href as never\)/.test(src),
  'the replace arm constructs the fallback route',
);

summary('escrow_detail_back_fallback');
