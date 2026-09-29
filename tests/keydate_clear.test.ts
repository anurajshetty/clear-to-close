// keydate_clear.test.ts — key-date clearing regression (Sept 28, 2026,
// Anuraj-reported bug + approved fix).
//
// BUG: in the Update escrow sheet's Key dates section, the inspection
// deadline, appraisal deadline, and loan approval date could be changed but
// NOT cleared — the native date picker always commits a date, so a set date
// could never be removed.
//
// FIX: a red × clear affordance on each key-date row once a date is set
// (reuses the checklist edit-mode remove-control styling: same Material
// close glyph, red, 44pt target). Closing date gets NO × — close_date is
// required (DB NOT NULL + form/store validation), flagged, left set-only.
// Clearing writes NULL through the synchronous confirmed-write path; the
// client sheet shows cleared dates as a neutral "Not set" row (never
// amber/red, never a crash).
//
// This test pins: (1) the confirmed-write path writes NULL on clear,
// (2) the × affordance exists on the three key-date fields (native + web)
// and NOT on the required close-date field, (3) the client sheet renders
// "Not set" for null rows with the muted style, (4) the entry-point hint
// skips nulls. Fails without the fix, passes with it.
// Run: see tests/run.sh (node, no framework). Dates computed at runtime.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { mostUrgentKeyDate } from '../src/lib/keyDates';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'DateField.tsx');
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

function readSrc(root: string, ...parts: string[]): string {
  return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

function dates(): { openDate: string; closeDate: string; d1: string; d2: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const plus = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };
  return { openDate: plus(0), closeDate: plus(61), d1: plus(20), d2: plus(30) };
}

