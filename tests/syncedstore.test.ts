// syncedstore.test.ts — execute-time coverage for the synced store wrapper
// (src/lib/syncedStore.ts). The delegate functions are tested elsewhere;
// these pin the wrapper's own timeout/gating/mirror logic:
//  - redeemInvite: the 8s-timeout race -> 'network' (the exact path screens
//    call), unexpected unique-violation -> 'network' (multi-escrow: the old
//    one-live-link-per-device gate is gone), bad codes -> 'invalid'
//  - validateClientLink: revoked/invalid -> fail-closed invalid; transport
//    failure -> fail-open valid (never strand a client on a flaky network)
//  - getClientProfile: linked-first for client devices, local fallback
//  - Synchronous writes (Sept 28, 2026): with no cloud client / no session,
//    every user write throws the plain not-saved copy and leaves local
//    state byte-identical — there are no local-only writes and no outbox.
//  - invite flow through the wrapper against a fake cloud: the two-per-side
//    cap, revoke (invite + server link), and atomic regenerate.
// The Supabase client is injected (no network); the public gate is enabled
// with fake env vars (this file runs in its own node process).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { createMockServer, mockCloudFromServer } from './mock_server';
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
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    about: 'About Rita',
    yearsExperience: '8',
    email: 'maya@compass.com',
    areasServed: 'Valencia',
    phone: '555-0100',
    dreLicense: 'DRE-123',
    realty_group: '',
    googleReviewLink: '',
    realtorComReviewLink: '',
    banner_image: null,
    reviews: [],
    rating: null,
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
    // Multi-escrow (migration 0022): an unexpected 23505 escaping the RPC is
    // a server anomaly, mapped to the retryable 'network' code — same
    // device/same escrow idempotency is the RPC's own job.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () =>
        mockClient(async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } })),
      redeemTimeoutMs: 50,
    });
    const r = await store.redeemInvite('ABCDEF', 'Priya Nair', 'dev-1');
    assert(!r.ok && r.error === 'network', 'redeem unique violation -> network (device_has_link is gone)');
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
  {
    // Explicit server 'invalid' (no live link row) must fail CLOSED: the
    // client lands on the dead-link state instead of seeing a stale view.
    // Regression: this used to fail open like a transport error.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockClient(async () => ({ data: { ok: false, error: 'invalid' }, error: null })),
    });
    const v = await store.validateClientLink('link-1');
    assert(v.valid === false, "validateClientLink server 'invalid' -> fail-closed invalid");
  }
  {
    // Case-insensitive server rejection still fails closed.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockClient(async () => ({ data: { ok: false, error: 'Revoked' }, error: null })),
    });
    const v = await store.validateClientLink('link-1');
    assert(v.valid === false, "validateClientLink server 'Revoked' -> invalid");
  }
  {
    // A free-form transport-ish message that merely CONTAINS a rejection word
    // must not be misread as a server rejection -> stays fail-open.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: () =>
        mockClient(async () => {
          throw new TypeError('invalid response from proxy');
        }),
    });
    const v = await store.validateClientLink('link-1');
    assert(v.valid === true, 'validateClientLink transport message containing a keyword -> fail-open');
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
    // (saveProfile is a confirmed write now, so the fixture client needs a
    // session + a profiles table — the rpc-only mockClient is not enough.)
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(createMockServer()),
    });
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

  // ---------------- synchronous writes: no cloud, no local-only writes -----
  // (Sept 28, 2026). Missing cloud/session must FAIL, never appear saved
  // locally. There is no outbox for user actions.
  async function inviteEscrow(store: { createEscrow: (i: never) => Promise<{ id: string }> }) {
    return store.createEscrow({
      address: '123 Main St',
      city: 'Santa Clarita',
      side: 'buy',
      buyerName: 'Alice Buyer',
      sellerName: 'Bob Seller',
      openDate: '2026-09-01',
      closeDate: '2026-10-15',
    } as never);
  }
  {
    // No cloud client at all: createEscrow throws the plain copy.
    const map = new Map<string, string>();
    const kv = {
      getItem: async (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: async (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: async (k: string) => {
        map.delete(k);
      },
      dump: () =>
        JSON.stringify(
          [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
    };
    const before = kv.dump();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    let msg = '';
    try {
      await inviteEscrow(store);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/Couldn't save/i.test(msg), `null cloud: createEscrow throws the not-saved copy (got: ${msg})`);
    assert((await store.listEscrows()).length === 0, 'null cloud: no escrow appears locally');
    assert(kv.dump() === before, 'null cloud: persisted KV is byte-identical');
    assert(
      (await kv.getItem('ctc:outbox')) === null,
      'null cloud: no outbox op is queued by the failed write',
    );
  }
  {
    // createInvite and saveProfile fail the same way with no cloud.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    let inviteThrew = false;
    try {
      await store.createInvite('esc-x', 'buyer', 'Ghost');
    } catch {
      inviteThrew = true;
    }
    assert(inviteThrew, 'null cloud: createInvite throws (no local-only invite)');
    let profileThrew = false;
    try {
      await store.saveProfile(profileFixture());
    } catch {
      profileThrew = true;
    }
    assert(profileThrew, 'null cloud: saveProfile throws (no local-only profile)');
    assert((await store.listInvites('esc-x')).length === 0, 'null cloud: no invite appears locally');
    assert((await store.getProfile()) === null, 'null cloud: no profile appears locally');
  }

  // ---------------- invite flow through the wrapper (fake cloud) -------------
  // The cap, revoke, and regenerate run as synchronous confirmed writes.
  async function liveStore() {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server),
      writeTimeoutMs: 2000,
      writeTimeoutLongMs: 4000,
    });
    const ping = await initCloudSync();
    assert(ping.ok, 'initCloudSync healthy');
    return { server, store };
  }
  {
    // Cap enforced through the synced wrapper: the 3rd create throws the
    // cap copy and leaves local + server invites untouched.
    const { server, store } = await liveStore();
    const escrow = await inviteEscrow(store);
    await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    await store.createInvite(escrow.id, 'buyer', 'Buyer Two');
    const before = (await store.listInvites(escrow.id)).map((i) => i.id).sort().join(',');
    let msg = '';
    try {
      await store.createInvite(escrow.id, 'buyer', 'Buyer Three');
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/2 active invite codes/.test(msg), `cap breach throws the cap copy (got: ${msg})`);
    const after = (await store.listInvites(escrow.id)).map((i) => i.id).sort().join(',');
    assert(after === before, 'cap breach leaves the local invites byte-identical');
    assert(server.invites.size === 2, 'cap breach pushes nothing to the server');
  }
  {
    // Revoke through the wrapper: the invite is revoked server-side, the
    // server device link is killed, and the local mirror follows.
    const { server, store } = await liveStore();
    const escrow = await inviteEscrow(store);
    const inv = await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    const r = await store.redeemInvite(inv.code, 'Buyer One', 'dev-1');
    if (!r.ok) throw new Error('fixture redeem failed');
    const linkId = r.linkId;
    const res = await store.revokeInvite(inv.id);
    assert(Array.isArray(res.revokedLinks), 'revokeInvite resolves with its revoked-links report');
    assert(server.invites.get(inv.id)?.revokedAt != null, 'the server invite row is revoked');
    assert(server.links.get(linkId)?.revokedAt !== null, 'the server device link is killed');
    assert(
      (await store.getInvite(inv.id))?.revokedAt !== null,
      'the local invite mirror is revoked',
    );
    const v = await store.validateClientLink(linkId);
    assert(v.valid === false, 'revokeInvite kills the client link');
  }
  {
    // Regenerate through the wrapper (atomic RPC): the old code is dead
    // server-side, the new code is live locally and server-side, and the
    // old device link is killed.
    const { server, store } = await liveStore();
    const escrow = await inviteEscrow(store);
    const inv = await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    const r = await store.redeemInvite(inv.code, 'Buyer One', 'dev-1');
    if (!r.ok) throw new Error('fixture redeem failed');
    const oldCode = inv.code;
    const regen = await store.regenerateInvite(inv.id);
    assert(regen.invite.code !== oldCode, 'synced regenerateInvite issues a fresh code');
    assert(regen.invite.partyName === 'Buyer One', 'synced regenerateInvite keeps the party');
    assert(
      server.invites.get(regen.invite.id)?.code === regen.invite.code,
      'the server row carries the fresh code',
    );
    const oldRedeem = await store.redeemInvite(oldCode, 'Buyer One', 'dev-9');
    assert(!oldRedeem.ok && oldRedeem.error === 'revoked', 'old code dead after synced regenerate');
    const v = await store.validateClientLink(r.linkId);
    assert(v.valid === false, 'old device link dead after synced regenerate');
  }

  summary('syncedstore');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
