/**
 * Multi-escrow list logic (Sept 28, 2026, Anuraj-approved).
 *
 * One device holds one live link per escrow. When 2+ links validate, the
 * client lands on the "My escrows" list instead of dropping into a single
 * escrow. Pure helpers — no I/O, no side effects — so unit tests can pin
 * routing, ordering, and state rules exactly.
 *
 * Approved ordering: in-progress first, completed second; most-recently
 * updated first within each group.
 *
 * Approved row data: address + city, role badge (Buyer/Seller/TC), state
 * (In progress/Completed), realtor name + photo (initials fallback), and
 * read-only on completed escrows.
 */
import type { DeviceClientLink } from './types';
import { escrowStatusLabel } from './clientView';

export interface EscrowListEntry {
  link: DeviceClientLink;
  /** Minimal view data for the row — a TcView's active side folds into this. */
  summary: {
    address: string;
    city: string;
    done: number;
    total: number;
    status?: 'open' | 'closed' | 'cancelled';
    updatedAt?: string;
  };
  /** 'progress' | 'completed' — drives the sort and the read-only rule. */
  state: 'progress' | 'completed';
  /** Realtor display name for this escrow (per-escrow branding isolation). */
  realtorName: string;
  /** Realtor profile photo data URL, or null → initials/teal fallback. */
  realtorPhoto: string | null;
  /** First letter of the realtor's name for the fallback badge. */
  realtorInitials: string;
}

export type EscrowListRoute =
  | { kind: 'redeem' } // 0 valid links
  | { kind: 'direct'; link: DeviceClientLink } // 1 valid link
  | { kind: 'list' }; // 2+ valid links

/** Boot route from the validated links (approved rule). */
export function routeForLinks(links: DeviceClientLink[]): EscrowListRoute {
  if (links.length === 1) return { kind: 'direct', link: links[0] };
  if (links.length > 1) return { kind: 'list' };
  return { kind: 'redeem' };
}

/** True when the "My escrows" back control may appear (2+ valid links). */
export function showEscrowListBack(validLinkCount: number): boolean {
  return validLinkCount >= 2;
}

/** Whether a list entry opens read-only (completed escrows are read-only). */
export function isReadOnlyEntry(state: 'progress' | 'completed'): boolean {
  return state === 'completed';
}

/**
 * Build one list entry from the device link and its cached/fresh view
 * summary. State comes from the same label the client homes use
 * (escrowStatusLabel), so the list and the homes can never disagree about
 * "Completed".
 */
export function buildEscrowListEntry(
  link: DeviceClientLink,
  summary: EscrowListEntry['summary'],
  realtorName: string,
  realtorPhoto: string | null,
): EscrowListEntry {
  const completed = escrowStatusLabel(summary) === 'Completed';
  const initials = realtorName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return {
    link,
    summary,
    state: completed ? 'completed' : 'progress',
    realtorName,
    realtorPhoto,
    realtorInitials: initials || '?',
  };
}

/**
 * Approved ordering: in-progress first, completed second; within a group,
 * most-recently-updated first (updatedAt). Entries without an updatedAt
 * sort as oldest — stable and deterministic.
 */
export function sortEscrowListEntries(entries: EscrowListEntry[]): EscrowListEntry[] {
  const rank = (e: EscrowListEntry) => (e.state === 'progress' ? 0 : 1);
  const ts = (e: EscrowListEntry) => {
    const t = e.summary.updatedAt ? Date.parse(e.summary.updatedAt) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  return [...entries].sort((a, b) => rank(a) - rank(b) || ts(b) - ts(a));
}
