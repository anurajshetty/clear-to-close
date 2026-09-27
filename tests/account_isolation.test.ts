// account_isolation.test.ts — REGRESSION (Anuraj, Sept 2026): account/data
// isolation failure. A realtor logs out, signs up with a NEW account, and
// after creating the profile OR skipping profile setup, the app showed the
// OLD profile from the account just logged out of.
//
// Root cause: logout never cleared the local realtor cache — the profile,
// escrows, invites, links, cloud-view cache, outbox, and managed photo/banner
// files were all keyed generically (ctc:profile, ctc:escrows, ...) instead of
// per auth.uid(), and signOut() only removed onboarding leftovers
// (ctc:profileskipped, ctc:pendingname). So the new account inherited the
// previous account's deal list, profile, and media.
//
// The fix: store.clearLocalAccountData() wipes every account-scoped artifact
// (in-memory snapshot + KV keys + managed photo/banner files) and the logout
// flow calls it before auth.signOut(). auth.signOut() itself clears the
// remaining identity-boundary keys as a backstop: the sync outbox (F1 —
// drainOutbox stamps the CURRENT session's uid onto each row before
// upserting, so lingering ops would push A's rows into B's account with RLS
// passing; NEVER drain before clearing) and the device client link (F3 —
// resolveBootHref checks the client link FIRST, so a stale link boots the
// signed-out device straight into the old client view). A realtor sign-up or
// login success also kills the device client link.
// Device-scoped keys (ctc:role, ctc:deviceid, ctc:pushasked) survive — they
// belong to the device, not the account.
//
// Each assertion below FAILS without the fix and PASSES with it.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createAuthService, type AuthClientLike } from '../src/lib/auth';
import { createSyncedStore } from '../src/lib/syncedStore';
import { enqueueOutbox } from '../src/lib/cloudSync';
import type { KV } from '../src/lib/store';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: (id: string) => any;

// The web managed-media files live in localStorage (src/lib/photoFile.ts).
// Stub it on globalThis so the wipe's web path is exercised in node.
const lsStore = new Map<string, string>();
(globalThis as unknown as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
};

const ACCOUNT_KEYS = [
  'ctc:profile',
  'ctc:escrows',
  'ctc:invites',
  'ctc:links',
  'ctc:cloudlinks',
  'ctc:outbox',
];

const DEVICE_KEYS = ['ctc:role', 'ctc:deviceid', 'ctc:pushasked'];

async function seedAccountA(kv: KV): Promise<string> {
  const { store } = createSyncedStore(kv, { cloudClient: () => null });
  // A's profile (with photo + banner, as in Anuraj's report).
  await store.saveProfile({
    name: 'Account A Realtor',
    photoUri: 'data:image/jpeg;base64,AAA',
    photoRemoteUrl: 'https://example.supabase.co/photo.jpg?v=1',
    bannerRemoteUrl: 'https://example.supabase.co/banner.jpg?v=1',
    about: 'A realtor',
    yearsExperience: '10',
    email: 'a@example.com',
    areasServed: 'Valencia',
    phone: '(555) 111-1111',
    dreLicense: 'DRE-A',
    realty_group: 'A Realty',
    banner_image: 'data:image/jpeg;base64,BBB',
    reviews: [],
    rating: null,
  });
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 30);
  const escrow = await store.createEscrow({
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'A Buyer',
    openDate: fmt(now),
    closeDate: fmt(close),
  });
  // A client link + an invite, an unsynced outbox op (A's identity), a
  // cached cloud view, and the web managed-media files.
  await store.createInvite(escrow.id, 'buyer', 'Client One');
  await enqueueOutbox(kv, { op: 'pushProfile', attempts: 0 });
  await kv.setItem('ctc:cloudlinks', JSON.stringify([{ linkId: 'link-a', role: 'buyer', escrowId: escrow.id }, { linkId: 'link-orphan', role: 'seller', escrowId: 'esc-orphan' }]));
  await kv.setItem('ctc:cloudview:' + escrow.id, JSON.stringify({ view: { escrowId: escrow.id }, profile: { name: 'Account A Realtor' } }));
  // An orphaned cached cloud view: its escrow is absent from the local
  // list (only present via the cloud links). The wipe must still remove it.
  await kv.setItem('ctc:cloudview:esc-orphan', JSON.stringify({ view: { escrowId: 'esc-orphan' } }));
  lsStore.set('ctc:profile-photo', 'data:image/jpeg;base64,AAA');
  lsStore.set('ctc:profile-banner', 'data:image/jpeg;base64,BBB');
  // Device-scoped keys that must SURVIVE the store wipe. (The client link
  // is cleared by auth.signOut() — covered in the identity-boundary
  // section below — not by the store wipe, so it stays here.)
  await kv.setItem('ctc:role', 'realtor');
  await kv.setItem('ctc:deviceid', 'device-1');
  await kv.setItem('ctc:clientlink', JSON.stringify({ linkId: 'device-link' }));
  await kv.setItem('ctc:pushasked', '1');
  return escrow.id;
}

