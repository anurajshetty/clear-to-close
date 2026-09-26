// Clear to Close — client-view recency window for "Just now" markers.
//
// The "Just now" tag on a newly checked-off step and the "your realtor checked
// off X just now" notice are shown only while (now - checkoffTimestamp) falls
// inside this window, computed at view render from the device clock. After the
// window expires the step stays in Completed; only the marker disappears.
// There is no live ticking and no timers anywhere in this module.

/** Hours a checkoff stays "recent" on client views. Easily adjustable. */
export const RECENCY_WINDOW_HOURS = 4;

/** Milliseconds in the recency window, derived from RECENCY_WINDOW_HOURS. */
export const RECENCY_WINDOW_MS = RECENCY_WINDOW_HOURS * 3_600_000;

/**
 * Returns true when `completedAt` (ISO timestamp, e.g. step.completedAt) is
 * within the recency window relative to `nowMs` (defaults to the device
 * clock). Future timestamps and invalid values are never recent.
 */
export function isRecent(
  completedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!completedAt) return false;
  const ts = Date.parse(completedAt);
  if (Number.isNaN(ts)) return false;
  const age = nowMs - ts;
  return age >= 0 && age <= RECENCY_WINDOW_MS;
}
