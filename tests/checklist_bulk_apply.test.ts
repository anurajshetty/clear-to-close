// checklist_bulk_apply.test.ts — REGRESSION: applyChecklistEdits as one
// synchronous server-first confirmed write (Anuraj, Sept 28, 2026).
//
// The checklist edit mode's save (add + remove + reorder in one tap) needs
// exactly one confirmed write: the escrow row and every step row upsert,
// the rows the edit removed DELETED, all inside the awaited server effect.
// Local state commits only after every step returns successfully. This is
// NOT a database transaction — the steps run sequentially, so a failure
// partway can leave the server partially updated (upserts applied, deletes
// pending). That window is fail-safe by design: local state is unchanged
// (the user still sees the pre-edit checklist and can retry), retry
// re-runs the idempotent upserts and finishes the deletes, and the next
// pull heals any crash-after-confirm gap.
//
// Each test below fails without the corresponding behavior and passes with it:
//
//   1. Success: add + remove + reorder in one write. The server holds the
//      new step rows and the removed row is gone; the escrow row was
//      upserted; locally the side's steps match the draft order; no outbox
//      op was created; lastAction is untouched (structural edits send no
//      push).
//   2. Server failure on the delete step: throws the plain copy; the local
//      checklist is byte-identical to before; persisted KV byte-identical.
//   3. Offline (transport failure): plain "couldn't reach the server" copy;
//      local unchanged and persisted KV byte-identical.
//   4. Partial server success converges on retry: upserts applied but the
//      delete failed -> throw, local unchanged; a healthy retry finishes
//      the delete and commits.
//   5. Closed-side semantics (approved spec): removing a checked step from
//      a closed, still-complete side keeps it closed; adding an unchecked
//      step reopens the side.
//   6. Crash after server confirmation heals through the next pull: server
//      rows the local store never saw (edited steps, deleted row gone)
//      converge on pull.
//   7. Missing cloud/session: throws the plain not-saved copy and commits
//      nothing locally.
import { assert, summary } from './assert';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer, type MockServer } from './mock_server';
import type { ChecklistDraftStep } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// --- fakes (same harness as cancel_sync_writes.test.ts) --------------------

interface Faults {
  failUpsert?: unknown;
  failUpsertTables?: string[];
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
      return q;
    };
    return c;
  };
}

