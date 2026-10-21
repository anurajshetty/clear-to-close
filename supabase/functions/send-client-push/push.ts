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
//   custom_step_added:           "{First} added a new step to your escrow." (P1: emitted again via the 0040 outbox)
//   close_date_changed:          "Your closing date is now {date}."
//                                (cleared -> "Your closing date was removed." — wired but inert: the date is never clearable today)
//   inspection_deadline_changed: "Your inspection contingency deadline is now {date}."
//                                (cleared -> "Your inspection contingency deadline was removed.")
//   appraisal_deadline_changed:  "Your appraisal deadline is now {date}."
//                                (cleared -> "Your appraisal deadline was removed.")
//   loan_approval_date_changed:  "Your loan approval date is now {date}."
//                                (cleared -> "Your loan approval date was removed.")
//   key_dates_changed:           "{First} updated your key dates."
// Forward progress only: unchecks never produce an event (the DB trigger
// matches transitions, never state).
//
// Team Access (0044, copy batch drafted Oct 20 2026): invite-received,
// invite-accepted, and member-step-activity bodies + the no-account
// invite email are built by the plan*/build* team builders at the
// bottom of this file; the drain decides recipients from live grant
// state, never from the outbox payload alone.

export type PushEvent =
  | 'step_done'
  | 'custom_step_added'
  | 'close_date_changed'
  | 'inspection_deadline_changed'
  | 'appraisal_deadline_changed'
  | 'loan_approval_date_changed'
  | 'key_dates_changed'
  // P1 outbox events (0040+): written to pending_event_pushes by
  // triggers and drained by the per-minute flush. They are NEVER valid
  // HTTP trigger payloads — parseTriggerPayload rejects them; bodies
  // are built by buildEventBody, not buildPushBody.
  | 'client_joined'
  | 'review_submitted'
  | 'escrow_closed'
  | 'escrow_cancelled'
  | 'buyer_intake_submitted'
  | 'seller_intake_submitted'
  // P3 (0042): written to the outbox by ctc_maybe_push_halfway when an
  // escrow's checklist crosses 50%; never an HTTP payload either.
  | 'halfway_milestone'
  // Team Access (0044): per-escrow Associate/TC grants. Written to the
  // outbox by create_team_invite / respond_team_invite / the steps
  // member-activity trigger; drained by the per-minute flush like the
  // P1 kinds. NEVER valid HTTP trigger payloads — parseTriggerPayload
  // rejects them; recipients and validity are decided at drain time
  // from the live grant row (R4), and bodies come from the plan*
  // builders below, not buildPushBody.
  | 'team_invite_received'
  | 'team_invite_accepted'
  | 'member_step_activity'
  // Internal cron events (0024+): posted by pg_cron via push_cron_ping.
  // They carry no escrow_id; parseTriggerPayload accepts them bare.
  | 'flush_step_pushes'
  | 'quiet_checkin_sweep'
  // P2 (0041): the hourly date-reminder sweep.
  | 'date_reminder_sweep';

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
  data: {
    escrowId: string;
    role: string;
    /** Team Access (0044) kinds carry their routing kind + the
     *  contract's snake-case escrow id alongside the legacy keys. */
    kind?: string;
    escrow_id?: string;
  };
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
      // A cleared closing date gets the same "removed" copy as the
      // other three key dates (Anuraj, Oct 15 2026). Inert today —
      // close_date is required/never clearable in the app — but wired
      // and pinned so the behavior is defined if that ever changes.
      if (!d) return 'Your closing date was removed.';
      return `Your closing date is now ${formatPushDate(d)}.`;
    }
    case 'inspection_deadline_changed': {
      // A clear is a change too (0021 counts it via IS DISTINCT FROM): a
      // null new_date means the realtor removed a date the client could
      // see — the client gets the honest "removed" copy, never silence.
      const d = (newDate ?? '').trim();
      if (!d) return 'Your inspection contingency deadline was removed.';
      return `Your inspection contingency deadline is now ${formatPushDate(d)}.`;
    }
    case 'appraisal_deadline_changed': {
      const d = (newDate ?? '').trim();
      if (!d) return 'Your appraisal deadline was removed.';
      return `Your appraisal deadline is now ${formatPushDate(d)}.`;
    }
    case 'loan_approval_date_changed': {
      const d = (newDate ?? '').trim();
      if (!d) return 'Your loan approval date was removed.';
      return `Your loan approval date is now ${formatPushDate(d)}.`;
    }
    case 'key_dates_changed':
      return `${first} updated your key dates.`;
    case 'client_joined':
    case 'review_submitted':
    case 'escrow_closed':
    case 'escrow_cancelled':
    case 'buyer_intake_submitted':
    case 'seller_intake_submitted':
    case 'halfway_milestone':
    case 'team_invite_received':
    case 'team_invite_accepted':
    case 'member_step_activity':
      // P1/Team outbox events: bodies are built by buildEventBody or
      // the plan* builders below from the outbox payload; this
      // HTTP-path builder never serves them.
      return null;
    case 'flush_step_pushes':
    case 'quiet_checkin_sweep':
    case 'date_reminder_sweep':
      // Internal cron events: never carry copy; the caller routes them
      // before building a body.
      return null;
  }
}

