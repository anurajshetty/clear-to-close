// Clear to Close — send-client-push pure logic (no imports, no Deno).
// Kept import-free so the same file ships inside the dashboard-paste single
// file AND compiles under node for unit tests.
//
// Push copy (step_done / custom_step_added FINAL, Anuraj Sept 26 2026;
// close_date_changed + key_dates_changed FINAL, Anuraj Sept 28 2026):
//   step_done:          "{First} checked off {step} in your escrow."
//   custom_step_added:  "{First} added a new step to your escrow."
//   close_date_changed: "Your closing date is now {date}."
//   key_dates_changed:  "{First} updated your key dates."
// Forward progress only: unchecks never produce an event (the DB trigger
// matches transitions, never state).

export type PushEvent = 'step_done' | 'custom_step_added' | 'close_date_changed' | 'key_dates_changed';

export interface TriggerPayload {
  event: PushEvent;
  escrow_id: string;
  step_title: string | null;
  new_close_date: string | null; // 'YYYY-MM-DD'
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
): string | null {
  const first = firstNameOf(realtorName);
  switch (event) {
    case 'step_done': {
      const title = (stepTitle ?? '').trim();
      if (!title) return null;
      return `${first} checked off ${title} in your escrow.`;
    }
    case 'custom_step_added':
      return `${first} added a new step to your escrow.`;
    case 'close_date_changed': {
      const d = (newCloseDate ?? '').trim();
      if (!d) return null;
      return `Your closing date is now ${formatPushDate(d)}.`;
    }
    case 'key_dates_changed':
      return `${first} updated your key dates.`;
    case 'key_dates_changed':
      return `${first} updated your key dates.`;
  }
}

/** Validate + normalize the trigger's JSON body. Returns null when invalid. */
export function parseTriggerPayload(raw: unknown): TriggerPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const event = p['event'];
  const escrowId = p['escrow_id'];
  if (
    (event !== 'step_done' &&
      event !== 'custom_step_added' &&
      event !== 'close_date_changed' &&
      event !== 'key_dates_changed') ||
    typeof escrowId !== 'string' ||
    !escrowId
  ) {
    return null;
  }
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : null;
  return {
    event,
    escrow_id: escrowId,
    step_title: strOrNull(p['step_title']),
    new_close_date: strOrNull(p['new_close_date']),
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
