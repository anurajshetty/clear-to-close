// delete_account.test.ts — Stream 4 (Nov 2026): in-app account deletion
// (App Store 5.1.1(v) preempt, auditor PASS WITH CONDITIONS).
//
// Pins, each failing before the fix:
//  A. auth.deleteAccount behavior against a scripted fetch: the request
//     carries ONLY the password in the body (identity travels in the
//     Authorization header, from the live session — never in the body),
//     outcomes map deleted/husk, a husk persists the deletion-husk
//     marker for the boot router, and failures map to honest codes.
//  B. The delete-account Edge Function source: identity ONLY from the
//     caller's JWT (auth.getUser), password re-verified against the JWT
//     user's OWN email, body identity fields never read, and the step
//     order revocation -> storage -> data RPC -> admin.deleteUser LAST.
//  C. UI fidelity to the approved mockup: the Profile screen gains a
//     quiet red "Delete account" row BELOW Log out; the confirmation
//     screen carries the mockup's exact consequence copy, a password
//     field, and the permanent-delete button; the welcome screens can
//     show "Your account has been deleted."; the root layout routes a
//     sign-in-with-no-profile husk to the completion offer.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createAuthService, type AuthClientLike } from '../src/lib/auth';

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'lib', 'auth.ts');
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, rel))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const ROOT = findRepoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UID = '11111111-2222-3333-4444-555555555555';

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function mockClient(session: unknown): AuthClientLike {
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
    },
  } as unknown as AuthClientLike;
}

