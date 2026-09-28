// outbox_concurrency.test.ts — REGRESSION (Sept 28, 2026).
//
// A close enqueues two convergeLinkRevokes ops; a stale bgPush completion
// (dequeueOutboxOp) from an earlier action can interleave its
// read-modify-write around those enqueues. Before the fix, the stale write
// silently dropped the newer op: the outbox ended empty, no sync error was
// recorded, and the server link stayed live (zombie) with nothing queued to
// retry it.
//
// This test pins the serialization with a rigged KV whose reads and writes
// only complete when released, so the stale writer's read/write can be
// deterministically interleaved around newer enqueues — the exact Sept 28
// race shape. A stale dequeue's write must never clobber ops enqueued
// after its read.
import { assert, summary } from './assert';
import type { KV } from '../src/lib/store';
import {
  enqueueOutbox,
  dequeueOutboxOp,
  drainOutbox,
  readOutboxOps,
  outboxOpKey,
  type OutboxOp,
} from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer } from './mock_server';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// A KV whose reads and writes pend until released, so the test can
// deterministically order a stale writer's read/write against newer
// enqueues.
function riggedKV() {
  const map = new Map<string, string>();
  const readQ: Array<(v?: unknown) => void> = [];
  const writeQ: Array<(v?: unknown) => void> = [];
  const kv: KV = {
    getItem: (k: string) =>
      new Promise<string | null>((resolve) => {
        readQ.push(() => resolve(map.has(k) ? map.get(k)! : null));
      }),
    setItem: (k: string, v: string) =>
      new Promise<void>((resolve) => {
        writeQ.push(() => {
          map.set(k, v);
          resolve();
        });
      }),
    removeItem: (k: string) =>
      new Promise<void>((resolve) => {
        writeQ.push(() => {
          map.delete(k);
          resolve();
        });
      }),
  };
  return { kv, readQ, writeQ };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(() => r()));
}

async function main(): Promise<void> {
  const rig = riggedKV();
  const kv = rig.kv;
  const releaseRead = () => {
    const f = rig.readQ.shift();
    if (f) f();
  };
  const releaseWrite = () => {
    const f = rig.writeQ.shift();
    if (f) f();
  };
  // Drive one pending KV op (a read if any is waiting, else a write).
  // Returns false when nothing is pending.
  async function driveOne(): Promise<boolean> {
    await flush();
    if (rig.readQ.length > 0) {
      releaseRead();
      return true;
    }
    if (rig.writeQ.length > 0) {
      releaseWrite();
      return true;
    }
    return false;
  }

  // Seed the outbox the way a close does: a leftover pushEscrow (the
  // stale bgPush's target) plus two pushRevokes.
  async function enqueueSync(op: OutboxOp): Promise<void> {
    const p = enqueueOutbox(kv, op);
    while (await driveOne()) {
      // keep driving until the enqueue's read+write complete
    }
    await p;
  }
  await enqueueSync({ op: 'pushEscrow', escrowId: 'e1', attempts: 0 });
  await enqueueSync({ op: 'pushRevoke', inviteId: 'inv-a', revokedAt: 't1', attempts: 0 });
  await enqueueSync({ op: 'pushRevoke', inviteId: 'inv-b', revokedAt: 't2', attempts: 0 });

  // The stale dequeue (a bgPush from an earlier action whose push finished
  // late) and the two converge enqueues (the close's) are all in flight.
  // The serialization chain runs them in call order: stale first, then
  // the enqueues — no interleaved stale write can land between them.
  const staleP = dequeueOutboxOp(kv, { op: 'pushEscrow', escrowId: 'e1' });
  const e1P = enqueueOutbox(kv, {
    op: 'convergeLinkRevokes',
    inviteId: 'inv-a',
    revokedAt: 't1',
    attempts: 0,
  });
  const e2P = enqueueOutbox(kv, {
    op: 'convergeLinkRevokes',
    inviteId: 'inv-b',
    revokedAt: 't2',
    attempts: 0,
  });
  for (let i = 0; i < 12; i++) {
    if (!(await driveOne())) break;
  }
  await Promise.all([staleP, e1P, e2P]);

  // The two converge ops must survive the stale dequeue's write.
  const rp = readOutboxOps(kv);
  while (await driveOne()) {
    // drain the read
  }
  const ops = await rp;
  const keys = new Set(ops.map(outboxOpKey));
  assert(keys.has('pushRevoke::inv-a:'), 'stale dequeue did not drop pushRevoke inv-a');
  assert(keys.has('pushRevoke::inv-b:'), 'stale dequeue did not drop pushRevoke inv-b');
  assert(
    keys.has('convergeLinkRevokes::inv-a:'),
    'stale dequeue did not drop converge inv-a (Sept 28 zombie)',
  );
  assert(keys.has('convergeLinkRevokes::inv-b:'), 'stale dequeue did not drop converge inv-b');
  assert(!keys.has('pushEscrow:e1::'), 'stale dequeue still removed its own pushEscrow op');

  // Drain against the mock server: every surviving op must execute.
  const server = createMockServer();
  server.invites.set('inv-a', { id: 'inv-a', code: 'A', escrowId: 'e1', role: 'buyer', revokedAt: null });
  server.invites.set('inv-b', { id: 'inv-b', code: 'B', escrowId: 'e1', role: 'tc', revokedAt: null });
  server.links.set('link-a', { id: 'link-a', inviteId: 'inv-a', deviceId: 'd1', revokedAt: null });
  server.links.set('link-b', { id: 'link-b', inviteId: 'inv-b', deviceId: 'd2', revokedAt: null });
  const client = mockCloudFromServer(server)() as never;
  const dp = drainOutbox(client, 'user-1', kv, {
    getEscrow: async () => null,
    getProfile: async () => null,
    getInvite: async (id: string) =>
      ({ id, revokedAt: id === 'inv-a' ? 't1' : 't2' }) as never,
  });
  let drained = false;
  dp.then(
    () => {
      drained = true;
    },
    () => {
      drained = true;
    },
  );
  for (let i = 0; i < 200 && !drained; i++) {
    await driveOne();
  }
  assert(drained, 'drain completed against the rigged KV');
  const result = await dp;
  assert(result.drained === 4, `drain executed all 4 ops (got ${result.drained})`);
  assert(result.pending === 0, 'outbox empty after drain');

  const rp2 = readOutboxOps(kv);
  while (await driveOne()) {
    // drain the read
  }
  assert((await rp2).length === 0, 'no ops left queued');

  assert(server.invites.get('inv-a')?.revokedAt === 't1', 'server invite inv-a revoked');
  assert(server.invites.get('inv-b')?.revokedAt === 't2', 'server invite inv-b revoked');
  assert(server.links.get('link-a')?.revokedAt === 't1', 'server link link-a revoked');
  assert(server.links.get('link-b')?.revokedAt === 't2', 'server link link-b revoked');

  summary('outbox_concurrency');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
