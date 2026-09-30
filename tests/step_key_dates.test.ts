// step_key_dates.test.ts — REGRESSION: key dates on checklist steps + rename.
// (Anuraj, Sept 30, 2026 — approved sample 06 + label rename.)
//
// 1. Mapping (src/lib/keyDates.ts stepKeyDateISO): when a key date is set, the
//    matching step carries it (rendered muted in parentheses on the title,
//    whether or not the step is checked off). Matched by templateKey so a
//    realtor-renamed step still carries its date. 'close-escrow' is excluded
//    per Anuraj's explicit call (the time-tracker card already shows
//    start/end); custom/unknown steps never match.
// 2. Rename: "Inspection contingency deadline" -> "Release contingency
//    deadline" in the three user-facing labels (EscrowFormSheet DateField
//    label + locked label, KeyDates ROW_LABELS). Internal field names
//    (inspectionDeadline) are unchanged.
import { assert, summary } from './assert';
import { stepKeyDateISO, formatShortDate } from '../src/lib/keyDates';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');

// ---- 1. Mapping ----
const DATES = {
  inspectionDeadline: '2026-10-30',
  appraisalDeadline: '2026-10-15',
  loanApprovalDate: '2026-10-22',
};

// Release contingency deadline -> buyer "Release contingencies".
assert(
  stepKeyDateISO('buyer', 'release-contingencies', DATES) === '2026-10-30',
  'buyer release-contingencies maps to inspectionDeadline',
);
// Release contingency deadline -> seller "Contingency release".
assert(
  stepKeyDateISO('seller', 'contingency-release', DATES) === '2026-10-30',
  'seller contingency-release maps to inspectionDeadline',
);
// Appraisal deadline -> "Appraisal scheduled" (both roles).
assert(
  stepKeyDateISO('buyer', 'appraisal-scheduled', DATES) === '2026-10-15',
  'buyer appraisal-scheduled maps to appraisalDeadline',
);
assert(
  stepKeyDateISO('seller', 'appraisal-scheduled', DATES) === '2026-10-15',
  'seller appraisal-scheduled maps to appraisalDeadline',
);
// Loan approval date -> "Signed loan docs" (buyer only — no seller step).
assert(
  stepKeyDateISO('buyer', 'signed-loan-docs', DATES) === '2026-10-22',
  'buyer signed-loan-docs maps to loanApprovalDate',
);
assert(
  stepKeyDateISO('seller', 'signed-loan-docs', DATES) === null,
  'seller signed-loan-docs maps to nothing (buyer only)',
);
// Closing date is NOT shown on "Close escrow" (Anuraj's explicit call).
assert(
  stepKeyDateISO('buyer', 'close-escrow', DATES) === null,
  'close-escrow carries no key date',
);
assert(
  stepKeyDateISO('seller', 'close-escrow', DATES) === null,
  'seller close-escrow carries no key date',
);
// Custom steps and unknown keys never match.
assert(stepKeyDateISO('buyer', null, DATES) === null, 'null templateKey -> null');
assert(
  stepKeyDateISO('buyer', undefined, DATES) === null,
  'undefined templateKey -> null',
);
assert(
  stepKeyDateISO('buyer', 'my-custom-step', DATES) === null,
  'unknown templateKey -> null',
);
// Date not set -> nothing rendered.
assert(
  stepKeyDateISO('buyer', 'release-contingencies', {
    ...DATES,
    inspectionDeadline: null,
  }) === null,
  'unset inspectionDeadline -> null (nothing rendered)',
);
assert(
  stepKeyDateISO('buyer', 'release-contingencies', {}) === null,
  'missing dates object fields -> null',
);
// The rendered label uses the existing "Oct 30" short format.
assert(
  formatShortDate('2026-10-30') === 'Oct 30',
  'key-date label format is "Oct 30"',
);

// ---- 2. Rename (source-text; RN components are not importable) ----
const ROOT = path.resolve(process.cwd());
const FORM = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'EscrowFormSheet.tsx'),
  'utf8',
);
const KEYDATES = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'KeyDates.tsx'),
  'utf8',
);

const formNew = (FORM.match(/Release contingency deadline/g) ?? []).length;
assert(
  formNew === 2,
  `EscrowFormSheet has the renamed label twice (DateField + locked), found ${formNew}`,
);
const rowLabels = KEYDATES.match(/inspection: 'Release contingency deadline'/) !== null;
assert(rowLabels, "KeyDates ROW_LABELS.inspection is 'Release contingency deadline'");

// No user-facing "Inspection contingency deadline" label remains. The code
// comment at the top of KeyDates.tsx and the internal `inspectionDeadline`
// field name are intentionally untouched.
const formOldLabels = (FORM.match(/Inspection contingency deadline/g) ?? []).length;
assert(
  formOldLabels === 0,
  `EscrowFormSheet has no old label left, found ${formOldLabels}`,
);
const keyDatesLines = KEYDATES.split('\n');
const oldLabelLines = keyDatesLines.filter(
  (l: string, i: number) =>
    l.includes('Inspection contingency deadline') && !l.trim().startsWith('//'),
);
assert(
  oldLabelLines.length === 0,
  'KeyDates has no old label outside comments',
);

// ---- 3. Edit-mode drafts carry templateKey (Sept 30, 2026 follow-up) ----
// Key dates must show while editing, not just after save. The draft is
// created in startEditing and mapped back to list steps in two render
// paths; all three must carry templateKey. The save path
// (computeApplyChecklist) already reads d.templateKey with a prev-step
// fallback, so no store change was needed.
const DETAIL = fs.readFileSync(
  path.join(ROOT, 'app', 'escrow', '[id].tsx'),
  'utf8',
);
const TYPES = fs.readFileSync(
  path.join(ROOT, 'src', 'lib', 'types.ts'),
  'utf8',
);
assert(
  /templateKey\?: string \| null;/.test(TYPES),
  'ChecklistDraftStep declares templateKey',
);
assert(
  DETAIL.includes('templateKey: s.templateKey,'),
  'startEditing carries templateKey into the draft',
);
const draftMappings = (DETAIL.match(/templateKey: d\.templateKey,/g) ?? []).length;
assert(
  draftMappings === 2,
  `both draft->list render mappings carry templateKey, found ${draftMappings}`,
);
// Custom steps added in edit mode get no key -> no date (addToDraft).
const addLine = DETAIL.split('\n').find((l: string) =>
  l.includes('custom: true, completedAt: null'),
);
assert(addLine !== undefined, 'addToDraft line exists');
assert(
  !addLine!.includes('templateKey'),
  'addToDraft custom steps carry no templateKey (no date on custom steps)',
);

summary('step_key_dates');
