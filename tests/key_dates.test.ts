// key_dates.test.ts — REGRESSION: key dates card + step explainers +
// per-step completed dates (Sept 28, 2026, Anuraj-approved).
//
// Rules pinned here:
//   1. describeKeyDate: "today"/"tomorrow"/"in N days"/"overdue by N days";
//      amber (soon) when within 7 days including today, red when overdue,
//      muted otherwise; date label "Oct 30" (no year).
//   2. formatCompletedDate: "Completed Sep 18, 2026" — year ALWAYS shown.
//   3. Every default buyer/seller template KEY ships a one-line explainer
//      (14 buyer + 12 seller); 'escrow-open' and 'close-escrow' differ per
//      role. Resolution is key-based and fail-closed: a renamed default
//      step still resolves, an unknown/missing key never expands, and a
//      custom step titled identically to a default step NEVER shows the
//      default explainer. No fabricated copy, no title-based lookup.
//   1b. mostUrgentKeyDate: the entry-point hint — most overdue first, then
//      nearest upcoming; null when no dates are set; invalid dates skipped.
//      Hint copy is "label · relative" with no em/en dashes.
//   3b. One-time upgrade backfill: steps built before template keys
//      (custom:false, no key) recover their key by title match; custom
//      steps never receive one.
//   4. updateEscrow with key dates is a synchronous confirmed write:
//      server row carries the columns, local commits only after confirm;
//      failure throws the plain copy and leaves local state unchanged.
//   5. Key dates default null on create; editable ONLY on open escrows —
//      closed/cancelled escrows are locked (store backstop rejects any
//      key-date write, the sheet shows a locked section with a
//      "Reactivate escrow" button); per-side views share them.
//   6. addCustomStep stores the optional explainer (max 140 chars); blank
//      stays null; custom steps always carry templateKey null. toStepRows
//      ships the explainer key only when a note exists, and the template_key
//      only when set (pre-migration safe for keyless steps).
//   7. RPC/client-view mapping carries the three dates, step explainers,
//      and template keys; pre-0019/0020 payloads (absent keys) map to null
//      (empty state / no expand), with title backfill for pre-key default
//      steps on the realtor's upgrade path.
//   8. Checklist draft save (applyChecklistEdits) preserves templateKey
//      across a default-step rename and commits the custom-step explainer
//      in the same confirmed write.
import { assert, summary } from './assert';
import {
  describeKeyDate,
  formatCompletedDate,
  formatShortDate,
  mostUrgentKeyDate,
  todayLocal,
} from '../src/lib/keyDates';
import { stepExplainer, explainerCoverage } from '../src/lib/stepExplainers';
import { BUY_STEPS, SELL_STEPS, backfillTemplateKey, isKnownTemplateKey, normalizeStepTitle } from '../src/lib/steps';
import {
  toEscrowRow,
  fromEscrowRow,
  toStepRows,
  fromStepRow,
  mapClientViewRpc,
} from '../src/lib/cloudSync';
import { createSyncedStore } from '../src/lib/syncedStore';
import { createMockServer, mockCloudFromServer, type MockServer } from './mock_server';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function trackingKV() {
  const map = new Map<string, string>();
  return {
    async getItem(k: string): Promise<string | null> {
      return map.has(k) ? map.get(k)! : null;
    },
    async setItem(k: string, v: string): Promise<void> {
      map.set(k, v);
    },
    async removeItem(k: string): Promise<void> {
      map.delete(k);
    },
  };
}

interface Faults {
  failUpsert?: unknown;
  failUpsertTables?: string[];
  pendingGates: (() => void)[];
}

function faultCloud(server: MockServer, faults: Faults): () => unknown {
  const baseFactory = mockCloudFromServer(server) as () => any;
  return () => {
    const c = baseFactory();
    const origFrom = c.from;
    c.from = (table: string) => {
      const q = origFrom(table);
      const origUpsert = q.upsert;
      q.upsert = (rows: unknown, opts?: unknown) => {
        if (
          faults.failUpsert !== undefined &&
          (!faults.failUpsertTables || faults.failUpsertTables.includes(table))
        ) {
          const e = faults.failUpsert;
          faults.failUpsert = undefined;
          throw e;
        }
        return origUpsert(rows, opts);
      };
      return q;
    };
    return c;
  };
}

async function setup(faults: Faults = { pendingGates: [] }) {
  faults.pendingGates = [];
  const server = createMockServer();
  const kv = trackingKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: faultCloud(server, faults) as never,
    writeTimeoutMs: 400,
    writeTimeoutLongMs: 800,
    redeemTimeoutMs: 2000,
  });
  const ping = await initCloudSync();
  assert(ping.ok, 'initCloudSync healthy');
  return { server, kv, store, faults };
}

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

