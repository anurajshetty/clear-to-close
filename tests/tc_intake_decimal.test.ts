// tc_intake_decimal.test.ts — REGRESSION: TC intake amount/% fields accept decimals
// (Anuraj, Sept 29 + Sept 30, 2026 — build-to-mockup fixes).
// The approved mockup 04 specifies inputmode="decimal" for "Realtor total %",
// "Buyer's-agent offer %" (placeholder "2.5", summary shows "2.5%"), and for the
// six amount fields: list price, TC fee, broker fee, HOA monthly amount, solar
// amount, warranty amount. The implementation used keyboardType="numeric", which
// on iOS shows a number pad with no decimal point — decimals could not be typed.
// All eight fields must use keyboardType="decimal-pad". Reads the component
// source as text because RN components are not importable in the node suite.
import { assert, summary } from './assert';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.cwd());
const SRC = fs.readFileSync(path.join(ROOT, 'app', 'tc-intake', '[escrowId].tsx'), 'utf8');

function fieldLine(testID: string): string | null {
  const line = SRC.split('\n').find((l: string) => l.includes(`testID="${testID}"`));
  return line ?? null;
}

for (const testID of [
  'tc-total-pct',
  'tc-buyer-pct',
  // Sept 30, 2026: the six remaining amount fields.
  'tc-list-price',
  'tc-tc-fee',
  'tc-broker-fee',
  'tc-hoa-amount',
  'tc-solar-amount',
  'tc-warranty-amount',
]) {
  const line = fieldLine(testID);
  assert(line !== null, `field ${testID} exists`);
  assert(line!.includes('keyboardType="decimal-pad"'),
    `${testID} uses keyboardType="decimal-pad" (iOS decimal pad, so decimals are typeable)`);
  assert(!line!.includes('keyboardType="numeric"'),
    `${testID} does not use keyboardType="numeric" (no decimal point on iOS)`);
}

summary('tc_intake_decimal');
