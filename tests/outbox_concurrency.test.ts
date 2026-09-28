// outbox_concurrency.test.ts — REGRESSION (Sept 28, 2026; reworked for the
// synchronous-write retirement).
//
// Original shape: a stale bgPush dequeue could interleave its read/write
// around newer enqueues and silently drop a close's converge op (the Sept
// 28 zombie-link failure). The per-KV promise chain fixed that.
//
// Retired shape: user actions never enqueue anymore (enqueueOutbox and
// dequeueOutboxOp were deleted). The only remaining outbox writers are the
// legacy final drain (drainOutbox) and the logout-wipe (clearOutbox), plus
// readers (readOutboxOps). This test pins that the chain still serializes
// them: a clearOutbox racing a mid-cycle drain must land AFTER the drain's
// final write — never interleaved between the drain's read and write,
// which would resurrect remaining ops or silently drop them — and a
// concurrent readOutboxOps must see a consistent post-drain snapshot.
import { assert, summary } from './assert';
import type { KV } from '../src/lib/store';
import { seedOutboxOps } from './outbox_seed';
import {
  clearOutbox,
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
// deterministically order the drain's read/write against concurrent
// clearOutbox/readOutboxOps calls. Every outbox write is logged in order.
function riggedKV() {
  const map = new Map<string, string>();
  const readQ: Array<(v?: unknown) => void> = [];
  const writeQ: Array<(v?: unknown) => void> = [];
  const writeLog: string[] = [];
  const kv: KV = {
    getItem: (k: string) =>
      new Promise<string | null>((resolve) => {
        readQ.push(() => resolve(map.has(k) ? map.get(k)! : null));
      }),
    setItem: (k: string, v: string) =>
      new Promise<void>((resolve) => {
        writeQ.push(() => {
          if (k === 'ctc:outbox') writeLog.push(`set:${v}`);
          map.set(k, v);
          resolve();
        });
      }),
    removeItem: (k: string) =>
      new Promise<void>((resolve) => {
        writeQ.push(() => {
          if (k === 'ctc:outbox') writeLog.push('remove');
          map.delete(k);
          resolve();
        });
      }),
  };
  return { kv, readQ, writeQ, writeLog };
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
  async function driveAll(limit = 400): Promise<void> {
    for (let i = 0; i < limit; i++) {
      if (!(await driveOne())) break;
    }
  }

  // Seed legacy ops the way the retired background-push model left them:
  // a pushRevoke that will drain, and a manual-only pushEscrow that stays
  // in remaining (so the drain's final write is non-empty and meaningful).
  const seedP = seedOutboxOps(kv, [
    { op: 'pushRevoke', inviteId: 'inv-a', revokedAt: 't1', attempts: 0 },
    { op: 'pushEscrow', escrowId: 'e1', attempts: 0, manualOnly: true },
  ]);
  await driveAll();
  await seedP;
  assert(rig.writeLog.length === 1, 'seed wrote the outbox once');

  const server = createMockServer();
  server.invites.set('inv-a', { id: 'inv-a', code: 'A', escrowId: 'e1', role: 'buyer', revokedAt: null });
  const client = mockCloudFromServer(server)() as never;

  // The final drain starts; a logout-wipe clearOutbox and a status read
  // race it mid-cycle. The chain must serialize them in call order: the
  // drain's full read-process-write cycle first, then the clear, then the
  // read. The clear's removeItem must land AFTER the drain's final write —
  // never between the drain's read and write.
  const drainP = drainOutbox(client, 'user-1', kv, {
    getEscrow: async () => null,
    getProfile: async () => null,
    getInvite: async (id: string) => ({ id, revokedAt: 't1' }) as never,
  });
  const clearP = clearOutbox(kv);
  const readP = readOutboxOps(kv);
  await driveAll();
  const result = await drainP;
  await clearP;
  const concurrentRead = await readP;

  assert(result.drained === 1, `drain executed the pushRevoke (got ${result.drained})`);
  assert(result.pending === 1, 'manual-only op stayed in remaining');
  assert(
    concurrentRead.length === 0,
    'concurrent readOutboxOps saw the post-clear snapshot (consistent, not half-drained)',
  );

  const log = rig.writeLog;
  const finalWriteIdx = log.findIndex((e) => e.startsWith('set:') && e.includes('pushEscrow'));
  const removeIdx = log.indexOf('remove');
  assert(finalWriteIdx >= 0, "drain's final write landed in the log");
  assert(removeIdx >= 0, "clearOutbox's remove landed in the log");
  assert(
    finalWriteIdx < removeIdx,
    'serialization: drain final write before clear remove (no interleaved stale write)',
  );

  // No resurrection: the final state is empty, and the manual-only op the
  // drain wrote back was wiped by the racing clear — exactly the
  // logout-wipe semantics (identity boundary backstop).
  const rp = readOutboxOps(kv);
  await driveAll();
  assert((await rp).length === 0, 'no ops left queued after drain + racing clear');

  assert(server.invites.get('inv-a')?.revokedAt === 't1', 'server invite inv-a revoked by the drain');

  summary('outbox_concurrency');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
