// update_closed_lifecycle.test.ts — Lifecycle side-effect matrix (Sept 28, 2026,
// Anuraj-approved lifecycle gate).
//
// Two operations, every field pinned:
//
//   updateEscrow on a closed/cancelled escrow (ordinary edit):
//     - NEVER reactivates: status stays closed/cancelled.
//     - address, buyer/seller name, open date, close date: editable, saved.
//     - side: locked (the sheet sends it unchanged; the store preserves it).
//     - key dates (inspection/appraisal/loan): LOCKED — the store backstop
//       throws, the stored values are preserved.
//     - status, per-side close timestamps: untouched.
//     - steps, invites, client links: untouched.
//   activateEscrow on a closed/cancelled escrow (the explicit "Reactivate
//   escrow" button in the locked Key dates section — the ONLY reactivating
//   path):
//     - status back to 'open'; per-side close timestamps cleared.
//     - address, names, open/close dates: saved from the form.
//     - key dates: preserved as stored (reactivation never writes them;
//       they become editable again because the escrow is open).
//     - steps (with state), invites, client links: carried over untouched.
//
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import type { CreateEscrowInput, UpdateEscrowInput } from '../src/lib/types';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string; kd1: string; kd2: string; kd3: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const plus = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };
  return { openDate: fmt(now), closeDate: plus(61), kd1: plus(10), kd2: plus(20), kd3: plus(30) };
}

function baseInput(address: string, d: { openDate: string; closeDate: string }): CreateEscrowInput {
  return {
    address,
    side: 'both',
    buyerName: 'Both Buyer',
    sellerName: 'Both Seller',
    openDate: d.openDate,
    closeDate: d.closeDate,
  };
}

