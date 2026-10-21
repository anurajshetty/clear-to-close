// Clear to Close — share-screen section visibility by escrow side.
//
// Since Sept 28, 2026 new escrows are single-side (buy OR sell);
// legacy escrows may still have side 'both'. The share screen shows
// only the relevant invite sections (Oct 2026, Anuraj):
//   side 'buy'  → Buyers
//   side 'sell' → Sellers
//   side 'both' → Buyers + Sellers (unchanged legacy behavior)
//
// Team Access (Oct 20, 2026): the Transaction coordinator section has
// LEFT the share screen — team invites are account-based and live on
// the Team sheet (app/team/[id].tsx). SHARE_SECTIONS keeps the TC meta
// because the store's side guard and legacy TC code links still use it;
// already-redeemed TC codes keep working and are managed (revoke) from
// the Team sheet.
//
// Pure logic, kept out of the screen component so it can be unit-tested.

import type { ClientRole, Side } from './types';

export interface ShareSectionMeta {
  role: ClientRole;
  plural: string; // "Buyers" | "Sellers" | "Transaction coordinator"
  buttonNoun: string; // "buyer" | "seller" | "TC" — "Invite the buyer", "Invite the TC"
  nameLabel: string; // "Buyer's name" | "Seller's name" | "TC's name"
  cap: number; // 2 | 2 | 1
}

export const SHARE_SECTIONS: ShareSectionMeta[] = [
  { role: 'buyer', plural: 'Buyers', buttonNoun: 'buyer', nameLabel: "Buyer's name", cap: 2 },
  { role: 'seller', plural: 'Sellers', buttonNoun: 'seller', nameLabel: "Seller's name", cap: 2 },
  { role: 'tc', plural: 'Transaction coordinator', buttonNoun: 'TC', nameLabel: "TC's name", cap: 1 },
];

/**
 * Whether an invite role is allowed on an escrow side (Oct 2026, Anuraj).
 * The TC role is side-agnostic; legacy 'both' escrows accept buyer/seller.
 * (Store-level guard — the share screen no longer offers TC codes, but
 * legacy TC invites stay valid data.)
 */
export function isInviteRoleAllowedForSide(role: ClientRole, side: Side): boolean {
  if (role === 'tc') return true;
  if (side === 'both') return true;
  return (role === 'buyer' && side === 'buy') || (role === 'seller' && side === 'sell');
}

/**
 * The invite sections visible for an escrow side. Client sections only:
 * the TC section never appears here anymore (Team Access, Oct 20, 2026 —
 * see the header note). A null/undefined side (escrow failed to load)
 * fails open to both client sections rather than hiding invite UI.
 */
export function visibleShareSections(side: Side | null | undefined): ShareSectionMeta[] {
  const clientSections = SHARE_SECTIONS.filter((s) => s.role !== 'tc');
  if (side === 'buy') return clientSections.filter((s) => s.role !== 'seller');
  if (side === 'sell') return clientSections.filter((s) => s.role !== 'buyer');
  return clientSections;
}
