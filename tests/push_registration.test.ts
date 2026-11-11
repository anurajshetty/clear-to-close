// push_registration.test.ts — REGRESSION: realtor push registration
// fired ONLY from PushGate's bootstrap effect (once per cold launch),
// so a fresh install that signed in afterwards never registered its
// token until the next cold launch (live incident, Nov 10, 2026: the
// owner received no member-activity pushes until he relaunched in the
// owner session). The fix re-runs registration on the SIGNED_IN path
// (layout listener + login screen) and records every attempt's outcome
// (registered / skipped+reason / failed+error) in the internal push
// registration log instead of swallowing it silently.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  __setExpoProjectIdForTests,
  __setNotificationsForTests,
  __setPlatformForTests,
  __setSessionUserIdForTests,
  __setSupabaseForTests,
  readRealtorPushRegistrationLog,
  registerRealtorPushToken,
} from '../src/lib/push';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'lib', 'push.ts');
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

interface FakeOpts {
  permission: string;
  session: string | null;
  projectId: string | null;
  rpcResult?: { data: unknown; error: { message: string } | null };
}

function setupFake(opts: FakeOpts): Array<{ fn: string; args: Record<string, unknown> }> {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  __setPlatformForTests('ios');
  __setNotificationsForTests({
    getPermissionsAsync: async () => ({ status: opts.permission }),
    getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[registration-test]' }),
  });
  __setSessionUserIdForTests(async () => opts.session);
  __setExpoProjectIdForTests(opts.projectId);
  __setSupabaseForTests({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return opts.rpcResult ?? { data: { ok: true }, error: null };
    },
  });
  return rpcCalls;
}

function resetSeams(): void {
  __setNotificationsForTests(undefined);
  __setSupabaseForTests(undefined);
  __setSessionUserIdForTests(undefined);
  __setExpoProjectIdForTests(undefined);
  __setPlatformForTests(null);
}

async function lastRecord() {
  const log = await readRealtorPushRegistrationLog();
  return log[log.length - 1];
}

async function main(): Promise<void> {
  // 1. Permission not granted -> skipped with reason, no RPC.
  let calls = setupFake({ permission: 'denied', session: 'uid-1', projectId: 'proj-1' });
  assert((await registerRealtorPushToken()) === false, 'denied permission returns false');
  let rec = await lastRecord();
  assert(rec?.status === 'skipped' && rec?.reason === 'permission-not-granted',
    'denied permission records skipped/permission-not-granted');
  assert(calls.length === 0, 'no RPC attempted when permission is not granted');

  // 2. Signed out -> skipped/signed-out.
  calls = setupFake({ permission: 'granted', session: null, projectId: 'proj-1' });
  assert((await registerRealtorPushToken()) === false, 'signed-out returns false');
  rec = await lastRecord();
  assert(rec?.status === 'skipped' && rec?.reason === 'signed-out',
    'signed-out records skipped/signed-out');
  assert(calls.length === 0, 'no RPC attempted while signed out');

  // 3. No project id -> skipped/no-project-id (the production-build trap
  // must be visible in the log, not just a console line).
  setupFake({ permission: 'granted', session: 'uid-1', projectId: null });
  assert((await registerRealtorPushToken()) === false, 'missing project id returns false');
  rec = await lastRecord();
  assert(rec?.status === 'skipped' && rec?.reason === 'no-project-id',
    'missing project id records skipped/no-project-id');

  // 4. Happy path -> registered, RPC carries device + token.
  calls = setupFake({ permission: 'granted', session: 'uid-1', projectId: 'proj-1' });
  assert((await registerRealtorPushToken()) === true, 'granted + signed in registers');
  rec = await lastRecord();
  assert(rec?.status === 'registered', 'success records registered');
  assert(calls.length === 1 && calls[0].fn === 'register_push_token_for_user',
    'registration calls register_push_token_for_user once');
  assert(calls[0].args.p_token === 'ExponentPushToken[registration-test]',
    'the minted token is sent');
  assert(typeof calls[0].args.p_device_id === 'string' &&
    (calls[0].args.p_device_id as string).length > 0, 'the device id is sent');

  // 5. RPC error -> failed with the error recorded.
  setupFake({
    permission: 'granted', session: 'uid-1', projectId: 'proj-1',
    rpcResult: { data: null, error: { message: 'rpc boom' } },
  });
  assert((await registerRealtorPushToken()) === false, 'RPC error returns false');
  rec = await lastRecord();
  assert(rec?.status === 'failed' && (rec?.error ?? '').includes('rpc boom'),
    'RPC error records failed with the error text');

  // 6. The log is a bounded ring (50), newest last.
  setupFake({ permission: 'denied', session: 'uid-1', projectId: 'proj-1' });
  for (let i = 0; i < 55; i++) await registerRealtorPushToken();
  const log = await readRealtorPushRegistrationLog();
  assert(log.length === 50, 'the registration log caps at 50 records');

  resetSeams();

  // 7. SIGNED_IN wiring (source pins): the layout auth listener and the
  // login screen re-run registration alongside initCloudSync; PushGate's
  // bootstrap call is unchanged.
  const root = findRepoRoot();
  assert(root !== '', 'could not locate the repo root');
  const layout: string = fs.readFileSync(path.join(root, 'app', '_layout.tsx'), 'utf8');
  const signedInBlock = /if \(event === 'SIGNED_IN'\) \{[\s\S]*?\n      \}/.exec(layout)?.[0] ?? '';
  assert(/initCloudSync\(\)/.test(signedInBlock), 'layout SIGNED_IN still runs initCloudSync');
  assert(/registerRealtorPushToken\(\)/.test(signedInBlock),
    'layout SIGNED_IN re-runs realtor push registration alongside initCloudSync');
  const login: string = fs.readFileSync(path.join(root, 'app', 'login.tsx'), 'utf8');
  assert(/await initCloudSync\(\);[\s\S]{0,700}?registerRealtorPushToken\(\)/.test(login),
    'login screen re-runs registration right after initCloudSync');
  const gate: string = fs.readFileSync(path.join(root, 'src', 'components', 'PushGate.tsx'), 'utf8');
  assert(/void registerRealtorPushToken\(\)\.catch\(\(\) => false\);/.test(gate),
    'PushGate bootstrap registration call is unchanged');

  summary('push_registration');
}

void main();
