// recency.test.ts — 4-hour recency expiry for client-view "Just now" markers.
// Run: see tests/run.sh. "now" is always the device clock; no fixed dates.
import { assert, summary } from './assert';
import { RECENCY_WINDOW_HOURS, RECENCY_WINDOW_MS, isRecent } from '../src/lib/recency';
import { mostRecentCheckoff, sortCompletedFirst } from '../src/lib/clientView';
import type { StepT } from '../src/lib/types';

declare const process: { exitCode?: number };

const MIN = 60_000;
const HOUR = 60 * MIN;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function step(partial: Partial<StepT> & { id: string }): StepT {
  return {
    id: partial.id,
    title: partial.title ?? 'Step',
    subtitle: partial.subtitle ?? '',
    done: partial.done ?? false,
    custom: partial.custom ?? false,
    order: partial.order ?? 0,
    completedAt: partial.completedAt ?? null,
  };
}

async function main(): Promise<void> {
  // The window constant is exactly 4 hours and is the module-level knob.
  assert(RECENCY_WINDOW_HOURS === 4, 'RECENCY_WINDOW_HOURS is 4');
  assert(RECENCY_WINDOW_MS === 4 * HOUR, 'RECENCY_WINDOW_MS derives from the constant');

  const now = Date.now();

  // Marker visible just inside the window: 3h59m after checkoff.
  assert(
    isRecent(isoAt(now - (3 * HOUR + 59 * MIN)), now) === true,
    'marker visible at 3h59m after checkoff',
  );

  // Marker gone just past the window: 4h01m after checkoff.
  assert(
    isRecent(isoAt(now - (4 * HOUR + 1 * MIN)), now) === false,
    'marker gone at 4h01m after checkoff',
  );

  // Boundary edges.
  assert(isRecent(isoAt(now), now) === true, 'fresh checkoff is recent');
  assert(isRecent(isoAt(now - 4 * HOUR), now) === true, 'exactly 4h is still recent');
  assert(isRecent(isoAt(now + MIN), now) === false, 'future checkoff is never recent');
  assert(isRecent(null, now) === false, 'undone step is not recent');
  assert(isRecent('not-a-date', now) === false, 'invalid timestamp is not recent');

  // After expiry the step REMAINS in Completed; only the marker disappears.
  const old = step({ id: 'a', done: true, order: 0, completedAt: isoAt(now - 5 * HOUR) });
  const completed = sortCompletedFirst([old]);
  assert(completed.length === 1 && completed[0].id === 'a', 'expired step stays in Completed');
  assert(mostRecentCheckoff([old], now) === null, 'notice disappears after expiry');

  // Completed orders most-recent-first, independent of checklist order.
  const older = step({ id: 'b', done: true, order: 0, completedAt: isoAt(now - 2 * HOUR) });
  const newer = step({ id: 'c', done: true, order: 1, completedAt: isoAt(now - MIN) });
  const ordered = sortCompletedFirst([older, newer]);
  assert(ordered[0].id === 'c' && ordered[1].id === 'b', 'Completed is most-recent-first');

  // The notice names the most recently checked-off step while it is recent.
  assert(
    mostRecentCheckoff([older, newer], now)?.id === 'c',
    'notice names the most recent checkoff while recent',
  );

  summary('recency');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
