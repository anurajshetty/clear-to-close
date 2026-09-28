// revoke_links_server_authoritative.test.ts — REGRESSION (Anuraj, Sept 28, 2026).
//
// cancelEscrow had the identical zombie-link bug: syncedStore.cancelEscrow
// enqueued pushRevoke for the invites but never converged the killed
// client_links rows, so a cancelled escrow's device link stayed live on
// the server and blocked that device from joining any other escrow.
//
// Production shape everywhere: the redeem went through the redeem_invite
// RPC, so the link row exists ONLY on the server — the realtor's local
// data.links is EMPTY. These tests seed the server (via the faithful mock
// in ./mock_server), never local data.links.
//
// This pins:
//  1. cancelEscrow converges the server link's revoked_at (no zombie);
//  2. a device whose client was removed via cancel can redeem a NEW code
//     afterward (different escrow AND same-escrow re-invite);
//  3. a genuinely-live link on another escrow still blocks the redeem
//     (device_has_link), so the fix doesn't over-release;
//  4. cancelling an escrow whose invites were never redeemed enqueues no
//     link ops.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
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

async function main(): Promise<void> {
  // --- 1+2. Cancel kills the server-side link; the device is freed --------
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    assert((await initCloudSync()).ok, 'initCloudSync healthy');

    const e1 = await store.createEscrow(ESCROW_INPUT('9 Cancel Ct', 'Fay'));
    const inv1 = await store.createInvite(e1.id, 'buyer', 'Fay');
    await tick();
    const r1 = await store.redeemInvite(inv1.code, 'Fay', 'dev-1');
    if (!r1.ok || !r1.linkId) throw new Error('redeem 1 failed: ' + JSON.stringify(r1));
    const serverLinkId = r1.linkId;
    assert(
      serverLinkId.startsWith('srv-link-'),
      `redeem went through the server RPC (link ${serverLinkId})`,
    );

    await store.cancelEscrow(e1.id);
    await tick();
    const link = server.links.get(serverLinkId);
    assert(
      !!link && typeof link.revokedAt === 'string' && link.revokedAt.length > 0,
      `cancel converged the server link's revoked_at (got ${link?.revokedAt})`,
    );
    assert(
      server.pushedLinkRevocations.some((p) => p.linkId === serverLinkId),
      'the confirmed cancel write killed the server link',
    );
    assert((await readOutboxOps(kv)).length === 0, 'outbox drained after cancel');

    // The freed device joins a DIFFERENT escrow — no more device_has_link.
    const e2 = await store.createEscrow(ESCROW_INPUT('10 Fresh Ct', 'Gus'));
    const inv2 = await store.createInvite(e2.id, 'buyer', 'Gus');
    await tick();
    const r2 = await store.redeemInvite(inv2.code, 'Gus', 'dev-1');
    assert(r2.ok, `device freed by cancel redeems a different escrow's code (got ${JSON.stringify(r2)})`);

    // Same-escrow re-invite after cancel is now BLOCKED (Anuraj, Sept 28,
    // 2026): no new invites on closed/cancelled escrows, any role.
    let blockedErr: unknown = null;
    try {
      await store.createInvite(e1.id, 'buyer', 'Hana');
    } catch (e) {
      blockedErr = e;
    }
    assert(
      !!blockedErr &&
        /cannot create invites for a cancelled escrow/.test(String((blockedErr as Error).message)),
      `createInvite on the cancelled escrow throws (got ${String(blockedErr)})`,
    );
  }

  // --- 3. A genuinely-live link still blocks ------------------------------
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    assert((await initCloudSync()).ok, 'initCloudSync healthy');

    const eA = await store.createEscrow(ESCROW_INPUT('11 LiveA Ct', 'Ivy'));
    const invA = await store.createInvite(eA.id, 'buyer', 'Ivy');
    await tick();
    const rA = await store.redeemInvite(invA.code, 'Ivy', 'dev-9');
    if (!rA.ok) throw new Error('redeem A failed');

    const eB = await store.createEscrow(ESCROW_INPUT('12 LiveB Ct', 'Jay'));
    const invB = await store.createInvite(eB.id, 'buyer', 'Jay');
    await tick();
    const rB = await store.redeemInvite(invB.code, 'Jay', 'dev-9');
    assert(
      !rB.ok && (rB as { error?: string }).error === 'device_has_link',
      `live link on another escrow still blocks (got ${JSON.stringify(rB)})`,
    );
  }

  // --- 4. Cancel with unredeemed invites: no phantom link ops ---------------
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    assert((await initCloudSync()).ok, 'initCloudSync healthy');

    const e = await store.createEscrow(ESCROW_INPUT('13 Bare Ct', 'Kay'));
    await store.createInvite(e.id, 'buyer', 'Kay');
    await tick();

    await store.cancelEscrow(e.id);
    await tick();
    assert(
      server.pushedLinkRevocations.length === 0,
      `no link ops for unredeemed invites (got ${server.pushedLinkRevocations.length})`,
    );
    assert((await readOutboxOps(kv)).length === 0, 'outbox drained after cancel');
  }

  // --- 5. A failed link lookup fails the whole revoke loudly ---------------
  // Fail-safe order (Sept 28, 2026): the invite row revokes FIRST — so
  // get_client_view already locks the client out via the invite check even
  // if the link kill never runs — then the live server links are killed.
  // If the link lookup fails, the confirmed write throws and nothing
  // applies locally. The retry is idempotent: the invite revoke re-lands
  // and the link kill converges.
  {
    const server = createMockServer();
    server.failLinkSelect = true; // transient query failure
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    assert((await initCloudSync()).ok, 'initCloudSync healthy');

    const e = await store.createEscrow(ESCROW_INPUT('14 Retry Ct', 'Liam'));
    const inv = await store.createInvite(e.id, 'buyer', 'Liam');
    await tick();
    const r = await store.redeemInvite(inv.code, 'Liam', 'dev-z');
    if (!r.ok || !r.linkId) throw new Error('redeem failed');
    const linkId = r.linkId;

    // The link lookup fails: the write throws, local state is untouched.
    let msg = '';
    try {
      await store.revokeInvite(inv.id);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg.length > 0, 'revoke with a failed link lookup throws instead of resolving');
    assert(
      (await store.getInvite(inv.id))?.revokedAt == null,
      'failed revoke leaves the local invite live',
    );
    // Fail-safe partial state: the invite row revoked server-side FIRST,
    // so the client is already locked out (get_client_view checks the
    // invite) even though the link row is not yet killed.
    assert(
      server.invites.get(inv.id)?.revokedAt != null,
      'the invite row revoked server-side before the link lookup failed',
    );
    assert(
      server.links.get(linkId)?.revokedAt === null,
      'the server link row is not yet killed',
    );
    assert((await readOutboxOps(kv)).length === 0, 'a failed revoke queues no outbox op');

    // Recovery: the lookup succeeds and the retry converges everything.
    server.failLinkSelect = false; // connectivity recovers
    await store.revokeInvite(inv.id);
    const link = server.links.get(linkId);
    assert(
      !!link && typeof link.revokedAt === 'string' && link.revokedAt.length > 0,
      `retry kills the server link's revoked_at (got ${link?.revokedAt})`,
    );
    assert(
      (await store.getInvite(inv.id))?.revokedAt != null,
      'retry revokes the local invite',
    );
  }

  summary('revoke_links_server_authoritative');
}

main().catch((e) => {
  console.error('FAIL - uncaught: ' + (e && (e as Error).stack ? (e as Error).stack : String(e)));
  process.exitCode = 1;
});
