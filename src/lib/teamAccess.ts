// Clear to Close — Team Access screen helpers.
//
// Team Access (Oct 20, 2026): per-escrow Associate + TC grants. The DATA
// layer owns the model types + RPC mappers (src/lib/teamModel.ts,
// migration 0044) and the store surface (Store in src/lib/store.ts) —
// screens call the store directly. This file holds only the pure
// derivations the team surfaces share (seat state, role gating, legacy
// TC-link detection, display copy), unit-tested in
// tests/team_screens.test.ts.

import type { Escrow, Invite, StepT, TeamGrantRole, TeamRole } from './types';
import type { TeamParticipantMember, TeamParticipants } from './teamModel';

export type { TeamActivityEntry } from './teamModel';
export type AccessRole = TeamRole;
export type GrantRole = TeamGrantRole;

// ---- Escrow access fields (stamped by the data layer, types.ts) ----

export function accessRoleOf(escrow: Escrow | null | undefined): AccessRole {
  if (!escrow) return 'owner';
  return escrow.accessRole === 'associate' || escrow.accessRole === 'tc'
    ? escrow.accessRole
    : 'owner';
}

export function ownerNameOf(escrow: Escrow | null | undefined): string {
  return (escrow?.ownerName ?? '').trim();
}

export function ownerPhotoUrlOf(escrow: Escrow | null | undefined): string | null {
  return escrow?.ownerPhotoUrl ?? null;
}

export function isMemberRole(role: AccessRole): boolean {
  return role !== 'owner';
}

/** Owner + Associate edit the checklist; the TC views it (spec matrix). */
export function canEditChecklist(role: AccessRole): boolean {
  return role === 'owner' || role === 'associate';
}

// ---- Step actor stamp (steps.completedBy, migration 0044) ----

export function completedByOf(step: StepT | null | undefined): string | null {
  const by = step?.completedBy;
  return typeof by === 'string' && by ? by : null;
}

// ---- Seats ----

export function teamRoleLabel(role: GrantRole): string {
  return role === 'tc' ? 'TC' : 'Associate';
}

export function teamRoleSeatTitle(role: GrantRole): string {
  return role === 'tc' ? 'Transaction coordinator' : 'Associate';
}

export function teamRoleCapability(role: GrantRole): string {
  return role === 'tc' ? 'Edits intakes only' : 'Can edit everything';
}

/**
 * The occupant of one seat: at most one active-or-pending grant exists per
 * role per escrow (data-layer invariant), so this is a plain find.
 */
export function seatFor(
  participants: TeamParticipants | null | undefined,
  role: GrantRole,
): TeamParticipantMember | null {
  if (!participants) return null;
  return participants.members.find((m) => m.role === role) ?? null;
}

/**
 * Invite-card seat pill (frame 7): "Associate · Alex Rivera" when the
 * seat is accepted, "TC · Invite sent" while pending, and NO pill for an
 * empty seat (the row's sub line already says how team invites work).
 */
export function seatPillLabel(
  role: GrantRole,
  seat: TeamParticipantMember | null | undefined,
): string | null {
  if (!seat) return null;
  if (seat.status === 'accepted') {
    const name = (seat.name ?? '').trim();
    return name ? `${teamRoleLabel(role)} · ${name}` : null;
  }
  return `${teamRoleLabel(role)} · Invite sent`;
}

/** userId -> display name for everyone attached to the escrow. */
export function participantNameMap(
  participants: TeamParticipants | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!participants) return map;
  const owner = participants.owner;
  if (owner?.userId && owner.name && owner.name.trim()) {
    map.set(owner.userId, owner.name.trim());
  }
  for (const m of participants.members) {
    if (m.userId && m.name && m.name.trim()) map.set(m.userId, m.name.trim());
  }
  return map;
}

// ---- Pending invite card copy (frame 4) ----

export function pendingInviteAbilityLine(role: GrantRole): string {
  return role === 'associate'
    ? "You'll be able to edit everything in this escrow."
    : 'You can edit the intakes and view everything else.';
}

/** The shared-strip sentence on a member's escrow view (frame 6). */
export function memberStripSentence(role: AccessRole): string {
  return role === 'associate'
    ? "You're an Associate here, so you can edit everything in it."
    : "You're the transaction coordinator here, so you can edit the intakes and view the rest.";
}

/** "Dana" from a pending member: profile name's first word, else the
 * invited email's local part capitalized (frame 3: "waiting for Dana"). */
export function waitingForName(seat: TeamParticipantMember): string {
  const name = (seat.name ?? '').trim();
  if (name) return name.split(/\s+/)[0];
  const email = (seat.invitedEmail ?? '').trim();
  if (email) {
    const local = email.split('@')[0].split('.')[0];
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return 'them';
}

// ---- Legacy TC code link (Q1) ----

/**
 * The live legacy TC link on an escrow: a TC invite that was redeemed and
 * never revoked. Managed (revoke) from the Team sheet now that the TC
 * section has left the share screen (frame 7 note).
 */
export function legacyTcInvite(invites: Invite[]): Invite | null {
  return (
    invites.find((i) => i.role === 'tc' && i.redeemedAt != null && !i.revokedAt) ??
    null
  );
}
