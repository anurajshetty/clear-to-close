// Clear to Close — step explainers (Sept 28, 2026, Anuraj-approved).
//
// CANONICAL COPY: ~/workspace/app-ideas/realtor-app/design/step-explainers.md
// (approved Sept 28, 2026). Static, bundled, no jargon, no em dashes in the
// one-liners. Do not reword from the HTML mockups — edit the canonical file
// first, then mirror it here.
//
// Client checklists are tappable: tapping a row reveals a one-line
// plain-language explainer below the title; tapping again collapses. The
// LATEST FROM card's step name reveals the same one-liner (one content
// source, two surfaces).
//
// RESOLUTION (Anuraj, Sept 28, 2026 — fail closed): a default explainer is
// shown ONLY when the step is a default step (custom === false) AND its
// templateKey is a known template key. Titles are realtor-editable and are
// NEVER used for explainer resolution. Custom steps show only the
// realtor-written line (StepT.explainer); a custom step titled identically
// to a default step must NOT receive the default explainer. Unrecognized
// steps get no explainer — never a wrong one.
//
// Template-key lookup, NEVER title lookup (Anuraj, Sept 28, 2026). The
// template titles match the canonical copy (incl. "Escrow opened"); legacy
// rows titled "Escrow open" backfill to the same key in steps.ts.

import type { ClientRole } from './types';
import type { StepT } from './types';
import { isKnownTemplateKey } from './steps';

const BUYER_EXPLAINERS: Record<string, string> = {
  'escrow-open': 'Your deal is officially underway. The countdown to closing starts now.',
  'earnest-money-wired':
    'Your good-faith deposit is in escrow. It goes toward your purchase at closing.',
  'property-inspection-scheduled':
    'An inspector walks the property and reports on its condition, so you know what you are buying.',
  'appraisal-scheduled':
    'Your lender orders a valuation to confirm the home is worth the loan amount.',
  'homeowners-insurance-quote':
    'A quote for the policy that protects your new home. Your lender requires one.',
  'sellers-disclosure-hoa-docs-received':
    "The seller's written history of the property, plus HOA rules and finances. Read them carefully.",
  'termite-inspection-report':
    'A check for termite damage, required by most lenders before they fund.',
  'signed-loan-docs': "Your lender's final paperwork. You will sign these at closing.",
  'release-contingencies':
    'You remove your inspection and appraisal protections, committing to the purchase.',
  'review-closing-disclosure':
    'Your final cost breakdown. Compare it to your loan estimate before signing.',
  'schedule-final-walkthrough':
    'One last visit to confirm the home is in the condition you agreed on.',
  'close-escrow': 'Funding is complete and ownership transfers to you.',
  'record-deal': 'The county records the sale, making your ownership official.',
  'get-keys': 'Keys in hand. The home is yours.',
};

const SELLER_EXPLAINERS: Record<string, string> = {
  'escrow-open': 'Your sale is officially underway. The countdown to closing starts now.',
  'wire-received': "The buyer's earnest money deposit has arrived in escrow.",
  'property-inspection-scheduled':
    'The buyer is having the property inspected. The report can trigger repair requests.',
  'appraisal-scheduled':
    "The buyer's lender orders a valuation to confirm the home covers the loan.",
  'seller-disclosure-due':
    'Your written history of the property. California requires it before closing.',
  'order-home-warranty':
    'A warranty plan for the buyer, covering major systems and appliances after closing.',
  'contingency-release': 'The buyer removes their inspection and appraisal protections.',
  'signed-closing-docs': "The buyer has signed the lender's final paperwork.",
  'schedule-utilities':
    'Shut-off dates for power, water, and gas at this home. Your realtor coordinates the final reads.',
  'final-walkthrough-scheduled': "The buyer takes one last look to confirm the home's condition.",
  'close-escrow': 'Funding is complete and ownership transfers to the buyer.',
  'record-deed': 'The county records the sale, making the transfer official.',
};

export interface ExplainerStep {
  custom: boolean;
  /** Permanent template key (src/lib/steps.ts). Absent on pre-key steps. */
  templateKey?: string | null;
  /** Realtor-written line for custom steps. */
  explainer?: string | null;
}

/**
 * The one-line explainer for a client checklist row, or null when the row
 * has nothing to expand. Fail closed: default copy only for default steps
 * with a known template key; custom steps only ever show the realtor's
 * own line.
 */
export function stepExplainer(role: ClientRole, step: ExplainerStep): string | null {
  if (step.custom) {
    const line = (step.explainer ?? '').trim();
    return line ? line : null;
  }
  const key = step.templateKey;
  if (!key || !isKnownTemplateKey(key)) return null;
  const map = role === 'buyer' ? BUYER_EXPLAINERS : SELLER_EXPLAINERS;
  return map[key] ?? null;
}

/** Convenience overload for full step records. */
export function stepExplainerFor(role: ClientRole, step: StepT): string | null {
  return stepExplainer(role, {
    custom: step.custom,
    templateKey: step.templateKey,
    explainer: step.explainer,
  });
}

/** Every template key this role ships must have an explainer (test guard). */
export function explainerCoverage(role: ClientRole, keys: string[]): string[] {
  const map = role === 'buyer' ? BUYER_EXPLAINERS : SELLER_EXPLAINERS;
  return keys.filter((k) => !(k in map));
}