async function main(): Promise<void> {
  const root = findRepoRoot();
  assert(root !== '', 'could not locate the repo root');
  const dateField = readSrc(root, 'src', 'components', 'DateField.tsx');
  const dateFieldWeb = readSrc(root, 'src', 'components', 'DateField.web.tsx');
  const formSheet = readSrc(root, 'src', 'components', 'EscrowFormSheet.tsx');
  const keyDatesView = readSrc(root, 'src', 'components', 'KeyDates.tsx');

  // ---- 1. confirmed-write path: clearing writes NULL ----
  const kv = memoryKV();
  const store = createStore(kv);
  const { openDate, closeDate, d1, d2 } = dates();
  const escrow = await store.createEscrow({
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'both',
    buyerName: 'Test Buyer',
    sellerName: 'Test Seller',
    openDate,
    closeDate,
  });
  const base = {
    address: escrow.address,
    side: escrow.side,
    buyerName: escrow.buyerName ?? undefined,
    sellerName: escrow.sellerName ?? undefined,
    openDate: escrow.openDate,
    closeDate: escrow.closeDate,
  };
  // Set all three key dates.
  const withDates = await store.updateEscrow(escrow.id, {
    ...base,
    inspectionDeadline: d1,
    appraisalDeadline: d2,
    loanApprovalDate: d1,
  });
  assert(
    withDates.inspectionDeadline === d1 &&
      withDates.appraisalDeadline === d2 &&
      withDates.loanApprovalDate === d1,
    'setting the three key dates stores them',
  );
  // Clear one: explicit null writes NULL through the confirmed path.
  const cleared = await store.updateEscrow(escrow.id, {
    ...base,
    inspectionDeadline: null,
    appraisalDeadline: d2,
    loanApprovalDate: d1,
  });
  assert(cleared.inspectionDeadline === null, 'clearing writes NULL (inspection deadline)');
  assert(
    cleared.appraisalDeadline === d2 && cleared.loanApprovalDate === d1,
    'clearing one date leaves the other two untouched',
  );
  // Clearing all three at once.
  const clearedAll = await store.updateEscrow(escrow.id, {
    ...base,
    inspectionDeadline: null,
    appraisalDeadline: null,
    loanApprovalDate: null,
  });
  assert(
    clearedAll.inspectionDeadline === null &&
      clearedAll.appraisalDeadline === null &&
      clearedAll.loanApprovalDate === null,
    'clearing all three writes NULL for each',
  );
  // Omitted (undefined) still preserves — the clear path must not leak into
  // ordinary edits.
  const preserved = await store.updateEscrow(escrow.id, { ...base });
  assert(
    preserved.inspectionDeadline === null &&
      preserved.appraisalDeadline === null &&
      preserved.loanApprovalDate === null,
    'omitted key dates preserve the stored (cleared) values',
  );

  // ---- 2. the × affordance: native DateField ----
  assert(/onClear\?: \(\) => void/.test(dateField), 'DateField exposes an optional onClear prop');
  assert(
    /canClear/.test(dateField) && /!!onClear/.test(dateField),
    'the × renders only where the owner passes onClear',
  );
  assert(/!!selected/.test(dateField), 'the × renders only once a date is set');
  assert(
    /CLEAR_X_PATH/.test(dateField) && dateField.includes('M19 6.41L17.59 5 12 10.59'),
    'the × reuses the checklist remove-control glyph (no new design language)',
  );
  assert(/fill=\{colors\.red\}/.test(dateField), 'the × is red');
  assert(
    /width: 44,\s*\n?\s*height: 44/.test(dateField),
    'the × keeps the 44pt remove-control target',
  );
  assert(/`Clear \$\{label\}`/.test(dateField), 'the × is labelled "Clear {label}"');
  assert(
    /\$\{testID\}-clear/.test(dateField),
    'the × carries a {testID}-clear testID',
  );

  // ---- 3. the × affordance: web DateField ----
  // (The web file imports DateFieldProps from the native file, so the prop
  // itself is pinned above; here we pin that web destructures and uses it.)
  assert(
    /function DateField\(\{ label, value, onChange, onClear, testID \}/.test(dateFieldWeb),
    'web DateField destructures onClear',
  );
  assert(/!!onClear/.test(dateFieldWeb), 'web × renders only where onClear is passed');
  assert(/!!value\.trim\(\)/.test(dateFieldWeb), 'web × renders only once a date is set');
  assert(/fill=\{colors\.red\}/.test(dateFieldWeb), 'web × is red');
  assert(/`Clear \$\{label\}`/.test(dateFieldWeb), 'web × is labelled "Clear {label}"');

  // ---- 4. the × is wired to the three key-date fields, NOT the close date ----
  const onClearCount = (formSheet.match(/onClear=\{/g) || []).length;
  assert(onClearCount === 3, `exactly the three key-date fields get onClear (got ${onClearCount})`);
  const closeIdx = formSheet.indexOf('testID="escrow-close-date"');
  assert(closeIdx > 0, 'the close-date DateField exists');
  const closeWindow = formSheet.slice(Math.max(0, closeIdx - 400), closeIdx + 60);
  assert(
    /label="Target close date"/.test(closeWindow) && !/onClear/.test(closeWindow),
    'the required close-date field has NO × (close_date is required)',
  );

  // ---- 5. client sheet: null rows render the neutral "Not set" treatment ----
  assert(/Not set/.test(keyDatesView), 'the client sheet renders "Not set" for null dates');
  assert(
    /date: string \| null/.test(keyDatesView),
    'the client row accepts a null date',
  );
  // The "Not set" line uses the muted style, never the amber/red tones.
  const notSetLine = keyDatesView.match(/<Text style=\{styles\.when\}>Not set<\/Text>/);
  assert(!!notSetLine, '"Not set" uses the muted style (no amber/red urgency)');

  // ---- 6. entry-point hint handles nulls ----
  assert(
    mostUrgentKeyDate(
      [
        { label: 'Closing date', date: null },
        { label: 'Inspection contingency deadline', date: null },
      ],
      '2026-09-28',
    ) === null,
    'all-null dates -> no hint (entry point shows no hint, no crash)',
  );
  const urgent = mostUrgentKeyDate(
    [
      { label: 'Closing date', date: null },
      { label: 'Inspection contingency deadline', date: '2026-10-02' },
    ],
    '2026-09-28',
  );
  assert(
    !!urgent && urgent.label === 'Inspection contingency deadline',
    'null dates are skipped when picking the most urgent date',
  );

  summary('keydate_clear');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
