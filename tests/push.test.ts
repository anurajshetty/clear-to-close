// push.test.ts — client push notifications: edge-function pure logic,
// client-side permission/registration behavior, deep-link routing.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  buildEventBody,
  buildPushBody,
  buildReminderBody,
  collapseBurstEvents,
  deadTokensFromReceipts,
  firstNameOf,
  formatPushDate,
  parseTriggerPayload,
  rolesForPushEvent,
  splitStepPushesByAudience,
  toExpoMessages,
  type PushEvent,
} from '../supabase/functions/send-client-push/push';
import {
  __setPlatformForTests,
  clientHomeRoute,
  escrowRouteFromResponse,
  contextualAskEligible,
  defaultPushAskState,
  getPushPermission,
  getRealtorUnregisterPending,
  isClientHomePath,
  isFinalAsk,
  loadNotifications,
  markDontAskAgain,
  PUSH_ASK_CAP,
  PUSH_ASK_COOLDOWN_MS,
  pushTapRoute,
  readPushAskState,
  recordContextualAskShown,
  recordSignupAskShown,
  recordTimedAskShown,
  registerPushToken,
  resolveRealtorPendingStore,
  setRealtorUnregisterPending,
  setupPushHandling,
  signupAskEligible,
  timedAskEligible,
  unregisterPushToken,
  type PushAskState,
} from '../src/lib/push';
import { memoryKV } from '../src/lib/kv';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // ---- approved single check-off copy (Anuraj, Sept 28 2026) ----
  assert(
    buildPushBody('step_done', 'Maya Sharma', 'Home inspection', null) ===
      'Your realtor just completed Home inspection.',
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

  // ---- specific single-date copy (Anuraj Sept 28, 2026 rule) ----
  // One date changed -> specific "Your {label} is now {date}."
  assert(
    buildPushBody('inspection_deadline_changed', 'Maya Sharma', null, null, '2026-10-15') ===
      'Your inspection contingency deadline is now Oct 15, 2026.',
    'inspection_deadline_changed copy is exact',
  );
  assert(
    buildPushBody('appraisal_deadline_changed', 'Maya Sharma', null, null, '2026-10-20') ===
      'Your appraisal deadline is now Oct 20, 2026.',
    'appraisal_deadline_changed copy is exact',
  );
  assert(
    buildPushBody('loan_approval_date_changed', 'Maya Sharma', null, null, '2026-10-25') ===
      'Your loan approval date is now Oct 25, 2026.',
    'loan_approval_date_changed copy is exact',
  );
  // close_date_changed accepts the date via new_date (0021+) or the legacy
  // new_close_date field.
  assert(
    buildPushBody('close_date_changed', 'Maya Sharma', null, null, '2026-11-24') ===
      'Your closing date is now Nov 24, 2026.',
    'close_date_changed via new_date',
  );
  // A cleared date is a change too (0021 counts it via IS DISTINCT FROM):
  // null/blank new_date -> the honest "removed" copy, never silence.
  assert(
    buildPushBody('inspection_deadline_changed', 'Maya', null, null, '') ===
      'Your inspection contingency deadline was removed.',
    'cleared inspection deadline says removed',
  );
  assert(
    buildPushBody('inspection_deadline_changed', 'Maya', null, null, null) ===
      'Your inspection contingency deadline was removed.',
    'cleared inspection deadline (null) says removed',
  );
  assert(
    buildPushBody('appraisal_deadline_changed', 'Maya', null, null, null) ===
      'Your appraisal deadline was removed.',
    'cleared appraisal deadline says removed',
  );
  assert(
    buildPushBody('loan_approval_date_changed', 'Maya', null, null, null) ===
      'Your loan approval date was removed.',
    'cleared loan approval date says removed',
  );
  // A cleared closing date gets the "removed" copy like the other
  // three dates (Anuraj, Oct 15 2026) — inert today (close_date is
  // NOT NULL and required in the form) but pinned so it's defined.
  assert(
    buildPushBody('close_date_changed', 'Maya', null, null, null) ===
      'Your closing date was removed.',
    'close_date_changed with null date says removed (wired, inert)',
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
    buildPushBody('close_date_changed', 'Maya', null, '') ===
      'Your closing date was removed.',
    'close date change with blank date says removed (wired, inert)',
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
    parseTriggerPayload({ event: 'inspection_deadline_changed', escrow_id: 'esc-1', new_date: '2026-10-15' }) !== null,
    'inspection_deadline_changed payload accepted',
  );
  assert(
    parseTriggerPayload({ event: 'appraisal_deadline_changed', escrow_id: 'esc-1', new_date: '2026-10-20' }) !== null,
    'appraisal_deadline_changed payload accepted',
  );
  assert(
    parseTriggerPayload({ event: 'loan_approval_date_changed', escrow_id: 'esc-1', new_date: '2026-10-25' }) !== null,
    'loan_approval_date_changed payload accepted',
  );
  assert(
    parseTriggerPayload({ event: 'uncheck_happened', escrow_id: 'esc-1' }) === null,
    'unknown event rejected',
  );
  assert(parseTriggerPayload(null) === null, 'null payload rejected');
  assert(parseTriggerPayload('x') === null, 'non-object payload rejected');
  assert(
    parseTriggerPayload({ event: 'date_reminder_sweep' }) !== null,
    'P2: the date-reminder sweep ping is accepted bare (internal event)',
  );

  // ---- Expo messages carry routing data ----
  const msgs = toExpoMessages(
    [
      { expo_push_token: 'tok-1', role: 'buyer' },
      { expo_push_token: 'tok-2', role: 'seller' },
    ],
    'Your realtor just completed Appraisal.',
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

  // ---- re-ask state (Notification Re-Ask, Nov 14, 2026) ----
  {
    const kv = memoryKV();
    const fresh = await readPushAskState('client', kv);
    assert(
      fresh.count === 0 && fresh.lastAskedAt === null && !fresh.dontAskAgain &&
        !fresh.ctx['client-code-join'] && !fresh.ctx['realtor-invite'],
      're-ask: fresh device starts at count 0 with no flags',
    );
    // Legacy migration: the ask-once client flag seeds count=1 with an
    // epoch last-asked (immediately eligible for one fresh ask).
    await kv.setItem('ctc:pushasked', '1');
    const legacy = await readPushAskState('client', kv);
    assert(legacy.count === 1 && legacy.lastAskedAt === 0 && !legacy.dontAskAgain,
      're-ask: legacy client flag seeds count=1, last=epoch, no stop');
    assert(
      timedAskEligible(legacy, 'undetermined', Date.now()),
      're-ask: legacy-seeded state is immediately eligible once',
    );
    // The realtor side is untouched by the client legacy flag.
    const realtorFresh = await readPushAskState('realtor', kv);
    assert(realtorFresh.count === 0, 're-ask: client legacy flag does not seed the realtor state');
    // Recording a timed ask on the legacy-seeded state persists the new
    // shape (count 2, last=now) and starts the cooldown.
    const t0 = 1_800_000_000_000;
    const after = await recordTimedAskShown('client', t0, kv);
    assert(after.count === 2 && after.lastAskedAt === t0, 're-ask: timed show records count+last');
    const reread = await readPushAskState('client', kv);
    assert(reread.count === 2 && reread.lastAskedAt === t0, 're-ask: recorded state persists');
    assert(!timedAskEligible(reread, 'undetermined', t0 + 1000), 're-ask: cooldown blocks an immediate re-ask');
    // Realtor legacy flag mirrors on its own key.
    const kv2 = memoryKV();
    await kv2.setItem('ctc:pushasked:realtor', '1');
    const rLegacy = await readPushAskState('realtor', kv2);
    assert(rLegacy.count === 1 && rLegacy.lastAskedAt === 0, 're-ask: legacy realtor flag seeds the realtor state');
    assert((await readPushAskState('client', kv2)).count === 0, 're-ask: realtor legacy flag does not seed the client state');
  }

  // ---- realtor sign-out unregister queue (P0, Oct 2026) ----
  // A failed authenticated unregister at logout queues the (deviceId,
  // token) pair so the next boot can retry by possession; the queue is
  // device-scoped state and must round-trip exactly.
  const kv = memoryKV();
  assert((await getRealtorUnregisterPending(kv)) === null, 'realtor unreg queue starts empty');
  await setRealtorUnregisterPending({ deviceId: 'dev-1', token: 'ExponentPushToken[x]' }, kv);
  const pending = await getRealtorUnregisterPending(kv);
  assert(
    pending !== null && pending.deviceId === 'dev-1' && pending.token === 'ExponentPushToken[x]',
    'realtor unreg queue round-trips the device+token pair',
  );
  await setRealtorUnregisterPending(null, kv);
  assert((await getRealtorUnregisterPending(kv)) === null, 'realtor unreg queue clears on success');
  await kv.setItem('ctc:push:realtor-unreg-pending', '{not json');
  assert((await getRealtorUnregisterPending(kv)) === null, 'corrupt queue entry reads as empty');
  {
    // v2 (auditor): the pending pair defaults to SecureStore, not plain
    // KV — it is a live push credential. An explicit KV still wins
    // (test injection), and the adapter maps the async SecureStore API.
    const secureWrites: Array<[string, string]> = [];
    const secureStore = {
      getItemAsync: async (k: string) => {
        const hit = secureWrites.find(([key]) => key === k);
        return hit ? hit[1] : null;
      },
      setItemAsync: async (k: string, v: string) => {
        secureWrites.push([k, v]);
      },
      deleteItemAsync: async (k: string) => {
        const i = secureWrites.findIndex(([key]) => key === k);
        if (i >= 0) secureWrites.splice(i, 1);
      },
    };
    const resolved = resolveRealtorPendingStore(undefined, secureStore);
    await resolved.setItem('ctc:push:realtor-unreg-pending', '{"deviceId":"d","token":"t"}');
    assert(
      secureWrites.length === 1 && secureWrites[0][1].includes('"token":"t"'),
      'v2 pending store: SecureStore is the default when available',
    );
    assert(
      (await resolved.getItem('ctc:push:realtor-unreg-pending')) !== null,
      'v2 pending store: reads route through SecureStore too',
    );
    const explicit = resolveRealtorPendingStore(kv, secureStore);
    await explicit.setItem('probe', '1');
    assert(
      (await kv.getItem('probe')) === '1' && secureWrites.length === 1,
      'v2 pending store: an explicit KV wins over SecureStore',
    );
  }

  // ---- timed re-ask eligibility (pure) ----
  {
    const NOW = 1_800_000_000_000;
    const st = (over: Partial<PushAskState>): PushAskState => ({ ...defaultPushAskState(), ...over });
    assert(timedAskEligible(st({}), 'undetermined', NOW), 'timed: fresh + undetermined shows');
    assert(timedAskEligible(st({}), 'denied', NOW), 'timed: fresh + denied shows (Settings path)');
    assert(!timedAskEligible(st({}), 'granted', NOW), 'timed: granted never shows');
    assert(
      !timedAskEligible(st({ count: 1, lastAskedAt: NOW - PUSH_ASK_COOLDOWN_MS + 1 }), 'undetermined', NOW),
      'timed: cooldown not elapsed -> no show',
    );
    assert(
      timedAskEligible(st({ count: 1, lastAskedAt: NOW - PUSH_ASK_COOLDOWN_MS }), 'undetermined', NOW),
      'timed: cooldown elapsed -> shows',
    );
    assert(
      !timedAskEligible(st({ count: PUSH_ASK_CAP, lastAskedAt: 0 }), 'undetermined', NOW),
      'timed: cap reached -> no show',
    );
    assert(
      timedAskEligible(st({ count: PUSH_ASK_CAP - 1, lastAskedAt: 0 }), 'denied', NOW),
      'timed: the final (4th) ask is allowed',
    );
    assert(
      !timedAskEligible(st({ count: 0, dontAskAgain: true }), 'undetermined', NOW),
      "timed: don't-ask-again -> no show",
    );
    assert(isFinalAsk(st({ count: PUSH_ASK_CAP - 1 })), 'final-ask: count 3 means the next show is the 4th');
    assert(!isFinalAsk(st({ count: PUSH_ASK_CAP - 2 })), 'final-ask: count 2 is not final');
    assert(!isFinalAsk(st({ count: PUSH_ASK_CAP })), 'final-ask: count 4 is past final');
  }

  // ---- contextual ask eligibility + recording (pure + KV) ----
  {
    const NOW = 1_800_000_000_000;
    const st = (over: Partial<PushAskState>): PushAskState => ({ ...defaultPushAskState(), ...over });
    assert(
      contextualAskEligible(st({ count: 1, lastAskedAt: NOW }), 'undetermined', 'realtor-invite'),
      'contextual: fires inside the cooldown (independent of it)',
    );
    assert(
      contextualAskEligible(st({}), 'denied', 'client-code-join'),
      'contextual: denied still fires (auditor condition 2: the sheet renders its Open Settings state)',
    );
    assert(
      !contextualAskEligible(st({ dontAskAgain: true }), 'undetermined', 'realtor-invite'),
      'contextual: stop flag set -> the first team invite completes with NO sheet (auditor condition 1)',
    );
    assert(
      !contextualAskEligible(st({ ctx: { 'realtor-invite': true, 'client-code-join': false, 'realtor-signup': false } }), 'undetermined', 'realtor-invite'),
      'contextual: a fired trigger never fires again',
    );
    assert(
      contextualAskEligible(st({ ctx: { 'realtor-invite': true, 'client-code-join': false, 'realtor-signup': false } }), 'undetermined', 'client-code-join'),
      'contextual: the other trigger is independent',
    );
    assert(!contextualAskEligible(st({ count: PUSH_ASK_CAP }), 'undetermined', 'realtor-invite'),
      'contextual: cap reached -> no show');
    assert(!contextualAskEligible(st({ dontAskAgain: true }), 'undetermined', 'realtor-invite'),
      "contextual: don't-ask-again -> no show");
    assert(!contextualAskEligible(st({}), 'granted', 'realtor-invite'),
      'contextual: granted -> no show');

    const kv = memoryKV();
    const t0 = 1_800_000_000_000;
    await recordTimedAskShown('realtor', t0, kv);
    const afterCtx = await recordContextualAskShown('realtor', 'realtor-invite', kv);
    assert(afterCtx.count === 2 && afterCtx.ctx['realtor-invite'] === true,
      'contextual record: count+1 and the trigger flag set');
    assert(afterCtx.lastAskedAt === t0,
      'contextual record: last-asked is NOT moved (cooldown stays anchored to timed asks)');
    await markDontAskAgain('realtor', kv);
    const stopped = await readPushAskState('realtor', kv);
    assert(stopped.dontAskAgain === true, "don't-ask-again persists");
    assert(!timedAskEligible(stopped, 'undetermined', t0 + PUSH_ASK_COOLDOWN_MS * 10),
      "don't-ask-again: timed never shows again");
    assert(!contextualAskEligible(stopped, 'undetermined', 'client-code-join'),
      "don't-ask-again: contextual never shows again");
    assert((await readPushAskState('client', kv)).count === 0,
      're-ask state is per-role: realtor activity never touches the client state');
  }

  // ---- sign-up / first-login trigger (amendment, Nov 14, 2026) ----
  {
    const NOW = 1_800_000_000_000;
    const st = (over: Partial<PushAskState>): PushAskState => ({ ...defaultPushAskState(), ...over });
    assert(signupAskEligible(st({}), 'undetermined'), 'signup: fresh + undetermined fires');
    assert(!signupAskEligible(st({}), 'denied'), 'signup: denied never fires (timed cadence owns it)');
    assert(!signupAskEligible(st({}), 'granted'), 'signup: granted never fires');
    assert(
      !signupAskEligible(st({ ctx: { 'realtor-invite': false, 'client-code-join': false, 'realtor-signup': true } }), 'undetermined'),
      'signup: once per device, ever',
    );
    assert(!signupAskEligible(st({ count: PUSH_ASK_CAP }), 'undetermined'), 'signup: cap reached -> no fire');
    assert(!signupAskEligible(st({ dontAskAgain: true }), 'undetermined'), "signup: don't-ask-again -> no fire");

    const kv = memoryKV();
    const after = await recordSignupAskShown(NOW, kv);
    assert(after.count === 1 && after.ctx['realtor-signup'] === true,
      'signup record: count+1 and the trigger is spent');
    assert(after.lastAskedAt === NOW,
      'signup record: the cooldown STARTS (it replaces the first timed ask)');
    assert(!timedAskEligible(after, 'undetermined', NOW + 1000),
      'signup record: the timed ask is snoozed by the cooldown it started');
    assert(
      timedAskEligible(after, 'undetermined', NOW + PUSH_ASK_COOLDOWN_MS),
      'signup record: the timed cadence resumes after the cooldown',
    );
  }

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
  // P1: a realtor push tap must survive extraction as 'realtor' —
  // collapsing it to buyer would land the realtor on a client home.
  const r3 = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'realtor' } } } },
  });
  assert(
    r3 !== null && r3.escrowId === 'esc-9' && r3.role === 'realtor',
    'P1 tap: realtor role preserved through extraction',
  );
  assert(
    r3 !== null && pushTapRoute(r3.escrowId, r3.role) === '/escrow/esc-9',
    'P1 tap: extracted realtor target routes to the realtor escrow screen',
  );

  // ---- tap routing per client role (P0 regression, Oct 15 2026) ----
  assert(
    clientHomeRoute('esc-9', 'buyer') === '/client/buyer/esc-9',
    'buyer tap routes to the buyer home',
  );
  assert(
    clientHomeRoute('esc-9', 'seller') === '/client/seller/esc-9',
    'seller tap routes to the seller home',
  );
  assert(
    clientHomeRoute('esc-9', 'tc') === '/client/tc/esc-9',
    'TC tap routes to the TC home (was misrouted to buyer)',
  );
  assert(
    clientHomeRoute('esc-9', 'bogus') === '/client/buyer/esc-9',
    'unknown role keeps the buyer default',
  );

  // ---- P0.3 targeting matrix: event x role -> exact device set ----
  // One device per role on the escrow; a role receives the event iff it
  // appears in the roles list. This is the brief's matrix, pinned.
  const ALL_ROLES = ['buyer', 'seller', 'tc'] as const;
  const receives = (event: PushEvent, stepRole: string | null, role: string): boolean =>
    (rolesForPushEvent(event, stepRole) as string[]).includes(role);
  const matrix: Array<[PushEvent, string | null, string[]]> = [
    // event, step side, roles that must receive
    ['step_done', 'buyer', ['buyer', 'tc']],
    ['step_done', 'seller', ['seller', 'tc']],
    ['step_done', null, ['buyer', 'tc']], // unknown side -> buyer fallback
    ['close_date_changed', null, ['buyer', 'seller', 'tc']],
    ['key_dates_changed', null, ['buyer', 'seller', 'tc']],
    ['inspection_deadline_changed', null, ['buyer', 'tc']],
    ['appraisal_deadline_changed', null, ['buyer', 'tc']],
    ['loan_approval_date_changed', null, ['buyer', 'tc']],
    // P1 Option A: intake saves notify only the TC.
    ['buyer_intake_submitted', null, ['tc']],
    ['seller_intake_submitted', null, ['tc']],
    // P3: the halfway milestone reaches every client device.
    ['halfway_milestone', null, ['buyer', 'seller', 'tc']],
  ];
  for (const [event, side, want] of matrix) {
    for (const role of ALL_ROLES) {
      assert(
        receives(event, side, role) === want.includes(role),
        `targeting: ${event} (side=${side ?? '-'}) ${want.includes(role) ? 'reaches' : 'skips'} ${role}`,
      );
    }
  }

  // ---- P0.3 flush audiences: buffered rows split by side ----
  const buf = (step_role: string | null, step_title = 'Step') => ({
    event: 'step_done' as PushEvent,
    step_title,
    step_role,
  });
  {
    const a = splitStepPushesByAudience([buf('buyer'), buf('buyer'), buf('seller')]);
    assert(a.length === 2, 'audiences: mixed buffer splits into two');
    assert(
      a[0].roles.join() === 'buyer,tc' && a[0].rows.length === 2,
      'audiences: buyer audience holds the 2 buyer rows',
    );
    assert(
      a[1].roles.join() === 'seller,tc' && a[1].rows.length === 1,
      'audiences: seller audience holds the 1 seller row',
    );
  }
  {
    const a = splitStepPushesByAudience([buf('seller')]);
    assert(a.length === 1 && a[0].roles.join() === 'seller,tc', 'audiences: seller-only buffer');
  }
  {
    // Pre-0039 rows carry no side: they join BOTH audiences so a deploy
    // never drops or mistargets an in-flight check-off.
    const a = splitStepPushesByAudience([buf(null)]);
    assert(
      a.length === 2 && a.every((g) => g.rows.length === 1),
      'audiences: legacy null-side row joins both audiences',
    );
  }
  assert(splitStepPushesByAudience([]).length === 0, 'audiences: empty buffer -> no audiences');

  // ---- pre-prompt home eligibility (P0.4, Oct 15 2026) ----
  // The pre-prompt may appear over any client escrow home — buyer,
  // seller, and (new in P0.4) TC — and nowhere else.
  assert(isClientHomePath('/client/buyer/esc-9'), 'pre-prompt home: buyer home eligible');
  assert(isClientHomePath('/client/seller/esc-9'), 'pre-prompt home: seller home eligible');
  assert(isClientHomePath('/client/tc/esc-9'), 'pre-prompt home: TC home eligible (P0.4)');
  assert(!isClientHomePath('/client/tc'), 'pre-prompt home: role root without escrow is not a home');
  assert(!isClientHomePath('/client/buyer'), 'pre-prompt home: buyer root without escrow is not a home');
  assert(!isClientHomePath('/deals'), 'pre-prompt home: realtor deals list not eligible');
  assert(!isClientHomePath('/realtor/abc'), 'pre-prompt home: public profile not eligible');
  assert(!isClientHomePath('/role'), 'pre-prompt home: role picker not eligible');
  assert(!isClientHomePath(''), 'pre-prompt home: empty path not eligible');

  // ---- P1 event bodies (approved copy batch, Oct 15 2026) ----
  assert(
    buildEventBody('client_joined', { clientName: 'Maya Sharma', clientRole: 'buyer' }) ===
      'Maya just joined their escrow.',
    'P1 join: buyer renders first name + approved copy',
  );
  assert(
    buildEventBody('client_joined', { clientName: 'Tom Reed', clientRole: 'seller' }) ===
      'Tom just joined their escrow.',
    'P1 join: seller renders first name + approved copy',
  );
  assert(
    buildEventBody('client_joined', { clientName: 'Pat Lee', clientRole: 'tc' }) ===
      'Your TC just joined the escrow.',
    'P1 join: TC uses the TC copy regardless of name',
  );
  assert(
    buildEventBody('client_joined', { clientName: '  ', clientRole: 'buyer' }) ===
      'Your client just joined their escrow.',
    'P1 join: blank name falls back honestly',
  );
  assert(
    buildEventBody('review_submitted', { clientName: 'Maya Sharma', stars: 5 }) ===
      'Maya left you a 5-star review.',
    'P1 review: rating renders in copy',
  );
  assert(
    buildEventBody('review_submitted', { clientName: 'Maya Sharma', stars: 1 }) ===
      'Maya left you a 1-star review.',
    'P1 review: 1-star grammar holds',
  );
  assert(
    buildEventBody('review_submitted', { clientName: 'Maya Sharma', stars: null }) ===
      'Maya left you a review.',
    'P1 review: no rating -> plain copy',
  );
  assert(
    buildEventBody('review_submitted', { clientName: null, stars: 4 }) ===
      'A client left you a 4-star review.',
    'P1 review: missing name falls back honestly',
  );
  assert(
    buildEventBody('escrow_closed', {}) === 'Congratulations, your escrow is closed!',
    'P1 closed: approved celebration copy verbatim',
  );
  assert(
    buildEventBody('escrow_cancelled', { realtorName: 'Anuraj Shetty' }) ===
      'This escrow has been cancelled. Anuraj can help with any questions.',
    'P1 cancelled: realtor first name renders',
  );
  assert(
    buildEventBody('escrow_cancelled', { realtorName: null }) ===
      'This escrow has been cancelled. Your realtor can help with any questions.',
    'P1 cancelled: missing name falls back to Your realtor',
  );
  assert(buildEventBody('step_done', {}) === null, 'P1 bodies: non-P1 event -> null');
  assert(
    buildEventBody('buyer_intake_submitted', {}) === 'Buyer intake submitted.',
    'P1 intake: buyer copy verbatim (Option A — to the TC)',
  );
  assert(
    buildEventBody('seller_intake_submitted', {}) === 'Seller intake submitted.',
    'P1 intake: seller copy verbatim (Option A — to the TC)',
  );
  assert(
    buildEventBody('halfway_milestone', { doneCount: 7, totalCount: 14 }) ===
      "You're halfway there: 7 of 14 steps done.",
    'P3 halfway: copy verbatim with the crossing counts',
  );
  assert(
    buildEventBody('halfway_milestone', { doneCount: 3, totalCount: 5 }) ===
      "You're halfway there: 3 of 5 steps done.",
    'P3 halfway: odd totals render as snapshotted',
  );
  assert(
    buildEventBody('halfway_milestone', {}) === null,
    'P3 halfway: missing counts drop (never improvise numbers)',
  );
  {
    // Burst coalescing: repeated intake saves for one escrow in a
    // drain collapse to a single row; other events never collapse.
    const rows = [
      { escrow_id: 'e1', event: 'buyer_intake_submitted' as PushEvent },
      { escrow_id: 'e1', event: 'buyer_intake_submitted' as PushEvent },
      { escrow_id: 'e1', event: 'seller_intake_submitted' as PushEvent },
      { escrow_id: 'e2', event: 'buyer_intake_submitted' as PushEvent },
      { escrow_id: 'e1', event: 'client_joined' as PushEvent },
      { escrow_id: 'e1', event: 'client_joined' as PushEvent },
    ];
    const collapsed = collapseBurstEvents(rows);
    assert(collapsed.length === 5, 'P1 bursts: 6 rows -> 5 (one duplicate intake collapsed)');
    assert(
      collapsed.filter((r) => r.event === 'buyer_intake_submitted' && r.escrow_id === 'e1').length === 1,
      'P1 bursts: same escrow+intake event collapses to one',
    );
    assert(
      collapsed.filter((r) => r.event === 'client_joined').length === 2,
      'P1 bursts: non-intake events never collapse',
    );
  }
  assert(
    buildPushBody('client_joined', 'Anuraj', null, null, null) === null,
    'P1 bodies: HTTP builder never serves outbox events',
  );
  assert(
    parseTriggerPayload({ event: 'client_joined', escrow_id: 'e1' }) === null,
    'P1 payloads: outbox events are rejected on the HTTP path',
  );
  assert(
    buildPushBody('close_date_changed', 'Anuraj', null, null, null) ===
      'Your closing date was removed.',
    'P1 close-date cleared: removed copy wired (inert — date is never clearable today)',
  );
  assert(
    receives('close_date_changed', null, 'buyer') &&
      receives('close_date_changed', null, 'seller') &&
      receives('close_date_changed', null, 'tc'),
    'P1 close-date cleared: targeting is the close_date_changed row — all parties',
  );

  // ---- P2: date-reminder bodies (approved copy, Oct 15 2026) ----
  {
    const d = '2026-10-22'; // formats as Oct 22, 2026
    assert(
      buildReminderBody('closing_reminder', 'client', { threshold: 7, dateISO: d, street: '12 Oak St' }) ===
        'One week to go. Your closing is on Oct 22, 2026.',
      'P2 closing client 7d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'client', { threshold: 3, dateISO: d, street: '12 Oak St' }) ===
        'Closing is in 3 days, on Oct 22, 2026.',
      'P2 closing client 3d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'client', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        'Closing is tomorrow, Oct 22, 2026.',
      'P2 closing client 1d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'realtor', { threshold: 7, dateISO: d, street: '12 Oak St' }) ===
        '12 Oak St closes in 7 days.',
      'P2 closing realtor 7d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'realtor', { threshold: 3, dateISO: d, street: '12 Oak St' }) ===
        '12 Oak St closes in 3 days.',
      'P2 closing realtor 3d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'realtor', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        '12 Oak St closes tomorrow.',
      'P2 closing realtor 1d copy',
    );
    assert(
      buildReminderBody('closing_reminder', 'client', { threshold: 5, dateISO: d, street: '12 Oak St' }) === null,
      'P2 closing: unlisted threshold has no copy (dropped, never improvised)',
    );
    assert(
      buildReminderBody('inspection_reminder', 'client', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        'Your inspection deadline is tomorrow, Oct 22, 2026.',
      'P2 inspection client copy',
    );
    assert(
      buildReminderBody('appraisal_reminder', 'client', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        'Your appraisal deadline is tomorrow, Oct 22, 2026.',
      'P2 appraisal client copy',
    );
    assert(
      buildReminderBody('loan_reminder', 'client', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        'Your loan approval deadline is tomorrow, Oct 22, 2026.',
      'P2 loan client copy',
    );
    assert(
      buildReminderBody('inspection_reminder', 'realtor', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        '12 Oak St: inspection deadline is tomorrow.',
      'P2 inspection realtor copy',
    );
    assert(
      buildReminderBody('loan_reminder', 'realtor', { threshold: 1, dateISO: d, street: '12 Oak St' }) ===
        '12 Oak St: loan approval deadline is tomorrow.',
      'P2 loan realtor copy',
    );
    assert(
      buildReminderBody('inspection_reminder', 'client', { threshold: 3, dateISO: d, street: '12 Oak St' }) === null,
      'P2 deadlines fire only at threshold 1',
    );
    assert(
      buildReminderBody('possession_reminder', 'client', { threshold: 5, dateISO: d, street: '12 Oak St' }) ===
        'The buyer takes possession in 5 days, on Oct 22, 2026.',
      'P2 possession copy (seller)',
    );
    assert(
      buildReminderBody('possession_reminder', 'realtor', { threshold: 5, dateISO: d, street: '12 Oak St' }) === null,
      'P2 possession: seller only, never the realtor',
    );
  }
  assert(
    rolesForPushEvent('custom_step_added', 'seller').join(',') === 'seller,tc' &&
      rolesForPushEvent('custom_step_added', 'buyer').join(',') === 'buyer,tc',
    'P1 custom step: audience is the step side + TC',
  );

  // ---- P1 app side: realtor tap route + realtor pre-prompt ----
  assert(pushTapRoute('e1', 'realtor') === '/escrow/e1', 'P1 tap: realtor push opens the realtor escrow screen');
  assert(pushTapRoute('e1', 'buyer') === '/client/buyer/e1', 'P1 tap: buyer still lands on buyer home');
  assert(pushTapRoute('e1', 'tc') === '/client/tc/e1', 'P1 tap: TC still lands on TC home');
  assert(pushTapRoute('e1', 'seller') === '/client/seller/e1', 'P1 tap: seller still lands on seller home');

  // (The P1 ask-once realtor eligibility + flag assertions were
  // replaced by the Notification Re-Ask matrix above: per-role state,
  // 14-day cooldown, 4-ask cap, don't-ask-again, legacy seeding.)

  summary('push.test.ts');
}

void main();
