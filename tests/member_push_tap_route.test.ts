// member_push_tap_route.test.ts — SCOPE CHANGE (Anuraj, Nov 10,
// 2026): the member_step_activity push must NOT land on the Activity
// timeline; tapping it opens the escrow's HOME (detail) screen
// directly — the checklist view. This supersedes the Oct 2026
// "tap opens Activity" rule and the same-day dead-end fix on the
// activity screen (reverted in the same change: the push path no
// longer lands there, and in-app Activity navigation is untouched).
// Both tap modes are pinned: warm taps arrive through the response
// listener, cold starts through the last-response read — PushGate
// funnels both through pushTapRoute, so the route the function
// returns IS the route both modes take.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { pushTapRoute, teamPushTapRoute } from '../src/lib/push';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'PushGate.tsx');
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

// 1. The route itself, at both layers PushGate consults.
assert(
  teamPushTapRoute('member_step_activity', 'esc-42') === '/escrow/esc-42',
  'teamPushTapRoute: member_step_activity -> the escrow home',
);
assert(
  pushTapRoute('esc-42', 'realtor', 'member_step_activity') === '/escrow/esc-42',
  'pushTapRoute: member_step_activity -> the escrow home',
);
assert(
  teamPushTapRoute('member_step_activity', 'esc-42') !== '/activity/esc-42',
  'the activity timeline is no longer the push destination',
);

// 2. Neighboring routes unchanged.
assert(teamPushTapRoute('team_invite_received', 'esc-42') === '/', 'invite received still lands home');
assert(
  teamPushTapRoute('team_invite_accepted', 'esc-42') === '/escrow/esc-42',
  'invite accepted still opens the escrow',
);
assert(
  pushTapRoute('esc-42', 'buyer') === '/client/buyer/esc-42',
  'client role routing is untouched',
);

// 3. Both tap modes funnel through the same routing (source pins):
// setupPushHandling (push.ts) wires the warm response listener AND
// the cold-start last-response read into one routeResponse, and
// PushGate's handler resolves it via pushTapRoute.
const root = findRepoRoot();
assert(root !== '', 'could not locate the repo root');
const pushSrc: string = fs.readFileSync(path.join(root, 'src', 'lib', 'push.ts'), 'utf8');
assert(
  /addNotificationResponseReceivedListener\(routeResponse\)/.test(pushSrc),
  'warm taps route through the shared response handler',
);
assert(
  /getLastNotificationResponseAsync\(\)[\s\S]{0,120}?routeResponse\(resp\)/.test(pushSrc),
  'cold starts feed the last response into the same handler',
);
const gate: string = fs.readFileSync(path.join(root, 'src', 'components', 'PushGate.tsx'), 'utf8');
assert(
  /router\.replace\(pushTapRoute\(escrowId, role, kind\) as never\)/.test(gate),
  'the shared handler resolves routes via pushTapRoute',
);

// 4. The in-app Activity entry is untouched: escrow detail still
// pushes the activity screen (its back behavior is the in-app one).
const detail: string = fs.readFileSync(path.join(root, 'app', 'escrow', '[id].tsx'), 'utf8');
assert(
  /router\.push\(`\/activity\/\$\{escrow\.id\}`\)/.test(detail),
  'in-app activity navigation is unchanged',
);

summary('member_push_tap_route');
