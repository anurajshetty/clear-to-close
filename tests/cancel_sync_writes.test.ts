// cancel_sync_writes.test.ts — REGRESSION: cancelEscrow as one synchronous
// server-first confirmed write (Anuraj, Sept 28, 2026).
//
// The escrow row, every invite revocation, and the server-side device-link
// kills all run inside the awaited server effect; local state commits only
// after every step returns successfully. This is NOT a database transaction —
// the steps run sequentially, so a failure partway can leave the server
// partially updated (e.g. the escrow row cancelled but one invite's links
// still live). That window is by design fail-safe: local state is unchanged
// (the user still sees the escrow as open and can retry), and the next
// invite/pull cycle converges the server truth locally.
//
// Each test below fails without the corresponding behavior and passes with it:
//
//   1. Success: the server escrow row reads cancelled, buyer/seller/TC
//      invites are revoked and their server-created device links killed;
//      locally the escrow reads cancelled and the invites read revoked; no
//      outbox op was created.
//   2. Server failure on the escrow write: throws the plain copy; the local
//      escrow still reads open; persisted KV byte-identical to before.
//   3. Offline (transport failure): plain "couldn't reach the server" copy;
//      local unchanged and persisted KV byte-identical.
//   4. Partial failure (invite-revoke step fails after the escrow row
//      cancelled): throws the plain copy; local unchanged. Retrying the
//      cancel with a healthy server converges everything.
//   5. Crash after server confirmation heals through the next pull: a
//      server row the local store never saw (cancelled + invites revoked)
//      converges on pull.
//   6. Missing cloud/session: throws the plain not-saved copy and commits
//      nothing locally.
import { assert, summary } from './assert';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer, type MockServer } from './mock_server';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// --- fakes (same harness as sync_writes.test.ts) --------------------------

interface Faults {
  failUpsert?: unknown;
  failUpsertTables?: string[];
  failUpdate?: unknown;
  failUpdateTables?: string[];
  failRpc?: unknown;
  gateUpsert?: boolean;
  pendingGates: (() => void)[];
}

function trackingKV() {
  const map = new Map<string, string>();
  return {
    async getItem(k: string): Promise<string | null> {
      return map.has(k) ? map.get(k)! : null;
    },
    async setItem(k: string, v: string): Promise<void> {
      map.set(k, v);
    },
    async removeItem(k: string): Promise<void> {
      map.delete(k);
    },
    dump(): string {
      return JSON.stringify(
        [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    },
  };
}

function faultCloud(server: MockServer, faults: Faults): () => unknown {
  const baseFactory = mockCloudFromServer(server) as () => any;
  return () => {
    const c = baseFactory();
    const origFrom = c.from;
    c.from = (table: string) => {
      const q = origFrom(table);
      const origUpsert = q.upsert;
      q.upsert = (rows: unknown, opts?: unknown) => {
        if (faults.gateUpsert) {
          return {
            select: (_cols?: string) =>
              new Promise((resolve) => {
                faults.pendingGates.push(() => resolve(server.upsert(table, rows)));
              }),
          };
        }
        if (
          faults.failUpsert !== undefined &&
          (!faults.failUpsertTables || faults.failUpsertTables.includes(table))
        ) {
          const e = faults.failUpsert;
          faults.failUpsert = undefined;
          throw e;
        }
        return origUpsert(rows, opts);
      };
      const origUpdate = q.update;
      q.update = (patch: unknown) => {
        if (
          faults.failUpdate !== undefined &&
          (!faults.failUpdateTables || faults.failUpdateTables.includes(table))
        ) {
          const e = faults.failUpdate;
          faults.failUpdate = undefined;
          throw e;
        }
        return origUpdate(patch);
      };
      return q;
    };
    const origRpc = c.rpc;
    c.rpc = async (name: string, params?: unknown) => {
      if (faults.failRpc !== undefined) {
        const e = faults.failRpc;
        faults.failRpc = undefined;
        throw e;
      }
      return origRpc(name, params);
    };
    return c;
  };
}

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

const BOTH_INPUT = (address: string) =>
  ({
    address,
    city: 'Santa Clarita',
    side: 'both',
    buyerName: 'Test Buyer',
    sellerName: 'Test Seller',
    openDate: dates().openDate,
    closeDate: dates().closeDate,
  }) as never;

async function setup(faults: Faults = { pendingGates: [] }) {
  faults.pendingGates = [];
  const server = createMockServer();
  const kv = trackingKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: faultCloud(server, faults) as never,
    writeTimeoutMs: 400,
    writeTimeoutLongMs: 800,
    redeemTimeoutMs: 2000,
  });
  const ping = await initCloudSync();
  assert(ping.ok, 'initCloudSync healthy');
  return { server, kv, store, faults, initCloudSync };
}