const shift = (base: string, days: number): string => {
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

function serverEscrowRow(server: MockServer, escrowId: string): Record<string, unknown> | undefined {
  const hits = server.upsertLog.filter((u) => u.table === 'escrows');
  for (let i = hits.length - 1; i >= 0; i--) {
    const rows = hits[i].rows as Record<string, unknown>[];
    const row = rows.find((r) => r.id === escrowId);
    if (row) return row;
  }
  return undefined;
}

async function main() {
  const TODAY = '2026-09-28';

  // --- 1. Relative-date rules -------------------------------------------
  {
    assert(formatShortDate('2026-10-30') === 'Oct 30', 'short date formats "Oct 30"');
    const t0 = describeKeyDate(TODAY, TODAY);
    assert(t0.when === 'today' && t0.tone === 'soon', 'today -> "today", amber');
    const t1 = describeKeyDate(shift(TODAY, 1), TODAY);
    assert(t1.when === 'tomorrow' && t1.tone === 'soon', 'next day -> "tomorrow", amber');
    const t5 = describeKeyDate(shift(TODAY, 5), TODAY);
    assert(t5.when === 'in 5 days' && t5.tone === 'soon', '5 days out -> "in 5 days", amber');
    const t7 = describeKeyDate(shift(TODAY, 7), TODAY);
    assert(t7.when === 'in 7 days' && t7.tone === 'soon', '7 days out -> still amber (<=7 rule)');
    const t8 = describeKeyDate(shift(TODAY, 8), TODAY);
    assert(t8.when === 'in 8 days' && t8.tone === 'muted', '8 days out -> muted');
    const t32 = describeKeyDate(shift(TODAY, 32), TODAY);
    assert(t32.when === 'in 32 days' && t32.tone === 'muted', '32 days out -> muted');
    const o1 = describeKeyDate(shift(TODAY, -1), TODAY);
    assert(o1.when === 'overdue by 1 day' && o1.tone === 'over', '1 day overdue -> singular, red');
    const o4 = describeKeyDate(shift(TODAY, -4), TODAY);
    assert(o4.when === 'overdue by 4 days' && o4.tone === 'over', '4 days overdue -> plural, red');
    assert(!/—|–/.test(t5.when + o4.when), 'no em/en dashes in relative lines');
  }

  // --- 1b. Most-urgent hint (entry point) ---------------------------------
  {
    // Mockup data: appraisal overdue beats inspection tomorrow.
    const u = mostUrgentKeyDate(
      [
        { label: 'Closing date', date: shift(TODAY, 32) },
        { label: 'Inspection contingency deadline', date: shift(TODAY, 1) },
        { label: 'Appraisal deadline', date: shift(TODAY, -4) },
        { label: 'Loan approval date', date: shift(TODAY, 4) },
      ],
      TODAY,
    );
    assert(u !== null, 'most urgent found among the four dates');
    assert(
      u!.hint === 'Appraisal deadline · overdue by 4 days' && u!.tone === 'over',
      'overdue date wins; hint is "label · relative", red tone',
    );
    // No overdue: nearest upcoming wins, amber tone.
    const u2 = mostUrgentKeyDate(
      [
        { label: 'Closing date', date: shift(TODAY, 32) },
        { label: 'Inspection contingency deadline', date: shift(TODAY, 1) },
        { label: 'Loan approval date', date: shift(TODAY, 4) },
      ],
      TODAY,
    );
    assert(
      u2 !== null && u2.hint === 'Inspection contingency deadline · tomorrow' && u2.tone === 'soon',
      'nearest upcoming wins when nothing is overdue',
    );
    // Far-out only: muted tone.
    const u3 = mostUrgentKeyDate([{ label: 'Closing date', date: shift(TODAY, 32) }], TODAY);
    assert(
      u3 !== null && u3.hint === 'Closing date · in 32 days' && u3.tone === 'muted',
      'far-out date -> muted tone',
    );
    // Nothing set -> no hint.
    assert(
      mostUrgentKeyDate(
        [
          { label: 'Closing date', date: null },
          { label: 'Appraisal deadline', date: undefined },
        ],
        TODAY,
      ) === null,
      'no dates set -> no hint',
    );
    // Invalid dates are skipped, never surfaced.
    assert(
      mostUrgentKeyDate([{ label: 'Appraisal deadline', date: 'not-a-date' }], TODAY) === null,
      'invalid date skipped',
    );
    assert(!/—|–/.test(u!.hint), 'no em/en dashes in the hint');
  }

  // --- 2. Completed-date format ------------------------------------------
  {
    assert(
      formatCompletedDate('2026-09-18T10:00:00.000Z') === 'Sep 18, 2026',
      'ISO checkoff timestamp -> "Sep 18, 2026"',
    );
    assert(
      formatCompletedDate('2025-12-31') === 'Dec 31, 2025',
      'plain date -> "Dec 31, 2025" (year always shown)',
    );
    assert(
      /\d{4}$/.test(formatCompletedDate('2026-01-05T00:00:00Z')),
      'year always present (Dec-to-Jan unambiguous)',
    );
    assert(!/—|–/.test(formatCompletedDate('2026-09-18')), 'no dashes in completed line');
  }

  // --- 3. Explainer inventory (key-based, fail closed) ---------------------
  {
    // Template counts match the approved mockups (14 buyer + 12 seller;
    // pool-equipment-inspection removed Sept 30, 2026).
    assert(BUY_STEPS.length === 14, `buyer templates = 14 (got ${BUY_STEPS.length})`);
    assert(SELL_STEPS.length === 12, `seller templates = 12 (got ${SELL_STEPS.length})`);
    const termiteIdx = BUY_STEPS.findIndex((s) => s.key === 'termite-inspection-report');
    assert(
      termiteIdx !== -1 && BUY_STEPS[termiteIdx].t === 'Termite inspection report',
      'buyer templates include Termite inspection report',
    );
    assert(
      termiteIdx > 0 && BUY_STEPS[termiteIdx - 1].key === 'sellers-disclosure-hoa-docs-received' &&
        BUY_STEPS[termiteIdx + 1].key === 'signed-loan-docs',
      'Termite inspection report sits after disclosures, before loan docs (mockup order)',
    );
    const disclosureIdx = SELL_STEPS.findIndex((s) => s.key === 'seller-disclosure-due');
    assert(
      disclosureIdx !== -1 && SELL_STEPS[disclosureIdx + 1].key === 'order-home-warranty',
      'pool-equipment-inspection removed: disclosure due is followed by warranty (Sept 30, 2026)',
    );
    assert(
      SELL_STEPS.findIndex((s) => s.key === 'pool-equipment-inspection') === -1,
      'pool-equipment-inspection absent from seller template',
    );
    // Keys are unique per role.
    assert(new Set(BUY_STEPS.map((s) => s.key)).size === 14, 'buyer template keys unique');
    assert(new Set(SELL_STEPS.map((s) => s.key)).size === 12, 'seller template keys unique');

    const missingBuyer = explainerCoverage('buyer', BUY_STEPS.map((s) => s.key));
    assert(missingBuyer.length === 0, `every buyer template key has an explainer (${missingBuyer.join(', ')})`);
    const missingSeller = explainerCoverage('seller', SELL_STEPS.map((s) => s.key));
    assert(missingSeller.length === 0, `every seller template key has an explainer (${missingSeller.join(', ')})`);

    // Key-based resolution: the title is ignored, so a realtor rename keeps
    // the explainer.
    const renamed = stepExplainer('buyer', { custom: false, templateKey: 'escrow-open' });
    assert(!!renamed, 'default step resolves by key');
    const escrowOpenSeller = stepExplainer('seller', { custom: false, templateKey: 'escrow-open' });
    assert(!!escrowOpenSeller && renamed !== escrowOpenSeller, "'escrow-open' explainer differs per role");
    const closeBuyer = stepExplainer('buyer', { custom: false, templateKey: 'close-escrow' });
    const closeSeller = stepExplainer('seller', { custom: false, templateKey: 'close-escrow' });
    assert(!!closeBuyer && !!closeSeller && closeBuyer !== closeSeller, "'close-escrow' explainer differs per role");

    // Fail closed: no key, unknown key, or blank custom note -> null.
    assert(stepExplainer('buyer', { custom: false }) === null, 'default step with no key -> null (never title-guess)');
    assert(
      stepExplainer('buyer', { custom: false, templateKey: 'not-a-real-key' }) === null,
      'unknown template key -> null (never a wrong explainer)',
    );
    assert(
      stepExplainer('buyer', { custom: true, templateKey: 'close-escrow' }) === null,
      'custom step with a default key set -> null (custom never resolves default copy)',
    );
    assert(
      stepExplainer('buyer', { custom: true, explainer: '  ' }) === null,
      'blank custom explainer -> null (row does not expand)',
    );
    assert(
      stepExplainer('seller', { custom: true, explainer: 'My note.' }) === 'My note.',
      'custom step uses the realtor\'s stored line',
    );
    assert(!/—|–/.test((renamed ?? '') + (closeSeller ?? '')), 'no em/en dashes in explainer copy');
  }

  // --- 3b. Upgrade backfill ------------------------------------------------
  {
    assert(
      backfillTemplateKey('buyer', { custom: false, title: 'Earnest money wired' }) === 'earnest-money-wired',
      'pre-key default step recovers its key by title',
    );
    assert(
      backfillTemplateKey('seller', { custom: false, title: 'Pool equipment inspection' }) === null,
      'removed template titles no longer backfill (pool-equipment-inspection, Sept 30, 2026)',
    );
    assert(
      backfillTemplateKey('buyer', { custom: false, title: 'Earnest money wired', templateKey: 'earnest-money-wired' }) ===
        'earnest-money-wired',
      'existing key is kept, never re-derived',
    );
    assert(
      backfillTemplateKey('buyer', { custom: false, title: 'Some renamed step' }) === null,
      'unrecognized title -> null (no explainer, never a wrong one)',
    );
    // The critical regression: a custom step titled exactly like a default
    // step must NOT receive the default key/explainer.
    assert(
      backfillTemplateKey('buyer', { custom: true, title: 'Close escrow' }) === null,
      'custom step titled like a default never receives a template key',
    );
    // Legacy title (pre-Sept-28-2026 copy alignment): escrows created with
    // "Escrow open" backfill to the same key as the renamed "Escrow opened".
    assert(
      backfillTemplateKey('buyer', { custom: false, title: 'Escrow open' }) === 'escrow-open',
      'legacy "Escrow open" backfills to escrow-open',
    );
    assert(
      backfillTemplateKey('seller', { custom: false, title: 'Escrow open' }) === 'escrow-open',
      'legacy "Escrow open" backfills on the seller side too',
    );
    assert(
      backfillTemplateKey('buyer', { custom: false, title: 'Escrow opened' }) === 'escrow-open',
      'current "Escrow opened" backfills to escrow-open',
    );
    // Visible-title normalization (Anuraj Sept 28, 2026): the approved
    // "Escrow open" -> "Escrow opened" rename applies to existing stored
    // rows, not just new defaults.
    assert(
      normalizeStepTitle({ custom: false, title: 'Escrow open', templateKey: 'escrow-open' }) ===
        'Escrow opened',
      'legacy "Escrow open" normalizes to "Escrow opened"',
    );
    assert(
      normalizeStepTitle({ custom: false, title: 'Escrow open' }) === 'Escrow opened',
      'legacy title normalizes even before the key is backfilled',
    );
    assert(
      normalizeStepTitle({ custom: false, title: 'Escrow opened', templateKey: 'escrow-open' }) ===
        'Escrow opened',
      'current "Escrow opened" is untouched',
    );
    assert(
      normalizeStepTitle({ custom: true, title: 'Escrow open' }) === 'Escrow open',
      'custom step titled "Escrow open" keeps its user-entered title',
    );
    assert(
      normalizeStepTitle({ custom: false, title: 'Home inspection', templateKey: 'home-inspection' }) ===
        'Home inspection',
      'unrelated titles are untouched',
    );
    assert(
      stepExplainer('buyer', { custom: true }) === null,
      'custom step with no realtor line shows no explainer (even if titled like a default)',
    );
    assert(isKnownTemplateKey('close-escrow'), 'known key recognized');
    assert(!isKnownTemplateKey('nope'), 'unknown key rejected');
  }

  // --- 4. updateEscrow key dates: confirmed write -------------------------
  {
    const { server, store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '4 Key Dates Ct',
      side: 'buy',
      buyerName: 'Key Buyer',
      openDate,
      closeDate,
    } as never);
    assert(
      created.inspectionDeadline === null && created.appraisalDeadline === null && created.loanApprovalDate === null,
      'createEscrow defaults all key dates to null (new-escrow form untouched)',
    );
    const updated = await store.updateEscrow(created.id, {
      address: '4 Key Dates Ct',
      side: 'buy',
      buyerName: 'Key Buyer',
      openDate,
      closeDate,
      inspectionDeadline: '2026-10-05',
      appraisalDeadline: '2026-10-12',
      loanApprovalDate: '2026-10-20',
    } as never);
    assert(updated.inspectionDeadline === '2026-10-05', 'updateEscrow returns the inspection deadline');
    assert(updated.appraisalDeadline === '2026-10-12', 'updateEscrow returns the appraisal deadline');
    assert(updated.loanApprovalDate === '2026-10-20', 'updateEscrow returns the loan approval date');
    const row = serverEscrowRow(server, created.id)!;
    assert(row.inspection_deadline === '2026-10-05', 'server row carries inspection_deadline');
    assert(row.appraisal_deadline === '2026-10-12', 'server row carries appraisal_deadline');
    assert(row.loan_approval_date === '2026-10-20', 'server row carries loan_approval_date');
    // Omitted = preserved; explicit null = cleared.
    const kept = await store.updateEscrow(created.id, {
      address: '4 Key Dates Ct',
      side: 'buy',
      buyerName: 'Key Buyer',
      openDate,
      closeDate,
    } as never);
    assert(kept.inspectionDeadline === '2026-10-05', 'omitted key dates are preserved on update');
    const cleared = await store.updateEscrow(created.id, {
      address: '4 Key Dates Ct',
      side: 'buy',
      buyerName: 'Key Buyer',
      openDate,
      closeDate,
      inspectionDeadline: null,
    } as never);
    assert(cleared.inspectionDeadline === null, 'explicit null clears a key date');
    assert(cleared.appraisalDeadline === '2026-10-12', 'other key dates untouched by the clear');
    // Per-side independence: buyer and seller views share the escrow-level dates.
    const buyerView = await store.getBuyerView(created.id);
    const sellerView = await store.getSellerView(created.id);
    assert(
      buyerView.appraisalDeadline === '2026-10-12' && sellerView.appraisalDeadline === '2026-10-12',
      'buyer and seller views carry the same key dates (escrow-level)',
    );
  }

  // --- 5. updateEscrow failure: plain error, local unchanged --------------
  {
    const faults: Faults = { pendingGates: [] };
    const { server, store } = await setup(faults);
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '5 Key Fail Ct',
      side: 'buy',
      buyerName: 'Fail Buyer',
      openDate,
      closeDate,
    } as never);
    faults.failUpsert = new Error('boom');
    faults.failUpsertTables = ['escrows'];
    let msg = '';
    try {
      await store.updateEscrow(created.id, {
        address: '5 Key Fail Ct',
        side: 'buy',
        buyerName: 'Fail Buyer',
        openDate,
        closeDate,
        inspectionDeadline: '2026-10-05',
      } as never);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg.length > 0, 'failed key-date save throws a plain-language error');
    const local = await store.getEscrow(created.id);
    assert(local!.inspectionDeadline === null, 'local key date unchanged after failed save');
    assert(serverEscrowRow(server, created.id) !== undefined, 'create still landed');
  }

  // --- 6. Key dates LOCKED on closed/cancelled escrows (Anuraj, Sept 28) ---
  // Key dates are editable only on open escrows. Closed/cancelled escrows
  // show the locked Key dates section with a "Reactivate escrow" button;
  // the store backstop rejects any key-date write on a non-open escrow so
  // no path can sneak one in, and key-date edits never reactivate.
  {
    const { store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '6 Closed Dates Ct',
      side: 'buy',
      buyerName: 'Closed Buyer',
      openDate,
      closeDate,
    } as never);
    // closeEscrow requires every step complete: check them all off first.
    let e = created;
    for (const s of created.buyerSteps) {
      e = await store.toggleStep(e.id, 'buyer', s.id);
    }
    await store.closeEscrow(e.id, 'buyer');
    let threw = false;
    try {
      await store.updateEscrow(e.id, {
        address: '6 Closed Dates Ct',
        side: 'buy',
        buyerName: 'Closed Buyer',
        openDate,
        closeDate,
        inspectionDeadline: '2026-09-20',
      } as never);
    } catch {
      threw = true;
    }
    assert(threw, 'key-date edit on a closed escrow is rejected');
    const after = (await store.getBuyerView(e.id));
    assert(after.inspectionDeadline == null, 'closed-escrow key dates stay unchanged after the rejected edit');

    // Cancelled escrows: the backstop rejects, status stays cancelled.
    const created2 = await store.createEscrow({
      address: '6b Cancelled Dates Ct',
      side: 'buy',
      buyerName: 'Cancelled Buyer',
      openDate,
      closeDate,
    } as never);
    await store.cancelEscrow(created2.id);
    let threw2 = false;
    try {
      await store.updateEscrow(created2.id, {
        address: '6b Cancelled Dates Ct',
        side: 'buy',
        buyerName: 'Cancelled Buyer',
        openDate,
        closeDate,
        appraisalDeadline: '2026-09-21',
      } as never);
    } catch {
      threw2 = true;
    }
    assert(threw2, 'key-date edit on a cancelled escrow is rejected');

    // Reactivation re-opens the gate: after activateEscrow the escrow is
    // open again and key dates are preserved; a subsequent key-date edit
    // then succeeds (reactivation itself never writes key dates).
    const reactivated = await store.activateEscrow(created2.id, {
      address: '6b Cancelled Dates Ct',
      side: 'buy',
      buyerName: 'Cancelled Buyer',
      openDate,
      closeDate,
    } as never);
    assert(reactivated.status === 'open', 'activateEscrow re-opens the escrow');
    const edited = await store.updateEscrow(created2.id, {
      address: '6b Cancelled Dates Ct',
      side: 'buy',
      buyerName: 'Cancelled Buyer',
      openDate,
      closeDate,
      appraisalDeadline: '2026-09-21',
    } as never);
    assert(edited.appraisalDeadline === '2026-09-21', 'key-date edit applies after reactivation');
  }

  // --- 7. Custom-step explainer storage -----------------------------------
  {
    const { server, store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '7 Explainer Ct',
      side: 'buy',
      buyerName: 'Explainer Buyer',
      openDate,
      closeDate,
    } as never);
    const withNote = await store.addCustomStep(created.id, 'buyer', 'Meet the HOA', 'The board meets monthly. Say hi.');
    const step = withNote.buyerSteps.find((s) => s.title === 'Meet the HOA')!;
    assert(step.explainer === 'The board meets monthly. Say hi.', 'custom-step explainer stored on the step');
    assert(step.templateKey === null, 'custom steps carry templateKey null (never a default key)');
    // A custom step titled exactly like a default step still resolves no
    // default explainer (fail-closed regression, end to end).
    const impostor = await store.addCustomStep(created.id, 'buyer', 'Close escrow', 'Our own note.');
    const impostorStep = impostor.buyerSteps.find((s) => s.explainer === 'Our own note.')!;
    assert(
      stepExplainer('buyer', impostorStep) === 'Our own note.',
      'impostor custom step shows only its own line, never the default explainer',
    );
    const blank = await store.addCustomStep(created.id, 'buyer', 'Extra visit', '   ');
    const blankStep = blank.buyerSteps.find((s) => s.title === 'Extra visit')!;
    assert(blankStep.explainer === null, 'blank explainer stores null (row does not expand)');
    const long = await store.addCustomStep(created.id, 'buyer', 'Long note', 'x'.repeat(200));
    const longStep = long.buyerSteps.find((s) => s.title === 'Long note')!;
    assert(longStep.explainer!.length === 140, 'explainer truncated to 140 chars');
    // New escrows stamp template keys on default steps at creation.
    const firstDefault = created.buyerSteps[0];
    assert(firstDefault.templateKey === 'escrow-open', 'built default steps carry their template key');
    assert(
      stepExplainer('buyer', firstDefault) !== null,
      'built default step resolves its explainer by key',
    );
    // The step upsert ships the explainer key only when a note exists, and
    // the template_key only when set.
    const rows = toStepRows(created.id, 'buyer', withNote.buyerSteps);
    const noteRow = rows.find((r) => r.title === 'Meet the HOA')!;
    assert(noteRow.explainer === 'The board meets monthly. Say hi.', 'toStepRows ships the explainer when set');
    assert(!('template_key' in noteRow), 'toStepRows omits template_key for custom steps (pre-0020 safe)');
    const defaultRow = rows.find((r) => r.title === 'Escrow opened')!;
    assert(defaultRow.template_key === 'escrow-open', 'toStepRows ships template_key for default steps');
    const noNoteRows = toStepRows(created.id, 'buyer', blank.buyerSteps.filter((s) => s.title === 'Extra visit'));
    assert(!('explainer' in noNoteRows[0]), 'toStepRows omits the key when no note (pre-0019 safe)');
    void server;
  }

  // --- 8. Cloud row round trips -------------------------------------------
  {
    const { store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '8 Roundtrip Ct',
      side: 'buy',
      buyerName: 'Round Buyer',
      openDate,
      closeDate,
    } as never);
    const updated = await store.updateEscrow(created.id, {
      address: '8 Roundtrip Ct',
      side: 'buy',
      buyerName: 'Round Buyer',
      openDate,
      closeDate,
      inspectionDeadline: '2026-10-05',
      appraisalDeadline: '2026-10-12',
      loanApprovalDate: '2026-10-20',
    } as never);
    const row = toEscrowRow('user-1', updated);
    assert(row.inspection_deadline === '2026-10-05', 'toEscrowRow maps inspection_deadline');
    const back = fromEscrowRow(row);
    assert(
      back.inspectionDeadline === '2026-10-05' && back.appraisalDeadline === '2026-10-12' && back.loanApprovalDate === '2026-10-20',
      'fromEscrowRow restores all three key dates',
    );
    const legacy = fromEscrowRow({ id: 'x', open_date: '2026-09-01', close_date: '2026-10-30' });
    assert(
      legacy.inspectionDeadline === null && legacy.appraisalDeadline === null && legacy.loanApprovalDate === null,
      'pre-0019 rows (absent columns) map to null',
    );
    const bad = fromEscrowRow({ id: 'x', inspection_deadline: 'not-a-date' });
    assert(bad.inspectionDeadline === null, 'malformed key-date values map to null, never garbage');
    const stepRow = fromStepRow({ id: 's1', title: 'Custom', custom: true, position: 0, explainer: 'Note.', role: 'buyer' });
    assert(stepRow.explainer === 'Note.', 'fromStepRow restores the explainer');
    assert(stepRow.templateKey === null, 'fromStepRow never backfills a key onto a custom step');
    const keyed = fromStepRow({ id: 's3', title: 'Close escrow', custom: false, position: 0, role: 'buyer', template_key: 'close-escrow' });
    assert(keyed.templateKey === 'close-escrow', 'fromStepRow restores template_key');
    const preKey = fromStepRow({ id: 's4', title: 'Earnest money wired', custom: false, position: 1, role: 'buyer' });
    assert(
      preKey.templateKey === 'earnest-money-wired',
      'pre-key default rows backfill templateKey by title on pull',
    );
    const noExpl = fromStepRow({ id: 's2', title: 'Plain', position: 0 });
    assert(noExpl.explainer === null, 'fromStepRow defaults explainer to null');
  }

  // --- 9. RPC payload mapping ----------------------------------------------
  {
    const payload = {
      ok: true,
      escrow: {
        id: 'esc-1',
        address: '9 RPC Ct',
        city: '',
        side: 'buy',
        status: 'open',
        open_date: '2026-09-01',
        close_date: '2026-10-30',
        inspection_deadline: '2026-10-05',
        appraisal_deadline: '2026-10-12',
        loan_approval_date: '2026-10-20',
        created_at: '2026-09-01T00:00:00Z',
      },
      buyer_steps: [
        { id: 'st1', title: 'Signed loan docs', subtitle: '', done: true, custom: false, position: 0, completed_at: '2026-09-18T10:00:00Z' },
        { id: 'st2', title: 'Custom visit', subtitle: '', done: false, custom: true, position: 1, explainer: 'Bring the dog.' },
      ],
      profile: null,
      my_review_id: null,
    };
    const res = mapClientViewRpc(payload);
    assert(res.ok === true, 'RPC payload maps ok');
    if (res.ok) {
      assert(res.view!.inspectionDeadline === '2026-10-05', 'ClientView carries inspection_deadline');
      assert(res.view!.appraisalDeadline === '2026-10-12', 'ClientView carries appraisal_deadline');
      assert(res.view!.loanApprovalDate === '2026-10-20', 'ClientView carries loan_approval_date');
      const done = res.view!.steps.find((s) => s.id === 'st1')!;
      assert(done.completedAt === '2026-09-18T10:00:00Z', 'completed_at rides the step payload');
      assert(
        done.templateKey === 'signed-loan-docs',
        'pre-key default step backfills templateKey by title in the RPC mapping',
      );
      assert(
        stepExplainer('buyer', done) !== null,
        'backfilled key resolves the explainer on the client view',
      );
      const custom = res.view!.steps.find((s) => s.id === 'st2')!;
      assert(custom.explainer === 'Bring the dog.', 'custom-step explainer rides the step payload');
      assert(custom.templateKey === null, 'custom steps never carry a template key');
      assert(
        formatCompletedDate(done.completedAt!) === 'Sep 18, 2026',
        'end-to-end: payload completed_at formats "Sep 18, 2026"',
      );
    }
    // Pre-0019 payload: absent keys -> empty state, no expand.
    const legacyPayload = {
      ok: true,
      escrow: { id: 'esc-2', address: 'L', city: '', side: 'buy', status: 'open', open_date: '2026-09-01', close_date: '2026-10-30', created_at: '2026-09-01T00:00:00Z' },
      buyer_steps: [{ id: 'st9', title: 'Signed loan docs', subtitle: '', done: false, custom: false, position: 0 }],
      profile: null,
      my_review_id: null,
    };
    const legacyRes = mapClientViewRpc(legacyPayload);
    assert(legacyRes.ok === true, 'legacy RPC payload maps ok');
    if (legacyRes.ok) {
      assert(
        legacyRes.view!.inspectionDeadline === null && legacyRes.view!.appraisalDeadline === null && legacyRes.view!.loanApprovalDate === null,
        'absent key-date keys map to null (card shows empty state)',
      );
    }
  }

  // --- 10. Check/uncheck drives the completed line -------------------------
  {
    const { store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '10 Completed Ct',
      side: 'buy',
      buyerName: 'Completed Buyer',
      openDate,
      closeDate,
    } as never);
    const stepId = created.buyerSteps[0].id;
    const checked = await store.toggleStep(created.id, 'buyer', stepId);
    const done = checked.buyerSteps.find((s) => s.id === stepId)!;
    assert(done.done && done.completedAt !== null, 'check-off stamps the server checkoff timestamp');
    assert(
      /^Completed [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(`Completed ${formatCompletedDate(done.completedAt!)}`),
      'completed line renders "Completed Sep 18, 2026" shape',
    );
    const unchecked = await store.toggleStep(created.id, 'buyer', stepId);
    assert(unchecked.buyerSteps.find((s) => s.id === stepId)!.completedAt === null, 'unchecking removes the timestamp (line disappears)');
  }

  // --- 11. Upgrade backfill on load ----------------------------------------
  {
    // Simulate a database from before template keys: raw KV JSON whose
    // default steps have no templateKey. Loading backfills them by title.
    const kv = trackingKV();
    const legacyEscrow = {
      id: 'legacy-1',
      address: '11 Legacy Ct',
      city: '',
      side: 'buy',
      status: 'open',
      buyerName: 'Legacy Buyer',
      sellerName: null,
      openDate: '2026-09-01',
      closeDate: '2026-10-30',
      buyerClosedAt: null,
      sellerClosedAt: null,
      inspectionDeadline: null,
      appraisalDeadline: null,
      loanApprovalDate: null,
      buyerSteps: [
        { id: 'l1', title: 'Earnest money wired', subtitle: '', done: false, custom: false, order: 0, completedAt: null },
        { id: 'l2', title: 'Close escrow', subtitle: '', done: false, custom: true, order: 1, completedAt: null, explainer: 'Our note.' },
      ],
      sellerSteps: [],
    };
    await kv.setItem('ctc:escrows', JSON.stringify([legacyEscrow]));
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    const escrows = await store.listEscrows();
    const loaded = escrows.find((e) => e.id === 'legacy-1')!;
    const backfilled = loaded.buyerSteps.find((s) => s.id === 'l1')!;
    assert(backfilled.templateKey === 'earnest-money-wired', 'upgrade backfill stamps the key on load');
    assert(stepExplainer('buyer', backfilled) !== null, 'backfilled step resolves its explainer');
    const customLegacy = loaded.buyerSteps.find((s) => s.id === 'l2')!;
    assert(customLegacy.templateKey == null, 'legacy custom step gets no key');
    assert(
      stepExplainer('buyer', customLegacy) === 'Our note.',
      'legacy custom step keeps its own line, never the default explainer',
    );
  }

  // --- 12. Checklist draft save: key + explainer in one confirmed write ----
  {
    const { server, store } = await setup();
    const { openDate, closeDate } = dates();
    const created = await store.createEscrow({
      address: '12 Draft Ct',
      side: 'buy',
      buyerName: 'Draft Buyer',
      openDate,
      closeDate,
    } as never);
    const target = created.buyerSteps.find((s) => s.templateKey === 'close-escrow')!;
    // Rename a default step in the draft (edit mode): the key — and the
    // explainer — must survive the rename.
    const drafts: import('../src/lib/types').ChecklistDraftStep[] = created.buyerSteps.map((s) => ({
      id: s.id,
      title: s.id === target.id ? 'Close escrow (renamed by realtor)' : s.title,
      subtitle: s.subtitle,
      done: s.done,
      custom: s.custom,
      completedAt: s.completedAt,
    }));
    // Add a custom step with an explainer in the same draft.
    drafts.push({ title: 'Meet the neighbors', done: false, custom: true, explainer: 'Say hello.' });
    const saved = await store.applyChecklistEdits(created.id, 'buyer', drafts);
    const renamedStep = saved.buyerSteps.find((s) => s.id === target.id)!;
    assert(renamedStep.templateKey === 'close-escrow', 'draft rename preserves the template key');
    assert(
      stepExplainer('buyer', renamedStep) !== null,
      'renamed default step still resolves its explainer (title ignored)',
    );
    const added = saved.buyerSteps.find((s) => s.title === 'Meet the neighbors')!;
    assert(added.custom && added.explainer === 'Say hello.', 'custom explainer committed with the checklist save');
    assert(added.templateKey === null, 'new custom step carries no template key');
    // The confirmed write pushed the keys server-side.
    const pushedRenamed = server.steps.get(target.id) as Record<string, unknown> | undefined;
    assert(pushedRenamed?.template_key === 'close-escrow', 'confirmed write pushes template_key to the server');
    void server;
  }

  summary('key_dates');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
