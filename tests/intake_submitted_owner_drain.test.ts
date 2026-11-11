// intake_submitted_owner_drain.test.ts — Intake-submit owner
// notification (0051): the drain half of the sibling producer. The
// pure body builder in supabase/functions/send-client-push/push.ts
// renders the owner copy from the outbox fact ({actor_id, intake});
// index.ts routes the kind EXPLICITLY to the escrow owner's realtor
// tokens (getRealtorTokens -> escrows.user_id), never through a
// default-allow fallthrough, and the kind stays an outbox-only event
// (never a valid HTTP trigger payload). Copy follows the realtor
// template family: the actor + the property street; NO intake
// content ever appears. Source pins cover the index.ts routing
// (the orchestrator is Deno-side and not unit-runnable here).
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  buildEventBody,
  buildIntakeSubmittedOwnerBody,
  buildPushBody,
  isBurstCoalescedEvent,
  parseTriggerPayload,
  type IntakeSubmittedOwnerFact,
} from '../supabase/functions/send-client-push/push';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('supabase', 'functions', 'send-client-push', 'index.ts');
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const STREET = '4821 Maple Grove Dr';

async function main(): Promise<void> {
  const buyer: IntakeSubmittedOwnerFact = { actor_id: 'user-9', intake: 'buyer' };
  const seller: IntakeSubmittedOwnerFact = { actor_id: 'user-9', intake: 'seller' };

  // ---- copy: exact, realtor template family (actor + street) ----
  assert(
    buildIntakeSubmittedOwnerBody(buyer, 'Alex Rivera', 'tc', STREET) ===
      'Alex Rivera submitted the buyer intake on 4821 Maple Grove Dr.',
    'buyer intake owner copy is exact (named actor)',
  );
  assert(
    buildIntakeSubmittedOwnerBody(seller, 'Dana Kim', 'tc', STREET) ===
      'Dana Kim submitted the seller intake on 4821 Maple Grove Dr.',
    'seller intake owner copy is exact (tc_intakes is the seller side)',
  );
  assert(
    buildIntakeSubmittedOwnerBody(buyer, 'Alex Rivera', 'associate', STREET) ===
      'Alex Rivera submitted the buyer intake on 4821 Maple Grove Dr.',
    'associate actor copy is exact',
  );

  // ---- actor fallbacks when the profile name is missing ----
  assert(
    buildIntakeSubmittedOwnerBody(buyer, null, 'tc', STREET) ===
      'Your transaction coordinator submitted the buyer intake on 4821 Maple Grove Dr.',
    'nameless TC falls back to the TC role label',
  );
  assert(
    buildIntakeSubmittedOwnerBody(seller, null, 'associate', STREET) ===
      'Your associate submitted the seller intake on 4821 Maple Grove Dr.',
    'nameless associate falls back to the associate role label',
  );
  assert(
    buildIntakeSubmittedOwnerBody(buyer, '  ', null, STREET) ===
      'A team member submitted the buyer intake on 4821 Maple Grove Dr.',
    'no name and no live grant role falls back to a neutral actor',
  );
  assert(
    buildIntakeSubmittedOwnerBody(
      { actor_id: null, intake: 'buyer' },
      null,
      null,
      STREET,
    ) === 'A team member submitted the buyer intake on 4821 Maple Grove Dr.',
    'a fact without an actor still renders honestly (producer never emits one)',
  );

  // ---- drops: no street, unknown intake — never improvise ----
  assert(
    buildIntakeSubmittedOwnerBody(buyer, 'Alex Rivera', 'tc', '') === null,
    'no street drops the push (house rule)',
  );
  assert(
    buildIntakeSubmittedOwnerBody(buyer, 'Alex Rivera', 'tc', '   ') === null,
    'blank street drops the push',
  );
  assert(
    buildIntakeSubmittedOwnerBody(
      { actor_id: 'user-9', intake: 'other' },
      'Alex Rivera',
      'tc',
      STREET,
    ) === null,
    'unknown intake kind drops rather than guess buyer/seller',
  );
  assert(
    buildIntakeSubmittedOwnerBody(
      { actor_id: 'user-9', intake: null },
      'Alex Rivera',
      'tc',
      STREET,
    ) === null,
    'missing intake kind drops',
  );

  // ---- the kind is outbox-only and not burst-collapsed ----
  assert(
    parseTriggerPayload({ event: 'intake_submitted_owner', escrow_id: 'e1' }) === null,
    'intake_submitted_owner is never a valid HTTP trigger payload',
  );
  assert(
    buildPushBody('intake_submitted_owner', 'Maria Lopez', null, null) === null,
    'the HTTP body builder never serves the owner intake kind',
  );
  assert(
    buildEventBody('intake_submitted_owner', {}) === null,
    'the P1 client body builder never serves the owner intake kind',
  );
  assert(
    isBurstCoalescedEvent('intake_submitted_owner') === false,
    'owner intake kind is NOT burst-collapsed (one push per transition, like team_invite_accepted)',
  );
  assert(
    !buildIntakeSubmittedOwnerBody(buyer, 'Alex Rivera', 'tc', STREET)!.includes('\u2014'),
    'owner intake copy has no em dashes',
  );

  // ---- index.ts routing pins (explicit, owner tokens, one handler) ----
  const root = findRepoRoot();
  assert(root !== '', 'could not locate the repo root');
  const indexSrc: string = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'send-client-push', 'index.ts'),
    'utf8',
  );
  assert(
    /row\.event === 'intake_submitted_owner'/.test(indexSrc),
    'the drain dispatches intake_submitted_owner explicitly',
  );
  assert(
    /async function handleIntakeSubmittedOwner\(/.test(indexSrc),
    'a dedicated handler serves the kind',
  );
  const handler =
    /async function handleIntakeSubmittedOwner\([\s\S]*?\n\}/.exec(indexSrc)?.[0] ?? '';
  assert(handler !== '', 'handler body located');
  assert(
    /getRealtorTokens\(supa, escrow\)/.test(handler),
    'the handler resolves the OWNER tokens via getRealtorTokens (escrows.user_id)',
  );
  assert(
    /sendTeamPush\(supa, env, tokens, body, 'intake_submitted_owner', escrow\.id\)/.test(
      handler,
    ),
    'the handler sends through sendTeamPush with the explicit kind (quiet hours inherited)',
  );
  assert(
    /buildIntakeSubmittedOwnerBody\(/.test(handler),
    'the handler builds copy with the pure builder',
  );
  assert(
    !/getLiveTokens/.test(handler),
    'the handler never touches client-link tokens (owner path only)',
  );
  assert(
    /'team_invite_received' \| 'team_invite_accepted' \| 'member_step_activity' \| 'intake_submitted_owner'/.test(
      indexSrc,
    ),
    'sendTeamPush kind union carries the new kind explicitly',
  );

  // ---- migration posture pins (0051) ----
  const mig: string = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '0051_intake_submit_owner_push.sql'),
    'utf8',
  );
  assert(
    /add column if not exists submitted_at timestamptz/.test(mig) &&
      (mig.match(/add column if not exists submitted_at/g) ?? []).length === 2,
    '0051 adds the stored submitted marker to BOTH intake tables',
  );
  assert(
    /'intake_submitted_owner'/.test(mig),
    '0051 widens the outbox kind check with the new kind',
  );
  assert(
    !/create or replace function ctc_push_event_from_intake/.test(mig),
    '0051 does NOT touch the 0040 producer (sibling, not an edit)',
  );
  assert(
    /revoke execute on function ctc_push_intake_submitted_owner\(\) from public, anon, authenticated/.test(
      mig,
    ),
    '0051 revokes EXECUTE on the new producer (trigger-only)',
  );
  assert(
    /auth\.uid\(\)/.test(mig) && !/submitted_by/.test(mig),
    'the actor comes from the trigger auth context; no actor column exists to spoof',
  );

  summary('intake_submitted_owner_drain.test');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
