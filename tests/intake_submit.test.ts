// intake_submit.test.ts — Intake Submit action (Anuraj's decision,
// Nov 13, 2026: "Add Submit, keep editing open after submit").
//
// The app-side writer for migration 0051's submitted_at marker:
//  - Submit (both intake forms) saves the current form through the
//    normal confirmed write path, then stamps submitted_at exactly
//    once via a targeted UPDATE guarded on the marker still being
//    null; the 0051 producer fires on that null -> non-null
//    transition and notifies the escrow owner (members only).
//  - SAVE NEVER TOUCHES submitted_at in either direction: the save
//    upsert payload carries no submitted_at key (so a post-submit
//    edit cannot clear or move the marker), and the local row's
//    marker survives saves byte-identical.
//  - After submission the form stays fully editable; the Submit
//    action is replaced by a static "Submitted" state (no re-submit,
//    no un-submit in v1). Submitting again is a no-op that returns
//    the original stamp.
//  - The pull path converges the marker into the local cache so any
//    device sees the Submitted state.
//
// No UI is rendered here (Anuraj's standing rule: unit tests only);
// the screens are pinned by source.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { createSyncedStore } from '../src/lib/syncedStore';
import { submitTcIntakeNow, submitBuyerIntakeNow } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer } from './mock_server';
import { emptyTcIntake, type TcIntakeData } from '../src/lib/tcIntake';
import { emptyBuyerIntake, type BuyerIntakeData } from '../src/lib/buyerIntake';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function tcFilled(): TcIntakeData {
  return { ...emptyTcIntake(), ownerOccupied: 'yes', trustName: 'Sharma Family Trust' };
}
function buyerFilled(): BuyerIntakeData {
  const d = emptyBuyerIntake();
  d.buyers = [{ name: 'Pat Buyer', phone: '', email: '' }];
  return d;
}

