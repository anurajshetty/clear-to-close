// city_removed.test.ts — the City field is gone from the new/edit escrow
// form (Sept 28, 2026, Anuraj: "not needed"). The DB column stays NOT NULL
// and existing rows keep their city; the form simply stops writing it.
// - createEscrow without city succeeds and stores ''.
// - updateEscrow without city preserves the stored city.
// - The form source no longer renders a City field or validates one.
// - The client top card hides the city line when empty (no blank line).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'EscrowFormSheet.tsx');
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date): string => {
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

async function main(): Promise<void> {
  const kv = memoryKV();
  const store = createStore(kv);
  const { openDate, closeDate } = dates();

  // createEscrow without a city succeeds and stores '' (column is NOT NULL).
  const created = await store.createEscrow({
    address: '4187 Oakmont Dr',
    side: 'buy',
    buyerName: 'Test Buyer',
    openDate,
    closeDate,
  });
  assert(created.city === '', 'createEscrow without city stores an empty city');

  // Legacy path: an explicit city still stores.
  const withCity = await store.createEscrow({
    address: '1 Main St',
    city: 'Valencia, CA 91355',
    side: 'sell',
    sellerName: 'Test Seller',
    openDate,
    closeDate,
  });
  assert(withCity.city === 'Valencia, CA 91355', 'createEscrow with city still stores it');

  // updateEscrow without a city preserves the stored city.
  const updated = await store.updateEscrow(withCity.id, {
    address: '2 Main St',
    side: 'sell',
    sellerName: 'Test Seller',
    openDate,
    closeDate,
  });
  assert(
    updated.city === 'Valencia, CA 91355',
    'updateEscrow without city preserves the stored city',
  );

  // The form no longer renders or validates a City field.
  const root = findRepoRoot();
  assert(root !== '', 'could not locate the repo root (EscrowFormSheet.tsx)');
  const form: string = fs.readFileSync(
    path.join(root, 'src', 'components', 'EscrowFormSheet.tsx'),
    'utf8',
  );
  assert(!/testID="escrow-city"/.test(form), 'no City field in the escrow form');
  assert(!/label="City"/.test(form), 'no "City" label in the escrow form');
  assert(!/enter the city/i.test(form), 'no city validation message in the escrow form');
  assert(!/\bcity\b/i.test(form), 'no city reference at all remains in the escrow form');

  // The client top card hides the city line when empty.
  const card: string = fs.readFileSync(
    path.join(root, 'src', 'components', 'ClientTopCard.tsx'),
    'utf8',
  );
  assert(
    /\{city \? \(/.test(card) && /testID="client-city"/.test(card),
    'client top card renders the city line only when a city exists',
  );

  summary('city_removed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
