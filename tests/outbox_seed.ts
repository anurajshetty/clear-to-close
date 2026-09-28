// outbox_seed.ts — test-only helper (Sept 28, 2026).
//
// The user-action outbox is RETIRED: production code can no longer enqueue
// ops (enqueueOutbox was deleted with the synchronous-write rewrite).
// Tests that exercise the legacy machinery — the one final drain on
// upgrade, manual Retry of surfaced failures, the logout-wipe — still need
// a way to put legacy ops in the queue. This writes them directly to the
// ctc:outbox KV key, exactly as the retired background-push model left
// them behind. User-action paths must never import this.
import type { KV } from '../src/lib/store';
import type { OutboxOp } from '../src/lib/cloudSync';

/** Seed legacy outbox ops the way the retired background-push model left them. */
export async function seedOutboxOps(kv: KV, ops: OutboxOp[]): Promise<void> {
  await kv.setItem('ctc:outbox', JSON.stringify(ops.map((o) => ({ ...o }))));
}
