// Clear to Close — send-client-push pure logic (no imports, no Deno).
// Kept import-free so the same file ships inside the dashboard-paste single
// file AND compiles under node for unit tests.
//
// Push copy (step_done / coalesced / check-ins, Anuraj Sept 28 2026;
// close_date_changed + key_dates_changed, Anuraj Sept 28 2026;
// inspection/appraisal/loan specific copy, Anuraj Sept 28 2026 rule:
//   one date changed -> specific "Your {label} is now {date}."
//   several dates changed together -> "{First} updated your key dates."):
//   step_done:                   "Your realtor just completed {step}."
//   coalesced (2+):              "Your realtor completed {N} steps."
//   check-in (> 7 days):         "Your escrow is on track: {done} of {total} steps done, closing in {n} days."
//   check-in (<= 7 days):        "Closing is {n} days away, {open} steps still to go."
//   custom_step_added:           "{First} added a new step to your escrow." (compat; new trigger never emits)
//   close_date_changed:          "Your closing date is now {date}."
//   inspection_deadline_changed: "Your inspection contingency deadline is now {date}."
//   appraisal_deadline_changed:  "Your appraisal deadline is now {date}."
//   loan_approval_date_changed:  "Your loan approval date is now {date}."
//   key_dates_changed:           "{First} updated your key dates."
// Forward progress only: unchecks never produce an event (the DB trigger
// matches transitions, never state).

export type PushEvent =
  | 'step_done'
  | 'custom_step_added'
  | 'close_date_changed'
  | 'inspection_deadline_changed'
  | 'appraisal_deadline_changed'
  | 'loan_approval_date_changed'
  | 'key_dates_changed'
  // Internal cron events (0024+): posted by pg_cron via push_cron_ping.
  // They carry no escrow_id; parseTriggerPayload accepts them bare.
  | 'flush_step_pushes'
  | 'quiet_checkin_sweep';

export interface TriggerPayload {
  event: PushEvent;
  escrow_id: string | null;
  step_title: string | null;
  new_close_date: string | null; // 'YYYY-MM-DD' (legacy: close_date_changed only)
  new_date: string | null; // 'YYYY-MM-DD' (specific key-date change events)
}

