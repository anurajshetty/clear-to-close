// Clear to Close — client view predicates (Sept 2026).
import type { ClientView } from './types';

/**
 * Review gate (Anuraj's rule, Sept 2026): a client can leave a review ONLY
 * when the full checklist is 100% complete AND the escrow was not
 * cancelled. A cancelled escrow never shows the review button, even if its
 * checklist happens to be complete.
 *
 * An absent status (older cached cloud views) fails open — the gate only
 * ever hides on an explicit 'cancelled', never on missing data.
 */
export function canLeaveReview(
  view: Pick<ClientView, 'done' | 'total' | 'status'>,
): boolean {
  return view.total > 0 && view.done >= view.total && view.status !== 'cancelled';
}

/**
 * Review feature ON HOLD (Anuraj's call, Sept 2026): the review/share entry
 * points are hidden — the "provide review" button and the review/share
 * section are not surfaced. All review code and gating logic stays intact
 * (canLeaveReview above, the 0015 status wiring, the review sheet); only
 * the UI is not shown. Flip back to true to resurface the feature.
 */
export const REVIEWS_ENABLED = false;

/**
 * Client top-card status label (Anuraj's call, Sept 2026): the escrow status
 * next to "YOUR PURCHASE" / "YOUR SALE". Mirrors the get_client_view status
 * semantics (migration 0015): the escrow is "Completed" once its checklist
 * is 100% done or the escrow row itself is closed; anything else is
 * "In progress" (the default when the status is absent or anything
 * unexpected).
 */
export function escrowStatusLabel(
  view: Pick<ClientView, 'done' | 'total' | 'status'>,
): 'In progress' | 'Completed' {
  if (view.status === 'closed') return 'Completed';
  if (view.total > 0 && view.done >= view.total) return 'Completed';
  return 'In progress';
}