function makeService(opts: {
  client: AuthClientLike | null;
  respond: (call: FetchCall) => Promise<{ status: number; body: unknown }>;
  kv?: ReturnType<typeof memoryKV>;
}) {
  const calls: FetchCall[] = [];
  const kv = opts.kv ?? memoryKV();
  const svc = createAuthService({
    getClient: () => opts.client,
    kv,
    platform: 'native',
    fetchFn: async (url: string, init: FetchCall['init']) => {
      const call = { url, init };
      calls.push(call);
      const r = await opts.respond(call);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
    },
    supabaseUrl: 'https://proj.example',
    anonKey: 'anon-key-1',
  });
  return { svc, calls, kv };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------- A. service --
  const session = { access_token: 'tok-abc', user: { id: UID, email: 'realtor@example.com' } };

  {
    const { svc, calls } = makeService({
      client: mockClient(session),
      respond: async () => ({ status: 200, body: { ok: true, outcome: 'deleted' } }),
    });
    const res = await svc.deleteAccount('pw-123');
    assert(res.ok && res.outcome === 'deleted', 'A1: deleted outcome maps through');
    assert(calls.length === 1, 'A1: exactly one function call');
    const c = calls[0];
    assert(
      c.url === 'https://proj.example/functions/v1/delete-account',
      'A1: posts to the delete-account function',
    );
    assert(
      c.init.headers?.Authorization === 'Bearer tok-abc',
      'A1: identity travels as the session bearer token',
    );
    assert(c.init.headers?.apikey === 'anon-key-1', 'A1: anon apikey header present');
    const body = JSON.parse(c.init.body ?? '{}') as Record<string, unknown>;
    assert(
      Object.keys(body).length === 1 && body.password === 'pw-123',
      'A1: body carries the password and NOTHING else (no identity-shaped fields)',
    );
    assert((await svc.getDeletionHuskUserId()) === null, 'A1: no husk marker after a clean deletion');
  }

  {
    const kv = memoryKV();
    const { svc } = makeService({
      client: mockClient(session),
      kv,
      respond: async () => ({ status: 200, body: { ok: true, outcome: 'husk' } }),
    });
    const res = await svc.deleteAccount('pw-123');
    assert(res.ok && res.outcome === 'husk', 'A2: husk outcome maps through');
    assert(
      (await svc.getDeletionHuskUserId()) === UID,
      'A2: husk persists the marker (uid) for the boot router',
    );
    // A later successful completion clears the marker.
    const { svc: svc2 } = makeService({
      client: mockClient(session),
      kv,
      respond: async () => ({ status: 200, body: { ok: true, outcome: 'deleted' } }),
    });
    const res2 = await svc2.deleteAccount('pw-123');
    assert(res2.ok && res2.outcome === 'deleted', 'A2: retry can complete the deletion');
    assert((await svc2.getDeletionHuskUserId()) === null, 'A2: completion clears the husk marker');
  }

  {
    const { svc } = makeService({
      client: mockClient(session),
      respond: async () => ({ status: 401, body: { ok: false, error: 'wrong_password' } }),
    });
    const res = await svc.deleteAccount('nope');
    assert(!res.ok && res.code === 'wrong_password', 'A3: wrong password maps to wrong_password');
  }

  {
    const { svc, calls } = makeService({
      client: mockClient(session),
      respond: async () => {
        throw new Error('socket hangup');
      },
    });
    const res = await svc.deleteAccount('pw');
    assert(!res.ok && res.code === 'network', 'A4: transport failure maps to network');
    assert(calls.length === 1, 'A4: the call was attempted once');
  }

  {
    const { svc, calls } = makeService({
      client: null,
      respond: async () => ({ status: 200, body: {} }),
    });
    const res = await svc.deleteAccount('pw');
    assert(!res.ok && res.code === 'unconfigured', 'A5: no client maps to unconfigured');
    assert(calls.length === 0, 'A5: no call is made when unconfigured');
  }

  {
    const { svc, calls } = makeService({
      client: mockClient(null),
      respond: async () => ({ status: 200, body: {} }),
    });
    const res = await svc.deleteAccount('pw');
    assert(!res.ok && res.code === 'no_session', 'A6: no live session maps to no_session');
    assert(calls.length === 0, 'A6: no call is made without a session');
  }

  // ------------------------------------------------------ B. edge function --
  const fnPath = path.join(ROOT, 'supabase', 'functions', 'delete-account', 'index.ts');
  assert(fs.existsSync(fnPath), 'B0: delete-account edge function exists');
  if (fs.existsSync(fnPath)) {
    const fn = read('supabase/functions/delete-account/index.ts');
    assert(/\.auth\.getUser\(/.test(fn), 'B1: identity comes from the JWT via auth.getUser');
    assert(
      /signInWithPassword\(\{\s*email:\s*user\.email,\s*password/.test(fn),
      "B2: password re-verified against the JWT user's OWN email only",
    );
    assert(/body\.password/.test(fn), 'B3: the handler reads the password from the body');
    assert(
      !/body\.(uid|user_id|userId|email)\b/.test(fn) && !/parsed\.(uid|user_id|userId|email)\b/.test(fn),
      'B3: identity-shaped body fields are never read',
    );
    const iRevoke = fn.indexOf('admin.signOut(');
    const iStorage = fn.indexOf('.storage.from(');
    const iRpc = fn.indexOf("rpc('delete_account_data'");
    const iDelete = fn.indexOf('admin.deleteUser(');
    assert(
      iRevoke >= 0 && iStorage > iRevoke && iRpc > iStorage && iDelete > iRpc,
      'B4: step order is revocation -> storage -> data RPC -> admin.deleteUser LAST',
    );
    assert(fn.includes("'realtor-media'"), 'B5: storage removal targets the realtor-media bucket');
    assert(
      /\.list\(user\.id/.test(fn) || /prefix\s*=\s*user\.id/.test(fn),
      "B5: storage removal is scoped to the caller's <uid>/ prefix",
    );
    assert(/outcome:\s*'husk'/.test(fn), 'B6: a distinct husk outcome is returned');
    assert(/export \{ handle \}/.test(fn), 'B7: handler exported for node tests (house pattern)');
    // B8 (Nov 13, 2026 live-battery find): GoTrueAdminApi.signOut takes
    // the user's JWT as its first argument, NOT the user id. Passing
    // user.id made GoTrue reject the call, so every production delete
    // died at step 1 with revoke_failed. The revoke must hand the
    // caller's own bearer token to admin signOut.
    assert(
      /admin\.auth\.admin\.signOut\(token,\s*'global'\)/.test(fn),
      "B8: revocation passes the caller's JWT to admin signOut",
    );
    assert(
      !/admin\.signOut\(user\.id/.test(fn) && !/admin\.auth\.admin\.signOut\(user\.id/.test(fn),
      'B8: admin signOut is never called with the user id',
    );
  }

  // ---------------------------------------------------------------- C. UI --
  const profile = read('app/profile-update.tsx');
  assert(/testID="delete-account-row"/.test(profile), 'C1: Profile screen has the delete-account row');
  assert(
    profile.indexOf('logout-row') >= 0 &&
      profile.indexOf('delete-account-row') > profile.indexOf('logout-row'),
    'C1: the row sits BELOW Log out',
  );
  assert(profile.includes("router.push('/delete-account')"), 'C1: the row opens the confirmation screen');

  const screenPath = path.join(ROOT, 'app', 'delete-account.tsx');
  assert(fs.existsSync(screenPath), 'C2: confirmation screen exists');
  if (fs.existsSync(screenPath)) {
    const s = read('app/delete-account.tsx');
    // JSX line breaks collapse to single spaces at render; flatten
    // before comparing copy markers.
    const flat = s.replace(/\s+/g, ' ');
    const copy = [
      'Delete your account?',
      'This permanently deletes your Clear to Close account. It cannot be undone.',
      'Your profile is removed:',
      'Escrows you own are deleted:',
      'Your seats on other realtors’ escrows are removed',
      'Your sign-in is deleted:',
      'If you only need a break,',
      'Enter your password to confirm',
      'Delete my account permanently',
      'Complete deletion',
    ];
    for (const line of copy) {
      assert(flat.includes(line), `C2: confirmation screen carries mockup copy: "${line}"`);
    }
    assert(/auth\.deleteAccount\(/.test(s), 'C2: the screen calls auth.deleteAccount');
    assert(/clearLocalAccountData\(\)/.test(s), 'C2: success reuses the logout wipe');
    assert(!s.includes('—') && !s.includes('–'), 'C2: no em/en dashes in the new screen copy');
  }

  for (const f of ['app/login.tsx', 'app/role.tsx']) {
    const src = read(f);
    assert(
      src.includes('Your account has been deleted.'),
      `C3: ${f} can show the post-deletion line`,
    );
    assert(/deleted === '1'|deleted: '1'/.test(src), `C3: ${f} reads the deleted notice param`);
  }

  const layout = read('app/_layout.tsx');
  assert(layout.includes('name="delete-account"'), 'C4: the delete-account route is registered');
  assert(
    /getDeletionHuskUserId/.test(layout),
    'C4: boot routing checks the deletion-husk marker for sign-in-with-no-profile',
  );

  summary('delete_account');
}

void main();
