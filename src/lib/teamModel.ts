// Clear to Close — Team Access model (Oct 2026, migration 0044).
//
// Types + pure mappers for the team RPC surface (escrow_team_grants).
// The RPCs return snake_case jsonb; every mapper here is defensive —
// a malformed payload maps to an empty/null result, never a throw — so
// the store can converge state without a try/catch around each field.
// Screens import the types from here (or via the store's re-exports).

import type { Escrow, Side, TeamGrantRole, TeamRole } from './types';

export type { TeamGrantRole, TeamRole };

/** Result of a team action RPC (create/respond/remove/cancel/leave). */
export interface TeamActionResult {
  ok: boolean;
  /** The server's error code (e.g. 'seat_taken', 'not_found') or 'network'. */
  error?: string;
}

/** One pending team invite addressed to the signed-in account. */
export interface TeamPendingInvite {
  grantId: string;
  role: TeamGrantRole;
  createdAt: string;
  ownerName: string | null;
  ownerPhotoUrl: string | null;
  escrow: {
    id: string;
    address: string;
    city: string;
    side: Side;
    buyerName: string | null;
    sellerName: string | null;
    closeDate: string;
    status: 'open' | 'closed' | 'cancelled';
  };
}

/**
 * One accepted grant from list_invited_escrows: the grant metadata plus
 * the RAW escrow row (to_jsonb of the escrows row). The store maps the
 * row through cloudSync.fromEscrowRow and decorates the result with
 * {@link decorateInvitedEscrow}.
 */
export interface InvitedEscrowEntry {
  grantId: string;
  role: TeamGrantRole;
  acceptedAt: string | null;
  ownerName: string | null;
  ownerPhotoUrl: string | null;
  escrowRow: Record<string, unknown>;
}

export interface TeamParticipantOwner {
  userId: string | null;
  name: string | null;
  photoUrl: string | null;
}

export interface TeamParticipantMember {
  grantId: string;
  userId: string | null;
  invitedEmail: string;
  name: string | null;
  photoUrl: string | null;
  role: TeamGrantRole;
  status: string;
  createdAt: string | null;
  acceptedAt: string | null;
}

export interface TeamParticipants {
  owner: TeamParticipantOwner | null;
  members: TeamParticipantMember[];
}

