// property_details.test.ts — the Oct 25, 2026 property-details model:
// formatting (the compact line), defensive row mapping, form parsing,
// and the store create/update round trip + confirmation summary row.
//
// Pins:
//   - the line renders ONLY entered fields, in the approved order,
//     with the approved formats (thousands separators, bathroom
//     decimals trimmed, acres vs sq ft lot rendering, $ price);
//   - all-empty renders NO line (null) — displays key off this;
//   - row mapping tolerates snake_case keys, string numerics, junk;
//   - create carries the details onto the escrow; update replaces
//     them wholesale when provided and preserves them when omitted;
//   - the create confirmation summary gains a Property details row
//     only when something was entered.
import { assert, summary } from './assert';

declare const process: { exitCode?: number };
import {
  EMPTY_PROPERTY_DETAILS,
  formatPropertyLine,
  hasPropertyDetails,
  parsePropertyNumber,
  propertyDetailsFromRow,
  propertyDetailsOf,
  propertyNumberText,
  propertyTypeLabel,
} from '../src/lib/propertyDetails';
import { confirmSummaryRows } from '../src/lib/escrowConfirm';
import { createStore } from '../src/lib/store';
import { memoryKV } from '../src/lib/kv';
import type { PropertyDetails } from '../src/lib/types';

const FULL: PropertyDetails = {
  bedrooms: 4,
  bathrooms: 2.5,
  sqft: 2140,
  lotSize: 7500,
  lotUnit: 'sqft',
  propertyType: 'single_family',
  yearBuilt: 1998,
  listedPrice: 875000,
};

async function main(): Promise<void> {
  // --- the line ---------------------------------------------------------------
  assert(!hasPropertyDetails(EMPTY_PROPERTY_DETAILS), 'empty details: hasPropertyDetails is false');
  assert(formatPropertyLine(EMPTY_PROPERTY_DETAILS) === null, 'empty details: no line renders (null)');
  assert(
    formatPropertyLine(FULL) ===
      '4 bd · 2.5 ba · 2,140 sq ft · Lot 7,500 sq ft · Single-family · Built 1998 · Listed $875,000',
    'full line matches the approved format and order',
  );
  assert(
    formatPropertyLine({ ...EMPTY_PROPERTY_DETAILS, lotSize: 0.25, lotUnit: 'acres' }) === 'Lot 0.25 acres',
    'acres lot renders as a decimal with the acres unit',
  );
  assert(
    formatPropertyLine({ ...EMPTY_PROPERTY_DETAILS, bathrooms: 3 }) === '3 ba',
    'whole bathrooms render without a trailing decimal',
  );
  assert(
    formatPropertyLine({ ...EMPTY_PROPERTY_DETAILS, bedrooms: 4 }) === '4 bd',
    'a single entered field renders alone',
  );
  assert(
    formatPropertyLine({ ...EMPTY_PROPERTY_DETAILS, propertyType: 'condo', listedPrice: 1250000 }) ===
      'Condo · Listed $1,250,000',
    'type + price render without the absent fields',
  );
  assert(propertyTypeLabel('multi_family') === 'Multi-family', 'property type labels map');
  assert(propertyTypeLabel('') === '', 'unchosen property type has no label');

  // --- form parsing -------------------------------------------------------------
  assert(parsePropertyNumber('$875,000') === 875000, 'parse: $ and commas stripped');
  assert(parsePropertyNumber(' 2.5 ') === 2.5, 'parse: decimals survive');
  assert(parsePropertyNumber('') === null, 'parse: blank is null (optional field)');
  assert(parsePropertyNumber('abc') === null, 'parse: junk is null, never a save blocker');
  assert(parsePropertyNumber('-4') === null, 'parse: negatives are null');
  assert(propertyNumberText(2.5) === '2.5' && propertyNumberText(null) === '', 'prefill text round-trips');

  // --- row mapping ---------------------------------------------------------------
  const fromRow = propertyDetailsFromRow({
    bedrooms: 4,
    bathrooms: '2.5',
    sqft: 2140,
    lot_size: '7500',
    lot_unit: 'acres',
    property_type: 'townhouse',
    year_built: 1998,
    listed_price: '875000.00',
  });
  assert(
    fromRow.bedrooms === 4 && fromRow.bathrooms === 2.5 && fromRow.lotSize === 7500 &&
      fromRow.lotUnit === 'acres' && fromRow.propertyType === 'townhouse' &&
      fromRow.listedPrice === 875000,
    'row mapping reads snake_case keys and string numerics',
  );
  const junk = propertyDetailsFromRow({ bedrooms: 'x', lot_unit: 'hectares', property_type: 'castle' });
  assert(
    junk.bedrooms === null && junk.lotUnit === 'sqft' && junk.propertyType === '',
    'row mapping maps junk to the empty defaults',
  );
  const absent = propertyDetailsFromRow({});
  assert(!hasPropertyDetails(absent) && absent.lotUnit === 'sqft', 'pre-0048 rows map to empty details');

  // --- store round trip ------------------------------------------------------------
  const store = createStore(memoryKV());
  const created = await store.createEscrow({
    address: '1 Details Way',
    side: 'buy',
    buyerName: 'Buyer One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
    propertyDetails: FULL,
  });
  assert(propertyDetailsOf(created).listedPrice === 875000, 'create carries the details onto the escrow');
  assert(formatPropertyLine(propertyDetailsOf(created))?.startsWith('4 bd') === true, 'created escrow renders the line');

  const bare = await store.createEscrow({
    address: '2 Plain St',
    side: 'sell',
    sellerName: 'Seller One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
  });
  assert(!hasPropertyDetails(propertyDetailsOf(bare)), 'create without details stays empty');

  const updated = await store.updateEscrow(created.id, {
    address: '1 Details Way',
    side: 'buy',
    buyerName: 'Buyer One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
    propertyDetails: { ...FULL, bedrooms: 5, listedPrice: null },
  });
  assert(
    propertyDetailsOf(updated).bedrooms === 5 && propertyDetailsOf(updated).listedPrice === null,
    'update replaces the details wholesale (a cleared field submits null)',
  );
  const preserved = await store.updateEscrow(created.id, {
    address: '1 Details Way',
    side: 'buy',
    buyerName: 'Buyer One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
  });
  assert(propertyDetailsOf(preserved).bedrooms === 5, 'update omitting the details preserves them');

  // --- confirmation summary ---------------------------------------------------------
  const withDetails = confirmSummaryRows({
    address: '1 Details Way',
    side: 'buy',
    buyerName: 'Buyer One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
    propertyDetails: FULL,
  });
  const propRow = withDetails.find((r) => r.testID === 'confirm-property-details');
  assert(!!propRow && propRow.value.startsWith('4 bd'), 'confirm summary gains the property row when details were entered');
  const without = confirmSummaryRows({
    address: '2 Plain St',
    side: 'sell',
    sellerName: 'Seller One',
    openDate: '2026-10-25',
    closeDate: '2026-12-25',
    propertyDetails: EMPTY_PROPERTY_DETAILS,
  });
  assert(
    !without.some((r) => r.testID === 'confirm-property-details'),
    'confirm summary has no property row when nothing was entered',
  );

  summary('property_details');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
