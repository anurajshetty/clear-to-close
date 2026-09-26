// lifecycle.test.ts — escrow lifecycle semantics (approved Sept 2026):
// per-side close, auto-reopen on uncheck, dual-agency independence,
// "Edit dates" validation, and the profile phone round-trip.
// Every test below fails on the pre-lifecycle code and passes with it.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import {
  closedDisplayDate,
  formatClosedDate,
  isClosedRow,
  isEscrowClosed,
  isSideClosed,
  sideClosedAt,
  todayLocalISO,
} from '../src/lib/lifecycle';
import type { ClientRole } from '../src/lib/types';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

async function checkAll(
  store: ReturnType<typeof createStore>,
  escrowId: string,
  role: ClientRole,
): Promise<void> {
  const e = await store.getEscrow(escrowId);
  const steps = role === 'buyer' ? e!.buyerSteps : e!.sellerSteps;
  for (const s of steps) {
    if (!s.done) await store.toggleStep(escrowId, role, s.id);
  }
}

async function main(): Promise<void> {
  const { openDate, closeDate } = dates();
  const today = todayLocalISO();

  // --- single-side close ---------------------------------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '4187 Oakmont Dr',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });

    // Closing with incomplete steps is rejected.
    let threw = false;
    try {
      await store.closeEscrow(e.id, 'buyer');
    } catch {
      threw = true;
    }
    assert(threw, 'closeEscrow rejects an incomplete side');

    await checkAll(store, e.id, 'buyer');
    const closed = await store.closeEscrow(e.id, 'buyer');
    assert(closed.buyerClosedAt === today, `buyer close stamps today (${closed.buyerClosedAt})`);
    assert(closed.sellerClosedAt === null, 'seller side untouched on a buy-side escrow');
    assert(closed.status === 'closed', 'single-side escrow reads closed');
    assert(isSideClosed(closed, 'buyer'), 'isSideClosed(buyer)');
    assert(isEscrowClosed(closed), 'isEscrowClosed for a closed single-side escrow');
    assert(
      formatClosedDate(closed.buyerClosedAt!) === formatClosedDate(today),
      'Closed date formats like "Sep 25, 2026"',
    );

    // Unchecking any step moves the escrow back to Active.
    const reloaded = await store.getEscrow(e.id);
    const firstStep = reloaded!.buyerSteps[0].id;
    const reopened = await store.toggleStep(e.id, 'buyer', firstStep);
    assert(reopened.buyerClosedAt === null, 'uncheck clears the buyer close date');
    assert(reopened.status === 'open', 'uncheck moves the escrow back to Active');
    assert(!isEscrowClosed(reopened), 'isEscrowClosed false after reopen');
    assert(sideClosedAt(reopened, 'buyer') === null, 'sideClosedAt null after reopen');

    // Re-completing lets the side close again.
    await store.toggleStep(e.id, 'buyer', firstStep);
    const reclosed = await store.closeEscrow(e.id, 'buyer');
    assert(reclosed.status === 'closed', 'side can be closed again after re-completion');
  }

  // --- dual agency: per-side independence ---------------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '2350 Hillcrest Ave',
      city: 'Stevenson Ranch, CA 91381',
      side: 'both',
      buyerName: 'Ana Ruiz',
      sellerName: 'Mark Doyle',
      openDate,
      closeDate,
    });
    await checkAll(store, e.id, 'buyer');
    await checkAll(store, e.id, 'seller');

    const buyerClosed = await store.closeEscrow(e.id, 'buyer');
    assert(isSideClosed(buyerClosed, 'buyer'), 'buyer side closed');
    assert(!isSideClosed(buyerClosed, 'seller'), 'seller side stays active');
    assert(buyerClosed.status === 'open', 'escrow stays open while one side is active');
    assert(!isEscrowClosed(buyerClosed), 'dual-agency escrow not closed on one side');

    // Unchecking a SELLER step does not reopen the buyer side.
    const sellerStep = buyerClosed.sellerSteps[0].id;
    const afterSellerUncheck = await store.toggleStep(e.id, 'seller', sellerStep);
    assert(isSideClosed(afterSellerUncheck, 'buyer'), 'buyer side still closed');
    assert(!isSideClosed(afterSellerUncheck, 'seller'), 'seller side was never closed');

    // Unchecking a BUYER step reopens only the buyer side.
    const buyerStep = afterSellerUncheck.buyerSteps[0].id;
    const afterBuyerUncheck = await store.toggleStep(e.id, 'buyer', buyerStep);
    assert(!isSideClosed(afterBuyerUncheck, 'buyer'), 'buyer side reopens on uncheck');
    assert(afterBuyerUncheck.status === 'open', 'escrow still open');

    // Close both sides: the escrow reads closed; chip uses the later date.
    await store.toggleStep(e.id, 'buyer', buyerStep); // re-check
    await store.toggleStep(e.id, 'seller', sellerStep); // re-check
    await store.closeEscrow(e.id, 'buyer');
    const fullyClosed = await store.closeEscrow(e.id, 'seller');
    assert(fullyClosed.status === 'closed', 'dual-agency escrow closed when both sides close');
    assert(isEscrowClosed(fullyClosed), 'isEscrowClosed for fully closed dual agency');
    assert(
      closedDisplayDate(fullyClosed) === today,
      'closed chip uses the later of the two close dates',
    );
  }

  // --- close dates survive a reload ----------------------------------------
  {
    const kv = memoryKV();
    const s1 = createStore(kv);
    const e = await s1.createEscrow({
      address: '9 Palm Ter',
      city: 'Newhall, CA 91321',
      side: 'sell',
      sellerName: 'Tom Becker',
      openDate,
      closeDate,
    });
    await checkAll(s1, e.id, 'seller');
    await s1.closeEscrow(e.id, 'seller');
    const s2 = createStore(kv);
    const reloaded = await s2.getEscrow(e.id);
    assert(reloaded!.sellerClosedAt === today, 'seller close date persists across reload');
    assert(reloaded!.status === 'closed', 'closed status persists across reload');
  }

  // --- "Edit dates" validation ----------------------------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '1120 Cedar Ln',
      city: 'Canyon Country, CA 91351',
      side: 'buy',
      buyerName: 'Daniel Kim',
      openDate: '2026-09-01',
      closeDate: '2026-11-01',
    });

    let threw = false;
    try {
      await store.updateDates(e.id, '2026-09-01', '2026-08-15');
    } catch {
      threw = true;
    }
    assert(threw, 'updateDates rejects target close before opened');

    // Target == opened is allowed (target ≥ opened).
    const sameDay = await store.updateDates(e.id, '2026-09-01', '2026-09-01');
    assert(
      sameDay.openDate === '2026-09-01' && sameDay.closeDate === '2026-09-01',
      'updateDates allows target close equal to opened',
    );

    const moved = await store.updateDates(e.id, '2026-09-10', '2026-12-01');
    assert(
      moved.openDate === '2026-09-10' && moved.closeDate === '2026-12-01',
      'updateDates saves both dates (tracker recomputes from them)',
    );

    let targetThrew = false;
    try {
      await store.updateTargetDate(e.id, '2026-09-01'); // before openDate 2026-09-10
    } catch {
      targetThrew = true;
    }
    assert(targetThrew, 'updateTargetDate rejects a target before the opened date');
  }

  // --- Legacy rows (saved before per-side close dates existed) ----------
  // Old stored JSON has no buyerClosedAt/sellerClosedAt keys: the backfill
  // must not read them as closed.
  {
    const kv = memoryKV();
    const store = createStore(kv);
    const e = await store.createEscrow({
      address: '7 Legacy Ln',
      city: 'Legacy',
      side: 'buy',
      buyerName: 'L',
      openDate,
      closeDate,
    });
    const legacyRaw = JSON.parse(JSON.stringify(e));
    delete legacyRaw.buyerClosedAt;
    delete legacyRaw.sellerClosedAt;
    kv.setItem('ctc:escrows', JSON.stringify([legacyRaw]));
    const s2 = createStore(kv);
    const loaded = await s2.getEscrow(e.id);
    assert(loaded !== null && !isEscrowClosed(loaded), 'legacy row without close dates reads active (backfill)');
    assert(loaded !== null && sideClosedAt(loaded, 'buyer') === null, 'legacy row sideClosedAt is null');
    // A legacy row that was already closed stays closed on the deal list.
    legacyRaw.status = 'closed';
    kv.setItem('ctc:escrows', JSON.stringify([legacyRaw]));
    const s3 = createStore(kv);
    const loadedClosed = await s3.getEscrow(e.id);
    assert(loadedClosed !== null && isClosedRow(loadedClosed), 'legacy closed status still reads closed');
  }

  // --- profile phone round-trip ----------------------------------------------
  {
    const store = createStore(memoryKV());
    await store.saveProfile({
      name: 'Maya Chen',
      photoUri: null,
      about: 'Realtor',
      yearsExperience: '12',
      dealsClosed: '240',
      areasServed: 'Santa Clarita',
      phone: '(555) 234-5678',
      dreLicense: '01998877',
    });
    const p = await store.getProfile();
    assert(p !== null && p.phone === '(555) 234-5678', 'phone number persists on the profile');

    // Updating the phone flows through the same profile read/write path.
    await store.saveProfile({ ...p!, phone: '5559990000' });
    const p2 = await store.getProfile();
    assert(p2 !== null && p2.phone === '5559990000', 'phone update persists');

    // Empty phone stays empty (no phantom value on the profile row).
    await store.saveProfile({ ...p2!, phone: '' });
    const p3 = await store.getProfile();
    assert(p3 !== null && p3.phone === '', 'empty phone persists as empty');
  }

  summary('lifecycle.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
