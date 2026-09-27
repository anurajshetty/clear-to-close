// Clear to Close — single date convention for every "days" number in the app.
//
// Convention (matches the mockup/component spec and the deal-card reference):
//   "days to close" / "days left to close" = whole CALENDAR days from today to
//   the target close date, exclusive of today. A close date of today reads 0,
//   yesterday reads -1 (past target).
//   Timeline: totalDays = whole calendar days from open to close;
//   dayNum = whole calendar days from open to today, + 1, clamped to
//   [1, totalDays]. So "day 1 of 61" always pairs with "61 days left to close".
//
// All arithmetic runs on UTC midnights so daylight-saving transitions can
// never shift a count by one (the old Math.ceil(ms / 86400000) approach did:
// Sep 25 -> Nov 25 2026 read 62 across the Nov 1 fall-back).

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' -> UTC-midnight epoch ms (DST-safe day arithmetic). */
export function parseDateUTC(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`parseDateUTC: expected YYYY-MM-DD, got "${iso}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole calendar days from `fromISO` to `toISO` (negative when to < from). */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((parseDateUTC(toISO) - parseDateUTC(fromISO)) / DAY_MS);
}

/** Local 'YYYY-MM-DD' for the device clock. */
export function localDateISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Whole calendar days from today to the target close date.
 * 0 = closes today, negative = past target.
 */
export function daysToClose(closeISO: string, nowMs: number = Date.now()): number {
  return daysBetween(localDateISO(new Date(nowMs)), closeISO);
}

/** Timeline numbers for the time-tracker card. */
export function timeline(
  openISO: string,
  closeISO: string,
  nowMs: number = Date.now(),
): { totalDays: number; dayNum: number } {
  const totalDays = Math.max(1, daysBetween(openISO, closeISO));
  const dayNum = Math.min(
    Math.max(daysBetween(openISO, localDateISO(new Date(nowMs))) + 1, 1),
    totalDays,
  );
  return { totalDays, dayNum };
}

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Compact relative time for the client home's "LATEST FROM" card:
 * "just now" (<5 min), "Xm ago", "Xh ago", "Yesterday", "Xd ago", then
 * "Mar 3" ("Mar 3, 2025" across years). The card is ALWAYS visible, so old
 * timestamps render as calendar dates — never hidden. Future or
 * unparseable input reads "just now" rather than a wrong or blank value.
 */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at) || at > nowMs) return 'just now';
  const mins = Math.floor((nowMs - at) / 60_000);
  if (mins < 5) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  const now = new Date(nowMs);
  const then = new Date(at);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return `${dayDiff}d ago`;
  const date = `${SHORT_MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === now.getFullYear()
    ? date
    : `${date}, ${then.getFullYear()}`;
}