/** One escrow_activity row (server-written, actor-stamped, frozen). */
export interface TeamActivityEntry {
  id: string;
  kind: string;
  actorId: string | null;
  actorName: string | null;
  actorLabel: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------- helpers --

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nullStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Sanitize an RPC role value: only 'tc' is special; anything else is an associate. */
export function sanitizeGrantRole(v: unknown): TeamGrantRole {
  return v === 'tc' ? 'tc' : 'associate';
}

function sideOf(v: unknown): Side {
  return v === 'sell' || v === 'both' ? v : 'buy';
}

function statusOf(v: unknown): 'open' | 'closed' | 'cancelled' {
  return v === 'closed' || v === 'cancelled' ? v : 'open';
}

/**
 * The access derivation: an escrow's effective role for this account.
 * Own escrows (table pull, local creation) never carry a grant, so a
 * missing accessRole is the owner; invited escrows carry the grant role
 * set by refreshTeam's merge.
 */
export function deriveAccessRole(e: Escrow): TeamRole {
  return e.accessRole ?? 'owner';
}

// ---------------------------------------------------------------- mappers --

/** Map list_my_team_invites() jsonb to pending invite cards. */
export function mapPendingTeamInvites(data: unknown): TeamPendingInvite[] {
  if (!Array.isArray(data)) return [];
  const out: TeamPendingInvite[] = [];
  for (const raw of data) {
    const r = rec(raw);
    const grantId = str(r.grant_id);
    const e = rec(r.escrow);
    const escrowId = str(e.id);
    if (!grantId || !escrowId) continue;
    out.push({
      grantId,
      role: sanitizeGrantRole(r.role),
      createdAt: str(r.created_at),
      ownerName: nullStr(r.owner_name),
      ownerPhotoUrl: nullStr(r.owner_photo_url),
      escrow: {
        id: escrowId,
        address: str(e.address),
        city: str(e.city),
        side: sideOf(e.side),
        buyerName: nullStr(e.buyer_name),
        sellerName: nullStr(e.seller_name),
        closeDate: str(e.close_date),
        status: statusOf(e.status),
      },
    });
  }
  return out;
}

/** Map list_invited_escrows() jsonb to grant entries with raw escrow rows. */
export function mapInvitedEscrowEntries(data: unknown): InvitedEscrowEntry[] {
  if (!Array.isArray(data)) return [];
  const out: InvitedEscrowEntry[] = [];
  for (const raw of data) {
    const r = rec(raw);
    const grantId = str(r.grant_id);
    const escrowRow = rec(r.escrow);
    if (!grantId || !str(escrowRow.id)) continue;
    out.push({
      grantId,
      role: sanitizeGrantRole(r.role),
      acceptedAt: nullStr(r.accepted_at),
      ownerName: nullStr(r.owner_name),
      ownerPhotoUrl: nullStr(r.owner_photo_url),
      escrowRow,
    });
  }
  return out;
}

/** Stamp an invited escrow (already mapped from its row) with its team meta. */
export function decorateInvitedEscrow(escrow: Escrow, entry: InvitedEscrowEntry): Escrow {
  return {
    ...escrow,
    accessRole: entry.role,
    ownerName: entry.ownerName,
    ownerPhotoUrl: entry.ownerPhotoUrl,
  };
}

/**
 * Map get_escrow_participants() jsonb. Null when the RPC did not confirm
 * access (ok is not true) or the payload is malformed — the caller shows
 * no team sheet rather than a guessed one.
 */
export function mapEscrowParticipants(data: unknown): TeamParticipants | null {
  const r = rec(data);
  if (r.ok !== true) return null;
  const o = rec(r.owner);
  const owner: TeamParticipantOwner | null =
    o && Object.keys(o).length > 0
      ? { userId: nullStr(o.user_id), name: nullStr(o.name), photoUrl: nullStr(o.photo_url) }
      : null;
  const members: TeamParticipantMember[] = [];
  if (Array.isArray(r.members)) {
    for (const raw of r.members) {
      const m = rec(raw);
      const grantId = str(m.grant_id);
      if (!grantId) continue;
      members.push({
        grantId,
        userId: nullStr(m.user_id),
        invitedEmail: str(m.invited_email),
        name: nullStr(m.name),
        photoUrl: nullStr(m.photo_url),
        role: sanitizeGrantRole(m.role),
        status: str(m.status),
        createdAt: nullStr(m.created_at),
        acceptedAt: nullStr(m.accepted_at),
      });
    }
  }
  return { owner, members };
}

/** Map list_escrow_activity() jsonb (newest first, as the RPC returns it). */
export function mapEscrowActivity(data: unknown): TeamActivityEntry[] {
  if (!Array.isArray(data)) return [];
  const out: TeamActivityEntry[] = [];
  for (const raw of data) {
    const r = rec(raw);
    const id = str(r.id);
    const kind = str(r.kind);
    if (!id || !kind) continue;
    out.push({
      id,
      kind,
      actorId: nullStr(r.actor_id),
      actorName: nullStr(r.actor_name),
      actorLabel: nullStr(r.actor_label),
      detail: rec(r.detail),
      createdAt: str(r.created_at),
    });
  }
  return out;
}

/**
 * Map a team action RPC's jsonb payload to the store's result shape.
 * Transport failures never reach here — the caller maps those to
 * { ok: false, error: 'network' } itself.
 */
export function teamResultFromRpc(data: unknown): TeamActionResult {
  const r = rec(data);
  if (r.ok === true) return { ok: true };
  const error = nullStr(r.error);
  return { ok: false, error: error ?? 'unknown' };
}
