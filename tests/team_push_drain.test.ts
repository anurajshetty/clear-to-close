// team_push_drain.test.ts — Team Access (0044) drain decisions: the
// pure planners/builders in supabase/functions/send-client-push/push.ts
// that the event drain consults at send time (R4). Covers branch
// exclusivity (account -> push only, no account -> email only), the
// per-owner invite-email cap, validity drops from live grant state,
// member-activity coalescing, and copy exactness against the Q3 copy
// batch (team-access-copy-batch.md).
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

  // ---- invite received: branch exclusivity ----
  const pushPlan = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(pushPlan.action === 'push', 'account invitee takes the push branch');
  assert(
    pushPlan.action === 'push' &&
      pushPlan.body === 'Maria Lopez invited you to join an escrow as an Associate.',
    'invite received push copy (associate) is exact',
  );
  const pushTc = planTeamInviteReceived(grant({ user_id: 'user-9', role: 'tc' }), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(
    pushTc.action === 'push' &&
      pushTc.body ===
        'Maria Lopez invited you to join an escrow as its transaction coordinator.',
    'invite received push copy (tc) is exact',
  );
  // An account invitee NEVER falls through to email, even over the cap
  // and with email fully configured: the push branch wins outright.
  assert(
    planTeamInviteReceived(grant({ user_id: 'user-9' }), {
      ownerName: OWNER,
      inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H + 5,
      emailConfigured: true,
    }).action === 'push',
    'account invitee never gets the email (cap does not reroute)',
  );
  const noName = planTeamInviteReceived(grant({ user_id: 'user-9' }), {
    ownerName: '  ',
    inviteEmailsSentLast24h: 0,
    emailConfigured: true,
  });
  assert(
    noName.action === 'push' &&
      noName.body === 'Your realtor invited you to join an escrow as an Associate.',
    'invite received push falls back to "Your realtor" without a profile name',
  );

  // ---- invite received: email branch + cap (R5) ----
  assert(
    planTeamInviteReceived(grant({}), {
      ownerName: OWNER,
      inviteEmailsSentLast24h: 0,
      emailConfigured: true,
    }).action === 'email',
    'no-account invitee takes the email branch',
  );
  assert(
    planTeamInviteReceived(grant({}), {
      ownerName: OWNER,
      inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H - 1,
      emailConfigured: true,
    }).action === 'email',
    'one below the 24h cap still emails',
  );
  const capped = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H,
    emailConfigured: true,
  });
  assert(
    capped.action === 'skip' && capped.reason === 'cap',
    'at the 24h cap the email is suppressed (row still consumed)',
  );
  assert(
    planTeamInviteReceived(grant({}), {
      ownerName: OWNER,
      inviteEmailsSentLast24h: INVITE_EMAIL_CAP_PER_24H + 3,
      emailConfigured: true,
    }).action === 'skip',
    'over the 24h cap the email is suppressed',
  );
  const unconfigured = planTeamInviteReceived(grant({}), {
    ownerName: OWNER,
    inviteEmailsSentLast24h: 0,
    emailConfigured: false,
  });
  assert(
    unconfigured.action === 'skip' && unconfigured.reason === 'unconfigured',
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

  // ---- invite email: copy batch verbatim, R7 by construction ----
  const email = buildTeamInviteEmail({
    ownerName: OWNER,
    role: 'associate',
    invitedEmail: 'alex@example.com',
    appLink: APP_LINK,
  });
  assert(
    email.subject === 'Maria Lopez invited you to Clear to Close',
    'invite email subject is exact',
  );
  const expectedText = [
    'Hi there,',
    '',
    'Maria Lopez invited you to help with an escrow as an Associate in Clear to Close, the app they use to keep every escrow step in one place.',
    '',
    'To accept, sign up with this email address (alex@example.com) and the invitation will be waiting for you in the app.',
    '',
    'Open Clear to Close:',
    APP_LINK,
    '',
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');
  assert(email.text === expectedText, 'invite email text is exact (associate)');
  const emailTc = buildTeamInviteEmail({
    ownerName: OWNER,
    role: 'tc',
    invitedEmail: 'dana@example.com',
    appLink: APP_LINK,
  });
  assert(
    emailTc.text.includes('as the transaction coordinator in Clear to Close'),
    'invite email uses the TC role phrase',
  );
  assert(
    email.html.includes(`<a href="${APP_LINK}">Open Clear to Close</a>`),
    'invite email HTML carries the labeled app link',
  );
  // R7: the builder takes no address/deal input; the rendered email
  // must not name the property or any party.
  assert(
    !email.text.includes(STREET) && !email.html.includes(STREET),
    'invite email contains no property address (R7)',
  );
  assert(
    !email.text.includes('—') && !email.html.includes('—'),
    'invite email has no em dashes',
  );
  const emailEscaped = buildTeamInviteEmail({
    ownerName: 'Ann <Admin> & Co',
    role: 'associate',
    invitedEmail: 'a@b.c',
    appLink: APP_LINK,
  });
  assert(
    emailEscaped.html.includes('Ann &lt;Admin&gt; &amp; Co'),
    'invite email HTML escapes interpolated values',
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
