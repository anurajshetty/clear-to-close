// multi_escrow.test.ts — end-to-end multi-escrow behavior (Anuraj-approved,
// Sept 28, 2026): one device, several escrows, server-authoritative.
//
// Drives the in-memory mock server (migration-0022 semantics):
//  1. Same device + same escrow re-redeem returns the EXISTING link — one
//     server row, no duplicate, both callers get the same link id.
//  2. Same device + different escrow mints a new link (the old
//     device_has_link gate is gone).
//  3. Re-redeeming an already-linked escrow returns the existing link id
//     (the app opens it directly; no new server row).
//  4. Revoking e1's invite kills only e1's link: e2's link stays valid.
//  5. Cancelling e1 kills only e1's link; e2's link is untouched.
//  6. Per-escrow branding isolation: each escrow's cached view carries only
//     its own realtor's profile — no cross-realtor leakage.
//  7. Link-scoped push tokens: the same Expo token registers once per link;
//     per-link unregister drops only that escrow's row.
// Production shape everywhere: redeems go through the redeem_invite RPC,
// never local minting (pinned by redeem_no_local_fallback.test.ts).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { createMockServer, mockCloudFromServer } from './mock_server';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

const ESCROW_INPUT = (address: string, name: string) =>
  ({
    address,
    city: 'Santa Clarita',
    side: 'buy',
    buyerName: name,
    openDate: dates().openDate,
    closeDate: dates().closeDate,
  }) as never;

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// Two escrows, two invites, both redeemed on the same device. Returns the
// synced store, the mock server, and the redeem results.
async function twoEscrowRig() {
  const server = createMockServer();
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: mockCloudFromServer(server) as never,
    redeemTimeoutMs: 2000,
  });
  assert((await initCloudSync()).ok, 'initCloudSync healthy');
  const e1 = await store.createEscrow(ESCROW_INPUT('1 Multi Ct', 'Fay'));
  const e2 = await store.createEscrow(ESCROW_INPUT('2 Multi Ct', 'Gus'));
  const inv1 = await store.createInvite(e1.id, 'buyer', 'Fay');
  const inv2 = await store.createInvite(e2.id, 'buyer', 'Gus');
  await tick();
  const r1 = await store.redeemInvite(inv1.code, 'Fay', 'dev-1');
  const r2 = await store.redeemInvite(inv2.code, 'Gus', 'dev-1');
  if (!r1.ok || !r1.linkId) throw new Error('redeem e1 failed: ' + JSON.stringify(r1));
  if (!r2.ok || !r2.linkId) throw new Error('redeem e2 failed: ' + JSON.stringify(r2));
  return { server, kv, store, e1, e2, inv1, inv2, r1, r2 };
}

async function main(): Promise<void> {
  // --- full flow on one rig ------------------------------------------------
  {
    const { server, kv, store, e1, e2, inv1, inv2, r1, r2 } = await twoEscrowRig();

    // Two links for two escrows on the same device — no device_has_link.
    assert(r1.linkId !== r2.linkId, 'different escrows get different link ids');
    assert(
      server.links.size === 2,
      `exactly two server link rows (got ${server.links.size})`,
    );
    const l1 = server.links.get(r1.linkId)!;
    const l2 = server.links.get(r2.linkId)!;
    assert(l1.deviceId === 'dev-1' && l2.deviceId === 'dev-1', 'both links belong to the redeeming device');
    assert(l1.escrowId === e1.id && l2.escrowId === e2.id, 'each link is bound to its own escrow');

    // 1+3. Re-redeem of e1's code: same link id, NO new server row.
    const r1b = await store.redeemInvite(inv1.code, 'Fay', 'dev-1');
    assert(r1b.ok && r1b.linkId === r1.linkId, 're-redeem returns the existing link (opens directly)');
    assert(server.links.size === 2, 're-redeem does not duplicate the server row');

    // Re-redeem of e2's code likewise.
    const r2b = await store.redeemInvite(inv2.code, 'Gus', 'dev-1');
    assert(r2b.ok && r2b.linkId === r2.linkId, 'second escrow re-redeem is also idempotent');
    assert(server.links.size === 2, 'still exactly two server rows');

    // Both links validate live, independently.
    assert((await store.validateClientLink(r1.linkId)).valid, 'e1 link validates live');
    assert((await store.validateClientLink(r2.linkId)).valid, 'e2 link validates live');

    // 6. Branding isolation: each escrow's view caches only its own realtor.
    server.viewProfiles[e1.id] = { name: 'Realtor Alpha', photoUri: null, photoRemoteUrl: null };
    server.viewProfiles[e2.id] = { name: 'Realtor Beta', photoUri: null, photoRemoteUrl: null };
    await store.refreshClientView(e1.id);
    await store.refreshClientView(e2.id);
    const snap1 = JSON.parse((await kv.getItem(`ctc:cloudview:${e1.id}`)) ?? 'null');
    const snap2 = JSON.parse((await kv.getItem(`ctc:cloudview:${e2.id}`)) ?? 'null');
    assert(snap1?.profile?.name === 'Realtor Alpha', 'e1 cached view carries Realtor Alpha');
    assert(snap2?.profile?.name === 'Realtor Beta', 'e2 cached view carries Realtor Beta');
    assert(snap1?.view?.escrowId === e1.id && snap2?.view?.escrowId === e2.id,
      'no cross-escrow leakage in the cached views');

    // 7. Link-scoped push tokens: same Expo token, one row per link.
    const cloud = mockCloudFromServer(server)();
    const token = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
    for (const lid of [r1.linkId, r2.linkId]) {
      const { error } = await cloud.rpc('register_push_token', {
        p_link_id: lid,
        p_device_id: 'dev-1',
        p_token: token,
      });
      assert(!error, `register_push_token ok for ${lid}`);
    }
    assert(server.pushTokens.size === 2, 'two link-scoped token rows for the same Expo token');
    await cloud.rpc('unregister_push_token_for_link', { p_link_id: r1.linkId });
    assert(server.pushTokens.size === 1, 'per-link unregister drops only that escrow row');
    const remaining = [...server.pushTokens.values()][0];
    assert(remaining.linkId === r2.linkId, 'the surviving row is the other escrow');

    // 4. Revoke e1's invite: only e1's link dies; e2's link stays live.
    // (Production shape: the synced store converges the SERVER-side link —
    // this device holds no local link rows, so revokedLinks comes from the
    // local preview and is empty; the truth is the server row.)
    await store.revokeInvite(inv1.id);
    await tick();
    const l1After = server.links.get(r1.linkId);
    assert(!!l1After?.revokedAt, `revoke converged e1 server link's revoked_at (got ${l1After?.revokedAt})`);
    assert(!(await store.validateClientLink(r1.linkId)).valid, 'e1 link reads dead after revoke');
    assert((await store.validateClientLink(r2.linkId)).valid, 'e2 link stays live after e1 revoke');
    assert(server.links.get(r2.linkId)?.revokedAt == null, 'e2 server link untouched by e1 revoke');

    // 5. Cancel e2: only e2's link dies (independent of the earlier revoke).
    await store.cancelEscrow(e2.id);
    await tick();
    const l2After = server.links.get(r2.linkId);
    assert(!!l2After?.revokedAt, 'cancel kills e2 server link');
    assert(!(await store.validateClientLink(r2.linkId)).valid, 'e2 link reads dead after cancel');
  }

  summary('multi_escrow');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
