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
