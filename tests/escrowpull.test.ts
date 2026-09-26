// escrowpull.test.ts — cloud escrow/step hydration for the deal list.
//
// The bug: the deal list read the local KV store only. A realtor logging in
// on a device/browser whose local store was never seeded saw an empty deal
// list even though their escrows existed in Supabase (verified live:
// realtoranu@gmail.com owns two escrows; anon/RLS reads return [] by
// design, so the empty list looked "correct" when it was a missing pull).
//
// The fix: store.pullEscrowsFromCloud() pulls the signed-in realtor's
// escrows (+ both roles' steps, in position order) from the cloud and
// merges them into the local store. initCloudSync() runs the pull after the
// outbox drain and before the background push-reconcile; the native boot
// router awaits it before the deal list renders.
//
// Merge rules (every one gets a case below):
//   1. cloud rows missing locally are inserted (fresh device sees deals);
//   2. rows for another user_id are never merged (RLS + app-layer filter);
//   3. steps hydrate in position order with done flags intact;
//   4. a row with queued local edits (pending pushEscrow op) keeps the
//      local copy — the pull cannot clobber unsynced changes;
//   5. a failed pull keeps the local list untouched and never throws;
//   6. an empty cloud result is a legitimate empty deal list.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { enqueueOutbox } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID_A = 'user-aaa';
const UID_B = 'user-bbb';

interface Fixture {
  escrows: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  failEscrows?: boolean;
  failSteps?: boolean;
}

function fixtures(): Fixture {
  return {
    escrows: [
      {
        id: 'esc-buy', user_id: UID_A,
        address: '26207 Benito Ct', city: 'Santa Clarita, CA 91355', side: 'buy',
        buyer_name: 'Anuraj', seller_name: null,
        open_date: '2026-08-01', close_date: '2026-10-15',
        status: 'open', created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'esc-sell', user_id: UID_A,
        address: '26203 Mc bean', city: 'santa clarita, CA 91355', side: 'sell',
        buyer_name: null, seller_name: 'Anuraj',
        open_date: '2026-09-01', close_date: '2026-11-20',
        status: 'open', created_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 'esc-other', user_id: UID_B,
        address: '999 Someone Else St', city: 'Nowhere', side: 'buy',
        buyer_name: 'Stranger', seller_name: null,
        open_date: '2026-09-01', close_date: '2026-12-01',
        status: 'open', created_at: '2026-09-01T00:00:00Z',
      },
    ],
    steps: [
      // Deliberately out of position order — the pull must sort.
      { id: 's2', escrow_id: 'esc-buy', role: 'buyer', title: 'Inspection', subtitle: '', done: true, custom: false, position: 2, completed_at: '2026-09-10T00:00:00Z' },
      { id: 's0', escrow_id: 'esc-buy', role: 'buyer', title: 'Offer accepted', subtitle: '', done: true, custom: false, position: 0, completed_at: '2026-08-05T00:00:00Z' },
      { id: 's1', escrow_id: 'esc-buy', role: 'buyer', title: 'Appraisal', subtitle: '', done: false, custom: false, position: 1, completed_at: null },
      { id: 'ss0', escrow_id: 'esc-buy', role: 'seller', title: 'Disclosures', subtitle: '', done: false, custom: false, position: 0, completed_at: null },
      { id: 'b0', escrow_id: 'esc-other', role: 'buyer', title: 'Other step', subtitle: '', done: false, custom: false, position: 0, completed_at: null },
    ],
  };
}

/**
 * Mock Supabase client. Simulates RLS: escrow/step selects only ever return
 * rows whose user_id matches the session (rows for UID_B are invisible to
 * UID_A, exactly like the live owner policy). Set failEscrows/failSteps to
 * simulate transport failures.
 */
function mockEscrowClient(fx: Fixture, sessionUid: string | null = UID_A) {
  const visibleEscrows = fx.escrows.filter((r) => r.user_id === sessionUid);
  const visibleIds = new Set(visibleEscrows.map((r) => String(r.id)));
  const table = (name: string) => {
    if (name === 'escrows') {
      return {
        select: (_cols: string) =>
          fx.failEscrows
            ? Promise.resolve({ data: null, error: { message: 'boom' } })
            : Promise.resolve({ data: visibleEscrows, error: null }),
        upsert: (_rows: unknown, _opts: unknown) => Promise.resolve({ data: null, error: null }),
      };
    }
    if (name === 'steps') {
      return {
        select: (_cols: string) => ({
          in: (_col: string, ids: string[]) =>
            fx.failSteps
              ? Promise.resolve({ data: null, error: { message: 'boom' } })
              : Promise.resolve({
                  data: fx.steps.filter((s) => visibleIds.has(String(s.escrow_id)) && ids.includes(String(s.escrow_id))),
                  error: null,
                }),
        }),
        upsert: (_rows: unknown, _opts: unknown) => Promise.resolve({ data: null, error: null }),
      };
    }
    if (name === 'realtor_profiles') {
      // pingCloud's read probe + write probe + read-back.
      const chain = {
        select: (_cols: string) => chain,
        eq: (_col: string, _val: unknown) => chain,
        limit: async (_n: number) => ({ data: [{ user_id: sessionUid }], error: null }),
        upsert: async (_row: unknown, _opts: unknown) => ({ data: null, error: null }),
      };
      return chain;
    }
    return {
      select: () => Promise.resolve({ data: [], error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    };
  };
  return {
    auth: {
      getSession: async () =>
        sessionUid
          ? { data: { session: { user: { id: sessionUid } } } }
          : { data: { session: null } },
    },
    from: table,
  };
}

function syncedStore(fx: Fixture, sessionUid: string | null = UID_A) {
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: () => mockEscrowClient(fx, sessionUid) as never,
  });
  return { kv, store, initCloudSync };
}