// The mock does not model escrow rows directly: the upsert log is the
// record of what the server received.
function serverEscrowStatus(server: MockServer, escrowId: string): string | undefined {
  const hits = server.upsertLog.filter((u) => u.table === 'escrows');
  for (let i = hits.length - 1; i >= 0; i--) {
    const rows = hits[i].rows as { id?: string; status?: string }[];
    const row = rows.find((r) => r.id === escrowId);
    if (row) return row.status;
  }
  return undefined;
}
// Creates an escrow with redeemed buyer, seller, and TC invites so the
// server holds live device links for every side.
async function fixtureWithRedeemedLinks(store: any, address: string) {
  const e = await store.createEscrow(BOTH_INPUT(address));
  const bInv = await store.createInvite(e.id, 'buyer', 'Test Buyer');
  const sInv = await store.createInvite(e.id, 'seller', 'Test Seller');
  const tInv = await store.createInvite(e.id, 'tc', 'Tina Coord');
  const bRes = await store.redeemInvite(bInv.code, 'Test Buyer', 'dev-b');
  const sRes = await store.redeemInvite(sInv.code, 'Test Seller', 'dev-s');
  const tRes = await store.redeemInvite(tInv.code, 'Tina Coord', 'dev-t');
  assert(bRes.ok && sRes.ok && tRes.ok, 'all three sides redeemed server-side links');
  return { e, bInv, sInv, tInv, bRes, sRes, tRes };
}

