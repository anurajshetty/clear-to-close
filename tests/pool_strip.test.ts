// pool_strip.test.ts — REGRESSION: pool-equipment-inspection removal
// (Anuraj, Sept 30, 2026).
// The step was removed from the seller template (13 -> 12 steps) and must
// be stripped from existing escrows too, checked or unchecked — keep it
// clean, no silent history left behind. Custom steps are never touched.
// Stripped ids are queued for the server-side delete (boot convergence).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore, readPendingStepDeletions } from '../src/lib/store';
import { SELL_STEPS } from '../src/lib/steps';
import { explainerCoverage } from '../src/lib/stepExplainers';

declare const process: { exitCode?: number };

function step(id: string, title: string, key: string | null, custom: boolean, done: boolean) {
  return {
    id,
    title,
    subtitle: '',
    done,
    custom,
    order: 0,
    completedAt: done ? '2026-09-29T10:00:00Z' : null,
    explainer: null,
    templateKey: key,
  };
}

async function main(): Promise<void> {
  // Template: 12 seller steps, no pool row, no pool explainer.
  assert(SELL_STEPS.length === 12, `seller template = 12 (got ${SELL_STEPS.length})`);
  assert(
    !SELL_STEPS.some((s) => s.key === 'pool-equipment-inspection'),
    'pool-equipment-inspection absent from seller template',
  );
  assert(
    explainerCoverage('seller', ['pool-equipment-inspection']).length === 1,
    'pool-equipment-inspection explainer removed',
  );

  // Seed a KV with a pre-removal escrow: one checked pool row (with key),
  // one unchecked pool row (pre-key, title only), and a custom step that
  // happens to share the title (must survive).
  const kv = memoryKV();
  const escrow: Record<string, unknown> = {
    id: 'esc-pool-1',
    address: '1 Pool Ln',
    city: 'Valencia',
    side: 'sell',
    buyerSteps: [],
    sellerSteps: [
      step('s-pool-checked', 'Pool equipment inspection', 'pool-equipment-inspection', false, true),
      step('s-pool-legacy', 'Pool equipment inspection', null, false, false),
      step('s-pool-custom', 'Pool equipment inspection', null, true, false),
      step('s-other', 'Order home warranty', 'order-home-warranty', false, false),
    ],
  };
  await kv.setItem('ctc:escrows', JSON.stringify([escrow]));

  // Fresh store on the same KV = app restart -> ensureLoaded strips.
  const store = createStore(kv);
  const loaded = await store.listEscrows();
  const sellerSteps = loaded[0].sellerSteps;
  assert(
    !sellerSteps.some((s) => s.id === 's-pool-checked' || s.id === 's-pool-legacy'),
    'checked and unchecked pool rows stripped from existing escrow',
  );
  assert(
    sellerSteps.some((s) => s.id === 's-pool-custom'),
    'custom step with the same title survives the strip',
  );
  assert(
    sellerSteps.some((s) => s.id === 's-other'),
    'unrelated template steps survive the strip',
  );

  // Stripped ids are queued for the server-side delete.
  const pending = await readPendingStepDeletions(kv);
  assert(
    pending.includes('s-pool-checked') && pending.includes('s-pool-legacy'),
    'stripped step ids queued for server delete',
  );
  assert(
    !pending.includes('s-pool-custom') && !pending.includes('s-other'),
    'custom and unrelated steps never queued',
  );

  summary('pool_strip');
}

main();