async function main(): Promise<void> {
  // 1. Fresh local store: the cloud's two escrows appear on the deal list.
  {
    const { store } = syncedStore(fixtures());
    assert((await store.listEscrows()).length === 0, 'setup: local store starts empty');
    const merged = await store.pullEscrowsFromCloud();
    assert(merged.length === 2, `cloud escrows appear on fresh store (got ${merged.length})`);
    const addrs = merged.map((e) => e.address).sort();
    assert(
      addrs[0] === '26203 Mc bean' && addrs[1] === '26207 Benito Ct',
      `addresses match cloud rows (got ${addrs.join(' | ')})`,
    );
  }

  // 2. Another realtor's rows are never merged (RLS + app-layer filter).
  {
    const { store } = syncedStore(fixtures());
    const merged = await store.pullEscrowsFromCloud();
    assert(
      merged.every((e) => e.id !== 'esc-other'),
      'other user escrow absent from merged list',
    );
    assert((await store.getEscrow('esc-other')) === null, 'other user escrow not persisted locally');
  }

  // 3. Steps hydrate in position order with done flags intact.
  {
    const { store } = syncedStore(fixtures());
    await store.pullEscrowsFromCloud();
    const buy = await store.getEscrow('esc-buy');
    assert(buy !== null, 'setup: esc-buy present');
    const titles = buy!.buyerSteps.map((s) => s.title);
    assert(
      titles.join(',') === 'Offer accepted,Appraisal,Inspection',
      `buyer steps in position order (got ${titles.join(',')})`,
    );
    assert(buy!.buyerSteps[2].done === true, 'done flag preserved');
    assert(
      buy!.buyerSteps[2].completedAt === '2026-09-10T00:00:00Z',
      'completedAt preserved',
    );
    assert(
      buy!.sellerSteps.length === 1 && buy!.sellerSteps[0].title === 'Disclosures',
      'seller steps hydrated on the same escrow',
    );
    const sell = await store.getEscrow('esc-sell');
    assert(sell !== null && sell.side === 'sell', 'second escrow hydrated with side');
  }

  // 4. A row with queued local edits keeps the local copy (no clobber).
  {
    const fx = fixtures();
    const { kv, store } = syncedStore(fx);
    await store.pullEscrowsFromCloud();
    // Local edit: rename the address, then queue its push (unsynced).
    const edited = { ...(await store.getEscrow('esc-buy'))!, address: '26207 Benito Ct (edited offline)' };
    await store.replaceEscrow(edited);
    await enqueueOutbox(kv, { op: 'pushEscrow', escrowId: 'esc-buy', attempts: 0 });
    const merged = await store.pullEscrowsFromCloud();
    const kept = merged.find((e) => e.id === 'esc-buy')!;
    assert(
      kept.address === '26207 Benito Ct (edited offline)',
      'queued local edits survive the pull',
    );
  }

  // 5. Cloud failure: local list untouched, never throws.
  {
    const fx = fixtures();
    fx.failEscrows = true;
    const { store } = syncedStore(fx);
    const created = await store.createEscrow({
      address: 'Local Only Ln', city: 'Localville', side: 'buy',
      openDate: '2026-09-01', closeDate: '2026-12-01',
    });
    let threw = false;
    let merged: { id: string }[] = [];
    try {
      merged = await store.pullEscrowsFromCloud();
    } catch {
      threw = true;
    }
    assert(!threw, 'failed pull never throws');
    assert(
      merged.length === 1 && merged[0].id === created.id,
      'failed pull keeps the local list untouched',
    );
  }

  // 6. Empty cloud result is a legitimate empty deal list.
  {
    const fx = fixtures();
    fx.escrows = [];
    fx.steps = [];
    const { store } = syncedStore(fx);
    const merged = await store.pullEscrowsFromCloud();
    assert(merged.length === 0, 'empty cloud result -> empty list (not an error)');
  }

  // 7. initCloudSync performs the hydration (the login/boot path).
  {
    const { store, initCloudSync } = syncedStore(fixtures());
    const res = await initCloudSync();
    assert(res.ok === true, 'setup: ping succeeds with mock session');
    // The pull inside initCloudSync is awaited before it resolves.
    const list = await store.listEscrows();
    assert(list.length === 2, `initCloudSync hydrates escrows (got ${list.length})`);
  }

  // 8. No session: pull is a local no-op.
  {
    const { store } = syncedStore(fixtures(), null);
    const merged = await store.pullEscrowsFromCloud();
    assert(merged.length === 0, 'no session -> local list unchanged');
  }

  summary('escrowpull.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
