// Clear to Close — invite list helpers (Oct 2026).
//
// Shared by the share screen (app/share/[id].tsx) and the realtor
// transaction detail (app/escrow/[id].tsx): the detail screen's share
// button reads "View clients" once a client invite exists, otherwise
// "Share this escrow" (Anuraj, Oct 2026).
import type { Invite } from './types';

/** Non-revoked invites, oldest first — revoked rows disappear from the list. */
export function visibleInvites(invites: Invite[]): Invite[] {
  return invites
    .filter((i) => !i.revokedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * True when at least one non-revoked buyer/seller client invite exists.
 * TC invites do not count (Anuraj, Oct 2026).
 */
export function hasClientInvites(invites: Invite[]): boolean {
  return visibleInvites(invites).some((i) => i.role === 'buyer' || i.role === 'seller');
}

/**
 * The transaction-detail share button title (Anuraj, Oct 2026): "View
 * clients" once clients are added, otherwise "Share this escrow".
 */
export function shareButtonTitle(hasClients: boolean): string {
  return hasClients ? 'View clients' : 'Share this escrow';
}
