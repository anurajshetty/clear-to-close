// sync_writes.test.ts — REGRESSION: the synchronous server-first write
// model (Anuraj, Sept 28, 2026).
//
// Every user-initiated server write must: hit the server first, apply
// locally only after confirmation, throw a plain-language error on failure
// leaving local state byte-identical, fail fast offline, and carry a
// timeout. No user action may enqueue to the retired outbox.
//
// The Supabase surface is the faithful in-memory mock (./mock_server) with
// a fault-injection wrapper (fail/hang upserts, fail RPCs). Each test below
// fails without the corresponding behavior and passes with it:
//
//   1. createEscrow success: local applies after server confirmation; the
//      server received the escrow + steps rows; no outbox op was created.
//   2. createEscrow server failure: throws plain copy; local list empty;
//      persisted KV byte-identical to before the action.
//   3. toggleStep offline (transport failure): plain "couldn't reach"
//      copy; the step is unchanged locally and in persisted KV.
//   4. toggleStep timeout: a hung push trips the write timeout; plain
//      copy; local unchanged. A late server success afterwards must NOT
//      apply locally (the write already failed).
//   5. Success applies ONLY after confirmation: while the push is gated,
//      local is unchanged; after the gate releases, local applies.
//   6. No user action creates an outbox operation (create, toggle, invite,
//      profile save).
//   7. Crash before confirmation (failure mid-push): in-memory AND
//      persisted local state byte-identical (verified by rehydrating a
//      second store on the same KV).
//   8. Crash after server confirmation heals through the next pull: a
//      server row the local store never saw converges on pull.
//   9. Whole close revokes buyer, seller, AND TC invite codes plus their
//      server-created device links; per-side close revokes only that
//      side's codes/links and preserves the other side and TC.
//  10. Unchecking a step reopens only that side.
//  11. Regenerate is atomic: success swaps in the RPC's code and kills the
//      old server link; RPC failure leaves the local invite byte-identical.
//  12. Profile save with a photo: upload failure leaves local + fingerprint
//      KV unchanged; success stamps the versioned URL locally only after
//      the row confirms.
//  13. Concurrent writes serialize: two overlapping writes both apply,
//      neither clobbers the other.
//  14. A pull racing a write cannot clobber it in either direction: the
//      write's commit keeps the pulled change to an unrelated escrow, and
//      the pull does not resurrect pre-write data over the commit.
//  15. Legacy outbox drains exactly once: a seeded op drains on the first
//      boot, the retired marker is set, and a second boot does not re-push.
//  16. Missing cloud/session: the write throws the plain not-saved copy
//      and commits nothing locally.
import { assert, summary } from './assert';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
import { seedOutboxOps } from './outbox_seed';
import { createMockServer, mockCloudFromServer, type MockServer } from './mock_server';
import type { RealtorProfile } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// --- fakes ---------------------------------------------------------------

interface Faults {
  failUpsert?: unknown;
  failUpsertTables?: string[];
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

const INPUT = (address: string, buyer = 'Test Buyer') =>
  ({
    address,
    city: 'Santa Clarita',
    side: 'buy',
    buyerName: buyer,
    openDate: dates().openDate,
    closeDate: dates().closeDate,
  }) as never;

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

function profileFixture(over: Partial<RealtorProfile> = {}): RealtorProfile {
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
    ...over,
  };
}

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

async function checkAllBuyer(store: { toggleStep(e: string, r: 'buyer', s: string): Promise<unknown>; getEscrow(id: string): Promise<{ buyerSteps: { id: string; done: boolean }[] } | null> }, escrowId: string) {
  const e = await store.getEscrow(escrowId);
  for (const s of e!.buyerSteps) {
    if (!s.done) await store.toggleStep(escrowId, 'buyer', s.id);
  }
}

async function checkAllSeller(store: { toggleStep(e: string, r: 'seller', s: string): Promise<unknown>; getEscrow(id: string): Promise<{ sellerSteps: { id: string; done: boolean }[] } | null> }, escrowId: string) {
  const e = await store.getEscrow(escrowId);
  for (const s of e!.sellerSteps) {
    if (!s.done) await store.toggleStep(escrowId, 'seller', s.id);
  }
}

