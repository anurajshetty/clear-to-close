// Clear to Close — key dates (Sept 28, 2026, Anuraj-approved).
//
// Client views carry a read-only key-dates entry point directly below the
// LATEST FROM card: calendar glyph + "Key dates" + the most urgent date as
// a quiet hint + chevron. Tapping opens a bottom sheet: Closing date (= the
// existing target close) plus three realtor-entered dates (inspection
// contingency deadline, appraisal deadline, loan approval date). Every
// relative line ("in 5 days", "tomorrow", "overdue by 2 days") is computed
// at render, never live-ticking.
//
// Pure helpers — no React, no store — so the unit suite can pin the rules.

import type { ClientRole } from './types';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Today as a local 'YYYY-MM-DD' (client-local day counting, Sept 2026). */
export function todayLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a local 'YYYY-MM-DD' into a local-midnight Date (never UTC-shifted). */
export function parseLocalDay(v: string): Date {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isValidDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = parseLocalDay(v);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Whole days from `today` to `date` (both local 'YYYY-MM-DD'). */
export function daysBetween(date: string, today: string): number {
  const ms = parseLocalDay(date).getTime() - parseLocalDay(today).getTime();
  return Math.round(ms / 86400000);
}

/** "Oct 30" — the mockup's key-date format (no year; the card is near-term). */
export function formatShortDate(v: string): string {
  const dt = parseLocalDay(v);
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

/** The escrow key dates that can appear on checklist steps (ISO 'YYYY-MM-DD'). */
export interface StepKeyDates {
  inspectionDeadline?: string | null;
  appraisalDeadline?: string | null;
  loanApprovalDate?: string | null;
}

/**
 * The key date (ISO string) for a checklist step, or null.
 * (Anuraj, Sept 30, 2026 — sample 06: key dates show in parentheses on the
 * matching step title, muted, whether or not the step is checked off.)
 * Matched by templateKey so a realtor-renamed step still carries its date.
 * 'close-escrow' is excluded per Anuraj's explicit call (the time-tracker
 * card already shows start/end); custom steps never match.
 */
export function stepKeyDateISO(
  role: ClientRole,
  templateKey: string | null | undefined,
  dates: StepKeyDates,
): string | null {
  switch (templateKey) {
    case 'release-contingencies': // buyer
    case 'contingency-release': // seller
      return dates.inspectionDeadline ?? null;
    case 'appraisal-scheduled': // both roles
      return dates.appraisalDeadline ?? null;
    case 'signed-loan-docs': // buyer only — no seller step
      return role === 'buyer' ? dates.loanApprovalDate ?? null : null;
    default:
      return null;
  }
}

/** The four key dates, tagged so the hint can map each to its checklist step. */
export type KeyDateKey = 'close' | 'inspection' | 'appraisal' | 'loan';

/** A key date candidate carrying its date key for step mapping. */
export interface KeyDateCandidate {
  key: KeyDateKey;
  label: string;
  date: string | null | undefined;
}

/** The template identity + completion state of a checklist step. */
export interface StepDoneState {
  templateKey: string | null | undefined;
  done: boolean;
}

/**
 * The templateKey of the checklist step mapped to a key date, or null when
 * the date has no mapped step (Oct 2026, Anuraj: the Key dates entry-row
 * alert hint appears only when the mapped step is NOT checked off).
 * Mirrors the mapping in stepKeyDateISO.
 */
export function keyDateTemplateKey(
  dateKey: 'inspection' | 'appraisal' | 'loan',
  role: ClientRole,
): string | null {
  switch (dateKey) {
    case 'inspection':
      return role === 'buyer' ? 'release-contingencies' : 'contingency-release';
    case 'appraisal':
      return 'appraisal-scheduled';
    case 'loan':
      return role === 'buyer' ? 'signed-loan-docs' : null;
  }
}

/**
 * Filter key-date candidates to those eligible for the entry-row alert
 * hint (Oct 2026, Anuraj): a date whose mapped checklist step is checked
 * off is excluded — the hint must appear only when the mapped step is NOT
 * checked off. Closing date has no mapping (always eligible). Without a
 * role or steps, or when the mapped step is absent (legacy/custom steps),
 * the old behavior applies (eligible) — a hint is never hidden without
 * proof the step is complete. Matched by templateKey, never by title.
 */
export function eligibleKeyDateCandidates(
  candidates: KeyDateCandidate[],
  role?: ClientRole | null,
  steps?: StepDoneState[] | null,
): KeyDateEntry[] {
  return candidates
    .filter((c) => {
      if (c.key === 'close' || !role || !steps) return true;
      const tk = keyDateTemplateKey(c.key, role);
      if (!tk) return true;
      const step = steps.find((s) => s.templateKey === tk);
      return !step || !step.done;
    })
    .map((c) => ({ label: c.label, date: c.date }));
}

export type KeyDateTone = 'muted' | 'soon' | 'over';

export interface KeyDateLine {
  /** "Oct 30" */
  dateLabel: string;
  /** "in 5 days" | "tomorrow" | "today" | "overdue by 2 days" */
  when: string;
  /** muted (8+ days out), soon/amber (within 7 days incl. today), over/red. */
  tone: KeyDateTone;
}

/**
 * The relative line for one key date (approved thresholds, Sept 28, 2026):
 * amber when the date is within 7 days (including today), red when overdue,
 * muted otherwise. Computed at render; never live-ticking.
 */
export function describeKeyDate(date: string, today: string = todayLocal()): KeyDateLine {
  const diff = daysBetween(date, today);
  let when: string;
  let tone: KeyDateTone;
  if (diff < 0) {
    const n = -diff;
    when = `overdue by ${n} day${n === 1 ? '' : 's'}`;
    tone = 'over';
  } else if (diff === 0) {
    when = 'today';
    tone = 'soon';
  } else if (diff === 1) {
    when = 'tomorrow';
    tone = 'soon';
  } else {
    when = `in ${diff} days`;
    tone = diff <= 7 ? 'soon' : 'muted';
  }
  return { dateLabel: formatShortDate(date), when, tone };
}

/**
 * "Completed Sep 18, 2026" — the per-step completed line (Sept 28, 2026,
 * Anuraj-approved). The year is ALWAYS shown so a December-to-January
 * escrow is unambiguous ("Dec 2025" vs "Jan 2026"). Accepts the server
 * checkoff ISO timestamp or a plain 'YYYY-MM-DD'.
 */
export function formatCompletedDate(completedAt: string): string {
  let y: number;
  let m: number;
  let d: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(completedAt)) {
    [y, m, d] = completedAt.split('-').map(Number);
    m -= 1;
  } else {
    const dt = new Date(completedAt);
    y = dt.getFullYear();
    m = dt.getMonth();
    d = dt.getDate();
  }
  return `${MONTHS[m]} ${d}, ${y}`;
}

export { isValidDay };

export interface KeyDateEntry {
  label: string;
  date: string | null | undefined;
}

export interface UrgentKeyDate {
  label: string;
  date: string;
  /** "Appraisal deadline · overdue by 4 days" — the entry-point hint. */
  hint: string;
  tone: KeyDateTone;
}

/**
 * The most urgent key date for the entry-point hint (FINAL spec, Sept 28,
 * 2026): the smallest days-until wins — most overdue first, then the
 * nearest upcoming date. Null when no dates are set (the entry point then
 * shows no hint). Invalid dates are skipped, never surfaced.
 */
export function mostUrgentKeyDate(
  entries: KeyDateEntry[],
  today: string = todayLocal(),
): UrgentKeyDate | null {
  let best: UrgentKeyDate | null = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    if (!e.date || !isValidDay(e.date)) continue;
    const diff = daysBetween(e.date, today);
    if (diff < bestDiff) {
      const line = describeKeyDate(e.date, today);
      best = { label: e.label, date: e.date, hint: `${e.label} · ${line.when}`, tone: line.tone };
      bestDiff = diff;
    }
  }
  return best;
}
