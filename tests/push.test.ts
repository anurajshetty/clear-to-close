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
  getPushPermission,
  getRealtorUnregisterPending,
  hasBeenAskedPush,
  hasBeenAskedRealtorPush,
  isClientHomePath,
  loadNotifications,
  markPushAsked,
  markRealtorPushAsked,
  pushTapRoute,
  registerPushToken,
  resolveRealtorPendingStore,
  setRealtorUnregisterPending,
  setupPushHandling,
  shouldShowPrePrompt,
  shouldShowRealtorPrePrompt,
  unregisterPushToken,
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

  // ---- ask-once state ----
  const kv = memoryKV();
  assert((await hasBeenAskedPush(kv)) === false, 'ask-once starts unasked');
  await markPushAsked(kv);
  assert((await hasBeenAskedPush(kv)) === true, 'ask-once persists after mark');

  // ---- realtor sign-out unregister queue (P0, Oct 2026) ----
  // A failed authenticated unregister at logout queues the (deviceId,
  // token) pair so the next boot can retry by possession; the queue is
  // device-scoped state and must round-trip exactly.
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

  assert(
    shouldShowRealtorPrePrompt({ role: 'realtor', hasSession: true, asked: false, permission: 'undetermined' }),
    'P1 realtor prompt: signed-in realtor, unasked, undetermined -> shows',
  );
  assert(
    !shouldShowRealtorPrePrompt({ role: 'realtor', hasSession: false, asked: false, permission: 'undetermined' }),
    'P1 realtor prompt: no session -> hidden',
  );
  assert(
    !shouldShowRealtorPrePrompt({ role: 'client', hasSession: true, asked: false, permission: 'undetermined' }),
    'P1 realtor prompt: client role -> hidden',
  );
  assert(
    !shouldShowRealtorPrePrompt({ role: 'realtor', hasSession: true, asked: true, permission: 'undetermined' }),
    'P1 realtor prompt: already asked -> hidden',
  );
  assert(
    !shouldShowRealtorPrePrompt({ role: 'realtor', hasSession: true, asked: false, permission: 'granted' }),
    'P1 realtor prompt: already granted -> hidden',
  );
  assert(
    !shouldShowRealtorPrePrompt({ role: 'realtor', hasSession: true, asked: false, permission: 'denied' }),
    'P1 realtor prompt: denied -> hidden (never nags)',
  );

  {
    const kv = memoryKV();
    assert((await hasBeenAskedRealtorPush(kv)) === false, 'P1 realtor flag: unset by default');
    await markRealtorPushAsked(kv);
    assert((await hasBeenAskedRealtorPush(kv)) === true, 'P1 realtor flag: set after mark');
    assert(
      (await hasBeenAskedPush(kv)) === false,
      'P1 realtor flag: separate from the client ask-once flag',
    );
    await markPushAsked(kv);
    assert((await hasBeenAskedPush(kv)) === true, 'P1 flags: client flag still independent');
  }

  summary('push.test.ts');
}

void main();