async function main(): Promise<void> {
  const kv = memoryKV();
  const store = createStore(kv);
  const d = dates();

  // --- setup: an open escrow with key dates set, one step checked, one invite ---
  const created = await store.createEscrow(baseInput('1 Matrix St', d));
  const withDates = await store.updateEscrow(created.id, {
    ...baseInput('1 Matrix St', d),
    inspectionDeadline: d.kd1,
    appraisalDeadline: d.kd2,
    loanApprovalDate: d.kd3,
  } as UpdateEscrowInput);
  assert(withDates.inspectionDeadline === d.kd1, 'setup: key dates saved on the open escrow');
  const stepId = withDates.buyerSteps[0].id;
  for (const s of withDates.buyerSteps) {
    if (!s.done) await store.toggleStep(created.id, 'buyer', s.id);
  }
  for (const s of withDates.sellerSteps) {
    if (!s.done) await store.toggleStep(created.id, 'seller', s.id);
  }
  const invite = await store.createInvite(created.id, 'buyer', 'Buyer One');
  const invitesBefore = await store.listInvites(created.id);

  // --- close it (both sides) ---
  await store.closeEscrow(created.id, 'buyer');
  const { escrow: closed } = await store.closeEscrow(created.id, 'seller');
  assert(closed.status === 'closed', 'setup: escrow closed');
  assert(closed.buyerClosedAt != null, 'setup: buyer close timestamp stamped');

  // --- ordinary edit on the CLOSED escrow: no reactivation, fields saved ---
  const edited = await store.updateEscrow(closed.id, {
    address: '1 Matrix Edited St',
    side: 'both',
    buyerName: 'Both Buyer Edited',
    sellerName: 'Both Seller Edited',
    openDate: d.openDate,
    closeDate: d.closeDate,
  } as UpdateEscrowInput);
  assert(edited.status === 'closed', 'update/closed: status stays closed (no silent reactivation)');
  assert(edited.address === '1 Matrix Edited St', 'update/closed: address saved');
  assert(edited.buyerName === 'Both Buyer Edited', 'update/closed: buyer name saved');
  assert(edited.sellerName === 'Both Seller Edited', 'update/closed: seller name saved');
  assert(edited.side === 'both', 'update/closed: side preserved (locked)');
  assert(edited.buyerClosedAt != null, 'update/closed: per-side close timestamp untouched');
  assert(edited.inspectionDeadline === d.kd1, 'update/closed: key dates preserved');
  assert(edited.buyerSteps.find((s) => s.id === stepId)!.done, 'update/closed: step state untouched');

  // --- key-date write on the CLOSED escrow: backstop throws, nothing changes ---
  let threw = false;
  try {
    await store.updateEscrow(closed.id, {
      address: '1 Matrix Edited St',
      side: 'both',
      buyerName: 'Both Buyer Edited',
      openDate: d.openDate,
      closeDate: d.closeDate,
      inspectionDeadline: d.kd2,
    } as UpdateEscrowInput);
  } catch {
    threw = true;
  }
  assert(threw, 'update/closed: key-date write rejected by the backstop');
  const afterThrow = (await store.getEscrow(closed.id))!;
  assert(afterThrow.inspectionDeadline === d.kd1, 'update/closed: rejected write leaves key dates unchanged');
  assert(afterThrow.status === 'closed', 'update/closed: rejected write leaves status unchanged');

  // --- explicit reactivation: the ONLY path that reopens ---
  const reactivated = await store.activateEscrow(closed.id, {
    address: '1 Matrix Reactivated St',
    side: 'both',
    buyerName: 'Both Buyer Reactivated',
    openDate: d.openDate,
    closeDate: d.closeDate,
  } as UpdateEscrowInput);
  assert(reactivated.status === 'open', 'activate: status back to open');
  assert(reactivated.address === '1 Matrix Reactivated St', 'activate: address saved');
  assert(reactivated.buyerName === 'Both Buyer Reactivated', 'activate: buyer name saved');
  assert(reactivated.buyerClosedAt === null, 'activate: buyer close timestamp cleared');
  assert(reactivated.sellerClosedAt === null, 'activate: seller close timestamp cleared');
  assert(
    reactivated.inspectionDeadline === d.kd1 &&
      reactivated.appraisalDeadline === d.kd2 &&
      reactivated.loanApprovalDate === d.kd3,
    'activate: key dates preserved (reactivation never writes them)',
  );
  assert(reactivated.buyerSteps.find((s) => s.id === stepId)!.done, 'activate: step state carried over');
  const invitesAfter = await store.listInvites(closed.id);
  assert(
    invitesAfter.some((i) => i.id === invite.id) && invitesAfter.length === invitesBefore.length,
    'activate: invites carried over untouched',
  );

  // --- key dates editable again now that the escrow is open ---
  const editedOpen = await store.updateEscrow(closed.id, {
    address: '1 Matrix Reactivated St',
    side: 'both',
    buyerName: 'Both Buyer Reactivated',
    openDate: d.openDate,
    closeDate: d.closeDate,
    inspectionDeadline: d.kd3,
  } as UpdateEscrowInput);
  assert(editedOpen.inspectionDeadline === d.kd3, 'update/open: key-date edit applies after reactivation');

  // --- cancelled escrow: same matrix ---
  const c2 = await store.createEscrow(baseInput('2 Cancelled Matrix St', d));
  const { escrow: cancelled } = await store.cancelEscrow(c2.id);
  assert(cancelled.status === 'cancelled', 'setup: escrow cancelled');

  const editedCancelled = await store.updateEscrow(cancelled.id, {
    ...baseInput('2 Cancelled Matrix Edited St', d),
  } as UpdateEscrowInput);
  assert(editedCancelled.status === 'cancelled', 'update/cancelled: status stays cancelled');
  assert(editedCancelled.address === '2 Cancelled Matrix Edited St', 'update/cancelled: address saved');

  let threw2 = false;
  try {
    await store.updateEscrow(cancelled.id, {
      ...baseInput('2 Cancelled Matrix Edited St', d),
      loanApprovalDate: d.kd1,
    } as UpdateEscrowInput);
  } catch {
    threw2 = true;
  }
  assert(threw2, 'update/cancelled: key-date write rejected by the backstop');

  const reactivated2 = await store.activateEscrow(cancelled.id, {
    ...baseInput('2 Cancelled Matrix Reactivated St', d),
  } as UpdateEscrowInput);
  assert(reactivated2.status === 'open', 'activate/cancelled: status back to open');

  summary('update_closed_lifecycle');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
