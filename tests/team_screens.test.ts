// Clear to Close — Team Access screen-logic tests (Oct 20, 2026).
// Pins the PURE helpers the Team Access screens render from:
//   src/lib/teamAccess.ts       — seat state, role gating, pending-card
//                                 copy, legacy TC link detection, actor
//                                 name resolution.
//   src/lib/teamActivityText.ts — the frame-5 activity line per kind,
//                                 day grouping, frozen timestamps, the
//                                 "Checked off by" step line (frames 6/7).
// RN screens themselves are not importable in node; everything they
// derive lives in those two lib files by design.
// Run: see tests/run.sh (team_screens).

import { assert, summary } from './assert';

function deepEq(actual: unknown, expected: unknown, msg: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

function eq(actual: unknown, expected: unknown, msg?: string): void {
  assert(
    actual === expected,
    msg ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
import type { Escrow, Invite, StepT } from '../src/lib/types';
import {
  accessRoleOf,
  addInviteLabel,
  canEditChecklist,
  completedByOf,
  invitesFrozen,
  isMemberRole,
  legacyTcInvite,
  memberStripSentence,
  ownerNameOf,
  participantNameMap,
  pendingInviteAbilityLine,
  seatEmailLabel,
  seatFor,
  seatPillLabel,
  teamFinalExplainer,
  teamRoleCapability,
  teamRoleLabel,
  teamRoleSeatTitle,
  waitingForName,
} from '../src/lib/teamAccess';
import type {
  TeamActivityEntry,
  TeamParticipantMember,
  TeamParticipants,
} from '../src/lib/teamModel';
import {
  activityLineParts,
  activityLineText,
  activitySummaryLine,
  activityTimeLabel,
  checkedOffByLine,
  groupActivityByDay,
} from '../src/lib/teamActivityText';

// Local-time anchors (helpers format in local time; no Z suffixes so the
// pins hold in any timezone): "now" is Tue Oct 20, 2026, 3:00 PM local.
const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();
const TODAY_1042 = '2026-10-20T10:42:00';
const YDAY_1626 = '2026-10-19T16:26:00';
const OCT18_0905 = '2026-10-18T09:05:00';
const OCT12_0905 = '2026-10-12T09:05:00';

function entry(partial: Partial<TeamActivityEntry>): TeamActivityEntry {
  return {
    id: 'a1',
    kind: 'step_checked',
    actorId: 'u-alex',
    actorName: 'Alex Rivera',
    actorLabel: null,
    detail: {},
    createdAt: TODAY_1042,
    ...partial,
  };
}

function member(partial: Partial<TeamParticipantMember>): TeamParticipantMember {
  return {
    grantId: 'g1',
    userId: 'u-alex',
    name: 'Alex Rivera',
    invitedEmail: 'alex@example.com',
    photoUrl: null,
    role: 'associate',
    status: 'accepted',
    acceptedAt: '2026-10-12T10:00:00',
    createdAt: '2026-10-12T09:00:00',
    ...partial,
  };
}

const participants: TeamParticipants = {
  owner: { userId: 'u-owner', name: 'Mariah Petzoldt', photoUrl: null },
  members: [
    member({}),
    member({
      grantId: 'g2',
      userId: 'u-dana',
      name: 'Dana Kim',
      invitedEmail: 'dana@tcservices.com',
      role: 'tc',
    }),
  ],
};

// ---- access role reads ----
{
  const bare = {} as Escrow;
  eq(accessRoleOf(bare), 'owner', 'no accessRole stamp -> owner');
  eq(accessRoleOf(null), 'owner', 'null escrow -> owner');
  eq(
    accessRoleOf({ accessRole: 'associate' } as unknown as Escrow),
    'associate',
    'associate stamp passes through',
  );
  eq(
    accessRoleOf({ accessRole: 'tc' } as unknown as Escrow),
    'tc',
    'tc stamp passes through',
  );
  eq(
    accessRoleOf({ accessRole: 'bogus' } as unknown as Escrow),
    'owner',
    'unknown stamp fails to owner',
  );
  eq(ownerNameOf({ ownerName: ' Mariah Petzoldt ' } as unknown as Escrow), 'Mariah Petzoldt');
  eq(ownerNameOf(bare), '', 'no owner name -> empty string');
  eq(isMemberRole('owner'), false);
  eq(isMemberRole('associate'), true);
  eq(isMemberRole('tc'), true);
}

// ---- role gating (spec matrix) ----
{
  eq(canEditChecklist('owner'), true, 'owner edits the checklist');
  eq(canEditChecklist('associate'), true, 'associate edits the checklist');
  eq(canEditChecklist('tc'), false, 'TC views the checklist only');
}

// ---- step actor stamp ----
{
  const plain = { completedBy: 'u-alex' } as unknown as StepT;
  eq(completedByOf(plain), 'u-alex');
  eq(completedByOf({} as StepT), null, 'no stamp -> null');
  eq(completedByOf(null), null);
}

// ---- role labels + capability copy (frame 3) ----
{
  eq(teamRoleLabel('associate'), 'Associate');
  eq(teamRoleLabel('tc'), 'TC');
  eq(teamRoleSeatTitle('associate'), 'Associate');
  eq(teamRoleSeatTitle('tc'), 'Transaction coordinator');
  eq(teamRoleCapability('associate'), 'Can edit everything');
  eq(teamRoleCapability('tc'), 'Edits intakes only');
}

// ---- per-seat invite forms + the closed/cancelled freeze (Oct 23, 2026) ----
{
  eq(addInviteLabel('associate'), '+ Add an associate');
  eq(addInviteLabel('tc'), '+ Add a coordinator');
  eq(seatEmailLabel('associate'), 'Associate’s email');
  eq(seatEmailLabel('tc'), 'TC’s email');
  const base = {
    id: 'e1', address: '1 St', city: 'X', side: 'buy' as const,
    buyerName: 'B', sellerName: null, openDate: '2026-10-01',
    closeDate: '2026-12-01', buyerSteps: [], sellerSteps: [],
    buyerClosedAt: null, sellerClosedAt: null, createdAt: '2026-10-01T00:00:00Z',
  };
  eq(invitesFrozen({ ...base, status: 'open' as const }), false);
  eq(invitesFrozen({ ...base, status: 'closed' as const }), true);
  eq(invitesFrozen({ ...base, status: 'cancelled' as const }), true);
  eq(invitesFrozen(null), false);
  eq(
    teamFinalExplainer({ ...base, status: 'closed' as const }),
    'This escrow is closed, so the team is final. No one can be invited or removed.',
  );
  eq(
    teamFinalExplainer({ ...base, status: 'cancelled' as const }),
    'This escrow is cancelled, so the team is final. No one can be invited or removed.',
  );
}

// ---- seats ----
{
  eq(seatFor(participants, 'associate')?.name, 'Alex Rivera');
  eq(seatFor(participants, 'tc')?.name, 'Dana Kim');
  eq(seatFor({ owner: null, members: [] }, 'tc'), null, 'empty seat -> null');
  eq(seatFor(null, 'associate'), null, 'no participants -> null seat');

  eq(
    seatPillLabel('associate', member({})),
    'Associate · Alex Rivera',
    'frame 7: accepted seat pill names the person',
  );
  eq(seatPillLabel('tc', member({ role: 'tc', name: 'Dana Kim' })), 'TC · Dana Kim');
  eq(
    seatPillLabel('tc', member({ role: 'tc', status: 'pending', userId: null, name: null })),
    'TC · Invite sent',
    'frame 7: pending seat pill',
  );
  eq(
    seatPillLabel('associate', member({ status: 'pending', userId: null, name: null })),
    'Associate · Invite sent',
  );
  eq(seatPillLabel('associate', null), null, 'empty seat shows NO pill (frame 7)');
  eq(
    seatPillLabel('associate', member({ name: null })),
    null,
    'accepted seat without a resolvable name shows no pill',
  );
}

// ---- participant name map (Checked-off-by resolution) ----
{
  const map = participantNameMap(participants);
  eq(map.get('u-owner'), 'Mariah Petzoldt', 'owner resolves');
  eq(map.get('u-alex'), 'Alex Rivera', 'member resolves');
  eq(map.get('u-dana'), 'Dana Kim');
  const withPending = participantNameMap({
    owner: null,
    members: [member({ userId: null, name: null, status: 'pending' })],
  });
  eq(withPending.size, 0, 'pending invitee (no account) never resolves a step actor');
  const nullOwner = participantNameMap({
    owner: { userId: null, name: null, photoUrl: null },
    members: [],
  });
  eq(nullOwner.size, 0, 'owner row with null id/name resolves nobody (never throws)');
}

// ---- pending invite + strip copy (frames 2/4/6) ----
{
  eq(
    pendingInviteAbilityLine('associate'),
    "You'll be able to edit everything in this escrow.",
  );
  eq(
    pendingInviteAbilityLine('tc'),
    'You can edit the intakes and view everything else.',
  );
  eq(
    memberStripSentence('associate'),
    "You're an Associate here, so you can edit everything in it.",
  );
  eq(
    memberStripSentence('tc'),
    "You're the transaction coordinator here, so you can edit the intakes and view the rest.",
  );
}

// ---- waiting-for name (frame 3) ----
{
  eq(waitingForName(member({ name: 'Dana Kim' })), 'Dana');
  eq(
    waitingForName(member({ name: null, invitedEmail: 'dana@tcservices.com', status: 'pending' })),
    'Dana',
    'email local part capitalizes (frame 3: dana@ -> Dana)',
  );
  eq(
    waitingForName(member({ name: null, invitedEmail: 'dana.kim@tcservices.com', status: 'pending' })),
    'Dana',
  );
  eq(waitingForName(member({ name: null, invitedEmail: '' })), 'them');
}

// ---- legacy TC link (Q1) ----
{
  const base: Invite = {
    id: 'i1',
    code: 'AAAA1111',
    escrowId: 'e1',
    role: 'tc',
    partyName: 'Dana Kim',
    createdAt: '2026-10-01T00:00:00',
    revokedAt: null,
    redeemedAt: '2026-10-02T00:00:00',
  };
  eq(legacyTcInvite([base])?.id, 'i1', 'redeemed + unrevoked TC link found');
  eq(legacyTcInvite([{ ...base, revokedAt: '2026-10-03T00:00:00' }]), null, 'revoked -> gone');
  eq(legacyTcInvite([{ ...base, redeemedAt: null }]), null, 'never redeemed -> not the legacy row');
  eq(legacyTcInvite([{ ...base, role: 'buyer' }]), null, 'buyer link is not the TC row');
  eq(legacyTcInvite([]), null);
}

// ---- activity action text, one pin per kind (frame 5 + brief mapping) ----
{
  eq(
    activityLineText(entry({ detail: { title: 'Appraisal ordered' } })),
    'Alex Rivera checked off “Appraisal ordered”',
  );
  eq(
    activityLineText(entry({ kind: 'step_unchecked', detail: { title: 'Appraisal ordered' } })),
    'Alex Rivera unchecked “Appraisal ordered”',
  );
  eq(
    activityLineText(entry({ kind: 'step_added', detail: { title: 'Order HOA docs' } })),
    'Alex Rivera added a step “Order HOA docs”',
  );
  eq(
    activityLineText(entry({ kind: 'intake_saved', actorName: 'Dana Kim', detail: { intake: 'tc' } })),
    'Dana Kim saved the TC intake',
  );
  eq(
    activityLineText(entry({ kind: 'intake_saved', detail: { intake: 'buyer' } })),
    'Alex Rivera saved the buyer intake',
  );
  eq(
    activityLineText(entry({ kind: 'intake_saved', detail: {} })),
    'Alex Rivera saved the buyer intake',
    'intake defaults to buyer when unspecified',
  );
  eq(
    activityLineText(
      entry({ kind: 'closing_date_changed', detail: { from: '2026-11-10', to: '2026-11-14' } }),
    ),
    'Alex Rivera changed the closing date to Nov 14',
  );
  eq(activityLineText(entry({ kind: 'escrow_closed' })), 'Alex Rivera closed this escrow');
  eq(
    activityLineText(entry({ kind: 'escrow_cancelled' })),
    'Alex Rivera cancelled this escrow',
  );
  eq(
    activityLineText(entry({ kind: 'escrow_opened', actorName: 'Mariah Petzoldt' })),
    'Mariah Petzoldt opened this escrow',
  );
  eq(
    activityLineText(
      entry({
        kind: 'client_joined',
        actorId: null,
        actorName: null,
        actorLabel: 'Priya Nair (buyer)',
      }),
    ),
    'Priya Nair (buyer) joined with an invite code',
  );
  eq(
    activityLineText(
      entry({
        kind: 'team_invited',
        actorName: 'Mariah Petzoldt',
        detail: { invited_email: 'dana@tcservices.com', role: 'tc' },
      }),
    ),
    'Mariah Petzoldt invited dana@tcservices.com as TC',
  );
  eq(
    activityLineText(
      entry({
        kind: 'team_invited',
        actorName: 'Mariah Petzoldt',
        detail: { invited_email: 'alex@example.com', invited_name: 'Alex Rivera', role: 'associate' },
      }),
    ),
    'Mariah Petzoldt invited Alex Rivera as Associate',
    'frame 5: the invitee name renders when the snapshot carries one',
  );
  eq(
    activityLineText(entry({ kind: 'team_accepted' })),
    'Alex Rivera accepted the invitation',
  );
  eq(
    activityLineText(entry({ kind: 'team_declined' })),
    'Alex Rivera declined the invitation',
  );
  eq(
    activityLineText(
      entry({
        kind: 'team_removed',
        actorName: 'Mariah Petzoldt',
        detail: { invited_email: 'alex@example.com' },
      }),
    ),
    'Mariah Petzoldt removed alex@example.com',
  );
  eq(activityLineText(entry({ kind: 'team_left' })), 'Alex Rivera left this escrow');
  eq(
    activityLineText(
      entry({
        kind: 'team_invite_cancelled',
        actorName: 'Mariah Petzoldt',
        detail: { invited_email: 'dana@tcservices.com' },
      }),
    ),
    'Mariah Petzoldt cancelled the invitation to dana@tcservices.com',
  );
  eq(
    activityLineText(entry({ kind: 'something_new' })),
    'Alex Rivera made a change',
    'unknown kinds degrade to a neutral line, never crash',
  );
}

// ---- activity line parts: bold actor; client label split (frame 5) ----
{
  const parts = activityLineParts(entry({ detail: { title: 'Appraisal ordered' } }));
  deepEq(parts, [
    { text: 'Alex Rivera', bold: true },
    { text: ' checked off “Appraisal ordered”' },
  ], 'step line: bold actor name, then the action');
  const clientParts = activityLineParts(
    entry({
      kind: 'client_joined',
      actorId: null,
      actorName: null,
      actorLabel: 'Priya Nair (buyer)',
    }),
  );
  deepEq(clientParts, [
    { text: 'Priya Nair', bold: true },
    { text: ' (buyer) joined with an invite code' },
  ], 'client line: name bold, "(buyer)" suffix plain');
}

// ---- day grouping + frozen timestamps (frame 5) ----
{
  const rows = [
    entry({ id: 't1', createdAt: TODAY_1042 }),
    entry({ id: 't2', createdAt: '2026-10-20T08:15:00' }),
    entry({ id: 'y1', createdAt: YDAY_1626 }),
    entry({ id: 'o1', createdAt: OCT12_0905 }),
  ];
  const groups = groupActivityByDay(rows, NOW);
  deepEq(
    groups.map((g) => g.label),
    ['Today', 'Yesterday', 'Oct 12'],
    'day labels in frame-5 shape',
  );
  deepEq(
    groups.map((g) => g.entries.length),
    [2, 1, 1],
    'same-day rows group together, order preserved',
  );
  eq(activityTimeLabel(TODAY_1042, NOW), '10:42 AM', 'today shows the time alone');
  eq(activityTimeLabel(YDAY_1626, NOW), 'Oct 19 · 4:26 PM', 'older days show date + time');
  eq(activityTimeLabel(OCT12_0905, NOW), 'Oct 12 · 9:05 AM');
  eq(
    activityTimeLabel('2025-12-31T23:59:00', NOW),
    'Dec 31, 2025 · 11:59 PM',
    'cross-year rows carry the year',
  );
  deepEq(groupActivityByDay([], NOW), [], 'no entries -> no groups');
}

// ---- latest-activity summary (frame 6 footer row) ----
{
  eq(
    activitySummaryLine(entry({ detail: { title: 'Appraisal ordered' } }), NOW),
    'Alex checked off Appraisal ordered · 10:42 AM',
    'first name + plain action (no quotes) + time, exactly the frame',
  );
  eq(
    activitySummaryLine(
      entry({ kind: 'intake_saved', actorName: 'Dana Kim', detail: { intake: 'tc' }, createdAt: YDAY_1626 }),
      NOW,
    ),
    'Dana saved the TC intake · Oct 19 · 4:26 PM',
  );
}

// ---- checked-off-by line (frames 6/7) ----
{
  eq(
    checkedOffByLine('Alex Rivera', TODAY_1042, NOW),
    'Checked off by Alex Rivera · Today',
  );
  eq(
    checkedOffByLine('Mariah Petzoldt', YDAY_1626, NOW),
    'Checked off by Mariah Petzoldt · Yesterday',
  );
  eq(
    checkedOffByLine('Alex Rivera', OCT18_0905, NOW),
    'Checked off by Alex Rivera · Oct 18',
  );
}

summary('team_screens');
