// editcancel.test.ts — deal-list edit/cancel round (Sept 2026).
// Covers: updateEscrow (field updates, side switching, validation, status
// preservation on closed/cancelled escrows), cancelEscrow (status flip,
// closed escrows refuse, list filtering), sideToSelection (picker
// pre-population round-trip), and the cloud pull mapping for 'cancelled'.
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { sideToSelection, selectionToSide } from '../src/lib/sidePicker';
import { fromEscrowRow, toEscrowRow } from '../src/lib/cloudSync';
import type { Escrow } from '../src/lib/types';

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
  const store = createStore(kv);
  const { openDate, closeDate } = dates();

  // --- updateEscrow: all fields editable, incl. side switching ---
  const created = await store.createEscrow({
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'Test Buyer',
    openDate,
    closeDate,
  });
  const updated = await store.updateEscrow(created.id, {
    address: '999 New Address Ln',
    city: 'Santa Clarita, CA 91355',
    side: 'both',
    buyerName: 'New Buyer',
    sellerName: 'New Seller',
    openDate,
    closeDate,
  });
  assert(updated.address === '999 New Address Ln', 'update: address changed');
  assert(updated.city === 'Santa Clarita, CA 91355', 'update: city changed');
  assert(updated.side === 'both', 'update: side switched buy -> both');
  assert(updated.buyerName === 'New Buyer', 'update: buyer name changed');
  assert(updated.sellerName === 'New Seller', 'update: seller name set');
  assert(updated.status === 'open', 'update: status preserved (open)');
  assert(updated.buyerSteps.length === created.buyerSteps.length, 'update: steps untouched');

  // Switching back to a single side clears the other name.
  const toSell = await store.updateEscrow(created.id, {
    address: '999 New Address Ln',
    city: 'Santa Clarita, CA 91355',
    side: 'sell',
    sellerName: 'Only Seller',
    openDate,
    closeDate,
  });
  assert(toSell.side === 'sell', 'update: side switched both -> sell');
  assert(toSell.buyerName === null, 'update: buyer name cleared on sell-only');
  assert(toSell.sellerName === 'Only Seller', 'update: seller name kept');

  // --- updateEscrow: validation mirrors creation ---
  let threw = false;
  try {
    await store.updateEscrow(created.id, {
      address: '  ', city: 'X', side: 'buy', buyerName: 'B', openDate, closeDate,
    });
  } catch { threw = true; }
  assert(threw, 'update: empty address rejected');

  threw = false;
  try {
    await store.updateEscrow(created.id, {
      address: 'A', city: 'X', side: 'buy', buyerName: 'B',
      openDate: closeDate, closeDate: openDate, // flipped
    });
  } catch { threw = true; }
  assert(threw, 'update: closeDate before openDate rejected');

  threw = false;
  try {
    await store.updateEscrow(created.id, {
      address: 'A', city: 'X', side: 'buy', buyerName: 'B',
      openDate: 'not-a-date', closeDate,
    });
  } catch { threw = true; }
  assert(threw, 'update: malformed openDate rejected');

  threw = false;
  try {
    await store.updateEscrow('no-such-id', {
      address: 'A', city: 'X', side: 'buy', buyerName: 'B', openDate, closeDate,
    });
  } catch { threw = true; }
  assert(threw, 'update: unknown escrow id rejected');

  // --- updateEscrow: closed/cancelled escrows keep their status ---
  const closedOne = await store.createEscrow({
    address: 'Closed St', city: 'X', side: 'buy', buyerName: 'B', openDate, closeDate,
  });
  // Per-side close requires every step on the side to be complete
  // (escrow lifecycle merge, Sept 2026).
  const closedCreated = await store.getEscrow(closedOne.id);
  for (const s of closedCreated!.buyerSteps) {
    if (!s.done) await store.toggleStep(closedOne.id, 'buyer', s.id);
  }
  await store.closeEscrow(closedOne.id, 'buyer');
  const editedClosed = await store.updateEscrow(closedOne.id, {
    address: 'Closed St Updated', city: 'X', side: 'buy', buyerName: 'B', openDate, closeDate,
  });
  assert(editedClosed.status === 'closed', 'update: closed escrow stays closed');
  assert(editedClosed.address === 'Closed St Updated', 'update: closed escrow fields still editable');

  // --- cancelEscrow: status flip + persistence ---
  const toCancel = await store.createEscrow({
    address: 'Cancel Me', city: 'X', side: 'sell', sellerName: 'S', openDate, closeDate,
  });
  const cancelled = await store.cancelEscrow(toCancel.id);
  assert(cancelled.status === 'cancelled', 'cancel: status becomes cancelled');
  assert(cancelled.address === 'Cancel Me', 'cancel: fields untouched');
  assert(cancelled.sellerSteps.length > 0, 'cancel: steps intact');

  const editedCancelled = await store.updateEscrow(toCancel.id, {
    address: 'Cancel Me Edited', city: 'X', side: 'sell', sellerName: 'S', openDate, closeDate,
  });
  assert(editedCancelled.status === 'cancelled', 'update: cancelled escrow stays cancelled');

  // Closed escrows cannot be cancelled (their cards show the pencil only).
  threw = false;
  try {
    await store.cancelEscrow(closedOne.id);
  } catch { threw = true; }
  assert(threw, 'cancel: closed escrow refused');

  threw = false;
  try {
    await store.cancelEscrow('no-such-id');
  } catch { threw = true; }
  assert(threw, 'cancel: unknown escrow id rejected');

  // --- list filtering: cancelled leaves open, joins cancelled ---
  const all = await store.listEscrows();
  const open = all.filter((e: Escrow) => e.status === 'open');
  const closedList = all.filter((e: Escrow) => e.status === 'closed');
  const cancelledList = all.filter((e: Escrow) => e.status === 'cancelled');
  assert(!open.some((e) => e.id === toCancel.id), 'cancel: escrow leaves the open list');
  assert(cancelledList.some((e) => e.id === toCancel.id), 'cancel: escrow lands in the cancelled list');
  assert(closedList.some((e) => e.id === closedOne.id), 'closed list intact');

  // --- sideToSelection: pre-population round-trip ---
  assert(
    JSON.stringify(sideToSelection('buy')) === JSON.stringify({ buy: true, sell: false }),
    'sideToSelection: buy',
  );
  assert(
    JSON.stringify(sideToSelection('sell')) === JSON.stringify({ buy: false, sell: true }),
    'sideToSelection: sell',
  );
  assert(
    JSON.stringify(sideToSelection('both')) === JSON.stringify({ buy: true, sell: true }),
    'sideToSelection: both',
  );
  for (const side of ['buy', 'sell', 'both'] as const) {
    assert(selectionToSide(sideToSelection(side)) === side, `side round-trip: ${side}`);
  }

  // --- cloud sync: 'cancelled' round-trips ---
  const row = toEscrowRow('user-1', cancelled);
  assert(row.status === 'cancelled', 'push: cancelled status serialized');
  const back = fromEscrowRow({ ...row });
  assert(back.status === 'cancelled', 'pull: cancelled status mapped through');
  const backOpen = fromEscrowRow({ ...row, status: 'open' });
  assert(backOpen.status === 'open', 'pull: open still maps to open');
  const backClosed = fromEscrowRow({ ...row, status: 'closed' });
  assert(backClosed.status === 'closed', 'pull: closed still maps to closed');

  summary('editcancel');
}

main();
