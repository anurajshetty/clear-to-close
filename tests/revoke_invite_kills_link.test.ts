// revoke_invite_kills_link.test.ts — REGRESSION (Anuraj, Sept 28, 2026):
// removing a client via the X in View clients left a zombie live device
// link on the server. Root cause: syncedStore.revokeInvite pushed only
// pushRevokeNow (invites.revoked_at) and never revoked the client_links
// rows, so the server-side link kept revoked_at = NULL and still occupied
// the device's one-live-link slot in client_links_device_live_uidx. Any
// later redeem for a DIFFERENT escrow on that device hit the unique
// violation -> device_has_link -> "This device is already linked to another
// escrow. Ask your realtor to release it, then try again." — with nothing
// left for the realtor to release. Regenerate and close-escrow did not
// have this bug because they enqueue the convergeLinkRevokes outbox op;
// single-invite revoke was the only path that skipped link convergence.
// Fix: syncedStore.revokeInvite enqueues a convergeLinkRevokes op for the
// revoked invite — the exact closeEscrow/regenerateInvite pattern (same
// "code invalidated + device link killed at the same moment"
// semantics). CORRECTION (Sept 28, 2026): the killed links are converged
// SERVER-AUTHORITATIVELY — the redeem_invite RPC creates client_links rows
// server-side, which the realtor's device never holds locally (local
// data.links is written only by the offline redeem fallback) — so
// converging from local data.links was a no-op in production. Every
// link-killing path queries the server for live link ids per invite
// (fetchLiveServerLinkIds) instead. Tests MUST seed the server side, not
// local data.links, or they pass for the wrong reason.
// This test pins:
//  1. store.revokeInvite returns the killed links (for cloud convergence);
//  2. the killed link reads dead via validateClientLink;
//  3. after a revoke, the same device CAN redeem a different escrow's
//     code (old link is dead, new link goes live);
//  4. revoking an invite with no redeemed link enqueues nothing;
//  5. (synced) revokeInvite converges link.revoked_at to the server — the
//     convergeLinkRevokes outbox op reaches pushLinkRevokeNow and drains.
// A genuinely-live link on another escrow still maps the 23505 unique
// violation to device_has_link (pinned separately in syncedstore.test.ts).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer } from './mock_server';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

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

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // --- 1-3. Local store semantics ------------------------------------------
  {
    const store = createStore(memoryKV());
    const e1 = await store.createEscrow(ESCROW_INPUT('1 Link Ct', 'Ada'));
    const e2 = await store.createEscrow(ESCROW_INPUT('2 Link Ct', 'Bo'));
    const inv1 = await store.createInvite(e1.id, 'buyer', 'Ada');
    const r1 = await store.redeemInvite(inv1.code, 'Ada', 'dev-1');
    if (!r1.ok || !r1.linkId) throw new Error('redeem 1 failed');
    assert((await store.validateClientLink(r1.linkId)).valid, 'link valid before revoke');

    const { revokedLinks } = await store.revokeInvite(inv1.id);
    assert(revokedLinks.length === 1, `revokeInvite returns the killed link (got ${revokedLinks.length})`);
    assert(revokedLinks[0].id === r1.linkId, 'killed link id matches the redeemed device link');
    assert(
      typeof revokedLinks[0].revokedAt === 'string' && revokedLinks[0].revokedAt.length > 0,
      'killed link carries revokedAt for cloud convergence',
    );
    assert(!(await store.validateClientLink(r1.linkId)).valid, 'link dead after revokeInvite');

    // Same device joins a DIFFERENT escrow: the old link is dead, so the
    // new redeem goes through and binds a fresh live link.
    const inv2 = await store.createInvite(e2.id, 'buyer', 'Bo');
    const r2 = await store.redeemInvite(inv2.code, 'Bo', 'dev-1');
    assert(r2.ok, 'same device redeems a different escrow code after the old link died');
    if (r2.ok && r2.linkId) {
      assert((await store.validateClientLink(r2.linkId)).valid, 'new link is live');
    }
  }

  // --- 4. Revoke with no redeemed link: no phantom killed links -------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow(ESCROW_INPUT('3 Link Ct', 'Cy'));
    const inv = await store.createInvite(e.id, 'buyer', 'Cy');
    const { revokedLinks } = await store.revokeInvite(inv.id);
    assert(revokedLinks.length === 0, `no links killed when nothing was redeemed (got ${revokedLinks.length})`);
  }

  // --- 5. Synced store converges the SERVER-side link revocation --------
  // Production shape: the redeem went through the redeem_invite RPC, so
  // the link row exists ONLY on the server — the realtor's local
  // data.links is EMPTY (local data.links is written only by the offline
  // redeem fallback). The revoke must still kill the server link; a test
  // that seeds local data.links would pass for the wrong reason.
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    const ping = await initCloudSync();
    assert(ping.ok, 'initCloudSync healthy (cloudOk true)');

    const e = await store.createEscrow(ESCROW_INPUT('4 Link Ct', 'Dee'));
    const inv = await store.createInvite(e.id, 'buyer', 'Dee');
    await tick(150); // let bgPush land the invite row on the mock server
    const r = await store.redeemInvite(inv.code, 'Dee', 'dev-9');
    if (!r.ok || !r.linkId) throw new Error('synced redeem failed: ' + JSON.stringify(r));
    const serverLinkId = r.linkId;
    assert(
      serverLinkId.startsWith('srv-link-'),
      `redeem went through the server RPC (link ${serverLinkId})`,
    );
    assert(server.links.get(serverLinkId)?.revokedAt === null, 'server link live before revoke');

    const before = await store.revokeInvite(inv.id);
    assert(
      before.revokedLinks.length === 0,
      `production shape: local data.links is EMPTY (got ${before.revokedLinks.length})`,
    );
    await tick(150);

    const link = server.links.get(serverLinkId);
    assert(
      !!link && typeof link.revokedAt === 'string' && link.revokedAt.length > 0,
      `server link revoked_at converged via the server query (got ${link?.revokedAt})`,
    );
    assert(
      server.pushedLinkRevocations.some((p) => p.linkId === serverLinkId),
      'convergeLinkRevokes op reached pushLinkRevokeNow for the server-side link',
    );
    const ops = await readOutboxOps(kv);
    assert(ops.length === 0, `convergeLinkRevokes op drained, nothing left queued (got ${ops.length})`);

    // The freed device can join a DIFFERENT escrow now — the zombie is gone.
    const e2 = await store.createEscrow(ESCROW_INPUT('5 Link Ct', 'Eli'));
    const inv2 = await store.createInvite(e2.id, 'buyer', 'Eli');
    await tick(150);
    const r2 = await store.redeemInvite(inv2.code, 'Eli', 'dev-9');
    assert(r2.ok, 'same device redeems a different escrow code after the server link died');
  }

  summary('revoke_invite_kills_link');
}

main().catch((e) => {
  console.error('FAIL - uncaught: ' + (e && (e as Error).stack ? (e as Error).stack : String(e)));
  process.exitCode = 1;
});