/** First name, or null when the name is missing/blank. */
function firstNameOrNull(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first || null;
}

export interface EventBodyContext {
  /** Joining client's name (client_links.party_name) or review author. */
  clientName?: string | null;
  /** The joining link's role ('buyer' | 'seller' | 'tc'). */
  clientRole?: string | null;
  /** Review stars when the review carries a rating. */
  stars?: number | null;
  /** Realtor's name (full or first — firstNameOf normalizes). */
  realtorName?: string | null;
  /** P3: checklist counts snapshotted at the halfway crossing. */
  doneCount?: number | null;
  totalCount?: number | null;
}

/**
 * Bodies for the P1 outbox events (approved copy batch, Oct 15 2026).
 * Client references render as FIRST names, matching the app's existing
 * first-name convention and the lock-screen privacy rule. Returns null
 * for events that carry no P1 copy — the drain drops those rows.
 */
export function buildEventBody(event: PushEvent, ctx: EventBodyContext): string | null {
  switch (event) {
    case 'client_joined': {
      if (ctx.clientRole === 'tc') return 'Your TC just joined the escrow.';
      const name = firstNameOrNull(ctx.clientName);
      return name
        ? `${name} just joined their escrow.`
        : 'Your client just joined their escrow.';
    }
    case 'review_submitted': {
      const who = firstNameOrNull(ctx.clientName) ?? 'A client';
      const stars =
        typeof ctx.stars === 'number' && ctx.stars >= 1 ? Math.round(ctx.stars) : null;
      return stars
        ? `${who} left you a ${stars}-star review.`
        : `${who} left you a review.`;
    }
    case 'escrow_closed':
      return 'Congratulations, your escrow is closed!';
    case 'escrow_cancelled':
      return `This escrow has been cancelled. ${firstNameOf(ctx.realtorName)} can help with any questions.`;
    case 'buyer_intake_submitted':
      // Option A (Anuraj, Oct 15 2026): intake saves notify the TC —
      // the forms are realtor-authored and the TC works from them.
      return 'Buyer intake submitted.';
    case 'seller_intake_submitted':
      // tc_intakes holds the listing (seller-side) details.
      return 'Seller intake submitted.';
    case 'halfway_milestone': {
      const done = ctx.doneCount;
      const total = ctx.totalCount;
      if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return null;
      return `You're halfway there: ${done} of ${total} steps done.`;
    }
    default:
      return null;
  }
}

/**
 * Intake events coalesce per (escrow, event) within one drain: a burst
 * of saves while editing is one fact ("the intake was submitted"),
 * never N pushes. All other events pass through untouched.
 */
export function isBurstCoalescedEvent(event: PushEvent): boolean {
  return event === 'buyer_intake_submitted' || event === 'seller_intake_submitted';
}

