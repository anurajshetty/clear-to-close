// dates.test.ts — REGRESSION: one day-count convention everywhere.
// Bug (Sept 25, 2026): for Sep 25 -> Nov 25 (61 days) the deal card said 61
// but the time-tracker card said "62 days left to close" (and its own timeline
// said "day 1 of 61") and the client view said "62 days to close". Cause:
// Math.ceil(ms / 86400000) on local midnights across the Nov 1 DST fall-back.
// Convention (pinned here): whole calendar days from today to close, exclusive
// of today — 0 = closes today, negative = past target. DST-safe via UTC.
// "today" is always computed at runtime; the fixed-date case below pins the
// DST-crossing pair without hardcoding today.
// Run this file with TZ=America/Los_Angeles (see tests/run.sh) so the DST
// regression is deterministic.
import { assert, summary } from './assert';
import { daysBetween, daysToClose, localDateISO, timeline } from '../src/lib/dates';

declare const process: { exitCode?: number };

function isoPlusDays(base: Date, n: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  return localDateISO(d);
}

async function main(): Promise<void> {
  const now = new Date();
  const todayISO = localDateISO(now);

  // The reported 61-day case, computed from runtime "today".
  assert(daysToClose(isoPlusDays(now, 61)) === 61, '61 calendar days out -> 61 days to close');
  assert(daysToClose(isoPlusDays(now, 1)) === 1, 'tomorrow -> 1 day to close');
  assert(daysToClose(todayISO) === 0, 'same-day close -> 0 days to close');
  assert(daysToClose(isoPlusDays(now, -1)) === -1, 'yesterday -> -1 (past target)');
  assert(daysToClose(isoPlusDays(now, -5)) === -5, '5 days past -> -5');

  // DST regression pin: Sep 25 -> Nov 25 2026 crosses the Nov 1 fall-back in
  // America/Los_Angeles. The old ceil(localMs / DAY) formula returned 62 here.
  assert(daysBetween('2026-09-25', '2026-11-25') === 61, 'DST-crossing span is exactly 61 days');
  const naiveOld = Math.ceil(
    (new Date(2026, 10, 25).getTime() - new Date(2026, 8, 25).getTime()) / 86_400_000,
  );
  assert(naiveOld === 62, 'old ceil formula demonstrably returned 62 for this span');

  // Timeline internals stay consistent with the headline number.
  const t = timeline(todayISO, isoPlusDays(now, 61));
  assert(t.totalDays === 61, 'timeline total is 61');
  assert(t.dayNum === 1, 'timeline starts at day 1');
  assert(
    t.totalDays - (t.dayNum - 1) === daysToClose(isoPlusDays(now, 61)),
    'day X of Y is consistent with days left',
  );

  // Same-day open+close: single-day tracker, 0 days left.
  const same = timeline(todayISO, todayISO);
  assert(same.totalDays === 1 && same.dayNum === 1, 'same-day escrow is day 1 of 1');

  // Past the end date: dayNum clamps to the end, days left goes negative.
  const past = timeline(isoPlusDays(now, -10), isoPlusDays(now, -5));
  assert(past.dayNum === past.totalDays, 'past end date clamps to the final day');
  assert(daysToClose(isoPlusDays(now, -5)) < 0, 'past end date -> negative days to close');

  summary('dates');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
