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
