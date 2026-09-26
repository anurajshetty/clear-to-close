// Clear to Close — pure client-view list helpers (no JSX, unit-testable).
//
// Completed sorts most-recently-completed first; Remaining stays in checklist
// order. Recency expiry only removes markers — a completed step stays in
// Completed forever once done.

import type { StepT } from './types';
import { isRecent } from './recency';

/** Most-recently-completed first (falls back to checklist order on ties). */
export function sortCompletedFirst(steps: StepT[]): StepT[] {
  return steps
    .filter((s) => s.done)
    .sort((a, b) => {
      const at = a.completedAt ? Date.parse(a.completedAt) : -1;
      const bt = b.completedAt ? Date.parse(b.completedAt) : -1;
      if (at !== bt) return bt - at;
      return a.order - b.order;
    });
}

/** Remaining steps in checklist order. */
export function sortRemainingSteps(steps: StepT[]): StepT[] {
  return steps.filter((s) => !s.done).sort((a, b) => a.order - b.order);
}

/**
 * The step named by the "your realtor checked off X just now" notice: the
 * most recently completed step, but only while its checkoff is still recent.
 * Returns null once the recency window expires (the step itself stays in
 * Completed; only the notice disappears).
 */
export function mostRecentCheckoff(
  steps: StepT[],
  nowMs: number = Date.now(),
): StepT | null {
  const completed = sortCompletedFirst(steps);
  if (completed.length === 0) return null;
  const top = completed[0];
  return isRecent(top.completedAt, nowMs) ? top : null;
}