export interface ExpoMessage {
  to: string;
  sound: 'default';
  title: string;
  body: string;
  data: { escrowId: string; role: string };
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '2026-11-24' -> 'Nov 24, 2026' (the app's long-date copy). */
export function formatPushDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** 'Maya Sharma' -> 'Maya'. Falls back to the full string when empty. */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first || 'Your realtor';
}

/**
 * Build the notification body for one trigger event. Returns null when the
 * payload cannot produce honest copy (missing step title / missing date) —
 * the caller must drop such events rather than send a wrong push.
 */
export function buildPushBody(
  event: PushEvent,
  realtorName: string | null | undefined,
  stepTitle: string | null | undefined,
  newCloseDate: string | null | undefined,
  newDate?: string | null | undefined,
): string | null {
  const first = firstNameOf(realtorName);
  // Specific date-change events carry the date in new_date (0021+); the
  // legacy new_close_date is honored for close_date_changed payloads from
  // pre-0021 triggers.
  const dateFor = (fallback: string | null | undefined): string =>
    ((newDate ?? fallback ?? '') as string).trim();
  switch (event) {
    case 'step_done': {
      // Approved single-completion copy (Sept 28 2026). Custom steps are
      // included — structural edits never push, only real check-offs.
      const title = (stepTitle ?? '').trim();
      if (!title) return null;
      return `Your realtor just completed ${title}.`;
    }
    case 'custom_step_added':
      return `${first} added a new step to your escrow.`;
    case 'close_date_changed': {
      const d = dateFor(newCloseDate);
      if (!d) return null;
      return `Your closing date is now ${formatPushDate(d)}.`;
    }
    case 'inspection_deadline_changed': {
      const d = dateFor(null);
      if (!d) return null;
      return `Your inspection contingency deadline is now ${formatPushDate(d)}.`;
    }
    case 'appraisal_deadline_changed': {
      const d = dateFor(null);
      if (!d) return null;
      return `Your appraisal deadline is now ${formatPushDate(d)}.`;
    }
    case 'loan_approval_date_changed': {
      const d = dateFor(null);
      if (!d) return null;
      return `Your loan approval date is now ${formatPushDate(d)}.`;
    }
    case 'key_dates_changed':
      return `${first} updated your key dates.`;
    case 'flush_step_pushes':
    case 'quiet_checkin_sweep':
      // Internal cron events: never carry copy; the caller routes them
      // before building a body.
      return null;
  }
}

/** Validate + normalize the trigger's JSON body. Returns null when invalid. */
export function parseTriggerPayload(raw: unknown): TriggerPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const event = p['event'];
  const escrowId = p['escrow_id'];
  const isInternal = event === 'flush_step_pushes' || event === 'quiet_checkin_sweep';
  if (
    (event !== 'step_done' &&
      event !== 'custom_step_added' &&
      event !== 'close_date_changed' &&
      event !== 'inspection_deadline_changed' &&
      event !== 'appraisal_deadline_changed' &&
      event !== 'loan_approval_date_changed' &&
      event !== 'key_dates_changed' &&
      !isInternal) ||
    (!isInternal && (typeof escrowId !== 'string' || !escrowId))
  ) {
    return null;
  }
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : null;
  return {
    event: event as PushEvent,
    escrow_id: isInternal ? null : (escrowId as string),
    step_title: strOrNull(p['step_title']),
    new_close_date: strOrNull(p['new_close_date']),
    new_date: strOrNull(p['new_date']),
  };
}

export interface PushTokenRow {
  expo_push_token: string;
  role: string;
}

/** One Expo message per live token. */
export function toExpoMessages(
  tokens: PushTokenRow[],
  body: string,
  escrowId: string,
): ExpoMessage[] {
  return tokens.map((t) => ({
    to: t.expo_push_token,
    sound: 'default',
    title: 'Clear to Close',
    body,
    data: { escrowId, role: t.role },
  }));
}

export interface ExpoReceipt {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Tokens the Expo Push API reports as dead (DeviceNotRegistered) must be
 * deleted so we stop sending to them. Returns the token strings to delete.
 */
export function deadTokensFromReceipts(
  messages: ExpoMessage[],
  receipts: Record<string, ExpoReceipt>,
): string[] {
  const dead: string[] = [];
  for (const m of messages) {
    const r = receipts[m.to];
    if (r && r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') {
      dead.push(m.to);
    }
  }
  return dead;
}

// ---------------------------------------------------------------------------
// Quiet hours, coalescing, and quiet check-ins (0024, Anuraj Sept 28 2026).
//
// Quiet hours: no buzzes 21:00-08:00 client-local. Timezone math uses the
// IANA zone captured at token registration; FALLBACK_TZ covers pre-0022 rows
// whose zone was never captured. Day counting for check-ins is done in the
// client's zone (timezone-safe).
//
// Copy notes:
//   * Single check-off uses the approved Sept 28 2026 copy ("Your realtor
//     just completed {step}."); several coalesced check-offs use the
//     approved "Your realtor completed {N} steps."
//   * The approved check-in copy used em dashes; the standing no-em-dash rule
//     (Sept 28, 2026) renders them as colon/comma instead. Flagged in the
//     release report for Anuraj.
/** Fallback zone when a token row predates timezone capture. */
export const FALLBACK_TZ = 'America/Los_Angeles';

/** Quiet window: 21:00 (inclusive) to 08:00 (exclusive), client-local. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

/** Coalescing window: flush an escrow's buffer once its oldest row is this old. */
export const COALESCE_WINDOW_MS = 2 * 60 * 1000;

/** Resolve a zone, falling back for unknown/empty values. */
export function resolveZone(timezone: string | null | undefined): string {
  const z = (timezone ?? '').trim();
  if (!z) return FALLBACK_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return FALLBACK_TZ;
  }
}