export function collapseBurstEvents<T extends { escrow_id: string; event: PushEvent }>(
  rows: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (isBurstCoalescedEvent(r.event)) {
      const key = `${r.escrow_id}:${r.event}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

export type ReminderEvent =
  | 'closing_reminder'
  | 'inspection_reminder'
  | 'appraisal_reminder'
  | 'loan_reminder'
  | 'possession_reminder';

export interface ReminderContext {
  /** Days-until threshold that fired (7/3/1 closing, 1 deadlines, 5 possession). */
  threshold: number;
  /** The date the reminder is about ('YYYY-MM-DD'). */
  dateISO: string;
  /** Street address for the realtor variants ({Street}). */
  street: string;
}

const DEADLINE_LABEL: Record<string, string> = {
  inspection_reminder: 'inspection deadline',
  appraisal_reminder: 'appraisal deadline',
  loan_reminder: 'loan approval deadline',
};

/**
 * Bodies for the P2 date reminders (approved copy batch, Oct 15 2026).
 * The sweep computes days-until in the RECIPIENT's timezone, so
 * "tomorrow"/"in N days" is true where the phone is. Returns null for a
 * threshold/event combination that carries no copy — the sweep drops
 * those rather than improvising.
 */
export function buildReminderBody(
  event: ReminderEvent,
  audience: 'client' | 'realtor',
  ctx: ReminderContext,
): string | null {
  const date = formatPushDate(ctx.dateISO);
  const street = (ctx.street ?? '').trim();
  switch (event) {
    case 'closing_reminder': {
      if (audience === 'realtor') {
        if (!street) return null;
        if (ctx.threshold === 7) return `${street} closes in 7 days.`;
        if (ctx.threshold === 3) return `${street} closes in 3 days.`;
        if (ctx.threshold === 1) return `${street} closes tomorrow.`;
        return null;
      }
      if (ctx.threshold === 7) return `One week to go. Your closing is on ${date}.`;
      if (ctx.threshold === 3) return `Closing is in 3 days, on ${date}.`;
      if (ctx.threshold === 1) return `Closing is tomorrow, ${date}.`;
      return null;
    }
    case 'inspection_reminder':
    case 'appraisal_reminder':
    case 'loan_reminder': {
      if (ctx.threshold !== 1) return null;
      const label = DEADLINE_LABEL[event];
      if (audience === 'realtor') {
        if (!street) return null;
        return `${street}: ${label} is tomorrow.`;
      }
      return `Your ${label} is tomorrow, ${date}.`;
    }
    case 'possession_reminder': {
      if (audience !== 'client' || ctx.threshold !== 5) return null;
      return `The buyer takes possession in 5 days, on ${date}.`;
    }
  }
}

/** Validate + normalize the trigger's JSON body. Returns null when invalid. */
export function parseTriggerPayload(raw: unknown): TriggerPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const event = p['event'];
  const escrowId = p['escrow_id'];
  const isInternal =
    event === 'flush_step_pushes' ||
    event === 'quiet_checkin_sweep' ||
    event === 'date_reminder_sweep';
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

// ------------------------------------------------------- P0.3 targeting --

export type ClientLinkRole = 'buyer' | 'seller' | 'tc';

/**
 * Side-aware targeting (P0.3, Oct 15 2026): which client link roles
 * receive a given push event.
 * - Step events go to the step's own side + TC. A step belongs to
 *   exactly one side (steps.role is 'buyer' | 'seller'); stepRole is
 *   that side. Anything unexpected falls back to the buyer side.
 * - The inspection / appraisal / loan deadlines are buyer contingencies:
 *   buyer side + TC.
 * - The closing date concerns every party, and key_dates_changed (a
 *   multi-date edit, which may include the closing date; the copy is
 *   generic) goes to all parties as well.
 * Check-ins do not route through here: the sweep's candidates are
 * already per-token, and a quiet check-in is an escrow-wide status.
 */
export function rolesForPushEvent(
  event: PushEvent,
  stepRole?: string | null,
): ClientLinkRole[] {
  switch (event) {
    case 'step_done':
    case 'custom_step_added':
      return stepRole === 'seller' ? ['seller', 'tc'] : ['buyer', 'tc'];
    case 'buyer_intake_submitted':
    case 'seller_intake_submitted':
      // P1 Option A: intake saves notify only the TC.
      return ['tc'];
    case 'inspection_deadline_changed':
    case 'appraisal_deadline_changed':
    case 'loan_approval_date_changed':
      return ['buyer', 'tc'];
    default:
      return ['buyer', 'seller', 'tc'];
  }
}

export interface BufferedStepPush {
  event: PushEvent;
  step_title: string;
  step_role: string | null;
}

export interface StepAudience {
  roles: ClientLinkRole[];
  rows: BufferedStepPush[];
}

/**
 * Split one escrow's buffered step pushes into delivery audiences for
 * the flush. Buyer-side rows address buyer + TC devices; seller-side
 * rows address seller + TC devices. A row with no recorded side (only
 * possible for rows buffered before migration 0039 landed) joins BOTH
 * audiences — the pre-P0.3 behavior — so an in-flight check-off is
 * never dropped or mistargeted by the deploy. TC devices sit in both
 * audiences and can receive one push per side in the same window; that
 * is the targeting rule itself (the step's side + TC), not a duplicate.
 */
export function splitStepPushesByAudience(rows: BufferedStepPush[]): StepAudience[] {
  const buyerRows = rows.filter((r) => r.step_role !== 'seller');
  const sellerRows = rows.filter((r) => r.step_role === 'seller' || r.step_role === null);
  const out: StepAudience[] = [];
  if (buyerRows.length > 0) out.push({ roles: ['buyer', 'tc'], rows: buyerRows });
  if (sellerRows.length > 0) out.push({ roles: ['seller', 'tc'], rows: sellerRows });
  return out;
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

// ------------------------------------------------------ Team Access (0044) --
//
// Copy: Q3 copy batch (team-access-copy-batch.md, drafted Oct 20 2026
// for Anuraj's approval). The drain decides everything at send time
// (R4): the outbox row is only a fact ("an invite was created", "a
// member touched a step"); the grant's CURRENT state decides whether
// anyone is notified and through which channel. Invite channels
// (Anuraj, Oct 21, 2026): the invite email goes on EVERY invite;
// an invitee WITH an account also gets the push; an invitee WITHOUT
// an account gets the email only. The invite email names the
// escrow's property address (Anuraj's Oct 21 override amending R7);
// party names, dates, and amounts stay out.

export type TeamRole = 'associate' | 'tc';

/** Snapshot of the grant row the drain decides from (escrow_team_grants). */
export interface TeamGrantSnapshot {
  id: string;
  escrow_id: string;
  invited_email: string;
  user_id: string | null;
  role: string;
  status: string;
  invited_by: string;
}

/** Per-owner invite-email cap: at most this many per rolling 24h (R5). */
export const INVITE_EMAIL_CAP_PER_24H = 20;

/** Role phrase for the invite-received PUSH ("join an escrow as ..."). */
export function teamRolePushPhrase(role: string | null | undefined): string {
  return role === 'tc' ? 'its transaction coordinator' : 'an Associate';
}

function trimmedOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s || null;
}

export type TeamInviteReceivedPlan =
  /** Grant gone or no longer pending: notify nobody, on any channel. */
  | { action: 'drop' }
  /** Grant live and pending: notify on each applicable channel. The
   *  invite email goes on EVERY invite (Anuraj, Oct 21, 2026 — this
   *  reverses the original branch exclusivity): account invitees get
   *  the push AND the email; no-account invitees get the email only.
   *  The email half is suppressed (silently) at the per-owner cap or
   *  when sending is unconfigured; the push half is never suppressed. */
  | {
      action: 'send';
      /** Push body for an account invitee; null for no-account. */
      pushBody: string | null;
      email: boolean;
      emailSkip?: 'cap' | 'unconfigured';
    };

/**
 * Quiet-hours decision for a team push to ONE token (merge addition,
 * Oct 2026): team pushes follow the same per-token quiet hours as
 * every other push in this function — during quiet hours the push is
 * queued for 08:00 recipient-local (push_queue, kind 'event'; the team
 * kind rides in data) instead of buzzing immediately. The validity
 * decision (R4) already happened in the planners above; this only
 * shifts delivery time, exactly like deliver()'s queued rows.
 */
export function teamQuietQueue(
  at: Date,
  timezone: string | null | undefined,
): { queued: boolean; sendAfter: string | null } {
  if (!isQuietHour(at, timezone)) return { queued: false, sendAfter: null };
  return { queued: true, sendAfter: nextMorning8am(at, timezone).toISOString() };
}

/**
 * Decide a team_invite_received outbox row from the grant's live state.
 * `inviteEmailsSentLast24h` counts the OWNER's invite emails in the
 * trailing 24h across BOTH branches (only Resend-accepted sends are
 * logged, so only they count); `emailConfigured` is true only when
 * both the Resend key and the From address are present.
 */
export function planTeamInviteReceived(
  grant: TeamGrantSnapshot | null,
  ctx: {
    ownerName: string | null | undefined;
    inviteEmailsSentLast24h: number;
    emailConfigured: boolean;
  },
): TeamInviteReceivedPlan {
  if (!grant || grant.status !== 'pending') return { action: 'drop' };
  const pushBody = grant.user_id
    ? `${trimmedOrNull(ctx.ownerName) ?? 'Your realtor'} invited you to join an escrow as ${teamRolePushPhrase(grant.role)}.`
    : null;
  if (ctx.inviteEmailsSentLast24h >= INVITE_EMAIL_CAP_PER_24H) {
    return { action: 'send', pushBody, email: false, emailSkip: 'cap' };
  }
  if (!ctx.emailConfigured) {
    return { action: 'send', pushBody, email: false, emailSkip: 'unconfigured' };
  }
  return { action: 'send', pushBody, email: true };
}

export type TeamInviteAcceptedPlan =
  | { action: 'drop' }
  | { action: 'push'; body: string };

/**
 * Decide a team_invite_accepted outbox row: the escrow OWNER hears
 * about it only while the grant stands accepted (a grant removed
 * before the drain sends nothing). Copy needs the street; without one
 * the plan drops rather than improvise (house rule).
 */
export function planTeamInviteAccepted(
  grant: TeamGrantSnapshot | null,
  ctx: { memberName: string | null | undefined; street: string | null | undefined },
): TeamInviteAcceptedPlan {
  if (!grant || grant.status !== 'accepted') return { action: 'drop' };
  const street = trimmedOrNull(ctx.street);
  if (!street) return { action: 'drop' };
  const name = trimmedOrNull(ctx.memberName) ?? 'Someone';
  return { action: 'push', body: `${name} accepted your invitation to join ${street}.` };
}

export interface MemberActivityFact {
  actor_id: string | null;
  action: string | null;
  title: string | null;
}

/**
 * Group member_step_activity rows by escrow, preserving fetch order.
 * The drain sends ONE summary push per escrow per pass and consumes
 * every grouped row.
 */
export function groupMemberActivityRows<T extends { escrow_id: string }>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const g = groups.get(r.escrow_id) ?? [];
    g.push(r);
    groups.set(r.escrow_id, g);
  }
  return groups;
}

const MEMBER_ACTIVITY_VERBS: Record<string, string> = {
  checked: 'checked off',
  unchecked: 'unchecked',
  added: 'added a step',
};

/**
 * Owner summary for one escrow's member step activity (copy batch).
 * One fact renders the verb form ("Alex Rivera checked off “Appraisal
 * ordered” on Maple Grove Dr."); several collapse to the count form.
 * A single fact whose verb/title cannot render honestly (unknown
 * action, missing title) also falls back to the count form. Returns
 * null without a street — the copy names the property.
 */
export function buildMemberActivityBody(
  facts: MemberActivityFact[],
  actorName: string | null | undefined,
  street: string | null | undefined,
): string | null {
  if (facts.length === 0) return null;
  const st = trimmedOrNull(street);
  if (!st) return null;
  const actor = trimmedOrNull(actorName) ?? 'Your associate';
  if (facts.length === 1) {
    const f = facts[0];
    const verb = MEMBER_ACTIVITY_VERBS[f.action ?? ''];
    const title = trimmedOrNull(f.title);
    if (verb && f.action !== 'added' && title) {
      return `${actor} ${verb} “${title}” on ${st}.`;
    }
    if (verb && f.action === 'added') {
      return `${actor} added a step on ${st}.`;
    }
  }
  const n = facts.length;
  return `${actor} made ${n} checklist update${n === 1 ? '' : 's'} on ${st}.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface TeamInviteEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The invite email (copy batch as amended by Anuraj, Oct 21, 2026):
 * inviter name, role, the escrow's property address, and the app
 * link. The address is IN by his explicit override amending R7;
 * party names, dates, and amounts stay OUT.
 */
export function buildTeamInviteEmail(ctx: {
  ownerName: string | null | undefined;
  role: string | null | undefined;
  address: string;
  appLink: string;
}): TeamInviteEmail {
  const owner = trimmedOrNull(ctx.ownerName) ?? 'Your realtor';
  const phrase = teamRolePushPhrase(ctx.role);
  const address = ctx.address.trim();
  const link = ctx.appLink;
  const subject = `${owner} invited you to an escrow on Clear to Close`;
  const intro = `${owner} has invited you to join the escrow for ${address} on Clear to Close as ${phrase}.`;
  const text = [
    intro,
    '',
    'Open the app to see the escrow and accept your invitation:',
    link,
    '',
    'New to Clear to Close? The link will get you set up. Sign up with this email address so the invitation is waiting for you when you arrive.',
    '',
    "You can ignore this email if you weren't expecting an invitation.",
  ].join('\n');
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<p>Open the app to see the escrow and accept your invitation:<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    '<p>New to Clear to Close? The link will get you set up. Sign up with this email address so the invitation is waiting for you when you arrive.</p>',
    "<p>You can ignore this email if you weren't expecting an invitation.</p>",
  ].join('\n');
  return { subject, text, html };
}
