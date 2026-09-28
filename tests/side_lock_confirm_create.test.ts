// side_lock_confirm_create.test.ts — REGRESSION: side locked after
// creation + two-phase new-escrow confirmation (Sept 28, 2026, Anuraj).
//
// 1. LOCK THE SIDE AFTER CREATION: the edit/activate flow's side picker is
//    non-interactive — it displays the current side (including 'both' for
//    older dual-agency escrows) and the side value submits unchanged. No
//    more buyer↔seller switches after creation (this also kills the
//    ghost-invite problem at the root).
// 2. CONFIRMATION SCREEN ON CREATE: the new-escrow form validates on
//    submit but then shows a confirmation screen summarizing the entered
//    data (Side / Property address / Client name / Escrow open date /
//    Target close date). "Create escrow" performs the existing create;
//    "Back to edit" returns to the form with all values preserved.
//    Update/activate sheets keep their direct save.
// Pure summary logic is unit-tested; the sheet wiring is pinned with
// structural assertions on the component sources (RN components are not
// importable in the node suite).
import { assert, summary } from './assert';
import { confirmSummaryRows, sideDisplayLabel } from '../src/lib/escrowConfirm';
import type { CreateEscrowInput } from '../src/lib/types';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number; env: Record<string, string> };
const fs = require('fs');
const path = require('path');

