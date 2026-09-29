// Clear to Close — default step templates, from the approved mockups.
//
// Each template carries a permanent `key` (e.g. 'earnest-money-wired').
// The key is stamped onto every built step as `templateKey` and is the
// ONLY thing the client explainer lookup trusts: realtor-editable titles
// must never drive explainer resolution (Anuraj, Sept 28, 2026). Keys are
// never renamed or reused; new templates get new keys.

import type { ClientRole } from './types';

export interface StepTemplate {
  t: string;
  s: string;
  /** Permanent, unique-per-role lookup key. Never rename an existing key. */
  key: string;
}

export const BUY_STEPS: StepTemplate[] = [
  { t: 'Escrow opened', s: 'See the time tracker card above.', key: 'escrow-open' },
  { t: 'Earnest money wired', s: 'Within 3 days of open.', key: 'earnest-money-wired' },
  { t: 'Property inspection scheduled', s: '', key: 'property-inspection-scheduled' },
  { t: 'Appraisal scheduled', s: '', key: 'appraisal-scheduled' },
  { t: 'Homeowners insurance quote', s: '', key: 'homeowners-insurance-quote' },
  {
    t: "Seller's disclosure / HOA docs received",
    s: '',
    key: 'sellers-disclosure-hoa-docs-received',
  },
  // Added Sept 28, 2026: the approved mockups list 14 buyer steps; the app
  // shipped 13. Order per the mockup (after disclosures, before loan docs).
  { t: 'Termite inspection report', s: '', key: 'termite-inspection-report' },
  { t: 'Signed loan docs', s: '', key: 'signed-loan-docs' },
  { t: 'Release contingencies', s: '', key: 'release-contingencies' },
  { t: 'Review closing disclosure', s: '', key: 'review-closing-disclosure' },
  { t: 'Schedule final walkthrough', s: '', key: 'schedule-final-walkthrough' },
  { t: 'Close escrow', s: '', key: 'close-escrow' },
  { t: 'Record deal', s: '', key: 'record-deal' },
  { t: 'Get keys', s: 'Hand over the keys. Done.', key: 'get-keys' },
];

export const SELL_STEPS: StepTemplate[] = [
  { t: 'Escrow opened', s: 'See the time tracker card above.', key: 'escrow-open' },
  { t: 'Wire received', s: 'Earnest money from the buyer.', key: 'wire-received' },
  { t: 'Property inspection scheduled', s: '', key: 'property-inspection-scheduled' },
  { t: 'Appraisal scheduled', s: '', key: 'appraisal-scheduled' },
  { t: 'Seller disclosure due', s: '', key: 'seller-disclosure-due' },
  // Added Sept 28, 2026: the approved mockups list 13 seller steps; the app
  // shipped 12. Order per the mockup (after disclosure due, before warranty).
  { t: 'Pool equipment inspection', s: '', key: 'pool-equipment-inspection' },
  { t: 'Order home warranty', s: '', key: 'order-home-warranty' },
  { t: 'Contingency release', s: '', key: 'contingency-release' },
  { t: 'Signed closing docs', s: '', key: 'signed-closing-docs' },
  {
    t: 'Schedule utilities',
    s: 'Final meter reads and shut-off dates.',
    key: 'schedule-utilities',
  },
  { t: 'Final walkthrough scheduled', s: '', key: 'final-walkthrough-scheduled' },
  { t: 'Close escrow', s: '', key: 'close-escrow' },
  { t: 'Record deed', s: '', key: 'record-deed' },
];

const BUYER_TITLE_TO_KEY = new Map(BUY_STEPS.map((t) => [t.t, t.key]));
const SELLER_TITLE_TO_KEY = new Map(SELL_STEPS.map((t) => [t.t, t.key]));
// Legacy titles (pre-Sept-28-2026): escrows created before the mockup copy
// alignment carry the old titles; they backfill to the same keys.
// NOTE: keep these OUT of the explainer inventory — lookup is by key only.
BUYER_TITLE_TO_KEY.set('Escrow open', 'escrow-open');
SELLER_TITLE_TO_KEY.set('Escrow open', 'escrow-open');

const KNOWN_KEYS = new Set<string>([
  ...BUY_STEPS.map((t) => t.key),
  ...SELL_STEPS.map((t) => t.key),
]);

/** True when the key is one this app version knows (fail-closed guard). */
export function isKnownTemplateKey(key: string): boolean {
  return KNOWN_KEYS.has(key);
}

/**
 * One-time upgrade backfill (Anuraj, Sept 28, 2026): steps built before
 * template keys existed have `custom: false` and no `templateKey`. Match
 * their title against the template titles to recover the key. Safe: the
 * shipped UI has no rename affordance, so default titles are intact.
 *
 * Custom steps NEVER receive a key, even when their title happens to match
 * a default title — a custom step must never resolve a default explainer.
 * Unmatched titles return null (no explainer, never a wrong one).
 */
export function backfillTemplateKey(
  role: ClientRole,
  step: { custom: boolean; title: string; templateKey?: string | null },
): string | null {
  if (step.custom) return null;
  if (step.templateKey) return step.templateKey;
  const map = role === 'buyer' ? BUYER_TITLE_TO_KEY : SELLER_TITLE_TO_KEY;
  return map.get(step.title) ?? null;
}

/**
 * Visible-title normalization for the approved Sept 28, 2026 rename:
 * "Escrow open" -> "Escrow opened". Existing stored rows carry the old
 * title; new defaults already use the new one. This normalizes the
 * display so all escrows show the approved copy. Idempotent — rows
 * already on the new title are untouched. Custom steps are never touched
 * (a custom step titled "Escrow open" keeps its user-entered title).
 */
export function normalizeStepTitle(
  step: { custom: boolean; title: string; templateKey?: string | null },
): string {
  if (step.custom) return step.title;
  const key = step.templateKey ?? null;
  // The key may not be backfilled yet at the call site; fall back to
  // matching the legacy title directly.
  if (step.title === 'Escrow open' && (key === 'escrow-open' || key === null)) {
    return 'Escrow opened';
  }
  return step.title;
}
