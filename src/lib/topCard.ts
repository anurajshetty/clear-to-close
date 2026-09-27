// Clear to Close — client top-card visual tokens + composition helpers
// (pure, unit-tested). Correction pass (Anuraj's call, Sept 2026):
//
//  - The top card sits on a solid dark teal background; the realtor's banner
//    image is a header strip at the very TOP of the card (brand-teal
//    gradient strip fallback when no banner is uploaded), with all content
//    below it.
//  - The "days left" number on the card is the default (white) color
//    normally, yellow at 7 or fewer days, red at 3 or fewer days. Overdue
//    and "due today" states keep their own treatments.
//  - At 100% the mid-card completion/pace pill stays visible: the ONLY
//    per-status changes on the top card are the escrow status tag flipping
//    to "Completed" and the shared confetti burst popping from below the
//    card.
import { aheadOfPace, completionPill } from './pace';

/** Solid background of the client top card (dark teal). */
export const CLIENT_TOPCARD_BG = '#011E1D';

/** "days left" number colors on the dark teal card. */
export const DAYS_LEFT_COLORS = {
  /** Default number color. */
  default: '#FFFFFF',
  /** 7 or fewer days left. */
  warn: '#F2C94C',
  /** 3 or fewer days left. */
  alert: '#F06A5E',
} as const;

/** Which color band the "days left" number falls in. */
export type DaysLeftTone = 'default' | 'warn' | 'alert';

/**
 * Days-left color threshold (Sept 2026, Anuraj's call): the number is the
 * default color normally, yellow at 7 or fewer days, red at 3 or fewer days.
 * Callers apply it to the positive "days left" state only; "due today" and
 * overdue keep their own treatments.
 */
export function daysLeftTone(daysToClose: number): DaysLeftTone {
  if (daysToClose <= 3) return 'alert';
  if (daysToClose <= 7) return 'warn';
  return 'default';
}

export type TopCardPill =
  | { kind: 'completion'; text: string }
  | { kind: 'pace'; daysAhead: number }
  | null;

/**
 * The pill shown on the mid-card slot at ANY checklist state (Sept 2026,
 * Anuraj's final call): the completion pill at 100% ("Checklist complete
 * with {N} days to spare..." with 5+ days left, otherwise the unchanged
 * congratulations line), the ahead-of-pace pill mid-escrow, nothing
 * otherwise. There is no 100%-only suppression — the top card keeps its
 * pill at 100%; only the status tag flips and the confetti burst pops.
 */
export function topCardPill(args: {
  done: number;
  total: number;
  daysToClose: number;
  name: string;
  openDate?: string | null;
  closeDate?: string | null;
  nowMs?: number;
}): TopCardPill {
  const { done, total, daysToClose, name, openDate, closeDate, nowMs } = args;
  const completion = completionPill({ done, total, daysToClose, name });
  if (completion) return { kind: 'completion', text: completion.text };
  const pace = aheadOfPace({ done, total, openDate, closeDate, nowMs });
  if (pace.kind === 'ahead') return { kind: 'pace', daysAhead: pace.daysAhead };
  return null;
}
