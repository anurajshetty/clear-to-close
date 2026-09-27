// Clear to Close — client top-card status-pill logic (pure, unit-tested).
//
// Two pill states live on the client home top card (branding redesign,
// APPROVED mockup screens 7 "banner bleed" + 9 "ahead of pace", Sept 2026):
//  - completion (100% checklist): 5+ days left -> "Checklist complete with {N}
//    days to spare. {Name} has you ahead of schedule." Fewer than 5 -> the
//    unchanged "Congratulations, your checklist is complete".
//  - ahead of pace (in progress): completion % runs 15+ percentage points
//    ahead of time-elapsed % -> "Ahead of pace. {Name} has you {X} days ahead
//    of schedule." Never at 100% (the completion messages own that state),
//    never on a missing or degenerate timeline — show nothing rather than a
//    wrong number.
import { daysBetween, localDateISO } from './dates';

/** Points of completion-% ahead of elapsed-% required to earn the pill. */
export const PACE_GAP_POINTS = 15;

export type PaceResult = { kind: 'ahead'; daysAhead: number } | { kind: 'none' };

export function firstNameOf(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function aheadOfPace(args: {
  done: number;
  total: number;
  openDate?: string | null;
  closeDate?: string | null;
  nowMs?: number;
}): PaceResult {
  const { done, total, openDate, closeDate, nowMs = Date.now() } = args;
  // 100% belongs to the completion pill — never show ahead-of-pace there.
  if (!(total > 0) || done >= total) return { kind: 'none' };
  if (!openDate || !closeDate) return { kind: 'none' };
  let timelineDays: number;
  let elapsedDays: number;
  try {
    timelineDays = daysBetween(openDate, closeDate);
    elapsedDays = daysBetween(openDate, localDateISO(new Date(nowMs)));
  } catch {
    // Malformed date: show nothing, never a wrong number.
    return { kind: 'none' };
  }
  if (!(timelineDays > 0)) return { kind: 'none' };
  // Pre-open: today before the open date must not inflate the gap (a
  // negative elapsed % would otherwise count as "ahead").
  const clampedElapsed = Math.max(0, elapsedDays);
  const completionPct = (done / total) * 100;
  const elapsedPct = (clampedElapsed / timelineDays) * 100;
  const gap = completionPct - elapsedPct;
  if (gap < PACE_GAP_POINTS) return { kind: 'none' };
  const daysAhead = Math.round((gap / 100) * timelineDays);
  if (!(daysAhead >= 1)) return { kind: 'none' };
  return { kind: 'ahead', daysAhead };
}

export type CompletionPill =
  | { variant: 'spare'; text: string }
  | { variant: 'done'; text: string }
  | null;

export function completionPill(args: {
  done: number;
  total: number;
  daysToClose: number;
  name: string;
}): CompletionPill {
  const { done, total, daysToClose, name } = args;
  if (!(total > 0) || done !== total) return null;
  if (daysToClose >= 5) {
    const first = firstNameOf(name);
    // No name on the profile: drop the name clause rather than leaving a
    // blank ("  has you..."). Second person keeps it pronoun-free.
    const tail = first ? `${first} has you ahead of schedule.` : `You're ahead of schedule.`;
    return {
      variant: 'spare',
      text: `Checklist complete with ${daysToClose} days to spare. ${tail}`,
    };
  }
  // Unchanged existing copy for the under-5-days case.
  return { variant: 'done', text: 'Congratulations, your checklist is complete' };
}
