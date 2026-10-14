// tc_intake_additions.test.ts — TC intake Oct 14, 2026 additions: form
// wiring for Seller's agent %, Water softener (+ conditional Owned/Leased
// validation on save), and the escrow officer fields.
//
// The model-level behavior (counts, sections, share text, the validation
// matrix) is covered in tests/tc_intake.test.ts; this file pins the FORM
// (app/tc-intake/[escrowId].tsx) the way tests/buyer_intake.test.ts pins
// the buyer form: fields exist with the right labels/testIDs, the water
// softener follow-up carries the inline error, "No" clears the follow-up,
// and onSave runs the validation BEFORE the store write.
import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const form = fs.readFileSync(path.join(ROOT, 'app/tc-intake/[escrowId].tsx'), 'utf8');

// --- Commission: Seller's-agent % between buyer's-agent and TC fee ---------
{
  const buyerIdx = form.indexOf('testID="tc-buyer-pct"');
  const sellerIdx = form.indexOf('testID="tc-seller-pct"');
  const feeIdx = form.indexOf('testID="tc-tc-fee"');
  assert(buyerIdx !== -1 && sellerIdx > buyerIdx && feeIdx > sellerIdx, "seller's-agent % sits between buyer's-agent % and the TC fee");
  const block = form.slice(Math.max(0, sellerIdx - 300), sellerIdx);
  assert(block.includes('label="Seller\'s-agent %"'), "seller's-agent field label");
  assert(block.includes('sellerPct'), "seller's-agent field binds sellerPct");
}

// --- Water softener: seg + conditional follow-up with the inline error -----
{
  const wsIdx = form.indexOf('testID="tc-water-softener"');
  assert(wsIdx !== -1, 'water softener segment renders');
  const wsBlock = form.slice(Math.max(0, wsIdx - 400), wsIdx);
  assert(wsBlock.includes('label="Water softener?"'), 'water softener label');
  assert(
    wsBlock.includes("waterSoftenerLeasedOwned: v === 'yes' ?"),
    '"No" on water softener clears the Owned/Leased follow-up',
  );
  const loIdx = form.indexOf('testID="tc-water-softener-lo"');
  assert(loIdx !== -1 && loIdx > wsIdx, 'Owned/Leased follow-up renders after the water softener segment');
  const loBlock = form.slice(Math.max(0, loIdx - 400), loIdx);
  assert(loBlock.includes("form.waterSoftener === 'yes'"), 'follow-up is revealed only when water softener is Yes');
  assert(
    loBlock.includes('error={errors.waterSoftenerLeasedOwned ?? null}'),
    'follow-up carries the inline conditional error',
  );
  // Solar precedes water softener in Property details (mirrors Solar).
  const solarIdx = form.indexOf('testID="tc-solar"');
  const poolIdx = form.indexOf('testID="tc-pool"');
  assert(solarIdx !== -1 && wsIdx > solarIdx && poolIdx > wsIdx, 'water softener sits between Solar and Pool');
}

// --- Save gate: validation runs before the store write ----------------------
{
  const saveIdx = form.indexOf('const onSave = async ()');
  assert(saveIdx !== -1, 'TC form defines onSave');
  const saveBlock = form.slice(saveIdx, saveIdx + 700);
  assert(saveBlock.includes('validateTcIntakeConditional(form)'), 'onSave runs the conditional validation');
  assert(
    saveBlock.indexOf('setErrors(violations)') < saveBlock.indexOf('store.saveTcIntake'),
    'violations block the save call',
  );
  assert(form.includes('const [errors, setErrors] = useState'), 'TC form holds field-error state');
}

// --- Vendors: officer fields directly under Escrow company -------------------
{
  const companyIdx = form.indexOf('testID="tc-escrow-company"');
  const nameIdx = form.indexOf('testID="tc-escrow-officer-name"');
  const contactIdx = form.indexOf('testID="tc-escrow-officer-contact"');
  const titleIdx = form.indexOf('testID="tc-title-company"');
  assert(
    companyIdx !== -1 && nameIdx > companyIdx && contactIdx > nameIdx && titleIdx > contactIdx,
    'officer fields sit under Escrow company, before Title company',
  );
  assert(form.includes('label="Escrow officer name"'), 'officer name label');
  assert(form.includes('label="Officer contact info"'), 'officer contact label');
}

summary('tc-intake-additions');