async function main(): Promise<void> {
  // ------------------------------------------- TC intake: full cycle ---
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });

    // Save alone never submits: the server row carries no marker and
    // the local row reads unsubmitted.
    await store.saveTcIntake('e1', tcFilled());
    const afterSave = server.intakeRow('tc_intakes', 'e1');
    assert(!!afterSave, 'TC save lands a server row');
    assert(afterSave!.submitted_at == null, 'save does not set submitted_at');
    assert((await store.getTcIntake('e1'))?.submittedAt == null, 'local row unsubmitted after save');

    // Submit stamps exactly once.
    const submitted = await store.submitTcIntake('e1', tcFilled());
    const stamp = submitted.submittedAt;
    assert(typeof stamp === 'string' && stamp.length > 0, 'submit returns the stamped row');
    assert(server.intakeRow('tc_intakes', 'e1')!.submitted_at === stamp, 'server row carries the stamp');
    assert((await store.getTcIntake('e1'))?.submittedAt === stamp, 'local row carries the stamp');

    // Post-submit edit: Save still works, the marker does not move,
    // and no save payload ever carried the marker key.
    const edited = { ...tcFilled(), trustName: 'Edited Trust' };
    await store.saveTcIntake('e1', edited);
    assert(server.intakeRow('tc_intakes', 'e1')!.submitted_at === stamp, 'post-submit save keeps the server stamp');
    assert((await store.getTcIntake('e1'))?.submittedAt === stamp, 'post-submit save keeps the local stamp');
    assert(
      server.upsertLog
        .filter((u) => u.table === 'tc_intakes')
        .every((u) => !(u.rows as Record<string, unknown>[]).some((r) => 'submitted_at' in r)),
      'no tc_intakes save payload ever contains submitted_at',
    );

    // Submitting again is a no-op returning the original stamp.
    const again = await store.submitTcIntake('e1', edited);
    assert(again.submittedAt === stamp, 'second submit returns the original stamp');
    assert(server.intakeRow('tc_intakes', 'e1')!.submitted_at === stamp, 'second submit does not move the server stamp');
  }

  // --------------------------------- TC intake: submit on a fresh row ---
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    const row = await store.submitTcIntake('e2', tcFilled());
    assert(typeof row.submittedAt === 'string', 'submit on a never-saved intake stamps it');
    const serverRow = server.intakeRow('tc_intakes', 'e2');
    assert(!!serverRow && serverRow.submitted_at === row.submittedAt, 'server row created and stamped in one submit');
    assert((serverRow!.data as TcIntakeData).trustName === 'Sharma Family Trust', 'submit saves the current form contents');
  }

  // --------------------------------------- stamp writer (cloudSync) ----
  {
    const server = createMockServer();
    const client = mockCloudFromServer(server)();
    // No row at all: the stamp cannot land and must fail loud.
    let threw = false;
    try {
      await submitTcIntakeNow(client, 'nope');
    } catch {
      threw = true;
    }
    assert(threw, 'stamp on a missing intake row throws');

    const { store } = createSyncedStore(memoryKV(), { cloudClient: mockCloudFromServer(server) });
    await store.saveTcIntake('e3', tcFilled());
    const t1 = await submitTcIntakeNow(client, 'e3');
    const t2 = await submitTcIntakeNow(client, 'e3');
    assert(t1 === t2, 'stamp writer is idempotent: second call returns the first stamp');
    assert(server.intakeRow('tc_intakes', 'e3')!.submitted_at === t1, 'server stamp written once');
    const b1 = await submitBuyerIntakeNow(client, 'e3').catch(() => null);
    assert(b1 === null, 'buyer stamp on a missing buyer row throws');
  }

  // ---------------------------------------- buyer intake: full cycle ----
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    await store.saveBuyerIntake('e4', buyerFilled());
    assert(server.intakeRow('buyer_intakes', 'e4')!.submitted_at == null, 'buyer save does not set submitted_at');
    const submitted = await store.submitBuyerIntake('e4', buyerFilled());
    const stamp = submitted.submittedAt;
    assert(typeof stamp === 'string' && !!stamp, 'buyer submit stamps the row');
    const edited = buyerFilled();
    edited.buyers = [{ name: 'Edited Buyer', phone: '', email: '' }];
    await store.saveBuyerIntake('e4', edited);
    assert(server.intakeRow('buyer_intakes', 'e4')!.submitted_at === stamp, 'buyer post-submit save keeps the stamp');
    assert((await store.getBuyerIntake('e4'))?.submittedAt === stamp, 'buyer local row keeps the stamp');
    assert(
      server.upsertLog
        .filter((u) => u.table === 'buyer_intakes')
        .every((u) => !(u.rows as Record<string, unknown>[]).some((r) => 'submitted_at' in r)),
      'no buyer_intakes save payload ever contains submitted_at',
    );
  }

  // --------------------------------------------- pull convergence -------
  {
    const server = createMockServer();
    const writer = createSyncedStore(memoryKV(), { cloudClient: mockCloudFromServer(server) });
    const stamped = await writer.store.submitTcIntake('e5', tcFilled());

    const reader = createSyncedStore(memoryKV(), { cloudClient: mockCloudFromServer(server) });
    await reader.store.refreshTcIntake('e5');
    const pulled = await reader.store.getTcIntake('e5');
    assert(pulled?.submittedAt === stamped.submittedAt, 'refresh converges submittedAt into a fresh cache');
    assert(pulled?.data.trustName === 'Sharma Family Trust', 'refresh still converges the form data');
  }

  // --------------------------------------------- local store contract ---
  {
    const kv = memoryKV();
    const local = createStore(kv);
    await local.setTcIntakeCache({
      escrowId: 'e6',
      data: tcFilled(),
      updatedAt: 'x',
      submittedAt: '2026-11-13T10:00:00.000Z',
    });
    // A local save preserves the marker (never sets, never clears).
    const saved = await local.saveTcIntake('e6', { ...tcFilled(), trustName: 'Local Edit' });
    assert(saved.submittedAt === '2026-11-13T10:00:00.000Z', 'local save preserves submittedAt');
    // Persistence round-trip keeps it; a legacy row without the field
    // parses as unsubmitted.
    const reloaded = createStore(kv);
    assert(
      (await reloaded.getTcIntake('e6'))?.submittedAt === '2026-11-13T10:00:00.000Z',
      'submittedAt survives a store reload',
    );
    await reloaded.setBuyerIntakeCache({ escrowId: 'e7', data: buyerFilled(), updatedAt: 'x' });
    assert((await reloaded.getBuyerIntake('e7'))?.submittedAt == null, 'row without the field reads unsubmitted');
  }

  // --------------------------------------------------- screen pins ------
  {
    const tc = read('app/tc-intake/[escrowId].tsx');
    assert(tc.includes('store.submitTcIntake'), 'TC screen submits through the store');
    assert(tc.includes('testID="tc-intake-submit"'), 'TC screen has the submit action slot');
    assert(tc.includes('testID="tc-intake-submitted"'), 'TC screen has the submitted state slot');
    assert(tc.includes('Submit intake'), 'TC submit action copy');
    assert(tc.includes('Submitted'), 'TC submitted state copy');

    const buyer = read('app/buyer-intake/[escrowId].tsx');
    assert(buyer.includes('store.submitBuyerIntake'), 'buyer screen submits through the store');
    assert(buyer.includes('testID="buyer-intake-submit"'), 'buyer screen has the submit action slot');
    assert(buyer.includes('testID="buyer-intake-submitted"'), 'buyer screen has the submitted state slot');
    assert(buyer.includes('Submit intake'), 'buyer submit action copy');
    assert(buyer.includes('Submitted'), 'buyer submitted state copy');
  }

  summary('intake_submit');
}

main().catch((err) => {
  console.error('FATAL -', err);
  process.exitCode = 1;
});
