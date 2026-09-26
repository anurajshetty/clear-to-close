// checklist.test.ts — single-list redesign contract (mockup 01, Sept 2026).
// The realtor, buyer, and seller views all show ONE ordered list in the
// realtor's order: no completed/remaining grouping, checked steps stay in
// place, the ring recounts against the current total, and the buyer/seller
// lists of a both-side escrow are fully independent.
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

async function main(): Promise<void> {
  const kv = memoryKV();
  const { openDate, closeDate } = dates();
  const store = createStore(kv);

  const escrow = await store.createEscrow({
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'both',
    buyerName: 'Test Buyer',
    sellerName: 'Test Seller',
    openDate,
    closeDate,
  });
  const titles = escrow.buyerSteps.map((s) => s.title);

  // 1. The client view is a single list in the realtor's order — done and
  // undone steps interleaved by `order`, never grouped.
  await store.toggleStep(escrow.id, 'buyer', escrow.buyerSteps[2].id);
  await store.toggleStep(escrow.id, 'buyer', escrow.buyerSteps[0].id);
  const view = await store.getBuyerView(escrow.id);
  assert(
    view.steps.map((s) => s.title).join('|') === titles.join('|'),
    'client view keeps the realtor order with checked steps in place (no grouping)',
  );
  assert(view.done === 2 && view.total === titles.length, 'ring counts 2 of N');
  assert(view.upNext?.title === titles[1], 'UP NEXT is the first remaining step in order');

  // 2. Toggling back off also keeps the step in place.
  await store.toggleStep(escrow.id, 'buyer', escrow.buyerSteps[0].id);
  const view2 = await store.getBuyerView(escrow.id);
  assert(
    view2.steps.map((s) => s.title).join('|') === titles.join('|'),
    'unchecking keeps the step in place',
  );
  assert(view2.done === 1, 'ring recounts down after uncheck');

  // 3. Reorder: the client view follows the realtor's new order, and UP NEXT
  // recomputes against it.
  const reordered = [
    escrow.buyerSteps[3].id,
    escrow.buyerSteps[0].id,
    escrow.buyerSteps[1].id,
    escrow.buyerSteps[2].id,
    ...escrow.buyerSteps.slice(4).map((s) => s.id),
  ];
  await store.reorderSteps(escrow.id, 'buyer', reordered);
  const view3 = await store.getBuyerView(escrow.id);
  assert(view3.steps[0].title === titles[3], 'reorder moves the step in the client view');
  assert(
    view3.steps.map((s) => s.title).join('|') ===
      [titles[3], titles[0], titles[1], titles[2], ...titles.slice(4)].join('|'),
    'full client order matches the realtor reorder',
  );
  assert(view3.upNext?.title === titles[3], 'UP NEXT follows the reorder');

  // 4. Custom step: appended, flagged custom, ring recounts against the new total.
  await store.addCustomStep(escrow.id, 'buyer', 'Termite inspection');
  const view4 = await store.getBuyerView(escrow.id);
  assert(view4.total === titles.length + 1, 'ring recounts against the new total');
  assert(view4.steps[view4.steps.length - 1].title === 'Termite inspection', 'custom step appended last');
  assert(view4.steps[view4.steps.length - 1].custom === true, 'custom step carries the custom flag');

  // 5. Both-side independence: buyer mutations never touch the seller list.
  const sellerBefore = (await store.getSellerView(escrow.id)).steps.map((s) => s.title).join('|');
  await store.toggleStep(escrow.id, 'seller', (await store.getSellerView(escrow.id)).steps[0].id);
  const sellerAfter = await store.getSellerView(escrow.id);
  const buyerAfter = await store.getBuyerView(escrow.id);
  assert(sellerAfter.done === 1, 'seller list checks off independently');
  assert(buyerAfter.done === 1, 'buyer done-count untouched by the seller checkoff');
  assert(
    sellerAfter.steps.map((s) => s.title).join('|') === sellerBefore,
    'seller order untouched by buyer reorder/add',
  );

  summary('checklist');
}

main();
