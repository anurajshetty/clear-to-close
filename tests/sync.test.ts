// sync.test.ts — step mutations reflect in client views; roles stay independent.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  const store = createStore(memoryKV());

  // Both-sides escrow.
  const escrow = await store.createEscrow({
    address: '456 Oak Ave',
    city: 'Valencia',
    side: 'both',
    buyerName: 'Alice Buyer',
    sellerName: 'Bob Seller',
    openDate: '2026-09-01',
    closeDate: '2026-10-15',
  });
  assert(escrow.buyerSteps.length === 13, `both-side escrow builds 13 buyer steps (got ${escrow.buyerSteps.length})`);
  assert(escrow.sellerSteps.length === 12, `both-side escrow builds 12 seller steps (got ${escrow.sellerSteps.length})`);

  // Toggle the 3rd buyer step.
  const third = escrow.buyerSteps[2];
  assert(third.title === 'Property inspection scheduled', '3rd buyer step is the inspection step');
  const updated = await store.toggleStep(escrow.id, 'buyer', third.id);
  assert(updated.buyerSteps.find((s) => s.id === third.id)!.done === true, 'toggleStep marks buyer step done');
  assert(typeof updated.buyerSteps.find((s) => s.id === third.id)!.completedAt === 'string', 'toggleStep stamps completedAt');

  let bv = await store.getBuyerView(escrow.id);
  assert(bv.done === 1, `buyer view done count +1 (got ${bv.done})`);
  assert(bv.total === 13, `buyer view total 13 (got ${bv.total})`);
  assert(bv.steps.find((s) => s.id === third.id)!.done === true, 'buyer view shows the step done');
  assert(bv.upNext !== null && bv.upNext.id === bv.steps.find((s) => !s.done)!.id, 'buyer view upNext is first not-done step');
  assert(bv.daysToClose > 0, `buyer view daysToClose positive (got ${bv.daysToClose})`);

  let sv = await store.getSellerView(escrow.id);
  assert(sv.done === 0, `seller view unchanged after buyer toggle (got ${sv.done})`);
  assert(sv.total === 12, `seller view total still 12 (got ${sv.total})`);

  // Uncheck -> reverts.
  await store.toggleStep(escrow.id, 'buyer', third.id);
  bv = await store.getBuyerView(escrow.id);
  assert(bv.done === 0, 'buyer view reverts after uncheck');
  assert(bv.steps.find((s) => s.id === third.id)!.completedAt === null, 'completedAt cleared after uncheck');

  // Custom step on buyer side only.
  const afterAdd = await store.addCustomStep(escrow.id, 'buyer', 'Sign HOA addendum');
  const custom = afterAdd.buyerSteps.find((s) => s.title === 'Sign HOA addendum')!;
  assert(custom.custom === true, 'custom step flagged custom');
  assert(custom.done === false && custom.completedAt === null, 'custom step starts not-done');
  assert(custom.order === 13, `custom step order = max+1 (got ${custom.order})`);

  bv = await store.getBuyerView(escrow.id);
  assert(bv.total === 14, `buyer view total+1 after custom step (got ${bv.total})`);
  sv = await store.getSellerView(escrow.id);
  assert(sv.total === 12, 'seller view total unchanged after buyer custom step');

  // Reorder buyer steps; seller unaffected.
  const ids = afterAdd.buyerSteps.map((s) => s.id).reverse();
  const afterReorder = await store.reorderSteps(escrow.id, 'buyer', ids);
  const buyerOrder = [...afterReorder.buyerSteps].sort((a, b) => a.order - b.order).map((s) => s.id);
  assert(JSON.stringify(buyerOrder) === JSON.stringify(ids), 'buyer steps follow the reordered ids');
  bv = await store.getBuyerView(escrow.id);
  assert(JSON.stringify(bv.steps.map((s) => s.id)) === JSON.stringify(ids), 'buyer view order matches reorder');
  sv = await store.getSellerView(escrow.id);
  const sellerIds = sv.steps.map((s) => s.id);
  assert(sellerIds.length === 12, 'seller view still has 12 steps after buyer reorder');

  // reorderSteps with wrong id set throws.
  let threw = false;
  try {
    await store.reorderSteps(escrow.id, 'buyer', ids.slice(1));
  } catch {
    threw = true;
  }
  assert(threw, 'reorderSteps with an incomplete id set throws');

  // Single-side buy escrow: toggle assertions on the buyer view.
  const buyOnly = await store.createEscrow({
    address: '789 Pine Rd',
    city: 'Canyon Country',
    side: 'buy',
    buyerName: 'Gina Buyer',
    openDate: '2026-09-10',
    closeDate: '2026-11-01',
  });
  assert(buyOnly.side === 'buy', 'single-side buy escrow side is buy');
  assert(buyOnly.sellerName === null, 'sellerName null when not provided');
  const step = buyOnly.buyerSteps[0];
  await store.toggleStep(buyOnly.id, 'buyer', step.id);
  const bv2 = await store.getBuyerView(buyOnly.id);
  assert(bv2.done === 1 && bv2.steps.find((s) => s.id === step.id)!.done === true, 'buy-only escrow buyer toggle reflected in buyer view');

  // createEscrow validation.
  let emptyAddrThrew = false;
  try {
    await store.createEscrow({ address: '   ', city: 'X', side: 'buy', openDate: '2026-09-01', closeDate: '2026-10-01' });
  } catch {
    emptyAddrThrew = true;
  }
  assert(emptyAddrThrew, 'createEscrow throws on empty address');

  let badDateThrew = false;
  try {
    await store.createEscrow({ address: 'A', city: 'X', side: 'buy', openDate: '2026-02-30', closeDate: '2026-10-01' });
  } catch {
    badDateThrew = true;
  }
  assert(badDateThrew, 'createEscrow throws on invalid calendar date');

  // updateTargetDate + daysToClose reflect the new date.
  // Use the VM's *local* today (not a hardcoded date) so this stays green across midnight.
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  await store.updateTargetDate(escrow.id, todayLocal);
  const bv3 = await store.getBuyerView(escrow.id);
  assert(bv3.daysToClose === 0, `daysToClose is 0 on the close date (got ${bv3.daysToClose})`);

  // closeEscrow.
  const closed = await store.closeEscrow(escrow.id);
  assert(closed.status === 'closed', 'closeEscrow sets status closed');

  summary('sync.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
