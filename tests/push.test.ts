// push.test.ts — client push notifications: edge-function pure logic,
// client-side permission/registration behavior, deep-link routing.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  buildPushBody,
  deadTokensFromReceipts,
  firstNameOf,
  formatPushDate,
  parseTriggerPayload,
  toExpoMessages,
} from '../supabase/functions/send-client-push/push';
import {
  __setPlatformForTests,
  escrowRouteFromResponse,
  getPushPermission,
  hasBeenAskedPush,
  loadNotifications,
  markPushAsked,
  registerPushToken,
  setupPushHandling,
  shouldShowPrePrompt,
  unregisterPushToken,
} from '../src/lib/push';
import { memoryKV } from '../src/lib/kv';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // ---- exact FINAL copy (Anuraj, Sept 26 2026) ----
  assert(
    buildPushBody('step_done', 'Maya Sharma', 'Home inspection', null) ===
      'Maya checked off Home inspection in your escrow.',
    'step_done copy is exact',
  );
  assert(
    buildPushBody('custom_step_added', 'Maya Sharma', 'Anything', null) ===
      'Maya added a new step to your escrow.',
    'custom_step_added copy is exact',
  );
  assert(
    buildPushBody('close_date_changed', 'Maya Sharma', null, '2026-11-24') ===
      'Your closing date is now Nov 24, 2026.',
    'close_date_changed copy is exact',
  );
  assert(
    buildPushBody('key_dates_changed', 'Maya Sharma', null, null) ===
      'Maya updated your key dates.',
    'key_dates_changed copy is exact',
  );
  assert(
    buildPushBody('key_dates_changed', '', null, null) === 'Your realtor updated your key dates.',
    'key_dates_changed falls back to "Your realtor"',
  );

  // ---- first-name extraction ----
  assert(firstNameOf('Maya Sharma') === 'Maya', 'first name extracted');
  assert(firstNameOf('  Maya  ') === 'Maya', 'name trimmed');
  assert(firstNameOf('') === 'Your realtor', 'empty name falls back');
  assert(firstNameOf(null) === 'Your realtor', 'null name falls back');

  // ---- honest-copy guard: never send a wrong push ----
  assert(
    buildPushBody('step_done', 'Maya', '   ', null) === null,
    'step_done with blank title drops',
  );
  assert(
    buildPushBody('close_date_changed', 'Maya', null, '') === null,
    'date change with blank date drops',
  );

  // ---- date format matches the app's long-date copy ----
  assert(formatPushDate('2026-11-24') === 'Nov 24, 2026', 'push date format');
  assert(formatPushDate('2026-01-05') === 'Jan 5, 2026', 'push date format (Jan)');
  assert(formatPushDate('not-a-date') === 'not-a-date', 'bad date passes through');

  // ---- trigger payload validation ----
  const good = parseTriggerPayload({
    event: 'step_done',
    escrow_id: 'esc-1',
    step_title: 'Appraisal',
    new_close_date: null,
  });
  assert(
    good !== null && good.event === 'step_done' && good.step_title === 'Appraisal',
    'valid trigger payload parses',
  );
  assert(parseTriggerPayload({ event: 'step_done' }) === null, 'missing escrow_id rejected');
  assert(
    parseTriggerPayload({ event: 'key_dates_changed', escrow_id: 'esc-1' }) !== null,
    'key_dates_changed payload accepted',
  );
  assert(
    parseTriggerPayload({ event: 'uncheck_happened', escrow_id: 'esc-1' }) === null,
    'unknown event rejected',
  );
  assert(parseTriggerPayload(null) === null, 'null payload rejected');
  assert(parseTriggerPayload('x') === null, 'non-object payload rejected');

  // ---- Expo messages carry routing data ----
  const msgs = toExpoMessages(
    [
      { expo_push_token: 'tok-1', role: 'buyer' },
      { expo_push_token: 'tok-2', role: 'seller' },
    ],
    'Maya checked off Appraisal in your escrow.',
    'esc-1',
  );
  assert(msgs.length === 2, 'one message per token');
  assert(
    msgs[0].to === 'tok-1' &&
      msgs[0].data.escrowId === 'esc-1' &&
      msgs[0].data.role === 'buyer' &&
      msgs[0].title === 'Clear to Close',
    'message carries escrowId + role routing data',
  );

  // ---- dead-token cleanup ----
  const dead = deadTokensFromReceipts(msgs, {
    'tok-1': { status: 'error', details: { error: 'DeviceNotRegistered' } },
    'tok-2': { status: 'ok' },
  });
  assert(dead.length === 1 && dead[0] === 'tok-1', 'DeviceNotRegistered token marked dead');
  const deadOther = deadTokensFromReceipts(msgs, {
    'tok-1': { status: 'error', details: { error: 'MessageTooBig' } },
  });
  assert(deadOther.length === 0, 'other Expo errors do not delete tokens');

  // ---- web is a safe no-op ----
  __setPlatformForTests('web');
  assert(loadNotifications() === null, 'web: loadNotifications is null');
  assert((await getPushPermission()) === 'undetermined', 'web: permission undetermined');
  assert((await registerPushToken()) === false, 'web: registerPushToken no-ops false');
  await unregisterPushToken(); // must not throw
  let tapped = false;
  const cleanup = setupPushHandling(() => {
    tapped = true;
  });
  cleanup();
  assert(tapped === false, 'web: no listeners wired');
  __setPlatformForTests(null);

  // ---- native node (no expo modules installed): graceful ----
  assert(loadNotifications() === null, 'node: loadNotifications null without native module');
  assert((await registerPushToken()) === false, 'node: registerPushToken false without modules');

  // ---- ask-once state ----
  const kv = memoryKV();
  assert((await hasBeenAskedPush(kv)) === false, 'ask-once starts unasked');
  await markPushAsked(kv);
  assert((await hasBeenAskedPush(kv)) === true, 'ask-once persists after mark');

  // ---- pre-prompt eligibility (pure) ----
  assert(
    shouldShowPrePrompt({ role: 'client', hasLink: true, asked: false, permission: 'undetermined' }) ===
      true,
    'pre-prompt shows for undetermined client',
  );
  assert(
    shouldShowPrePrompt({ role: 'client', hasLink: true, asked: true, permission: 'undetermined' }) ===
      false,
    'pre-prompt never re-asks',
  );
  assert(
    shouldShowPrePrompt({ role: 'client', hasLink: true, asked: false, permission: 'denied' }) ===
      false,
    'pre-prompt never nags after denial',
  );
  assert(
    shouldShowPrePrompt({ role: 'client', hasLink: true, asked: false, permission: 'granted' }) ===
      false,
    'pre-prompt not shown when already granted',
  );
  assert(
    shouldShowPrePrompt({ role: 'realtor', hasLink: false, asked: false, permission: 'undetermined' }) ===
      false,
    'pre-prompt never shows for realtor',
  );

  // ---- deep-link routing from a notification response ----
  const r1 = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'seller' } } } },
  });
  assert(
    r1 !== null && r1.escrowId === 'esc-9' && r1.role === 'seller',
    'tap routes to seller escrow home',
  );
  const r2 = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'bogus' } } } },
  });
  assert(r2 !== null && r2.role === 'buyer', 'unknown role defaults to buyer');
  assert(escrowRouteFromResponse({}) === null, 'malformed response routes nowhere');
  assert(escrowRouteFromResponse(null) === null, 'null response routes nowhere');

  summary('push.test.ts');
}

void main();
