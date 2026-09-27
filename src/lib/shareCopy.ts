// Clear to Close — "Share {Name}'s profile" copy builders.
//
// APPROVED copy spec: mockup "Share summary — approved copy spec" (Sept 26,
// 2026). Both versions are built dynamically from the realtor's profile +
// the client's escrow. Copy rules: realtor by name only (first name on
// second reference), no gendered pronouns, no em dashes.
//
// - Message version: short, for texting/messaging apps. Shared through the
//   native share sheet.
// - Email version: subject + body, for a "share via email" affordance.
// - profile.rating is null when there are no reviews: the rating segment is
//   then dropped entirely (never "0 stars").
// - The deals-closed count appears nowhere: not in share copy, not on any
//   screen (Anuraj's call, Sept 26).
import { firstNameOf } from './pace';

/** Public profile URL contract: https://anurajshetty.github.io/clear-to-close/realtor/<realtor-id> */
export const PROFILE_URL_BASE = 'https://anurajshetty.github.io/clear-to-close/realtor';

export function profileUrlFor(realtorId: string | null | undefined): string {
  const id = (realtorId ?? '').trim();
  return id ? `${PROFILE_URL_BASE}/${id}` : '';
}

export interface ShareCopyInput {
  realtorName: string;
  realtyGroup?: string | null;
  dreLicense?: string | null;
  /** Raw profile string (e.g. "9"). Unparseable/empty -> the years segment is dropped. */
  yearsExperience?: string | null;
  /** Null when there are no reviews — the rating segment is then dropped. */
  rating?: number | null;
  tagline?: string | null;
  stepCount: number;
  /** Days from close to today at 100%. Null/unknown -> "ahead of schedule". */
  daysToClose?: number | null;
  /** Public profile URL. Empty -> the "See the profile" line is dropped. */
  profileUrl: string;
  clientName: string;
}

function groupSegment(i: ShareCopyInput): string {
  const group = (i.realtyGroup ?? '').trim();
  const dre = (i.dreLicense ?? '').trim();
  if (group && dre) return `${group} (DRE #${dre})`;
  if (group) return group;
  if (dre) return `DRE #${dre}`;
  return '';
}

function starString(rating: number | null | undefined): string {
  if (rating == null || !Number.isFinite(rating)) return '';
  const n = Math.min(Math.max(Math.round(rating), 1), 5);
  return '★'.repeat(n);
}

/** "27 days early" / "ahead of schedule" — mirrors the 100% pill rule (5+ days). */
function earlyPhrase(i: ShareCopyInput, style: 'early' | 'ahead'): string {
  const d = i.daysToClose;
  if (d != null && d >= 5) {
    return style === 'early' ? `${d} days early` : `${d} days ahead of schedule`;
  }
  return 'ahead of schedule';
}

function statsLine(i: ShareCopyInput): string {
  const parts: string[] = [];
  const years = parseInt((i.yearsExperience ?? '').trim(), 10);
  if (Number.isFinite(years) && years > 0) {
    parts.push(`${years} year${years === 1 ? '' : 's'}`);
  }
  const stars = starString(i.rating);
  if (stars) parts.push(stars);
  return parts.join(' · ');
}

/**
 * Text message / messaging apps version.
 *
 * e.g. "🏡 My realtor Maya Sharma just got us closed, 27 days early!
 * Compass Realty (DRE #01998877) · ★★★★★ from clients.
 * See the profile: https://anurajshetty.github.io/clear-to-close/realtor/<id>"
 */
export function buildShareMessage(i: ShareCopyInput): string {
  const name = i.realtorName.trim();
  const early = earlyPhrase(i, 'early');
  const head =
    early === 'ahead of schedule'
      ? `🏡 My realtor ${name} just got us closed ahead of schedule!`
      : `🏡 My realtor ${name} just got us closed, ${early}!`;
  const segments: string[] = [];
  const group = groupSegment(i);
  if (group) segments.push(group);
  const stars = starString(i.rating);
  if (stars) segments.push(`${stars} from clients`);
  const lines = [segments.length > 0 ? `${head} ${segments.join(' · ')}.` : head];
  const url = i.profileUrl.trim();
  if (url) lines.push(`See the profile: ${url}`);
  return lines.join('\n');
}

/**
 * Email version: subject + body.
 *
 * Subject: "My realtor just got us home, meet {Name}"
 */
export function buildShareEmail(i: ShareCopyInput): { subject: string; body: string } {
  const name = i.realtorName.trim();
  const first = firstNameOf(name);
  const early = earlyPhrase(i, 'ahead');
  const subject = `My realtor just got us home, meet ${name}`;
  const lines: string[] = [
    'Hi,',
    '',
    `I just closed my escrow with ${name} and could not recommend ${name} more highly. ` +
      `${first} completed all ${i.stepCount} steps and got us closed ${early}.`,
    '',
  ];
  const group = groupSegment(i);
  lines.push(group ? `${name}, ${group}` : name);
  const tagline = (i.tagline ?? '').trim();
  if (tagline) lines.push(`"${tagline}"`);
  const stats = statsLine(i);
  if (stats) lines.push(stats);
  const url = i.profileUrl.trim();
  if (url) {
    lines.push('', `See the profile: ${url}`);
  }
  const client = i.clientName.trim();
  if (client) {
    lines.push('', `- ${client}`);
  }
  return { subject, body: lines.join('\n') };
}

/** Redeem celebration card kicker (Anuraj's call, Sept 2026): personalized
 *  "Congratulations, {client name}" using the redeemed invite's party name.
 *  Falls back to a bare congratulations when the name is somehow empty. */
export function celebrationKicker(clientName: string | null | undefined): string {
  const n = (clientName ?? '').trim();
  return n ? `Congratulations, ${n}` : 'Congratulations!';
}

/**
 * Redeem celebration card headline (celebration redesign, Anuraj's call,
 * Sept 2026): "Your escrow is open!", rendered on two lines. The line break
 * is part of the copy so every surface renders the same two-line headline.
 */
export function celebrationHeadline(): string {
  return 'Your escrow\nis open!';
}

/**
 * Celebration card checklist line (celebration redesign, Sept 2026):
 * "<realtor name> has your checklist ready." Takes the resolved display
 * name (already fallen back to "Your realtor" by the caller).
 */
export function celebrationChecklistReady(name: string): string {
  return `${name.trim()} has your checklist ready.`;
}

/** Celebration card follow line (celebration redesign, Sept 2026). */
export function celebrationFollowProgress(): string {
  return 'Follow your progress right here.';
}

/** "YOUR REALTOR" label above the tappable realtor photo (Sept 2026). */
export function celebrationRealtorLabel(): string {
  return 'Your realtor';
}
