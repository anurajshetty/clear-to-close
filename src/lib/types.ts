// Clear to Close — core domain types.
// These contracts are shared across workstreams; do not change names/shapes.

export type Side = 'buy' | 'sell' | 'both';

export type ClientRole = 'buyer' | 'seller';

export interface StepT {
  id: string;
  title: string;
  subtitle: string;
  done: boolean;
  custom: boolean;
  order: number;
  completedAt: string | null;
}

export interface Escrow {
  id: string;
  address: string;
  city: string;
  side: Side;
  buyerName: string | null;
  sellerName: string | null;
  openDate: string;
  closeDate: string;
  buyerSteps: StepT[];
  sellerSteps: StepT[];
  status: 'open' | 'closed';
  createdAt: string;
}

export interface CreateEscrowInput {
  address: string;
  city: string;
  side: Side;
  buyerName?: string;
  sellerName?: string;
  openDate: string;
  closeDate: string;
}

export interface RealtorProfile {
  name: string;
  photoUri: string | null;
  about: string;
  yearsExperience: string;
  dealsClosed: string;
  areasServed: string;
  phone: string;
  /** Optional DRE / license number — shown on the client profile only if entered. */
  dreLicense: string;
}

export interface Invite {
  id: string;
  code: string;
  escrowId: string;
  role: ClientRole;
  partyName: string;
  createdAt: string;
  revokedAt: string | null;
  redeemedAt: string | null;
}

export type RedeemResult =
  | { ok: true; escrowId: string; role: ClientRole; partyName: string; linkId: string }
  | { ok: false; error: 'invalid' | 'name_mismatch' | 'revoked' | 'already_used' | 'network' | 'device_has_link' };

export interface ClientLink {
  id: string;
  escrowId: string;
  inviteId: string;
  role: ClientRole;
  partyName: string;
  createdAt: string;
  /** Device this link is bound to (0002 device linking). Null until redeemed. */
  deviceId: string | null;
  /** Set when the invite is regenerated or revoked — the link is dead. */
  revokedAt: string | null;
}

/** The client link as persisted on this device (the access key to the escrow). */
export interface DeviceClientLink {
  linkId: string;
  escrowId: string;
  role: ClientRole;
  partyName: string;
  deviceId: string;
}

export interface ClientView {
  escrowId: string;
  role: ClientRole;
  address: string;
  city: string;
  daysToClose: number;
  done: number;
  total: number;
  steps: StepT[];
  upNext: StepT | null;
}
