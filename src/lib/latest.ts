// Clear to Close — "LATEST FROM {NAME}" card model (pure, unit-tested).
//
// The card sits directly below the client top card and shows the single
// most recent realtor action on the escrow — forward AND backward moves
// (Anuraj, Sept 2026: the card stays honest with neutral wording, no
// blame). Always visible: the fallback covers escrows with no checkoffs
// yet, and old timestamps render as calendar dates, never hidden.
//
// Copy rules: realtor by FIRST NAME only, never gendered pronouns, no em
// dashes.
import { firstNameOf } from './pace';
import { relativeTime } from './dates';
import type { RealtorAction, StepT } from './types';

export type LatestIcon = 'check' | 'reopen';

export interface LatestModel {
  /** "LATEST FROM MAYA" */
  kicker: string;
  /** "Checked off" | "Reopened" | "Maya opened your escrow" */
  lead: string;
  /** The step name, rendered bold (null for the opened-escrow fallback). */
  stepTitle: string | null;
  /** "2h ago" */
  time: string;
  /** 'check' for forward moves, 'reopen' for backward moves. */
  icon: LatestIcon;
}

export function latestModel(args: {
  lastAction?: RealtorAction | null;
  steps: StepT[];
  realtorName: string;
  openedAt?: string | null;
  openDate?: string | null;
  nowMs?: number;
}): LatestModel {
  const { lastAction, steps, realtorName, openedAt, openDate, nowMs = Date.now() } = args;
  const first = firstNameOf(realtorName);
  const kicker = `LATEST FROM ${first ? first.toUpperCase() : 'YOUR REALTOR'}`;

  // The stamped action wins: it captures backward moves, which leave no
  // completedAt behind.
  if (lastAction && (lastAction.kind === 'checked' || lastAction.kind === 'reopened')) {
    return {
      kicker,
      lead: lastAction.kind === 'checked' ? 'Checked off' : 'Reopened',
      stepTitle: lastAction.stepTitle,
      time: relativeTime(lastAction.at, nowMs),
      icon: lastAction.kind === 'checked' ? 'check' : 'reopen',
    };
  }

  // Escrows last touched before the stamp existed: derive from the latest
  // completed_at.
  let latest: StepT | null = null;
  for (const s of steps) {
    if (!s.done || !s.completedAt) continue;
    if (!latest || !latest.completedAt || s.completedAt > latest.completedAt) {
      latest = s;
    }
  }
  if (latest && latest.completedAt) {
    return {
      kicker,
      lead: 'Checked off',
      stepTitle: latest.title,
      time: relativeTime(latest.completedAt, nowMs),
      icon: 'check',
    };
  }

  // Nothing checked off yet.
  const fallbackAt = openedAt ?? openDate ?? new Date(nowMs).toISOString();
  return {
    kicker,
    lead: `${first || 'Your realtor'} opened your escrow`,
    stepTitle: null,
    time: relativeTime(fallbackAt, nowMs),
    icon: 'check',
  };
}
