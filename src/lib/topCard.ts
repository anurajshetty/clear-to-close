// Clear to Close — client top-card visual tokens + composition helpers
// (pure, unit-tested). Celebration redesign (Anuraj's call, Sept 2026):
//
//  - All client cards are back on the LIGHT theme: the paper screen, white
//    cards. The top card is a white card with a subtle border; the dark
//    teal is gone.
//  - The escrow status tag ("In progress" / "Completed") and the days-left
//    color rule stay, restyled to read on the light background: the number
//    is ink normally, amber at 7 or fewer days, red at 3 or fewer days.
//    Overdue and "due today" keep their own treatments.
//  - At 100% the mid-card completion/pace pill stays visible: the ONLY
//    per-status changes on the top card are the status tag flip and the
//    confetti burst popping from below the card.
import { aheadOfPace, completionPill } from './pace';

/** Solid background of the client top card (white, on the paper screen). */
export const CLIENT_TOPCARD_BG = '#FFFFFF';

/** "days left" number colors on the light top card. */
export const DAYS_LEFT_COLORS = {
  /** Default number color (ink). */
  default: '#211D17',
  /** 7 or fewer days left (amber, readable on white). */
  warn: '#A86A12',
  /** 3 or fewer days left (red). */
  alert: '#B23B3B',
} as const;

/** Which color band the "days left" number falls in. */
export type DaysLeftTone = 'default' | 'warn' | 'alert';

/**
 * Days-left color threshold (Sept 2026, Anuraj's call): the number is the
 * default (ink) color normally, amber at 7 or fewer days, red at 3 or fewer
 * days. Callers apply it to the positive "days left" state only; "due today"
 * and overdue keep their own treatments.
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