/** Milliseconds the zone is ahead of UTC at the given instant. */
function tzOffsetMs(timezone: string, at: Date): number {
  const zone = resolveZone(timezone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUTC - at.getTime();
}

/** Whole local hour (0-23) in the zone at the given instant. */
export function zonedHour(at: Date, timezone: string | null | undefined): number {
  const shifted = new Date(at.getTime() + tzOffsetMs(timezone ?? FALLBACK_TZ, at));
  return shifted.getUTCHours();
}

/** True when the instant falls in 21:00-08:00 client-local. */
export function isQuietHour(at: Date, timezone: string | null | undefined): boolean {
  const h = zonedHour(at, timezone);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** Next 08:00 client-local strictly after `at`, as a UTC Date. */
export function nextMorning8am(at: Date, timezone: string | null | undefined): Date {
  const zone = resolveZone(timezone);
  // Local y/m/d of `at` in the zone.
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = dtf.format(at).split('-').map(Number);
  // 08:00 local expressed in UTC: guess, then correct for the offset at the
  // guessed instant (two passes converge across DST boundaries).
  let guess = new Date(Date.UTC(y, m - 1, d, 8, 0, 0));
  for (let i = 0; i < 2; i++) {
    guess = new Date(Date.UTC(y, m - 1, d, 8, 0, 0) - tzOffsetMs(zone, guess));
  }
  if (guess.getTime() <= at.getTime()) {
    guess = new Date(guess.getTime() + 24 * 60 * 60 * 1000);
  }
  return guess;
}

/**
 * Whole days from the client's today to the close date (a 'YYYY-MM-DD'
 * date, no zone). Timezone-safe: both sides are measured in the zone.
 */
export function daysUntilClose(
  closeDateISO: string,
  at: Date,
  timezone: string | null | undefined,
): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closeDateISO);
  if (!m) return 0;
  const zone = resolveZone(timezone);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, mo, d] = dtf.format(at).split('-').map(Number);
  const todayStartUTC = Date.UTC(y, mo - 1, d);
  const closeUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((closeUTC - todayStartUTC) / (24 * 60 * 60 * 1000));
}

/** Coalesced body for N (>= 2) rapid check-offs. Approved copy. */
export function buildCoalescedBody(count: number): string {
  return `Your realtor completed ${count} steps.`;
}

function daysAway(n: number): string {
  if (n <= 0) return 'today';
  return n === 1 ? '1 day away' : `${n} days away`;
}

/**
 * Five-day quiet check-in body. Returns null when the inputs cannot produce
 * honest copy. > 7 days to close -> on-track variant; <= 7 days with open
 * steps -> closing-soon variant. Em dashes from the approved copy render as
 * colon/comma per the standing no-em-dash rule.
 */
export function buildQuietCheckinBody(
  done: number,
  total: number,
  daysToClose: number,
): string | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0 || done > total) {
    return null;
  }
  const open = total - done;
  if (open <= 0) return null; // all-complete gets nothing
  if (daysToClose > 7) {
    const dayWord = daysToClose === 1 ? 'day' : 'days';
    return `Your escrow is on track: ${done} of ${total} steps done, closing in ${daysToClose} ${dayWord}.`;
  }
  return `Closing is ${daysAway(daysToClose)}, ${open} step${open === 1 ? '' : 's'} still to go.`;
}

/**
 * Multi-escrow: the notification names the property so the client knows
 * which escrow moved. Single-escrow devices keep the existing copy byte for
 * byte (no behavior change for the common case).
 */
export function withAddress(body: string, address: string, multiEscrow: boolean): string {
  if (!multiEscrow) return body;
  const a = (address ?? '').trim();
  if (!a) return body;
  return `${body} (${a})`;
}