// --- tests ---------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Success: local applies only after the server confirms; the server
  //    got the rows; no outbox op was created.
  {
    const { server, store, kv } = await setup();
    const e = await store.createEscrow(INPUT('1 Sync Ct'));
    const got = await store.getEscrow(e.id);
    assert(!!got && got.address === '1 Sync Ct', 'createEscrow success applies locally');
    assert(
      server.upsertLog.some((u) => u.table === 'escrows'),
      'the server received the escrow row',
    );
    assert(
      server.upsertLog.some((u) => u.table === 'steps'),
      'the server received the step rows',
    );
    assert((await readOutboxOps(kv)).length === 0, 'no outbox op was created by the write');
  }

  // 2. Server failure: plain copy, local list empty, KV byte-identical.
  {
    const faults: Faults = { pendingGates: [], failUpsert: new Error('db exploded') };
    const { store, kv } = await setup(faults);
    const before = kv.dump();
    let msg = '';
    try {
      await store.createEscrow(INPUT('2 Fail Ct'));
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/not saved/i.test(msg), `failure throws the plain not-saved copy (got: ${msg})`);
    assert((await store.listEscrows()).length === 0, 'a failed create leaves no local escrow');
    assert(kv.dump() === before, 'a failed create leaves persisted KV byte-identical');
  }

  // 3 + 7. Offline transport failure mid-write: step unchanged, persisted
  //    KV byte-identical (rehydrated store agrees).
  {
    const faults: Faults = { pendingGates: [] };
    const { store, kv } = await setup(faults);
    const e = await store.createEscrow(INPUT('3 Offline Ct'));
    const stepId = (await store.getEscrow(e.id))!.buyerSteps[0].id;
    const beforeDump = kv.dump();
    faults.failUpsert = Object.assign(new Error('fetch failed'), { code: 'NETWORK' });
    let msg = '';
    try {
      await store.toggleStep(e.id, 'buyer', stepId);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/Couldn't reach the server/.test(msg), `offline throws the plain copy (got: ${msg})`);
    assert(
      (await store.getEscrow(e.id))!.buyerSteps[0].done === false,
      'the step is unchanged in memory after failure',
    );
    assert(kv.dump() === beforeDump, 'persisted KV is byte-identical after failure');
    const { store: rehydrated } = createSyncedStore(kv, {
      cloudClient: faultCloud(createMockServer(), { pendingGates: [] }) as never,
    });
    assert(
      (await rehydrated.getEscrow(e.id))!.buyerSteps[0].done === false,
      'a rehydrated store sees the unchanged step (nothing was persisted)',
    );
  }

  // 4. Timeout: a hung push trips the write deadline; local unchanged; a
  //    late server success afterwards must NOT apply locally.
  {
    const faults: Faults = { pendingGates: [] };
    const { store } = await setup(faults);
    const e = await store.createEscrow(INPUT('4 Timeout Ct'));
    const stepId = (await store.getEscrow(e.id))!.buyerSteps[0].id;
    // Gate ONLY the toggle's push — the fixture create above ran ungated.
    faults.gateUpsert = true;
    const write = store.toggleStep(e.id, 'buyer', stepId);
    await new Promise((r) => setTimeout(r, 100));
    assert(
      (await store.getEscrow(e.id))!.buyerSteps[0].done === false,
      'local is unchanged while the push is unconfirmed',
    );
    let msg = '';
    try {
      await write;
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/Couldn't reach the server/.test(msg), `timeout throws the plain copy (got: ${msg})`);
    // The server eventually answers — the write already failed, so the
    // late confirmation must not apply locally.
    faults.gateUpsert = false;
    faults.pendingGates.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 100));
    assert(
      (await store.getEscrow(e.id))!.buyerSteps[0].done === false,
      'a late server success after the timeout does not apply locally',
    );
  }

  // 5. Success applies ONLY after confirmation (positive control for 4).
  {
    const faults: Faults = { pendingGates: [] };
    const { store } = await setup(faults);
    const e = await store.createEscrow(INPUT('5 Gated Ct'));
    const stepId = (await store.getEscrow(e.id))!.buyerSteps[0].id;
    // Gate only the toggle's push.
    faults.gateUpsert = true;
    const write = store.toggleStep(e.id, 'buyer', stepId);
    await new Promise((r) => setTimeout(r, 100));
    assert(
      (await store.getEscrow(e.id))!.buyerSteps[0].done === false,
      'no local apply before the server confirms',
    );
    faults.gateUpsert = false;
    faults.pendingGates.splice(0).forEach((r) => r());
    await write;
    assert(
      (await store.getEscrow(e.id))!.buyerSteps[0].done === true,
      'local applies after the server confirms',
    );
  }

  // 6. No user action creates an outbox operation.
  {
    const { store, kv } = await setup();
    const e = await store.createEscrow(INPUT('6 NoOutbox Ct'));
    const stepId = (await store.getEscrow(e.id))!.buyerSteps[0].id;
    await store.toggleStep(e.id, 'buyer', stepId);
    await store.createInvite(e.id, 'buyer', 'Test Buyer');
    await store.saveProfile(profileFixture());
    assert((await readOutboxOps(kv)).length === 0, 'user actions never enqueue to the outbox');
  }

  // 8. Crash after server confirmation heals through the next pull: a
  //    server row the local store never applied converges on pull.
  {
    const { server } = await setup();
    server.seedRows['escrows'] = [
      {
        user_id: 'user-1',
        id: 'srv-escrow-1',
        address: '8 Healed Ct',
        city: 'Santa Clarita',
        side: 'buy',
        buyer_name: 'Healed Buyer',
        seller_name: null,
        open_date: '2026-09-28',
        close_date: '2026-11-28',
        status: 'cancelled',
        buyer_closed_at: null,
        seller_closed_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    server.seedRows['steps'] = [];
    // Pull via a fresh store on the same server: the row converges.
    const kv2 = trackingKV();
    const { store: s2, initCloudSync: init2 } = createSyncedStore(kv2, {
      cloudClient: faultCloud(server, { pendingGates: [] }) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    await init2();
    const healed = await s2.getEscrow('srv-escrow-1');
    assert(!!healed && healed.status === 'cancelled', 'the next pull heals the unapplied server row');
  }

  // 9. Close: per-side close revokes only that side; whole close revokes
  //    buyer + seller + TC codes and their server-created links.
  {
    const { server, store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('9 Close Ct'));
    const bInv = await store.createInvite(e.id, 'buyer', 'Test Buyer');
    const sInv = await store.createInvite(e.id, 'seller', 'Test Seller');
    const tInv = await store.createInvite(e.id, 'tc', 'Tina Coord');
    const bRes = await store.redeemInvite(bInv.code, 'Test Buyer', 'dev-b');
    const sRes = await store.redeemInvite(sInv.code, 'Test Seller', 'dev-s');
    const tRes = await store.redeemInvite(tInv.code, 'Tina Coord', 'dev-t');
    assert(bRes.ok && sRes.ok && tRes.ok, 'all three sides redeemed server-side links');
    if (!bRes.ok || !sRes.ok || !tRes.ok) throw new Error('redeem failed in fixture');
    const bLink = bRes.linkId;
    const sLink = sRes.linkId;
    const tLink = tRes.linkId;

    await checkAllBuyer(store as never, e.id);
    await store.closeEscrow(e.id, 'buyer');
    assert(
      !!server.invites.get(bInv.id)?.revokedAt,
      'per-side close revokes the buyer invite server-side',
    );
    assert(
      !!server.links.get(bLink)?.revokedAt,
      'per-side close kills the buyer server link',
    );
    assert(
      !server.invites.get(sInv.id)?.revokedAt && !server.links.get(sLink)?.revokedAt,
      'per-side close preserves the seller invite and link',
    );
    assert(
      !server.invites.get(tInv.id)?.revokedAt && !server.links.get(tLink)?.revokedAt,
      'per-side close preserves the TC invite and link',
    );

    await checkAllSeller(store as never, e.id);
    await store.closeEscrow(e.id, 'seller');
    assert(
      !!server.invites.get(sInv.id)?.revokedAt && !!server.links.get(sLink)?.revokedAt,
      'whole close revokes the seller invite and kills its link',
    );
    assert(
      !!server.invites.get(tInv.id)?.revokedAt && !!server.links.get(tLink)?.revokedAt,
      'whole close revokes the TC invite and kills its link',
    );
    const closed = await store.getEscrow(e.id);
    assert(closed!.status === 'closed', 'the escrow reads closed after both sides close');
  }

  // 10. Unchecking a step reopens only that side.
  {
    const { store } = await setup();
    const e = await store.createEscrow(BOTH_INPUT('10 Uncheck Ct'));
    await checkAllBuyer(store as never, e.id);
    await checkAllSeller(store as never, e.id);
    await store.closeEscrow(e.id, 'buyer');
    await store.closeEscrow(e.id, 'seller');
    const stepId = (await store.getEscrow(e.id))!.buyerSteps[0].id;
    await store.toggleStep(e.id, 'buyer', stepId);
    const after = (await store.getEscrow(e.id))!;
    assert(after.buyerClosedAt === null, 'unchecking reopens the buyer side');
    assert(typeof after.sellerClosedAt === 'string', 'the seller side stays closed');
    assert(after.buyerSteps[0].done === false, 'the unchecked step reads undone');
  }

  // 11. Regenerate is atomic: success swaps in the RPC code and kills the
  //     old server link; RPC failure leaves the local invite unchanged.
  {
    const { server, store } = await setup();
    const e = await store.createEscrow(INPUT('11 Regen Ct'));
    const inv = await store.createInvite(e.id, 'buyer', 'Test Buyer');
    const red = await store.redeemInvite(inv.code, 'Test Buyer', 'dev-1');
    assert(red.ok, 'redeemed a server link for the invite');
    const oldCode = inv.code;
    const res = await store.regenerateInvite(inv.id);
    assert(res.invite.code !== oldCode, 'the local invite carries the new code');
    assert(res.oldCode === oldCode, 'the result reports the old code');
    assert(
      res.invite.code === server.invites.get(res.invite.id)?.code,
      'the local code matches the server-issued code',
    );
    assert(
      !!server.invites.get(inv.id)?.revokedAt,
      'the old invite row is revoked server-side',
    );
    if (!red.ok) throw new Error('redeem failed in fixture');
    assert(
      !!server.links.get(red.linkId)?.revokedAt,
      'the old server device link is killed atomically',
    );

    // Failure: the RPC throws — local invite byte-identical.
    const faults: Faults = { pendingGates: [], failRpc: new Error('rpc down') };
    const ctx = await setup(faults);
    const e2 = await ctx.store.createEscrow(INPUT('11b Regen Ct'));
    faults.failUpsert = undefined;
    const inv2 = await ctx.store.createInvite(e2.id, 'buyer', 'Test Buyer');
    const code2 = inv2.code;
    faults.failRpc = new Error('rpc down');
    let msg = '';
    try {
      await ctx.store.regenerateInvite(inv2.id);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/not saved/i.test(msg), `regenerate failure throws the plain copy (got: ${msg})`);
    const kept = await ctx.store.getInvite(inv2.id);
    assert(
      !!kept && kept.code === code2 && kept.revokedAt === null,
      'a failed regenerate leaves the local invite byte-identical',
    );
  }

  // 12. Profile save with a photo: upload failure leaves local + the
  //     fingerprint KV unchanged; success stamps the versioned URL only
  //     after the row confirms.
  {
    const DATA_URI = 'data:image/jpeg;base64,AQIDBA==';
    // Failure: the row upsert fails after the upload succeeded.
    {
      const faults: Faults = { pendingGates: [] };
      const { store, kv } = await setup(faults);
      await store.saveProfile(profileFixture());
      const before = kv.dump();
      faults.failUpsert = new Error('row down');
      faults.failUpsertTables = ['realtor_profiles'];
      let msg = '';
      try {
        await store.saveProfile(profileFixture({ photoUri: DATA_URI }));
      } catch (err) {
        msg = (err as Error).message;
      }
      assert(/not saved/i.test(msg), `profile failure throws the plain copy (got: ${msg})`);
      const kept = await store.getProfile();
      assert(kept!.photoUri === null && kept!.photoRemoteUrl === null, 'the failed save leaves the local profile unchanged');
      assert(kv.dump() === before, 'the failed save leaves the fingerprint KV unchanged');
    }
    // Success.
    {
      const { server, store } = await setup();
      await store.saveProfile(profileFixture({ photoUri: DATA_URI }));
      const saved = (await store.getProfile())!;
      assert(
        typeof saved.photoRemoteUrl === 'string' &&
          /^https:\/\/cdn\.test\/realtor-media\/user-1\/photo-[0-9a-z]+\.jpg$/.test(saved.photoRemoteUrl),
        'success stamps the unique-path photo URL locally',
      );
      assert(
        server.upsertLog.some((u) => u.table === 'realtor_profiles'),
        'the profile row was pushed to the server',
      );
    }
  }

  // 13. Concurrent writes serialize: overlapping writes both apply.
  {
    const { store } = await setup();
    const e = await store.createEscrow(INPUT('13 Concurrent Ct'));
    const steps = (await store.getEscrow(e.id))!.buyerSteps;
    await Promise.all([
      store.saveProfile(profileFixture({ name: 'Concurrent Rita' })),
      store.toggleStep(e.id, 'buyer', steps[0].id),
      store.toggleStep(e.id, 'buyer', steps[1].id),
    ]);
    const prof = (await store.getProfile())!;
    const esc = (await store.getEscrow(e.id))!;
    assert(prof.name === 'Concurrent Rita', 'the concurrent profile save applied');
    assert(esc.buyerSteps[0].done && esc.buyerSteps[1].done, 'both concurrent toggles applied');
  }

  // 14. A pull racing a write cannot clobber it in either direction. The
  //    pull runs on the SAME store (the production shape): its fetch lands
  //    while the write is in flight, its merge waits on the exclusive gate
  //    behind the write, then the commit-seq guard skips the row the write
  //    committed after the fetch started.
  {
    const faults: Faults = { pendingGates: [] };
    const { server, store, initCloudSync } = await setup(faults);
    const a = await store.createEscrow(INPUT('14a Race Ct'));
    const b = await store.createEscrow(INPUT('14b Race Ct'));

    // Start a write on A with the push gated...
    const stepId = (await store.getEscrow(a.id))!.buyerSteps[0].id;
    faults.gateUpsert = true;
    const write = store.toggleStep(a.id, 'buyer', stepId);
    await new Promise((r) => setTimeout(r, 100));
    // ...while a pull fetches a server-side change to unrelated escrow B.
    server.seedRows['escrows'] = [
      {
        user_id: 'user-1',
        id: b.id,
        address: '14b Pulled Ct',
        city: 'Santa Clarita',
        side: 'buy',
        buyer_name: 'Test Buyer',
        seller_name: null,
        open_date: dates().openDate,
        close_date: dates().closeDate,
        status: 'open',
        buyer_closed_at: null,
        seller_closed_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    server.seedRows['steps'] = [];
    const pull = initCloudSync();
    await new Promise((r) => setTimeout(r, 50));
    // The write's commit must not wipe the pulled change...
    faults.gateUpsert = false;
    faults.pendingGates.splice(0).forEach((r) => r());
    await write;
    await pull;
    const afterA = (await store.getEscrow(a.id))!;
    const afterB = (await store.getEscrow(b.id))!;
    assert(afterA.buyerSteps[0].done === true, 'the write applied to escrow A');
    assert(afterB.address === '14b Pulled Ct', 'the write commit kept the pulled change to escrow B');
  }

  // 15. Legacy outbox drains exactly once, then retires.
  {
    const { server, store, kv } = await setup();
    const e = await store.createEscrow(INPUT('15 Drain Ct'));
    // Simulate an install upgrading from the background-push model: a
    // queued op from the old world. The fixture's own boot already set the
    // retired marker, so clear it to exercise the final drain.
    await kv.removeItem('ctc:outbox-retired');
    await seedOutboxOps(kv, [{ op: 'pushEscrow', escrowId: e.id, attempts: 0 }]);
    const pushesBefore = server.upsertLog.filter((u) => u.table === 'escrows').length;
    const { initCloudSync: boot2 } = createSyncedStore(kv, {
      cloudClient: faultCloud(server, { pendingGates: [] }) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    await boot2();
    const pushesAfterFirst = server.upsertLog.filter((u) => u.table === 'escrows').length;
    assert(pushesAfterFirst > pushesBefore, 'the first boot drains the legacy op');
    assert((await readOutboxOps(kv)).length === 0, 'the drained op is gone');
    const { initCloudSync: boot3 } = createSyncedStore(kv, {
      cloudClient: faultCloud(server, { pendingGates: [] }) as never,
      writeTimeoutMs: 400,
      writeTimeoutLongMs: 800,
    });
    await boot3();
    const pushesAfterSecond = server.upsertLog.filter((u) => u.table === 'escrows').length;
    assert(
      pushesAfterSecond === pushesAfterFirst,
      'the second boot does not re-push (the outbox is retired)',
    );
  }

  // 16. Missing cloud/session: the write throws the plain not-saved copy
  //     and commits nothing locally.
  {
    const kv = trackingKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    let msg = '';
    try {
      await store.createEscrow(INPUT('16 NoSession Ct'));
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/signed out/.test(msg), `missing session throws the not-saved copy (got: ${msg})`);
    assert((await store.listEscrows()).length === 0, 'nothing commits locally without a session');
  }

  summary('sync_writes');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
