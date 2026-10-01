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

// ---- 4. Alert-hint suppression when the mapped step is checked off ----
// (Anuraj, Oct 2026): the Key dates entry-row hint appears ONLY when the
// checklist step mapped to that date is NOT checked off. A checked-off
// mapped step excludes its date from hint candidacy — the next most urgent
// ELIGIBLE date becomes the hint. Closing date has no mapping (unchanged).
// Matched by templateKey, never by title; a missing step or missing
// role/steps falls back to the old behavior (eligible) — a hint is never
// hidden without proof the step is complete.
import {
  keyDateTemplateKey,
  eligibleKeyDateCandidates,
  mostUrgentKeyDate as mostUrgent2,
  type KeyDateCandidate,
} from '../src/lib/keyDates';

// 4a. keyDateTemplateKey mapping (mirrors stepKeyDateISO).
assert(
  keyDateTemplateKey('inspection', 'buyer') === 'release-contingencies',
  'inspection/buyer -> release-contingencies',
);
assert(
  keyDateTemplateKey('inspection', 'seller') === 'contingency-release',
  'inspection/seller -> contingency-release',
);
assert(
  keyDateTemplateKey('appraisal', 'buyer') === 'appraisal-scheduled',
  'appraisal/buyer -> appraisal-scheduled',
);
assert(
  keyDateTemplateKey('appraisal', 'seller') === 'appraisal-scheduled',
  'appraisal/seller -> appraisal-scheduled',
);
assert(
  keyDateTemplateKey('loan', 'buyer') === 'signed-loan-docs',
  'loan/buyer -> signed-loan-docs',
);
assert(
  keyDateTemplateKey('loan', 'seller') === null,
  'loan/seller -> null (buyer only)',
);

// 4b. Eligibility. Fixed today for deterministic day math.
const HTODAY = '2026-10-01';
const HCANDIDATES: KeyDateCandidate[] = [
  { key: 'close', label: 'Closing date', date: '2026-11-15' },
  // overdue by 1 day
  { key: 'inspection', label: 'Release contingency deadline', date: '2026-09-30' },
  // overdue by 5 days
  { key: 'appraisal', label: 'Appraisal deadline', date: '2026-09-26' },
  { key: 'loan', label: 'Loan approval date', date: '2026-10-20' },
];
const mkSteps = (doneKeys: string[]) =>
  ['release-contingencies', 'appraisal-scheduled', 'signed-loan-docs'].map((k) => ({
    templateKey: k,
    done: doneKeys.includes(k),
  }));

// Nothing checked: the most overdue eligible date (appraisal, 5 days) wins.
let eligible = eligibleKeyDateCandidates(HCANDIDATES, 'buyer', mkSteps([]));
let urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Appraisal deadline',
  'unchecked mapped step: appraisal hint wins (most overdue)',
);

// Appraisal checked: excluded; the next most urgent eligible date
// (inspection, overdue by 1 day) becomes the hint.
eligible = eligibleKeyDateCandidates(HCANDIDATES, 'buyer', mkSteps(['appraisal-scheduled']));
urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Release contingency deadline',
  'checked appraisal step: inspection hint wins',
);

// Appraisal + inspection checked: loan (Oct 20, muted) beats closing (Nov 15).
eligible = eligibleKeyDateCandidates(
  HCANDIDATES,
  'buyer',
  mkSteps(['appraisal-scheduled', 'release-contingencies']),
);
urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Loan approval date',
  'two checked steps: loan hint wins over later closing',
);

// All mapped steps checked and no closing date: no hint at all.
const NO_CLOSE: KeyDateCandidate[] = HCANDIDATES.map((c) =>
  c.key === 'close' ? { ...c, date: null } : c,
);
eligible = eligibleKeyDateCandidates(
  NO_CLOSE,
  'buyer',
  mkSteps(['appraisal-scheduled', 'release-contingencies', 'signed-loan-docs']),
);
urgent = mostUrgent2(eligible, HTODAY);
assert(urgent === null, 'all mapped steps checked, no closing date -> no hint');

// Closing date is never suppressed: checked everything else, closing stays.
eligible = eligibleKeyDateCandidates(
  HCANDIDATES,
  'buyer',
  mkSteps(['appraisal-scheduled', 'release-contingencies', 'signed-loan-docs']),
);
urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Closing date',
  'closing date never suppressed by step state',
);

// Loan suppression is buyer-only: a done buyer loan step does not suppress
// the seller loan hint (seller has no loan mapping).
eligible = eligibleKeyDateCandidates(HCANDIDATES, 'seller', mkSteps(['signed-loan-docs']));
urgent = mostUrgent2(eligible, HTODAY);
assert(
  eligible.some((c) => c.label === 'Loan approval date'),
  'seller: loan date stays eligible despite done buyer loan step',
);

// Missing step (templateKey absent): fail-open, the date stays eligible.
eligible = eligibleKeyDateCandidates(HCANDIDATES, 'buyer', []);
urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Appraisal deadline',
  'absent steps -> old behavior (appraisal hint)',
);

// Missing role/steps: old behavior, all four candidates eligible.
eligible = eligibleKeyDateCandidates(HCANDIDATES, undefined, undefined);
assert(eligible.length === 4, 'missing role/steps -> all candidates eligible');

// Unchecking restores eligibility: toggling done back to false brings the hint back.
const toggled = mkSteps(['appraisal-scheduled']).map((s) =>
  s.templateKey === 'appraisal-scheduled' ? { ...s, done: false } : s,
);
eligible = eligibleKeyDateCandidates(HCANDIDATES, 'buyer', toggled);
urgent = mostUrgent2(eligible, HTODAY);
assert(
  urgent !== null && urgent.label === 'Appraisal deadline',
  'unchecked step restores hint eligibility',
);

summary('step_key_dates');