async function main(): Promise<void> {
  const kv = memoryKV();
  const escrowId = await seedAccountA(kv);
  const { store } = createSyncedStore(kv, { cloudClient: () => null });

  // Sanity: A's data is fully cached before logout.
  assert((await store.getProfile())?.name === 'Account A Realtor', 'setup: A profile cached');
  assert((await store.listEscrows()).length === 1, 'setup: A escrow cached');

  // The logout wipe — this method did not exist before the fix (TypeError),
  // and nothing else in the logout path cleared the cache.
  const wipe = (store as unknown as { clearLocalAccountData?: () => Promise<void> })
    .clearLocalAccountData;
  assert(typeof wipe === 'function', 'REGRESSION: logout wipe exists on the store');
  await wipe!.call(store);

  // Account A's artifacts are gone — in-memory AND on disk.
  assert((await store.getProfile()) === null, 'REGRESSION: profile gone after logout');
  assert((await store.listEscrows()).length === 0, 'REGRESSION: escrows gone after logout');
  assert((await store.listInvites(escrowId)).length === 0, 'REGRESSION: invites gone after logout');
  for (const key of ACCOUNT_KEYS) {
    assert((await kv.getItem(key)) === null, `REGRESSION: ${key} removed`);
  }
  assert(
    (await kv.getItem('ctc:cloudview:' + escrowId)) === null,
    'REGRESSION: cached cloud view removed',
  );
  assert(
    (await kv.getItem('ctc:cloudview:esc-orphan')) === null,
    'REGRESSION: orphaned cached cloud view removed',
  );
  assert(lsStore.has('ctc:profile-photo') === false, 'REGRESSION: web managed photo removed');
  assert(lsStore.has('ctc:profile-banner') === false, 'REGRESSION: web managed banner removed');

  // A brand-new store over the same device storage (account B's first read)
  // sees a fresh/empty account — never A's data.
  const { store: storeB } = createSyncedStore(kv, { cloudClient: () => null });
  assert((await storeB.getProfile()) === null, 'REGRESSION: new account sees no profile');
  assert((await storeB.listEscrows()).length === 0, 'REGRESSION: new account sees no escrows');

  // Device-scoped keys survive — logout must not nuke device identity.
  for (const key of DEVICE_KEYS) {
    assert((await kv.getItem(key)) !== null, `device key ${key} survives logout`);
  }
  // The client link survives the STORE wipe specifically — it is
  // auth-domain state, cleared by auth.signOut() (asserted below).
  assert(
    (await kv.getItem('ctc:clientlink')) !== null,
    'store wipe leaves the client link for auth.signOut to clear',
  );

  // Skip-profile path: B skips creation and still sees nothing of A.
  const { store: storeC } = createSyncedStore(kv, { cloudClient: () => null });
  assert((await storeC.getProfile()) === null, 'REGRESSION: skipped-profile account sees no profile');
  assert((await storeC.listEscrows()).length === 0, 'REGRESSION: skipped-profile account sees no escrows');

  // --- auth identity boundary (F1/F3) ------------------------------------
  // signOut() is the identity-boundary backstop: it clears the sync outbox
  // and the device client link even if a caller only ever calls signOut().
  {
    const kv2 = memoryKV();
    let serverSignOut = false;
    const svc = createAuthService({
      getClient: () =>
        ({
          auth: {
            signOut: async () => {
              serverSignOut = true;
              return { error: null };
            },
          },
        }) as unknown as AuthClientLike,
      kv: kv2,
      platform: 'native',
    });
    await enqueueOutbox(kv2, { op: 'pushEscrow', escrowId: 'esc-a', attempts: 0 });
    await kv2.setItem('ctc:clientlink', JSON.stringify({ linkId: 'device-link' }));
    await kv2.setItem('ctc:profileskipped', '1');
    await kv2.setItem('ctc:pendingname', 'A Realtor');
    await kv2.setItem('ctc:role', 'realtor');
    await kv2.setItem('ctc:deviceid', 'device-1');
    await svc.signOut();
    assert(serverSignOut, 'F1/F3: supabase signOut still called');
    assert((await kv2.getItem('ctc:outbox')) === null, 'F1: signOut clears the outbox (never drain it)');
    assert((await kv2.getItem('ctc:clientlink')) === null, 'F3: signOut clears the device client link');
    assert((await kv2.getItem('ctc:profileskipped')) === null, 'signOut clears profile-skipped flag');
    assert((await kv2.getItem('ctc:pendingname')) === null, 'signOut clears pending name');
    assert((await kv2.getItem('ctc:role')) === 'realtor', 'signOut keeps the device role');
    assert((await kv2.getItem('ctc:deviceid')) === 'device-1', 'signOut keeps the device id');
    // A server-side signOut failure must not trap the local wipe.
    const kv3 = memoryKV();
    await enqueueOutbox(kv3, { op: 'pushProfile', attempts: 0 });
    const svc2 = createAuthService({
      getClient: () =>
        ({
          auth: {
            signOut: async () => {
              throw new Error('signout boom');
            },
          },
        }) as unknown as AuthClientLike,
      kv: kv3,
      platform: 'native',
    });
    await svc2.signOut();
    assert((await kv3.getItem('ctc:outbox')) === null, 'F1: outbox cleared even when server signOut throws');
    // A realtor sign-up/login success kills the device client link too, so
    // resolveBootHref (which checks the link first) can't boot the new
    // realtor session into the old client view.
    const kv4 = memoryKV();
    await kv4.setItem('ctc:clientlink', JSON.stringify({ linkId: 'device-link' }));
    const svc3 = createAuthService({
      getClient: () =>
        ({
          auth: {
            signUp: async () => ({ data: { session: { user: { id: 'uid-b' } } }, error: null }),
          },
        }) as unknown as AuthClientLike,
      kv: kv4,
      platform: 'native',
    });
    const up = await svc3.signUp('B Realtor', 'b@example.com', 'longenough');
    assert(up.ok, 'signUp success');
    assert((await kv4.getItem('ctc:clientlink')) === null, 'F3: signUp clears the device client link');
    const kv5 = memoryKV();
    await kv5.setItem('ctc:clientlink', JSON.stringify({ linkId: 'device-link' }));
    const svc4 = createAuthService({
      getClient: () =>
        ({
          auth: {
            signInWithPassword: async () => ({ data: { user: { id: 'uid-b' } }, error: null }),
          },
        }) as unknown as AuthClientLike,
      kv: kv5,
      platform: 'native',
    });
    const inn = await svc4.signIn('b@example.com', 'longenough');
    assert(inn.ok, 'signIn success');
    assert((await kv5.getItem('ctc:clientlink')) === null, 'F3: signIn clears the device client link');
  }

  // --- migration 0017 (F2) structural guard -------------------------------
  // get_client_view must serialize an explicit profile field list, not
  // to_jsonb(p): email is realtor-side only and must not reach clients.
  {
    const fs = require('fs');
    const path = require('path');
    const root = (process.env['CTC_REPO_ROOT'] as string) ?? '';
    const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '0017_client_view_profile_fields.sql'), 'utf8') as string;
    // Strip -- line comments: the header explains the old to_jsonb(p)
    // behavior, so only the actual function body is checked.
    const body = sql.replace(/--[^\n]*/g, '');
    assert(!body.includes('to_jsonb(p)'), 'F2: migration 0017 does not serialize the full profile row');
    assert(!body.includes("'email'"), 'F2: migration 0017 ships no email field to clients');
    assert(body.includes("'phone', p.phone"), 'F2: migration 0017 keeps phone for client Call/Text');
    assert(body.includes('create or replace function get_client_view'), 'F2: migration 0017 re-creates get_client_view');
  }

  summary('account-isolation');
}

main().catch((e) => {
  console.error('FAIL - uncaught: ' + (e && (e as Error).message ? (e as Error).message : e));
  process.exitCode = 1;
});
