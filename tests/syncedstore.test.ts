// syncedstore.test.ts — execute-time coverage for the synced store wrapper
// (src/lib/syncedStore.ts). The delegate functions are tested elsewhere;
// these pin the wrapper's own timeout/gating/mirror logic, which previously
// had zero coverage:
//  - redeemInvite: the 8s-timeout race -> 'network' (the exact path screens
//    call), unique-violation -> 'device_has_link', bad codes -> 'invalid'
//  - validateClientLink: revoked/invalid -> fail-closed invalid; transport
//    failure -> fail-open valid (never strand a client on a flaky network)
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

  // --------------------------------- invite flow: cap / revoke / regenerate --
  // (approved invite-client flow, Sept 2026). The cloud client is null so the
  // wrapper exercises the local path; the outbox assertions pin the queued
  // convergence ops.
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
    // Cap enforced through the synced wrapper: the 3rd create throws and
    // queues no pushInvite op.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    const escrow = await inviteEscrow(store);
    await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    await store.createInvite(escrow.id, 'buyer', 'Buyer Two');
    let threw = false;
    try {
      await store.createInvite(escrow.id, 'buyer', 'Buyer Three');
    } catch {
      threw = true;
    }
    assert(threw, 'synced createInvite enforces the two-per-side cap');
    const outbox = JSON.parse((await kv.getItem('ctc:outbox')) ?? '[]') as { op: string }[];
    const pushInvites = outbox.filter((o) => o.op === 'pushInvite');
    assert(pushInvites.length === 2, `cap breach queues no pushInvite op (got ${pushInvites.length})`);
  }
  {
    // Revoke through the wrapper: the local client link dies AND a
    // pushRevoke op is queued for cloud convergence.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    const escrow = await inviteEscrow(store);
    const inv = await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    const r = await store.redeemInvite(inv.code, 'Buyer One', 'dev-1');
    if (!r.ok) throw new Error('fixture redeem failed');
    await store.revokeInvite(inv.id);
    const v = await store.validateClientLink(r.linkId);
    assert(v.valid === false, 'synced revokeInvite kills the local client link');
    const outbox = JSON.parse((await kv.getItem('ctc:outbox')) ?? '[]') as { op: string; inviteId?: string }[];
    assert(
      outbox.some((o) => o.op === 'pushRevoke' && o.inviteId === inv.id),
      'synced revokeInvite queues a pushRevoke op',
    );
  }
  {
    // Regenerate through the wrapper (cloud dormant -> local path): fresh
    // code for the same party, old code dead, old device link dead, and the
    // convergence ops (pushRevoke old / pushInvite new / revokeClientLink)
    // are queued.
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    const escrow = await inviteEscrow(store);
    const inv = await store.createInvite(escrow.id, 'buyer', 'Buyer One');
    const r = await store.redeemInvite(inv.code, 'Buyer One', 'dev-1');
    if (!r.ok) throw new Error('fixture redeem failed');
    const regen = await store.regenerateInvite(inv.id);
    assert(regen.invite.code !== inv.code, 'synced regenerateInvite issues a fresh code');
    assert(regen.invite.partyName === 'Buyer One', 'synced regenerateInvite keeps the party');
    const oldRedeem = await store.redeemInvite(inv.code, 'Buyer One');
    assert(!oldRedeem.ok && oldRedeem.error === 'revoked', 'old code dead after synced regenerate');
    const v = await store.validateClientLink(r.linkId);
    assert(v.valid === false, 'old device link dead after synced regenerate');
    const outbox = JSON.parse((await kv.getItem('ctc:outbox')) ?? '[]') as { op: string }[];
    const ops = outbox.map((o) => o.op);
    assert(
      ops.includes('pushRevoke') && ops.includes('pushInvite') && ops.includes('revokeClientLink'),
      `regen queues pushRevoke + pushInvite + revokeClientLink (got ${ops.join(',')})`,
    );
  }

  summary('syncedstore');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
