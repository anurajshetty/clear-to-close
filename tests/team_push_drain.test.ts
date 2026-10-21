// team_push_drain.test.ts — Team Access (0044) drain decisions: the
// pure planners/builders in supabase/functions/send-client-push/push.ts
// that the event drain consults at send time (R4). Covers the invite
// channels (email on EVERY invite; account invitees also get the
// push — Oct 21, 2026 rule), the per-owner invite-email cap, validity
// drops from live grant state, member-activity coalescing, and copy
// exactness against the Q3 copy batch (team-access-copy-batch.md).
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  buildMemberActivityBody,
  buildPushBody,
  buildTeamInviteEmail,
  groupMemberActivityRows,
  parseTriggerPayload,
  planTeamInviteAccepted,
  planTeamInviteReceived,
  teamQuietQueue,
  INVITE_EMAIL_CAP_PER_24H,
  type MemberActivityFact,
  type TeamGrantSnapshot,
} from '../supabase/functions/send-client-push/push';

declare const process: { exitCode?: number };

const OWNER = 'Maria Lopez';
const STREET = '4821 Maple Grove Dr';
const APP_LINK = 'https://anurajshetty.github.io/clear-to-close/redeem';

function grant(overrides: Partial<TeamGrantSnapshot>): TeamGrantSnapshot {
  return {
    id: 'grant-1',
    escrow_id: 'escrow-1',
    invited_email: 'alex@example.com',
    user_id: null,
    role: 'associate',
    status: 'pending',
    invited_by: 'owner-1',
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---- invite received: validity from live grant state (R4) ----
  assert(
    planTeamInviteReceived(null, {
      ownerName: OWNER,
      inviteEmailsSentLast24h: 0,
      emailConfigured: true,
    }).action === 'drop',
    'invite received: missing grant drops',
  );
  for (const status of ['accepted', 'declined', 'removed', 'left', 'cancelled']) {
    assert(
      planTeamInviteReceived(grant({ status, user_id: 'user-9' }), {
        ownerName: OWNER,
        inviteEmailsSentLast24h: 0,
        emailConfigured: true,
      }).action === 'drop',
      `invite received: grant ${status} at drain drops (no longer pending)`,
    );
  }

  // ---- invite received: channels (Oct 21 rule — email on EVERY
  // invite; account invitees get push + email) ----
  const pushPlan = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(pushPlan.action === 'send' && pushPlan.email === true, 'account invitee gets push + email');
  assert(
    pushPlan.action === 'send' &&
      pushPlan.pushBody === 'Maria Lopez invited you to join an escrow as an Associate.',
    'invite received push copy (associate) is exact',
  );
  const pushTc = planTeamInviteReceived(grant({ user_id: 'user-9', role: 'tc' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(
    pushTc.action === 'send' &&
      pushTc.pushBody ===
        'Maria Lopez invited you to join an escrow as its transaction coordinator.',
    'invite received push copy (tc) is exact',
  );
  // The cap suppresses ONLY the email half: an account invitee over
  // the cap still gets the push.
  const accountCapped = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H + 5,
    emailConfigured: true,
  });
  assert(
    accountCapped.action === 'send' &&
      accountCapped.pushBody !== null &&
      accountCapped.email === false &&
      accountCapped.emailSkip === 'cap',
    'account invitee over the cap: push sends, email suppressed',
  );
  const accountUnconfigured = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: false,
  });
  assert(
    accountUnconfigured.action === 'send' &&
      accountUnconfigured.pushBody !== null &&
      accountUnconfigured.email === false &&
      accountUnconfigured.emailSkip === 'unconfigured',
    'account invitee unconfigured: push sends, email skipped',
  );
  const noName = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: '  ',
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(
    noName.action === 'send' &&
      noName.pushBody === 'Your realtor invited you to join an escrow as an Associate.',
    'invite received push falls back to "Your realtor" without a profile name',
  );

  // ---- invite received: no-account invitee + cap (R5) ----
  const emailPlan = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(
    emailPlan.action === 'send' && emailPlan.pushBody === null && emailPlan.email === true,
    'no-account invitee gets the email only',
  );
  const belowCap = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H - 1,
    emailConfigured: true,
  });
  assert(
    belowCap.action === 'send' && belowCap.email === true,
    'one below the 24h cap still emails',
  );
  const capped = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H,
    emailConfigured: true,
  });
  assert(
    capped.action === 'send' && capped.pushBody === null && capped.email === false &&
      capped.emailSkip === 'cap',
    'at the 24h cap the email is suppressed (row still consumed)',
  );
  const overCap = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H + 3,
    emailConfigured: true,
  });
  assert(
    overCap.action === 'send' && overCap.email === false && overCap.emailSkip === 'cap',
    'over the 24h cap the email is suppressed',
  );
  const unconfigured = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: false,
  });
  assert(
    unconfigured.action === 'send' && unconfigured.email === false &&
      unconfigured.emailSkip === 'unconfigured',
    'missing Resend key/From skips the email silently',
  );
  assert(INVITE_EMAIL_CAP_PER_24H === 20, 'invite email cap is 20 per owner per 24h');

  // ---- invite accepted: live-state validity + copy ----
  assert(
    planTeamInviteAccepted(null, { memberName: 'Alex Rivera', street: STREET }).action ===
      'drop',
    'invite accepted: missing grant drops',
  );
  assert(
    planTeamInviteAccepted(grant({ status: 'pending' }), {
      memberName: 'Alex Rivera',
      street: STREET,
    }).action === 'drop',
    'invite accepted: not-yet-accepted grant drops',
  );
  assert(
    planTeamInviteAccepted(grant({ status: 'removed' }), {
      memberName: 'Alex Rivera',
      street: STREET,
    }).action === 'drop',
    'invite accepted: grant removed before drain drops',
  );
  const accepted = planTeamInviteAccepted(grant({ status: 'accepted', user_id: 'user-9' }), {
    memberName: 'Alex Rivera',
    street: STREET,
  });
  assert(
    accepted.action === 'push' &&
      accepted.body === 'Alex Rivera accepted your invitation to join 4821 Maple Grove Dr.',
    'invite accepted copy is exact',
  );
  const acceptedNoName = planTeamInviteAccepted(grant({ status: 'accepted' }), {
    memberName: null,
    street: STREET,
  });
  assert(
    acceptedNoName.action === 'push' &&
      acceptedNoName.body === 'Someone accepted your invitation to join 4821 Maple Grove Dr.',
    'invite accepted falls back to "Someone" without a profile name',
  );
  assert(
    planTeamInviteAccepted(grant({ status: 'accepted' }), {
      memberName: 'Alex Rivera',
      street: ' ',
    }).action === 'drop',
    'invite accepted without a street drops rather than improvise copy',
  );

  // ---- member step activity: coalescing + copy ----
  const one: MemberActivityFact[] = [
    { actor_id: 'user-9', action: 'checked', title: 'Appraisal ordered' },
  ];
  assert(
    buildMemberActivityBody(one, 'Alex Rivera', STREET) ===
      'Alex Rivera checked off “Appraisal ordered” on 4821 Maple Grove Dr.',
    'single check-off copy is exact (curly quotes)',
  );
  assert(
    buildMemberActivityBody(
      [{ actor_id: 'user-9', action: 'unchecked', title: 'Appraisal ordered' }],
      'Alex Rivera',
      STREET,
    ) === 'Alex Rivera unchecked “Appraisal ordered” on 4821 Maple Grove Dr.',
    'single uncheck copy is exact',
  );
  assert(
    buildMemberActivityBody(
      [{ actor_id: 'user-9', action: 'added', title: 'Order survey' }],
      'Alex Rivera',
      STREET,
    ) === 'Alex Rivera added a step on 4821 Maple Grove Dr.',
    'single step-add copy is exact (no title in copy)',
  );
  const three: MemberActivityFact[] = [
    { actor_id: 'user-9', action: 'checked', title: 'Appraisal ordered' },
    { actor_id: 'user-9', action: 'checked', title: 'Inspection scheduled' },
    { actor_id: 'user-9', action: 'unchecked', title: 'Appraisal ordered' },
  ];
  assert(
    buildMemberActivityBody(three, 'Alex Rivera', STREET) ===
      'Alex Rivera made 3 checklist updates on 4821 Maple Grove Dr.',
    'several actions collapse to one count summary',
  );
  assert(
    buildMemberActivityBody(
      [{ actor_id: 'user-9', action: 'checked', title: '' }],
      'Alex Rivera',
      STREET,
    ) === 'Alex Rivera made 1 checklist update on 4821 Maple Grove Dr.',
    'single fact without an honest title falls back to the count form (singular)',
  );
  assert(
    buildMemberActivityBody(one, null, STREET) ===
      'Your associate checked off “Appraisal ordered” on 4821 Maple Grove Dr.',
    'member activity falls back to "Your associate" without a profile name',
  );
  assert(
    buildMemberActivityBody([], 'Alex Rivera', STREET) === null,
    'no facts, no body',
  );
  assert(
    buildMemberActivityBody(one, 'Alex Rivera', '') === null,
    'member activity without a street drops',
  );

  // ---- grouping: one push per escrow per drain pass ----
  const rows = [
    { id: 'r1', escrow_id: 'e1', event: 'member_step_activity' as const },
    { id: 'r2', escrow_id: 'e2', event: 'member_step_activity' as const },
    { id: 'r3', escrow_id: 'e1', event: 'member_step_activity' as const },
    { id: 'r4', escrow_id: 'e1', event: 'member_step_activity' as const },
  ];
  const groups = groupMemberActivityRows(rows);
  assert(groups.size === 2, 'activity rows group by escrow');
  assert(
    (groups.get('e1') ?? []).map((r) => r.id).join(',') === 'r1,r3,r4',
    'group preserves fetch order and consumes every row',
  );
  assert((groups.get('e2') ?? []).length === 1, 'single-row escrow forms its own group');

  // ---- invite email: amended template verbatim (Oct 21, 2026) ----
  const email = buildTeamInviteEmail({
    ownerName: OWNER,
    role: 'associate',
    address: STREET,
    appLink: APP_LINK,
  });
  assert(
    email.subject === 'Maria Lopez invited you to an escrow on Clear to Close',
    'invite email subject is exact',
  );
  const expectedText = [
    'Maria Lopez has invited you to join the escrow for 4821 Maple Grove Dr on Clear to Close as an Associate.',
    '',
    'Open the app to see the escrow and accept your invitation:',
    APP_LINK,
    '',
    'New to Clear to Close? The link will get you set up. Sign up with this email address so the invitation is waiting for you when you arrive.',
    '',
    "You can ignore this email if you weren't expecting an invitation.",
  ].join('\n');
  assert(email.text === expectedText, 'invite email text is exact (associate, with address)');
  const emailTc = buildTeamInviteEmail({
    ownerName: OWNER,
    role: 'tc',
    address: STREET,
    appLink: APP_LINK,
  });
  assert(
    emailTc.text.includes(
      'has invited you to join the escrow for 4821 Maple Grove Dr on Clear to Close as its transaction coordinator.',
    ),
    'invite email uses the TC role phrase with the address',
  );
  assert(
    email.html.includes(`<a href="${APP_LINK}">${APP_LINK}</a>`),
    'invite email HTML carries the app link',
  );
  // Amended R7 (Oct 21 override): the address is IN; party names,
  // dates, and amounts stay OUT.
  assert(
    email.text.includes(STREET) && email.html.includes(STREET),
    'invite email names the property address (Oct 21 override)',
  );
  assert(
    !email.text.includes('\u2014') && !email.html.includes('\u2014'),
    'invite email has no em dashes',
  );
  const emailEscaped = buildTeamInviteEmail({
    ownerName: 'Ann <Admin> & Co',
    role: 'associate',
    address: '1 <Main> St & 2nd',
    appLink: APP_LINK,
  });
  assert(
    emailEscaped.html.includes('Ann &lt;Admin&gt; &amp; Co') &&
      emailEscaped.html.includes('1 &lt;Main&gt; St &amp; 2nd'),
    'invite email HTML escapes interpolated values (owner + address)',
  );
  assert(
    emailEscaped.text.includes('1 <Main> St & 2nd'),
    'invite email text keeps the address verbatim',
  );

  // ---- team kinds are outbox-only ----
  assert(
    parseTriggerPayload({ event: 'team_invite_received', escrow_id: 'e1' }) === null &&
      parseTriggerPayload({ event: 'team_invite_accepted', escrow_id: 'e1' }) === null &&
      parseTriggerPayload({ event: 'member_step_activity', escrow_id: 'e1' }) === null,
    'team kinds are never valid HTTP trigger payloads',
  );
  assert(
    buildPushBody('team_invite_received', OWNER, null, null) === null &&
      buildPushBody('team_invite_accepted', OWNER, null, null) === null &&
      buildPushBody('member_step_activity', OWNER, null, null) === null,
    'the HTTP body builder never serves team kinds',
  );

  // Quiet hours (merge addition): team pushes queue per token during
  // quiet hours for 08:00 recipient-local, like every other push here.
  {
    // 23:30 in Los Angeles (quiet) vs 12:00 (not quiet).
    const night = new Date('2026-10-21T06:30:00.000Z'); // 23:30 PDT previous day
    const q = teamQuietQueue(night, 'America/Los_Angeles');
    assert(q.queued === true && q.sendAfter !== null, 'team push queues during quiet hours');
    assert(
      q.sendAfter === '2026-10-21T15:00:00.000Z',
      'quiet team push is held for 08:00 recipient-local',
    );
    const noon = new Date('2026-10-21T19:00:00.000Z'); // 12:00 PDT
    const d = teamQuietQueue(noon, 'America/Los_Angeles');
    assert(d.queued === false && d.sendAfter === null, 'team push sends immediately outside quiet hours');
  }

  summary('team_push_drain.test');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
