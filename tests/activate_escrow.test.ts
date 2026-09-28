// activate_escrow.test.ts — Activate escrow (Sept 2026).
// Covers: activating a closed escrow and a cancelled escrow both land it
// back in the active list with field edits saved (status 'open', per-side
// close dates cleared — the deal list reads closed from those dates, so
// flipping status alone would not move the card). Steps carry over with
// their state; activating an already-open escrow throws; validation mirrors
// updateEscrow; updateEscrow on open escrows is untouched.
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { isClosedRow } from '../src/lib/lifecycle';
import type { CreateEscrowInput } from '../src/lib/types';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

function input(address: string, d: { openDate: string; closeDate: string }): CreateEscrowInput {
  return {
    address,
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'Test Buyer',
    openDate: d.openDate,
    closeDate: d.closeDate,
  };
}

async function main(): Promise<void> {
  const kv = memoryKV();
  const store = createStore(kv);
  const d = dates();

  // --- activating a closed escrow lands it back in the active list ---
  const created = await store.createEscrow(input('10 Closed St', d));
  const withSteps = await store.getEscrow(created.id);
  for (const s of withSteps!.buyerSteps) {
    if (!s.done) await store.toggleStep(created.id, 'buyer', s.id);
  }
  const closedResult = await store.closeEscrow(created.id, 'buyer');
  const closed = closedResult.escrow;
  assert(closed.status === 'closed', 'setup: escrow closed');
  assert(isClosedRow(closed), 'setup: closed row reads closed');
  const stepsBefore = closed.buyerSteps.length;

  const activated = await store.activateEscrow(created.id, input('10 Reopened St', d));
  assert(activated.status === 'open', 'activate: closed status back to open');
  assert(!isClosedRow(activated), 'activate: no longer reads as a closed row');
  assert(activated.address === '10 Reopened St', 'activate: field edits saved');
  assert(activated.buyerClosedAt === null, 'activate: buyer close date cleared');
  assert(activated.sellerClosedAt === null, 'activate: seller close date cleared');
  assert(activated.buyerSteps.length === stepsBefore, 'activate: steps carried over');
  assert(activated.buyerSteps.every((s) => s.done), 'activate: step state carried over');

  // --- activating a cancelled escrow lands it back in the active list ---
  const c2 = await store.createEscrow(input('20 Cancel St', d));
  const { escrow: cancelled } = await store.cancelEscrow(c2.id);
  assert(cancelled.status === 'cancelled', 'setup: escrow cancelled');
  const stepsBefore2 = cancelled.buyerSteps.length;

  const activated2 = await store.activateEscrow(c2.id, input('20 Reopened St', d));
  assert(activated2.status === 'open', 'activate: cancelled status back to open');
  assert(activated2.address === '20 Reopened St', 'activate: cancelled field edits saved');
  assert(activated2.buyerSteps.length === stepsBefore2, 'activate: cancelled steps intact');

  // --- already-open escrow refuses (use updateEscrow for that) ---
  let threw = false;
  try {
    await store.activateEscrow(c2.id, input('20 Again St', d));
  } catch {
    threw = true;
  }
  assert(threw, 'activate: already-open escrow throws');

  // --- validation mirrors updateEscrow ---
  const c3 = await store.createEscrow(input('30 Validate St', d));
  await store.cancelEscrow(c3.id);
  let threw2 = false;
  try {
    await store.activateEscrow(c3.id, {
      ...input('30 Validate St', d),
      closeDate: d.openDate,
      openDate: d.closeDate,
    });
  } catch {
    threw2 = true;
  }
  assert(threw2, 'activate: closeDate before openDate throws');

  // --- updateEscrow on an open escrow is untouched ---
  const plain = await store.updateEscrow(c2.id, input('20 Plain Update St', d));
  assert(plain.status === 'open', 'update: open escrow stays open');
  assert(plain.address === '20 Plain Update St', 'update: open escrow fields saved');

  summary('activate_escrow');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