function readFromRoot(rel: string): string {
  const roots: string[] = [];
  if (process.env.CTC_REPO_ROOT) roots.push(process.env.CTC_REPO_ROOT);
  roots.push(process.cwd(), __dirname);
  for (const start of roots) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const src = (rel: string): string => {
  const s = readFromRoot(rel);
  assert(s !== '', `could not locate ${rel}`);
  return s;
};

async function main(): Promise<void> {
  // ---- Part 1: pure summary logic (src/lib/escrowConfirm.ts) ----
  assert(sideDisplayLabel('buy') === 'Buy side', "side label: buy -> 'Buy side'");
  assert(sideDisplayLabel('sell') === 'Sell side', "side label: sell -> 'Sell side'");
  assert(sideDisplayLabel('both') === 'Dual agency', "side label: both -> 'Dual agency'");

  const buyInput: CreateEscrowInput = {
    address: '4187 Oakmont Dr',
    side: 'buy',
    buyerName: 'Maya Rao',
    openDate: '2026-10-01',
    closeDate: '2026-11-15',
  };
  const rows = confirmSummaryRows(buyInput);
  const labels = rows.map((r) => r.label);
  assert(
    JSON.stringify(labels) ===
      JSON.stringify(['Side', 'Property address', 'Client name', 'Escrow open date', 'Target close date']),
    'summary rows come in the approved order',
  );
  const byId = Object.fromEntries(rows.map((r) => [r.testID, r]));
  assert(byId['confirm-side'].value === 'Buy side', 'summary shows Buy side');
  assert(byId['confirm-address'].value === '4187 Oakmont Dr', 'summary shows the address');
  assert(byId['confirm-client-name'].value === 'Maya Rao', 'buy side: client name is the buyer name');
  assert(byId['confirm-open-date'].value === '2026-10-01', 'summary shows the open date');
  assert(byId['confirm-close-date'].value === '2026-11-15', 'summary shows the close date');

  const sellInput: CreateEscrowInput = {
    address: '99 Palm Ave',
    side: 'sell',
    sellerName: 'Dev Patel',
    openDate: '2026-10-02',
    closeDate: '2026-11-20',
  };
  const sellRows = confirmSummaryRows(sellInput);
  const sellById = Object.fromEntries(sellRows.map((r) => [r.testID, r]));
  assert(sellById['confirm-side'].value === 'Sell side', 'summary shows Sell side');
  assert(sellById['confirm-client-name'].value === 'Dev Patel', 'sell side: client name is the seller name');

  // Legacy dual-agency escrows render both name rows instead of Client name.
  const bothInput: CreateEscrowInput = {
    address: '1 Main St',
    side: 'both',
    buyerName: 'A',
    sellerName: 'B',
    openDate: '2026-10-01',
    closeDate: '2026-11-01',
  };
  const bothRows = confirmSummaryRows(bothInput);
  const bothById = Object.fromEntries(bothRows.map((r) => [r.testID, r]));
  assert(bothById['confirm-side'].value === 'Dual agency', 'summary shows Dual agency');
  assert(bothById['confirm-buyer-name'].value === 'A', 'dual: buyer name row');
  assert(bothById['confirm-seller-name'].value === 'B', 'dual: seller name row');
  assert(!bothById['confirm-client-name'], 'dual: no single Client name row');

  // ---- Part 2: sheet wiring (structural) ----
  const form = src(path.join('src', 'components', 'EscrowFormSheet.tsx'));
  const update = src(path.join('src', 'components', 'UpdateEscrowSheet.tsx'));
  const create = src(path.join('src', 'components', 'NewEscrowSheet.tsx'));

  // lockSide prop exists and drives a non-interactive display.
  assert(/lockSide\?: boolean/.test(form), 'EscrowFormSheet accepts a lockSide prop');
  assert(
    /testID=\{`side-\$\{which\}-locked`\}/.test(form),
    'locked side cards carry side-{which}-locked testIDs',
  );
  assert(
    /const lockedCard = \(/.test(form) && /<View[\s\S]*?testID=\{`side-\$\{which\}-locked`\}/.test(form),
    'the locked side display is a View (no Pressable, no onPress) — non-interactive',
  );
  assert(
    /lockSide \? \(/.test(form),
    'the side row renders the locked display when lockSide is set',
  );
  // The locked cards reuse the same card styles (no new visual language).
  assert(
    /style=\{\[styles\.pick, selected && styles\.pickSelected\]\}/.test(form),
    'locked cards reuse the picker card styles',
  );

  // Edit + activate flows lock the side; the new-escrow flow does not.
  assert(/\blockSide\b/.test(update), 'UpdateEscrowSheet passes lockSide');
  assert(
    !/confirmCreate/.test(update),
    'UpdateEscrowSheet does not pass confirmCreate — update/activate keep their direct save',
  );
  assert(!/lockSide/.test(create), 'NewEscrowSheet does not pass lockSide — side stays editable at creation');

  // Two-phase create: NewEscrowSheet opts in; the form holds the validated
  // input on a confirmation screen instead of creating immediately.
  assert(/confirmCreate\?: boolean/.test(form), 'EscrowFormSheet accepts a confirmCreate prop');
  assert(/\n\s+confirmCreate\n/.test(create), 'NewEscrowSheet passes confirmCreate');
  assert(
    /if \(confirmCreate && !confirming\) \{\s*setConfirming\(input\);\s*return;\s*\}/.test(form),
    'submit with confirmCreate holds the validated input on the confirmation screen',
  );
  assert(
    /confirming \? \(\s*<EscrowConfirmView/.test(form),
    'the sheet renders the confirmation view while an input is held',
  );
  assert(
    /onBackToEdit=\{\(\) => setConfirming\(null\)\}/.test(form),
    '"Back to edit" clears the hold and returns to the form — values preserved',
  );
  assert(
    /const confirmSave = async \(\) => \{\s*if \(saving \|\| !confirming\) return;\s*await performSave\(confirming\);\s*\};/.test(form),
    '"Create escrow" performs the held create through the existing save path',
  );

  // The confirmation screen's buttons and summary rows.
  assert(/title=\{saving \? savingLabel : 'Create escrow'\}/.test(form), 'confirmation primary button reads "Create escrow"');
  assert(/title="Back to edit"/.test(form), 'confirmation has a "Back to edit" secondary button');
  assert(/testID="confirm-create-escrow"/.test(form), 'the create button is identifiable');
  assert(/testID="confirm-back-to-edit"/.test(form), 'the back-to-edit button is identifiable');
  assert(/confirmSummaryRows\(input\)\.map/.test(form), 'the confirmation renders the summary rows');
  assert(/<Text style=\{styles\.h2\}>Confirm escrow<\/Text>/.test(form), 'the confirmation screen is titled "Confirm escrow"');

  summary('side_lock_confirm_create');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