function netErr(): Error {
  const e = new Error('fetch failed: network unreachable');
  (e as { code?: string }).code = 'ENOTFOUND';
  return e;
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

function serverStepIds(server: MockServer): string[] {
  return [...server.steps.keys()].sort();
}

async function main() {
  // 1. Success: add + remove + reorder in one confirmed write.
  {
    const { server, kv, store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('11 Bulk Ct'));
    const before = await store.getEscrow(e.id);
    const buyerSteps = before!.buyerSteps;
    assert(buyerSteps.length >= 3, `fixture has buyer steps (got ${buyerSteps.length})`);
    const removedId = buyerSteps[1].id;
    const draft: ChecklistDraftStep[] = [
      { ...buyerSteps[2] },
      { ...buyerSteps[0] },
      { title: 'Radon test ordered', done: false, custom: true },
    ];
    const out = await store.applyChecklistEdits(e.id, 'buyer', draft);
    const ids = serverStepIds(server).filter((id) => {
      const r = server.steps.get(id)!;
      return String(r['escrow_id']) === e.id && String(r['role']) === 'buyer';
    });
    assert(!server.steps.has(removedId), 'removed step row deleted server-side');
    assert(ids.length === 3, `server holds the 3 new buyer step rows (got ${ids.length})`);
    const positions = ids
      .map((id) => server.steps.get(id)!)
      .sort((a, b) => Number(a['position']) - Number(b['position']));
    assert(
      String(positions[0]['title']) === buyerSteps[2].title &&
        String(positions[1]['title']) === buyerSteps[0].title &&
        String(positions[2]['title']) === 'Radon test ordered',
      'server step order matches the draft',
    );
    const escrowUpserts = server.upsertLog.filter((u) => u.table === 'escrows');
    assert(escrowUpserts.length >= 2, 'escrow row re-upserted with the edit');
    assert(
      out.buyerSteps.map((s) => s.title).join('|') ===
        [buyerSteps[2].title, buyerSteps[0].title, 'Radon test ordered'].join('|'),
      'local buyer steps match the draft order',
    );
    assert(out.buyerSteps[2].custom === true, 'added step flagged custom');
    assert(out.lastAction == null, 'structural edit leaves lastAction untouched (no push)');
    const ops = await readOutboxOps(kv);
    assert(ops.length === 0, 'bulk apply creates no outbox op');
  }

  // 2. Server failure on the delete step: loud throw, local unchanged.
  {
    const { server, kv, store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('22 Bulk Ct'));
    const before = await store.getEscrow(e.id);
    const removedId = before!.buyerSteps[0].id;
    const beforeDump = kv.dump();
    server.failStepDelete = true;
    let err: unknown = null;
    try {
      await store.applyChecklistEdits(e.id, 'buyer', before!.buyerSteps.slice(1));
    } catch (e2) {
      err = e2;
    }
    assert(err instanceof Error, 'failed bulk apply throws');
    assert(
      (err as Error).message.length > 0 && !(err as Error).message.includes('applyChecklistEdits:'),
      'failed bulk apply throws a plain-language error',
    );
    const after = await store.getEscrow(e.id);
    assert(
      JSON.stringify(after!.buyerSteps) === JSON.stringify(before!.buyerSteps),
      'local checklist unchanged after a failed bulk apply',
    );
    assert(kv.dump() === beforeDump, 'persisted KV byte-identical after a failed bulk apply');
    // The upserts landed before the delete failed — retry must converge.
    assert(server.steps.has(removedId), 'removed row still present server-side after the failure');
  }

  // 3. Offline: fail fast, local unchanged.
  {
    const { kv, store, faults } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('33 Bulk Ct'));
    const before = await store.getEscrow(e.id);
    const beforeDump = kv.dump();
    faults.failUpsert = netErr();
    let err: unknown = null;
    try {
      await store.applyChecklistEdits(e.id, 'buyer', before!.buyerSteps.slice(1));
    } catch (e2) {
      err = e2;
    }
    assert(err instanceof Error, 'offline bulk apply throws');
    assert(
      /couldn.?t reach the server|offline|network|connection/i.test((err as Error).message),
      `offline bulk apply fails fast with plain copy (got: ${(err as Error).message})`,
    );
    const after = await store.getEscrow(e.id);
    assert(
      JSON.stringify(after!.buyerSteps) === JSON.stringify(before!.buyerSteps),
      'local checklist unchanged when offline',
    );
    assert(kv.dump() === beforeDump, 'persisted KV byte-identical when offline');
  }

  // 4. Partial server success converges on retry.
  {
    const { server, store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('44 Bulk Ct'));
    const before = await store.getEscrow(e.id);
    const removedId = before!.buyerSteps[0].id;
    const draft = before!.buyerSteps.slice(1).map((s) => ({ ...s }));
    server.failStepDelete = true;
    let err: unknown = null;
    try {
      await store.applyChecklistEdits(e.id, 'buyer', draft);
    } catch (e2) {
      err = e2;
    }
    assert(err instanceof Error, 'first attempt throws when the delete fails');
    server.failStepDelete = false;
    const out = await store.applyChecklistEdits(e.id, 'buyer', draft);
    assert(!server.steps.has(removedId), 'retry finished the delete server-side');
    assert(
      out.buyerSteps.length === before!.buyerSteps.length - 1,
      'retry committed the edit locally',
    );
  }

  // 5. Closed-side semantics: remove-checked-from-complete keeps closed;
  //    an unchecked step reopens the side.
  {
    const { store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('55 Bulk Ct'));
    const created = await store.getEscrow(e.id);
    for (const s of created!.buyerSteps) {
      await store.toggleStep(e.id, 'buyer', s.id);
    }
    const closed = await store.closeEscrow(e.id, 'buyer');
    assert(!!closed.escrow.buyerClosedAt, 'buyer side closed');
    const checked = (await store.getEscrow(e.id))!.buyerSteps;
    // Remove one checked step from the still-complete side: stays closed.
    const stillComplete = checked.slice(1).map((s) => ({ ...s }));
    const kept = await store.applyChecklistEdits(e.id, 'buyer', stillComplete);
    assert(!!kept.buyerClosedAt, 'removing a checked step from a complete side keeps it closed');
    // Add an unchecked step: the side reopens.
    const reopened = await store.applyChecklistEdits(e.id, 'buyer', [
      ...stillComplete.map((s) => ({ ...s })),
      { title: 'Final walkthrough redo', done: false, custom: true },
    ]);
    assert(reopened.buyerClosedAt == null, 'adding an unchecked step reopens the side');
    assert(reopened.status !== 'closed', 'escrow-level status follows the reopened side');
  }

  // 6. Crash after server confirmation heals through the next pull.
  {
    const server = createMockServer();
    server.seedRows['escrows'] = [
      {
        user_id: 'user-1',
        id: 'srv-bulk-1',
        address: '66 Healed Ct',
        city: 'Santa Clarita',
        side: 'both',
        buyer_name: 'Healed Buyer',
        seller_name: 'Healed Seller',
        open_date: '2026-09-28',
        close_date: '2026-11-28',
        status: 'open',
        buyer_closed_at: null,
        seller_closed_at: null,
        created_at: '2026-09-28T00:00:00.000Z',
      },
    ];
    // Server truth after a confirmed bulk edit the local store never saw:
    // step s2 removed, s3 added, s1 kept.
    server.seedRows['steps'] = [
      { id: 's1', escrow_id: 'srv-bulk-1', role: 'buyer', title: 'Kept step', subtitle: '', done: true, custom: false, position: 0, completed_at: '2026-09-28T01:00:00.000Z' },
      { id: 's3', escrow_id: 'srv-bulk-1', role: 'buyer', title: 'Added step', subtitle: '', done: false, custom: true, position: 1, completed_at: null },
    ];
    const kv = trackingKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: faultCloud(server, { pendingGates: [] }) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    await initCloudSync();
    const healed = await store.getEscrow('srv-bulk-1');
    assert(
      !!healed && healed.buyerSteps.length === 2,
      'the next pull heals a server-confirmed bulk edit the local store never saw',
    );
    assert(
      healed!.buyerSteps.every((s) => s.id !== 's2') &&
        healed!.buyerSteps.some((s) => s.id === 's3'),
      'pulled steps reflect the server edit (removed gone, added present)',
    );
  }

  // 7. Missing cloud/session: plain not-saved throw, nothing committed.
  {
    const seeded = await setup();
    const created = await seeded.store.createEscrow(BOTH_INPUT('77 Bulk Ct'));
    const before = await seeded.store.getEscrow(created.id);
    const beforeDump = seeded.kv.dump();
    // Same device KV, but no cloud session anymore.
    const { store } = createSyncedStore(seeded.kv, {
      cloudClient: (() => null) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    let err: unknown = null;
    try {
      await store.applyChecklistEdits(created.id, 'buyer', before!.buyerSteps.slice(1));
    } catch (e2) {
      err = e2;
    }
    assert(err instanceof Error, 'bulk apply without a session throws');
    assert(
      /sign in|couldn't save/i.test((err as Error).message),
      `bulk apply without a session throws the plain not-saved copy (got: ${(err as Error).message})`,
    );
    const after = await store.getEscrow(created.id);
    assert(
      JSON.stringify(after!.buyerSteps) === JSON.stringify(before!.buyerSteps),
      'nothing committed locally without a session',
    );
    assert(seeded.kv.dump() === beforeDump, 'persisted KV byte-identical without a session');
  }

  summary('checklist_bulk_apply');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
