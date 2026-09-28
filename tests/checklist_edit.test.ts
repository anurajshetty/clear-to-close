// checklist_edit.test.ts — checklist edit mode contract (Sept 2026).
//
// The tick saves the whole draft with ONE atomic write: removals,
// additions, and the draft's order apply together for one role. Lifecycle:
// a side stays closed only when every remaining step is complete; any
// unchecked step reopens that side (the same as unchecking today). The
// other side is untouched. Structural edits never stamp lastAction (no
// LATEST FROM entry, no client push).
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import type { ChecklistDraftStep } from '../src/lib/types';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

function toDraft(s: {
  id: string;
  title: string;
  subtitle: string;
  done: boolean;
  custom: boolean;
  completedAt: string | null;
}): ChecklistDraftStep {
  return {
    id: s.id,
    title: s.title,
    subtitle: s.subtitle,
    done: s.done,
    custom: s.custom,
    completedAt: s.completedAt,
  };
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
  const buyerTotal = escrow.buyerSteps.length;
  assert(buyerTotal > 3, `test escrow has several buyer steps (got ${buyerTotal})`);

  // 1. One atomic write: remove one step, add one custom step, reorder the
  // rest. The draft order becomes the new order (0..n); the removed row is
  // gone from the saved list (and, on the synced store, from the server).
  const removedId = escrow.buyerSteps[1].id;
  const kept = escrow.buyerSteps.filter((s) => s.id !== removedId);
  const reordered = [kept[2], kept[0], kept[1], ...kept.slice(3)];
  const draft: ChecklistDraftStep[] = [
    ...reordered.map(toDraft),
    { id: 'draft-new-1', title: 'Termite inspection', subtitle: '', done: false, custom: true, completedAt: null },
  ];
  const saved = await store.applyChecklistEdits(escrow.id, 'buyer', draft);
  assert(
    saved.buyerSteps.length === buyerTotal,
    `save keeps the count (removed 1, added 1): ${saved.buyerSteps.length} of ${buyerTotal}`,
  );
  assert(
    saved.buyerSteps.map((s) => s.title).join('|') ===
      [...reordered.map((s) => s.title), 'Termite inspection'].join('|'),
    'saved order follows the draft order with the new step appended',
  );
  assert(
    saved.buyerSteps.every((s, i) => s.order === i),
    'order is normalized 0..n',
  );
  const goneIds = escrow.buyerSteps
    .map((s) => s.id)
    .filter((id) => !saved.buyerSteps.some((s) => s.id === id));
  assert(
    goneIds.length === 1 && goneIds[0] === removedId,
    'exactly the removed step is gone from the saved list',
  );
  const added = saved.buyerSteps.find((s) => s.id === 'draft-new-1');
  assert(!!added && added.custom === true, 'added step keeps its client id and is custom');
  assert(
    !saved.buyerSteps.some((s) => s.id === removedId),
    'removed step is gone from the saved list',
  );

  // 2. The client view follows the save: new order, removed gone, counts
  // recomputed (13 -> 12 style: total drops when a step is removed).
  const removedOnly = await store.applyChecklistEdits(
    escrow.id,
    'buyer',
    saved.buyerSteps.filter((s) => s.id !== 'draft-new-1').map(toDraft),
  );
  assert(
    removedOnly.buyerSteps.length === buyerTotal - 1,
    `total drops by one after a pure removal (${removedOnly.buyerSteps.length})`,
  );
  const view = await store.getBuyerView(escrow.id);
  assert(view.total === buyerTotal - 1, 'client view total recomputes after removal');
  assert(
    !view.steps.some((s) => s.title === 'Termite inspection'),
    'client view no longer shows the removed custom step',
  );

  // 3. Closed side stays closed when a checked step is removed and the rest
  // are all complete.
  const kv2 = memoryKV();
  const store2 = createStore(kv2);
  const e2 = await store2.createEscrow({
    address: '9 Closed Ct',
    city: 'Valencia, CA 91355',
    side: 'both',
    buyerName: 'B Buyer',
    sellerName: 'S Seller',
    openDate,
    closeDate,
  });
  for (const s of e2.buyerSteps) await store2.toggleStep(e2.id, 'buyer', s.id);
  await store2.closeEscrow(e2.id, 'buyer');
  const closedBefore = await store2.getEscrow(e2.id);
  assert(closedBefore?.buyerClosedAt !== null, 'buyer side is closed before the edit');
  // Build the draft from the CURRENT steps (all done) — the createEscrow
  // return value is stale after the toggles above.
  const doneSteps = closedBefore?.buyerSteps ?? [];
  const dropChecked = doneSteps[doneSteps.length - 1].id;
  const closedSave = await store2.applyChecklistEdits(
    e2.id,
    'buyer',
    doneSteps.filter((s) => s.id !== dropChecked).map(toDraft),
  );
  assert(
    closedSave.buyerClosedAt === closedBefore?.buyerClosedAt,
    'removing a checked step keeps the closed side closed when the rest are complete',
  );
  assert(
    closedSave.buyerSteps.length === e2.buyerSteps.length - 1,
    'the checked step is removed from the closed side',
  );

  // 4. Adding an unchecked step reopens the side — the same as unchecking
  // today. The other side is untouched.
  const reopened = await store2.applyChecklistEdits(e2.id, 'buyer', [
    ...closedSave.buyerSteps.map(toDraft),
    { id: 'draft-new-2', title: 'Final walkthrough', subtitle: '', done: false, custom: true, completedAt: null },
  ]);
  assert(reopened.buyerClosedAt === null, 'adding an unchecked step reopens the side');
  assert(reopened.status === 'open', 'escrow status flips back to open');
  assert(
    reopened.sellerClosedAt === null && reopened.sellerSteps.length === e2.sellerSteps.length,
    'the seller side is untouched by the buyer edit',
  );

  // 5. Leaving an unchecked step in the draft also reopens (draft uncheck).
  const kv3 = memoryKV();
  const store3 = createStore(kv3);
  const e3 = await store3.createEscrow({
    address: '7 Uncheck Ln',
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'B Buyer',
    openDate,
    closeDate,
  });
  for (const s of e3.buyerSteps) await store3.toggleStep(e3.id, 'buyer', s.id);
  await store3.closeEscrow(e3.id, 'buyer');
  const e3done = await store3.getEscrow(e3.id);
  const draftUncheck = (e3done?.buyerSteps ?? []).map(toDraft);
  draftUncheck[0] = { ...draftUncheck[0], done: false, completedAt: null };
  const uncheckSave = await store3.applyChecklistEdits(e3.id, 'buyer', draftUncheck);
  assert(uncheckSave.buyerClosedAt === null, 'an unchecked step left in the draft reopens the side');
  assert(
    uncheckSave.buyerSteps[0].done === false && uncheckSave.buyerSteps[0].completedAt === null,
    'the unchecked draft step clears done and completedAt',
  );

  // 6. Structural edits never stamp lastAction: no LATEST FROM entry and no
  // client push trigger from an edit. The save must leave whatever
  // lastAction the last real check/uncheck stamped completely untouched.
  const actionBefore = JSON.stringify(reopened.lastAction);
  const noOpSave = await store2.applyChecklistEdits(
    e2.id,
    'buyer',
    reopened.buyerSteps.map(toDraft),
  );
  assert(
    JSON.stringify(noOpSave.lastAction) === actionBefore,
    'structural edits leave lastAction untouched',
  );
  const toggleAction = await store3.toggleStep(e3.id, 'buyer', e3.buyerSteps[1].id);
  assert(toggleAction.lastAction !== null, 'sanity: a real toggle still stamps lastAction');

  // 7. Dual-agency independence: a seller edit never touches buyer steps or
  // the buyer close date.
  const sellerDraft = e2.sellerSteps.map(toDraft);
  const sellerSave = await store2.applyChecklistEdits(e2.id, 'seller', [
    ...sellerDraft,
    { id: 'draft-new-3', title: 'Seller disclosure', subtitle: '', done: false, custom: true, completedAt: null },
  ]);
  assert(
    sellerSave.buyerSteps.length === reopened.buyerSteps.length,
    'a seller edit leaves the buyer list alone',
  );
  assert(
    sellerSave.buyerClosedAt === null,
    'a seller edit leaves the buyer close date alone',
  );

  // 8. Validation: duplicate ids and empty titles throw, and the failed
  // save leaves the local list untouched.
  const before = await store.getEscrow(escrow.id);
  const beforeTitles = before?.buyerSteps.map((s) => s.title).join('|');
  let threw = 0;
  try {
    const dupe = removedOnly.buyerSteps.map(toDraft);
    await store.applyChecklistEdits(escrow.id, 'buyer', [...dupe, { ...dupe[0] }]);
  } catch {
    threw++;
  }
  try {
    const empty = removedOnly.buyerSteps.map(toDraft);
    empty[0] = { ...empty[0], title: '   ' };
    await store.applyChecklistEdits(escrow.id, 'buyer', empty);
  } catch {
    threw++;
  }
  assert(threw === 2, 'duplicate ids and empty titles both throw');
  const after = await store.getEscrow(escrow.id);
  assert(
    after?.buyerSteps.map((s) => s.title).join('|') === beforeTitles,
    'a failed save leaves the local list untouched',
  );

  // 9. completedAt is preserved for steps that stay done; clearing done
  // clears completedAt.
  const kv4 = memoryKV();
  const store4 = createStore(kv4);
  const e4 = await store4.createEscrow({
    address: '3 Keep Ts',
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'B Buyer',
    openDate,
    closeDate,
  });
  await store4.toggleStep(e4.id, 'buyer', e4.buyerSteps[0].id);
  const withDone = await store4.getEscrow(e4.id);
  const doneAt = withDone?.buyerSteps[0].completedAt;
  assert(!!doneAt, 'sanity: toggling stamps completedAt');
  const keepDone = await store4.applyChecklistEdits(
    e4.id,
    'buyer',
    withDone!.buyerSteps.map(toDraft),
  );
  assert(
    keepDone.buyerSteps[0].completedAt === doneAt,
    'a step that stays done keeps its completedAt across a structural edit',
  );

  // 10. Removing every step reopens the side (an empty list is not "all
  // complete" for lifecycle purposes).
  const emptySave = await store4.applyChecklistEdits(e4.id, 'buyer', []);
  assert(emptySave.buyerSteps.length === 0, 'all steps can be removed');
  const emptiedIds = e4.buyerSteps
    .map((s) => s.id)
    .filter((id) => !emptySave.buyerSteps.some((s) => s.id === id));
  assert(emptiedIds.length === e4.buyerSteps.length, 'every id is gone after removing all steps');
  assert(emptySave.status === 'open', 'emptying the list leaves the escrow open, not closed');

  summary('checklist_edit');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
