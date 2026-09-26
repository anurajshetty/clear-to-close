// persistence.test.ts — REGRESSION: escrow mutations must hit storage.
// Bug (Sept 25, 2026): toggleStep/addCustomStep/reorderSteps/updateTargetDate/
// closeEscrow called persist() BEFORE replaceEscrow(), so storage received the
// PRE-mutation escrow. The UI looked right (in-memory snapshot was replaced)
// until the next load, when progress silently reset to 0.
// These tests fail on the old ordering and pass on the fixed one.
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

  // Session 1: create an escrow and check off a step.
  const s1 = createStore(kv);
  const escrow = await s1.createEscrow({
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'buy',
    buyerName: 'Test Buyer',
    openDate,
    closeDate,
  });
  const stepId = escrow.buyerSteps[0].id;
  await s1.toggleStep(escrow.id, 'buyer', stepId);

  // Simulate an app reload: a brand-new store over the SAME storage.
  const s2 = createStore(kv);
  const reloaded = await s2.getEscrow(escrow.id);
  assert(reloaded !== null, 'escrow reloads from storage');
  const reloadedStep = reloaded!.buyerSteps.find((s) => s.id === stepId);
  assert(reloadedStep !== undefined, 'step id survives reload');
  assert(reloadedStep!.done === true, 'REGRESSION: checked-off step persists across reload');
  assert(
    typeof reloadedStep!.completedAt === 'string' && reloadedStep!.completedAt.length > 0,
    'completedAt timestamp persists across reload',
  );

  // Progress survives too: 1 of 13.
  const view = await s2.getBuyerView(escrow.id);
  assert(view.done === 1, 'REGRESSION: progress count (1) survives reload');
  assert(view.total === 13, 'progress total (13) survives reload');

  // Un-checking persists as well.
  await s2.toggleStep(escrow.id, 'buyer', stepId);
  const s3 = createStore(kv);
  const again = await s3.getEscrow(escrow.id);
  assert(
    again!.buyerSteps.find((s) => s.id === stepId)!.done === false,
    'REGRESSION: un-check persists across reload',
  );
  assert((await s3.getBuyerView(escrow.id)).done === 0, 'progress resets to 0 after un-check');

  // A custom step added by the realtor is visible after reload.
  await s3.addCustomStep(escrow.id, 'buyer', 'Termite inspection report');
  const s4 = createStore(kv);
  const withCustom = await s4.getEscrow(escrow.id);
  assert(
    withCustom!.buyerSteps.some((s) => s.custom && s.title === 'Termite inspection report'),
    'REGRESSION: added custom step persists across reload',
  );
  assert((await s4.getBuyerView(escrow.id)).total === 14, 'progress total recalculates to 14');

  summary('persistence');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
