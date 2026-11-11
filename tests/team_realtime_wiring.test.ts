// team_realtime_wiring.test.ts — source pins for the realtime wiring
// that lives in screens/layout/store (not unit-testable in node):
//
//   * identity binding rides the SAME auth events as initCloudSync:
//     SIGNED_IN syncs the realtime identity in the root layout (and on
//     the login screen, next to its initCloudSync call); SIGNED_OUT
//     unbinds (all channels torn down) BEFORE the expected-sign-out
//     check, so our own logout stops channels too.
//   * foreground complement: the layout's AppState-'active' handler
//     re-runs the boot pull set (pullEscrowsFromCloud + refreshTeam)
//     ALONGSIDE the existing app-config link refresh.
//   * screens own their subscriptions: home starts the home channel on
//     focus; escrow detail and activity start the per-escrow channel.
//   * refreshTeam's invited merge runs through the exclusive gate with
//     the writeInflight / committedSeq guards (the race the realtime
//     diagnosis flagged: it used to call local.replaceEscrow bare).
//
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'lib', 'teamRealtime.ts');
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
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// ---- layout: identity binding + foreground pull set -------------------
const layout = read('app/_layout.tsx');
const signedInAt = layout.indexOf("event === 'SIGNED_IN'");
assert(signedInAt >= 0, 'layout has a SIGNED_IN branch');
const signedInBlock = layout.slice(signedInAt, signedInAt + 2400);
assert(
  /initCloudSync\(\)/.test(signedInBlock) && /syncTeamRealtimeIdentity\(\)/.test(signedInBlock),
  'layout SIGNED_IN syncs the realtime identity alongside initCloudSync',
);
const signedOutAt = layout.indexOf("event !== 'SIGNED_OUT'");
assert(signedOutAt >= 0, 'layout has a SIGNED_OUT branch');
const unbindAt = layout.indexOf('setTeamRealtimeUser(null)');
assert(
  unbindAt > signedOutAt && unbindAt - signedOutAt < 400,
  'layout SIGNED_OUT unbinds the realtime identity immediately',
);
const expectAt = layout.indexOf('takeExpectSignOut()', signedOutAt);
assert(
  unbindAt < expectAt,
  'the unbind runs BEFORE the expected-sign-out check (own logout stops channels too)',
);
const appStateAt = layout.indexOf("AppState.addEventListener('change'");
assert(appStateAt >= 0, 'layout has the AppState foreground handler');
const appStateBlock = layout.slice(appStateAt, appStateAt + 900);
assert(/refreshClientAppLink\(\)/.test(appStateBlock), 'foreground handler keeps the app-config refresh');
assert(/pullEscrowsFromCloud\(\)/.test(appStateBlock), 'foreground handler re-pulls own escrows');
assert(/refreshTeam\(\)/.test(appStateBlock), 'foreground handler re-runs refreshTeam');

// ---- login: identity sync next to initCloudSync ------------------------
const login = read('app/login.tsx');
const loginInitAt = login.indexOf('await initCloudSync();');
assert(loginInitAt >= 0, 'login still calls initCloudSync');
assert(
  /syncTeamRealtimeIdentity\(\)/.test(login.slice(loginInitAt, loginInitAt + 1100)),
  'login syncs the realtime identity right after initCloudSync',
);

// ---- screens own their subscriptions -----------------------------------
const home = read('app/index.tsx');
assert(/startTeamRealtimeHome\(/.test(home), 'home starts the home realtime channel');
assert(/pullEscrowsFromCloud\(\)/.test(home), 'home invalidation re-pulls own escrows');
const detail = read('app/escrow/[id].tsx');
assert(/startTeamRealtimeEscrow\(/.test(detail), 'escrow detail starts the per-escrow channel');
assert(/refreshTeam\(\)/.test(detail), 'escrow detail invalidation re-runs refreshTeam');
const activity = read('app/activity/[id].tsx');
assert(/startTeamRealtimeEscrow\(/.test(activity), 'activity screen starts the per-escrow channel');

// ---- refreshTeam merge goes through the gate ---------------------------
const synced = read('src/lib/syncedStore.ts');
const rtAt = synced.indexOf('async function refreshTeam()');
assert(rtAt >= 0, 'refreshTeam exists');
const rtBlock = synced.slice(rtAt, rtAt + 6000);
const gateAt = rtBlock.indexOf('enqueueExclusive');
const replaceAt = rtBlock.indexOf('await local.replaceEscrow');
assert(gateAt >= 0, 'refreshTeam merge uses enqueueExclusive');
assert(
  replaceAt > gateAt,
  'refreshTeam replaceEscrow calls sit INSIDE the gate (after enqueueExclusive)',
);
assert(/writeInflight\.has\(/.test(rtBlock), 'refreshTeam merge checks writeInflight');
assert(/committedSeq\.get\(/.test(rtBlock), 'refreshTeam merge checks committedSeq');

summary('team_realtime_wiring');
