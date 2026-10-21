// Clear to Close — Team Access activity timeline text (frame 5).
//
// Pure rendering derivations for the per-escrow activity feed: the action
// sentence per entry kind, day grouping ("Today" / "Yesterday" / "Oct 12"),
// and the frozen timestamp format (same-day rows show the time only,
// older rows show "Oct 19 · 4:26 PM" — the frame's exact shapes). Times
// are formatted ONCE from the stored timestamp and never tick.
// Unit-pinned in tests/team_screens.test.ts.

import type { TeamActivityEntry } from './teamAccess';
import { teamRoleLabel, type GrantRole } from './teamAccess';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface ActivityTextPart {
  text: string;
  bold?: boolean;
}

function detailString(entry: TeamActivityEntry, key: string): string {
  const v = entry.detail?.[key];
  return typeof v === 'string' ? v : '';
}

function detailRole(entry: TeamActivityEntry): GrantRole {
  return detailString(entry, 'role') === 'tc' ? 'tc' : 'associate';
}

/**
 * The invitee named by a team_invited entry: the stored display name when
 * the snapshot carries one (frame 5 shows the name), else the invited
 * email from the brief's mapping.
 */
function inviteeName(entry: TeamActivityEntry): string {
  return detailString(entry, 'invited_name') || detailString(entry, 'invited_email');
}

/**
 * The full activity line as styled parts: the actor's name bold, then the
 * action. Client actors render their snapshot label ("Priya Nair
 * (buyer)") — name bold, the "(buyer)" suffix plain.
 */
export function activityLineParts(entry: TeamActivityEntry): ActivityTextPart[] {
  if (entry.kind === 'client_joined') {
    const label = (entry.actorLabel ?? entry.actorName ?? '').trim();
    const splitAt = label.indexOf(' (');
    if (splitAt > 0) {
      return [
        { text: label.slice(0, splitAt), bold: true },
        { text: `${label.slice(splitAt)} joined with an invite code` },
      ];
    }
    return [
      { text: label, bold: true },
      { text: ' joined with an invite code' },
    ];
  }

  const actor = (entry.actorName ?? entry.actorLabel ?? '').trim() || 'Someone';
  const head: ActivityTextPart[] = [{ text: actor, bold: true }];
  const title = detailString(entry, 'title');
  switch (entry.kind) {
    case 'step_checked':
      return [...head, { text: ` checked off “${title}”` }];
    case 'step_unchecked':
      return [...head, { text: ` unchecked “${title}”` }];
    case 'step_added':
      return [...head, { text: ` added a step “${title}”` }];
    case 'intake_saved':
      return [
        ...head,
        {
          text:
            detailString(entry, 'intake') === 'tc'
              ? ' saved the TC intake'
              : ' saved the buyer intake',
        },
      ];
    case 'closing_date_changed': {
      const to = detailString(entry, 'to');
      const d = to ? new Date(`${to}T12:00:00`) : null;
      const label =
        d && Number.isFinite(d.getTime())
          ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
          : to;
      return [...head, { text: ` changed the closing date to ${label}` }];
    }
    case 'escrow_closed':
      return [...head, { text: ' closed this escrow' }];
    case 'escrow_cancelled':
      return [...head, { text: ' cancelled this escrow' }];
    case 'team_invited': {
      const invitee = inviteeName(entry);
      return [
        ...head,
        { text: ' invited ' },
        { text: invitee, bold: true },
        { text: ` as ${teamRoleLabel(detailRole(entry))}` },
      ];
    }
    case 'team_accepted':
      return [...head, { text: ' accepted the invitation' }];
    case 'team_declined':
      return [...head, { text: ' declined the invitation' }];
    case 'team_removed':
      // The actor is the owner; the subject rides the entry detail.
      return [...head, { text: ` removed ${inviteeName(entry)}` }];
    case 'team_left':
      return [...head, { text: ' left this escrow' }];
    case 'team_invite_cancelled':
      return [...head, { text: ` cancelled the invitation to ${inviteeName(entry)}` }];
    case 'escrow_opened':
      return [...head, { text: ' opened this escrow' }];
    default:
      return [...head, { text: ' made a change' }];
  }
}

/** The line flattened to plain text (search/tests/accessibility). */
export function activityLineText(entry: TeamActivityEntry): string {
  return activityLineParts(entry)
    .map((p) => p.text)
    .join('');
}

/**
 * The escrow footer's latest-activity summary (frame 6): first name +
 * plain action (no curly quotes, no bold) + time, e.g.
 * "Alex checked off Appraisal ordered · 10:42 AM".
 */
export function activitySummaryLine(
  entry: TeamActivityEntry,
  nowMs: number = Date.now(),
): string {
  const full = activityLineText(entry);
  const actor = (entry.actorName ?? entry.actorLabel ?? '').trim();
  const first = actor ? actor.split(/\s+/)[0] : '';
  const plain = full.replace(/“([^”]*)”/g, '$1');
  const withFirst =
    first && actor && plain.startsWith(actor)
      ? first + plain.slice(actor.length)
      : plain;
  return `${withFirst} · ${activityTimeLabel(entry.createdAt, nowMs)}`;
}

// ---- Day grouping + frozen timestamps ----

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function activityDayLabel(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return '';
  const dayDiff = Math.round((startOfDayMs(new Date(nowMs)) - startOfDayMs(then)) / DAY_MS);
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  const base = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === new Date(nowMs).getFullYear()
    ? base
    : `${base}, ${then.getFullYear()}`;
}

export interface ActivityDayGroup {
  label: string;
  entries: TeamActivityEntry[];
}

/** Groups newest-first entries under day labels, preserving order. */
export function groupActivityByDay(
  entries: TeamActivityEntry[],
  nowMs: number = Date.now(),
): ActivityDayGroup[] {
  const groups: ActivityDayGroup[] = [];
  for (const entry of entries) {
    const label = activityDayLabel(entry.createdAt, nowMs);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function clockLabel(d: Date): string {
  let h = d.getHours();
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${mins} ${suffix}`;
}

/**
 * Frozen row timestamp (frame 5): today shows the time alone; any older
 * day shows "Mon D · h:mm AM" (year added across years).
 */
export function activityTimeLabel(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return '';
  if (activityDayLabel(iso, nowMs) === 'Today') return clockLabel(then);
  const base = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  const dated =
    then.getFullYear() === new Date(nowMs).getFullYear()
      ? base
      : `${base}, ${then.getFullYear()}`;
  return `${dated} · ${clockLabel(then)}`;
}

/**
 * The realtor step row's check-off attribution (frames 6/7):
 * "Checked off by Alex Rivera · Today" / "· Oct 18".
 */
export function checkedOffByLine(
  name: string,
  completedAtIso: string,
  nowMs: number = Date.now(),
): string {
  const label = activityDayLabel(completedAtIso, nowMs);
  return `Checked off by ${name} · ${label}`;
}
