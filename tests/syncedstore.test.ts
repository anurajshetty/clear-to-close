// syncedstore.test.ts — execute-time coverage for the synced store wrapper
// (src/lib/syncedStore.ts). The delegate functions are tested elsewhere;
// these pin the wrapper's own timeout/gating/mirror logic, which previously
// had zero coverage:
//  - redeemInvite: the 8s-timeout race -> 'network' (the exact path screens
//    call), unique-violation -> 'device_has_link', bad codes -> 'invalid'
//  - validateClientLink: revoked -> invalid; transport failure -> fail-open
//  - getClientProfile: linked-first for client devices, local fallback
// The Supabase client is injected (no network); the public gate is enabled
// with fake env vars (this file runs in its own node process).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import type { RealtorProfile } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function mockClient(rpc: (name: string, params?: unknown) => Promise<{ data?: unknown; error?: unknown }>) {
  return { rpc };
}

function profileFixture(): RealtorProfile {
  return {
    name: 'Rita Realtor',
    photoUri: null,
    about: 'About Rita',
    yearsExperience: '8',
    dealsClosed: '42',
    areasServed: 'Valencia',
    phone: '555-0100',
    dreLicense: 'DRE-123',
  };
}

async function main(): Promise<void> {
  // ------------------------------------------------------- redeem wrapper ---
  {
    // The RPC never resolves: the timeout race must surface retryable
    // 'network', never hang and never 'invalid'.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockClient(() => new Promise(() => {})),
      redeemTimeoutMs: 50,
    });
    const r = await store.redeemInvite('ABCDEF', 'Priya Nair', 'dev-1');
    assert(!r.ok && r.error === 'network', 'redeem rpc timeout -> network (not invalid)');
  }
  {
    // Second live link on the same device_id: 23505 -> 'device_has_link'.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () =>
        mockClient(async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } })),
      redeemTimeoutMs: 50,
    });
    const r = await store.redeemInvite('ABCDEF', 'Priya Nair', 'dev-1');
    assert(!r.ok && r.error === 'device_has_link', 'redeem unique violation -> device_has_link');
  }
  {
    // Genuine bad code still maps to 'invalid' through the wrapper.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockClient(async () => ({ data: { ok: false, error: 'invalid' }, error: null })),
      redeemTimeoutMs: 50,
    });
    const r = await store.redeemInvite('ZZZZZZ', 'Nobody', 'dev-1');
    assert(!r.ok && r.error === 'invalid', 'redeem bad code via wrapper -> invalid');
  }
  {
    // Happy path: the cloud link is persisted for the escrow + role.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () =>
        mockClient(async () => ({
          data: { ok: true, escrow_id: 'esc-7', role: 'buyer', party_name: 'Priya Nair', link_id: 'link-7' },
          error: null,
        })),
      redeemTimeoutMs: 50,
    });
    const r = await store.redeemInvite('ABCDEF', 'Priya Nair', 'dev-1');
    assert(r.ok === true, 'redeem ok through wrapper');
    if (!r.ok) throw new Error('fixture redeem failed');
    const raw = await kv.getItem('ctc:cloudlinks');
    const links = raw ? (JSON.parse(raw) as Record<string, { linkId: string; role: string }>) : {};
    assert(links['esc-7']?.linkId === 'link-7' && links['esc-7']?.role === 'buyer',
      'redeem persists the cloud link ref');
  }

  // ------------------------------------------------- validateClientLink -----
  {
    // Revoked on the server -> the link is dead.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockClient(async () => ({ data: { ok: false, error: 'revoked' }, error: null })),
    });
    const v = await store.validateClientLink('link-1');
    assert(v.valid === false, 'validateClientLink revoked -> invalid');
  }
  {
    // Transport failure fails OPEN: an offline client keeps its cached view.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () =>
        mockClient(async () => {
          throw new TypeError('fetch failed');
        }),
    });
    const v = await store.validateClientLink('link-1');
    assert(v.valid === true, 'validateClientLink transport failure -> fail-open valid');
  }

  // --------------------------------------------------- getClientProfile -----
  {
    // Client device: no local profile, but the invite populated the linked
    // profile — the client-facing profile screen must show it (regression:
    // it used to read getProfile() only and render "Loading…" forever).
    const kv = memoryKV();
    await kv.setItem('ctc:cloudview:esc-1', JSON.stringify({ view: null, profile: profileFixture() }));
    const { store } = createSyncedStore(kv, { cloudClient: () => mockClient(async () => ({})) });
    assert((await store.getProfile()) === null, 'fixture: client device has no local profile');
    const p = await store.getClientProfile('esc-1');
    assert(p !== null && p.name === 'Rita Realtor', 'getClientProfile prefers the linked profile');
  }
  {
    // Realtor's own device: no linked profile -> falls back to local.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockClient(async () => ({})) });
    await store.saveProfile(profileFixture());
    const p = await store.getClientProfile('esc-9');
    assert(p !== null && p.name === 'Rita Realtor', 'getClientProfile falls back to the local profile');
  }
  {
    // No escrow context -> the local profile, whatever it is.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockClient(async () => ({})) });
    assert((await store.getClientProfile(null)) === null, 'getClientProfile null escrow, no local -> null');
  }

  summary('syncedstore');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