async function main() {
  // 1. Success: server escrow cancelled; buyer/seller/TC invites revoked and
  //    their device links killed; local mirrors; no outbox op.
  {
    const { server, kv, store } = await setup();
    const { e, bInv, sInv, tInv, bRes, sRes, tRes } = await fixtureWithRedeemedLinks(
      store as never,
      '1 Cancel Ct',
    );
    if (!bRes.ok || !sRes.ok || !tRes.ok) throw new Error('redeem failed in fixture');
    const bLink = bRes.linkId;
    const sLink = sRes.linkId;
    const tLink = tRes.linkId;

    const res = await store.cancelEscrow(e.id);
    assert(res.escrow.status === 'cancelled', 'cancelEscrow returns the cancelled escrow');
    assert(
      serverEscrowStatus(server, e.id) === 'cancelled',
      'the server escrow row was upserted as cancelled',
    );
    for (const [name, inv] of [['buyer', bInv], ['seller', sInv], ['tc', tInv]] as const) {
      assert(
        !!server.invites.get(inv.id)?.revokedAt,
        `the server ${name} invite is revoked`,
      );
    }
    for (const [name, link] of [['buyer', bLink], ['seller', sLink], ['tc', tLink]] as const) {
      assert(
        !!server.links.get(link)?.revokedAt,
        `the server ${name} device link is killed`,
      );
    }
    const local = await store.getEscrow(e.id);
    assert(local!.status === 'cancelled', 'the local escrow reads cancelled after confirmation');
    const localInvites = await store.listInvites(e.id);
    assert(
      localInvites.length === 3 && localInvites.every((i: any) => !!i.revokedAt),
      'the local invites read revoked after confirmation',
    );
    assert(
      (await readOutboxOps(kv)).length === 0,
      'a confirmed cancel creates no outbox operation',
    );
  }

  // 2. Server failure on the escrow write: throws the plain copy; local
  //    escrow still open; persisted KV byte-identical.
  {
    const faults: Faults = { pendingGates: [] };
    const { kv, store } = await setup(faults);
    await fixtureWithRedeemedLinks(store as never, '2 Cancel Ct');
    const escrowId = (await store.listEscrows())[0].id;
    faults.failUpsert = new Error('db down');
    const before = kv.dump();
    let msg = '';
    try {
      await store.cancelEscrow(escrowId);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/not saved/i.test(msg), `server failure throws the plain copy (got: ${msg})`);
    assert(
      (await store.getEscrow(escrowId))!.status === 'open',
      'the local escrow still reads open after a failed cancel',
    );
    assert(kv.dump() === before, 'persisted KV is byte-identical after a failed cancel');
  }

  // 3. Offline (transport failure): plain "couldn't reach the server" copy;
  //    local unchanged; persisted KV byte-identical.
  {
    const faults: Faults = { pendingGates: [] };
    const { kv, store } = await setup(faults);
    await fixtureWithRedeemedLinks(store as never, '3 Cancel Ct');
    const escrowId = (await store.listEscrows())[0].id;
    faults.failUpsert = new Error('fetch failed');
    const before = kv.dump();
    let msg = '';
    try {
      await store.cancelEscrow(escrowId);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(
      /couldn't reach the server/i.test(msg),
      `offline cancel throws the offline copy (got: ${msg})`,
    );
    assert(
      (await store.getEscrow(escrowId))!.status === 'open',
      'the local escrow still reads open when offline',
    );
    assert(kv.dump() === before, 'persisted KV is byte-identical when offline');
  }

  // 4. Partial failure (invite-revoke step fails after the escrow row
  //    cancelled): throws the plain copy; local unchanged. A retry with a
  //    healthy server converges everything.
  {
    const faults: Faults = { pendingGates: [] };
    const { server, store } = await setup(faults);
    const { e, bInv, sInv, tInv, bRes } = await fixtureWithRedeemedLinks(
      store as never,
      '4 Cancel Ct',
    );
    if (!bRes.ok) throw new Error('redeem failed in fixture');
    // Arm the fault only now: the first invites-table update after the
    // escrow row cancels fails, leaving the server partially updated.
    faults.failUpdate = new Error('invites down');
    faults.failUpdateTables = ['invites'];
    let msg = '';
    try {
      await store.cancelEscrow(e.id);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/not saved/i.test(msg), `partial failure throws the plain copy (got: ${msg})`);
    assert(
      (await store.getEscrow(e.id))!.status === 'open',
      'local still reads open: nothing applies until every step confirms',
    );
    assert(
      serverEscrowStatus(server, e.id) === 'cancelled',
      'the escrow row did cancel server-side before the invite step failed',
    );
    assert(
      !server.invites.get(bInv.id)?.revokedAt,
      'the invite step failed: the buyer invite stays live server-side',
    );
    // Retry: the server is healthy again, so the second attempt converges.
    const res = await store.cancelEscrow(e.id);
    assert(res.escrow.status === 'cancelled', 'retry completes the cancel');
    for (const [name, inv] of [['buyer', bInv], ['seller', sInv], ['tc', tInv]] as const) {
      assert(
        !!server.invites.get(inv.id)?.revokedAt,
        `retry revokes the ${name} invite server-side`,
      );
    }
    assert(
      (await store.getEscrow(e.id))!.status === 'cancelled',
      'retry commits the cancel locally after every step confirms',
    );
  }

  // 5. Crash after server confirmation heals through the next pull: the
  //    server row was cancelled and the invites revoked, but the local
  //    store never saw any of it.
  {
    const server = createMockServer();
    server.seedRows['escrows'] = [
      {
        user_id: 'user-1',
        id: 'srv-cancel-1',
        address: '5 Healed Ct',
        city: 'Santa Clarita',
        side: 'both',
        buyer_name: 'Healed Buyer',
        seller_name: 'Healed Seller',
        open_date: '2026-09-28',
        close_date: '2026-11-28',
        status: 'cancelled',
        buyer_closed_at: null,
        seller_closed_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    server.seedRows['steps'] = [];
    const kv = trackingKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: faultCloud(server, { pendingGates: [] }) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    await initCloudSync();
    const healed = await store.getEscrow('srv-cancel-1');
    assert(
      !!healed && healed.status === 'cancelled',
      'the next pull heals a server-cancelled row the local store never saw',
    );
  }

  // 6. Missing cloud/session: throws the plain not-saved copy and commits
  //    nothing locally.
  {
    const kv = trackingKV();
    const { store: online } = createSyncedStore(kv, {
      cloudClient: faultCloud(createMockServer(), { pendingGates: [] }) as never,
    });
    const created = await online.createEscrow(BOTH_INPUT('6 Cancel Ct'));
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    let msg = '';
    try {
      await store.cancelEscrow(created.id);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/signed out/.test(msg), `missing session throws the not-saved copy (got: ${msg})`);
    assert(
      (await store.getEscrow(created.id))!.status === 'open',
      'nothing commits locally without a session',
    );
  }

  summary('cancel_sync_writes');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
