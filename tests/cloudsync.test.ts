// cloudsync.test.ts — unit tests for the Supabase sync layer.
// The supabase client is a scripted mock (no network). These pin:
//  - row mappers (snake_case, position/completed_at, no created_at overwrite)
//  - redeem_invite / get_client_view RPC payload mapping
//  - invite-code regenerate-on-collision (DB 23505 -> new code -> retry)
//  - boot ping: realtor session + read/write round-trip, graceful failure paths
//  - anonymous auth is DISABLED: signInAnonymously is never called, by
//    ensureCloudUser or anything else (the mock throws if it is invoked)
//  - outbox: failed pushes queue and later drain
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  drainOutbox,
  enqueueOutbox,
  ensureCloudUser,
  fromEscrowRow,
  isMissingColumnError,
  isUniqueViolation,
  mapClientViewRpc,
  mapRedeemRpc,
  pingCloud,
  pushEscrowNow,
  pushInviteNow,
  redeemViaCloud,
  regenerateInviteNow,
  toEscrowRow,
  toProfileRow,
  toStepRows,
} from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

// Scripted mock of the supabase client: each keyed call consumes one
// scripted {data, error}. Query builders are thenable, like postgrest-js.
function makeClient(script: Record<string, { data?: unknown; error?: unknown }[]>) {
  const calls: string[] = [];
  // writes tracks mutating builder calls separately so tests can assert a
  // path is read-only (the ping probe must never write to the profile row).
  const writes: string[] = [];
  const next = (key: string) => {
    calls.push(key);
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`mock: no script for "${key}"`);
    const r = q.shift()!;
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const builder = (key: string): unknown => ({
    select: () => builder(key),
    eq: () => builder(key),
    limit: () => builder(key),
    upsert: () => {
      writes.push(key);
      return builder(key);
    },
    insert: () => {
      writes.push(key);
      return builder(key);
    },
    update: () => {
      writes.push(key);
      return builder(key);
    },
    then: (res: (v: unknown) => void) => {
      res(next(key));
    },
  });
  return {
    calls,
    writes,
    auth: {
      getSession: async () => next('auth.getSession'),
      // Anonymous auth stays disabled: any call is a test failure.
      signInAnonymously: async () => {
        calls.push('auth.signInAnonymously');
        throw new Error('signInAnonymously must never be called');
      },
    },
    from: (table: string) => builder(`from:${table}`),
    rpc: async (name: string) => next(`rpc:${name}`),
  };
}

const UID = '11111111-1111-4111-8111-111111111111';

function escrowFixture() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    address: '4187 Oakmont Dr',
    city: 'Valencia, CA 91355',
    side: 'buy' as const,
    buyerName: 'Test Buyer',
    sellerName: null,
    openDate: '2026-09-25',
    closeDate: '2026-11-25',
    buyerSteps: [
      { id: 's1', title: 'Escrow open', subtitle: '', done: true, custom: false, order: 0, completedAt: '2026-09-25T10:00:00Z' },
      { id: 's2', title: 'Earnest money', subtitle: '', done: false, custom: true, order: 1, completedAt: null },
    ],
    sellerSteps: [],
    status: 'open' as const,
    buyerClosedAt: null,
    sellerClosedAt: null,
    createdAt: '2026-09-25T09:00:00Z',
  };
}

async function main(): Promise<void> {
  // --- mappers -----------------------------------------------------------
  const e = escrowFixture();
  const erow = toEscrowRow(UID, e);
  assert(erow.user_id === UID, 'escrow row stamps user_id');
  assert(erow.open_date === '2026-09-25' && erow.close_date === '2026-11-25', 'escrow row snake_case dates');
  assert(erow.buyer_name === 'Test Buyer' && erow.seller_name === null, 'escrow row party names');
  assert(erow.buyer_closed_at === null && erow.seller_closed_at === null, 'escrow row per-side close columns (null when open)');

  // Per-side close dates round-trip (migration 0007).
  const closed = { ...e, buyerClosedAt: '2026-09-26', status: 'closed' as const };
  const closedRow = toEscrowRow(UID, closed);
  assert(closedRow.buyer_closed_at === '2026-09-26', 'toEscrowRow maps buyer close date');
  const back = fromEscrowRow({ ...closedRow, buyer_name: 'Test Buyer' });
  assert(back.buyerClosedAt === '2026-09-26', 'fromEscrowRow reads buyer close date');
  assert(back.sellerClosedAt === null, 'fromEscrowRow null for the open side');
  assert(back.status === 'closed', 'fromEscrowRow derives closed from per-side dates');
  // Legacy row from before migration 0007: status column still honored.
  const legacy = fromEscrowRow({ id: 'x', side: 'buy', status: 'closed' });
  assert(legacy.status === 'closed' && legacy.buyerClosedAt === null, 'legacy closed row keeps status without side dates');
  const legacyOpen = fromEscrowRow({ id: 'x', side: 'buy', status: 'open' });
  assert(legacyOpen.status === 'open', 'legacy open row stays open');

  // Missing-column detection (pre-migration databases).
  assert(isMissingColumnError({ code: '42703', message: 'x' }), '42703 -> missing column');
  assert(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'buyer_closed_at' column" }), 'schema-cache message -> missing column');
  assert(!isMissingColumnError({ code: '42501', message: 'rls blocked' }), 'RLS error is not a missing column');
  assert(!isMissingColumnError(null), 'null error is not a missing column');

  // pushEscrowNow falls back to the pre-migration column set when the
  // database hasn't applied 0007 yet (and still pushes the steps).
  const upserted: Record<string, unknown>[] = [];
  const fallbackClient = {
    from: (table: string) => ({
      upsert: (rows: Record<string, unknown>[]) => {
        if (table === 'escrows') {
          upserted.push(rows[0]);
          if (!('buyer_closed_at' in rows[0])) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({ data: null, error: { code: '42703', message: 'column buyer_closed_at does not exist' } });
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  await pushEscrowNow(fallbackClient, UID, closed);
  assert(upserted.length === 2, 'escrow upsert retried after the missing-column error');
  assert(!('buyer_closed_at' in upserted[1]) && !('seller_closed_at' in upserted[1]), 'retry drops the per-side close columns');
  assert(upserted[1].id === closed.id, 'retry still pushes the same escrow');

  const srows = toStepRows(e.id, 'buyer', e.buyerSteps);
  assert(srows.length === 2, 'two step rows');
  assert(srows[0].position === 0 && srows[1].position === 1, 'position mirrors order');
  assert(srows[0].completed_at === '2026-09-25T10:00:00Z', 'completed_at passes through');
  assert(!('created_at' in srows[0]), 'created_at omitted (DB default fills it)');
  assert(srows[1].custom === true, 'custom flag passes through');

  const prow = toProfileRow(UID, {
    name: 'Rita', photoUri: 'file://x.jpg', about: 'Hi',
    yearsExperience: '5', dealsClosed: '20', areasServed: 'SCV', phone: '555',
    dreLicense: '01998877',
  });
  assert(prow.user_id === UID && prow.photo_url === 'file://x.jpg', 'profile row maps photoUri -> photo_url');
  assert(prow.dre_license === '01998877', 'profile row maps dreLicense -> dre_license');
  assert(toProfileRow(UID, null).name === null, 'null profile maps to nulls');

  // --- RPC mapping --------------------------------------------------------
  const rok = mapRedeemRpc({ ok: true, escrow_id: 'eid', role: 'seller', party_name: 'Bob', link_id: 'lid' });
  assert(rok.ok === true && rok.linkId === 'lid' && rok.role === 'seller', 'redeem ok maps link id + role');
  const rerr = mapRedeemRpc({ ok: false, error: 'already_used' });
  assert(rerr.ok === false && rerr.error === 'already_used', 'redeem already_used maps');
  const rbogus = mapRedeemRpc({ ok: false, error: 'zzz' });
  assert(rbogus.ok === false && rbogus.error === 'invalid', 'unknown redeem error -> invalid');
  const rnet = mapRedeemRpc({ ok: false, error: 'network' });
  assert(rnet.ok === false && rnet.error === 'network', 'redeem network error passes through');

  // Transport failures during cloud redeem surface as retryable 'network',
  // never 'invalid' (a missing migration or a dropped connection is not a
  // bad code). Bad codes still arrive as data {ok:false}.
  const rpcGone = { rpc: async () => ({ data: null, error: { message: 'PGRST202: function not found' } }) };
  const viaGone = await redeemViaCloud(rpcGone as never, 'ABCDEF', 'Priya Nair', 'dev-1');
  assert(viaGone.ok === false && viaGone.error === 'network', 'RPC error (e.g. missing migration) -> network');
  const rpcThrow = { rpc: async () => { throw new TypeError('fetch failed'); } };
  const viaThrow = await redeemViaCloud(rpcThrow as never, 'ABCDEF', 'Priya Nair', 'dev-1');
  assert(viaThrow.ok === false && viaThrow.error === 'network', 'RPC throw (network down) -> network');
  const rpcInvalid = { rpc: async () => ({ data: { ok: false, error: 'invalid' }, error: null }) };
  const viaInvalid = await redeemViaCloud(rpcInvalid as never, 'ZZZZZZ', 'Nobody', 'dev-1');
  assert(viaInvalid.ok === false && viaInvalid.error === 'invalid', 'bad code via data -> invalid');
  // The 0002 one-live-link-per-device index: a second live link on the same
  // device_id raises 23505 — permanent and connection-independent, so it
  // surfaces as 'device_has_link', never the misleading retryable 'network'.
  const rpcDup = { rpc: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) };
  const viaDup = await redeemViaCloud(rpcDup as never, 'ABCDEF', 'Priya Nair', 'dev-1');
  assert(viaDup.ok === false && viaDup.error === 'device_has_link', 'unique violation (second live link) -> device_has_link');

  // regenerate_invite RPC mapping: success returns the new/old codes and the
  // server-issued invite id; a data-level failure throws (the synced store
  // falls back to the local + outbox path).
  const rpcRegen = {
    rpc: async () => ({ data: { ok: true, new_code: 'QQQQQQ', old_code: 'ABCDEF', new_invite_id: 'inv-new' }, error: null }),
  };
  const regen = await regenerateInviteNow(rpcRegen as never, 'inv-old');
  assert(regen.newCode === 'QQQQQQ' && regen.oldCode === 'ABCDEF' && regen.newInviteId === 'inv-new',
    'regenerate_invite ok -> new/old code + server invite id');
  const rpcRegenFail = { rpc: async () => ({ data: { ok: false, error: 'forbidden' }, error: null }) };
  let regenThrew = false;
  try {
    await regenerateInviteNow(rpcRegenFail as never, 'inv-old');
  } catch {
    regenThrew = true;
  }
  assert(regenThrew, 'regenerate_invite data failure -> throws');
  const rpcRegenErr = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  let regenErrThrew = false;
  try {
    await regenerateInviteNow(rpcRegenErr as never, 'inv-old');
  } catch {
    regenErrThrew = true;
  }
  assert(regenErrThrew, 'regenerate_invite rpc error -> throws');

  const cv = mapClientViewRpc({
    ok: true,
    escrow: { id: 'eid', address: 'A', city: 'C', close_date: '2026-11-25' },
    buyer_steps: [
      { id: 's2', title: 'Two', subtitle: '', done: false, custom: false, position: 1, completed_at: null },
      { id: 's1', title: 'One', subtitle: '', done: true, custom: false, position: 0, completed_at: '2026-09-25T10:00:00Z' },
    ],
    profile: { name: 'Rita', photo_url: null, about: '', years_experience: '', deals_closed: '', areas_served: '', phone: '' },
  });
  assert(cv.ok === true, 'client view ok');
  assert(cv.view!.role === 'buyer' && cv.view!.steps[0].id === 's1', 'steps sorted by position, role routed');
  assert(cv.view!.done === 1 && cv.view!.total === 2, 'done/total computed');
  assert(cv.view!.upNext !== null && cv.view!.upNext.id === 's2', 'upNext is first not-done');
  assert(typeof cv.view!.daysToClose === 'number', 'daysToClose computed');
  assert(cv.profile!.name === 'Rita', 'profile mapped');
  const cvBad = mapClientViewRpc({ ok: false, error: 'invalid' });
  assert(cvBad.ok === false, 'bad client view maps to not-ok');

  // --- pushInviteNow: collision regeneration --------------------------------
  const inv = {
    id: 'i1', code: 'AAAAAA', escrowId: e.id, role: 'buyer' as const, partyName: 'Test Buyer',
    createdAt: '2026-09-25T09:00:00Z', revokedAt: null, redeemedAt: null,
  };
  const c1 = makeClient({ 'from:invites': [{ error: { code: '23505', message: 'duplicate' } }, { data: null }] });
  let genCount = 0;
  await pushInviteNow(c1, inv, () => `CODE${++genCount}`);
  assert(inv.code === 'CODE1', 'code regenerated after 23505 collision');
  assert(c1.calls.filter((k) => k === 'from:invites').length === 2, 'insert retried once after collision');

  const inv2 = { ...inv, id: 'i2', code: 'BBBBBB' };
  const c2 = makeClient({ 'from:invites': [{ data: null }] });
  await pushInviteNow(c2, inv2);
  assert(inv2.code === 'BBBBBB', 'no collision -> code untouched');

  const inv3 = { ...inv, id: 'i3', code: 'CCCCCC' };
  const c3 = makeClient({ 'from:invites': [{ error: { code: '42501', message: 'rls' } }] });
  let threw = false;
  try {
    await pushInviteNow(c3, inv3);
  } catch {
    threw = true;
  }
  assert(threw, 'non-unique errors throw immediately (no regen)');

  const inv4 = { ...inv, id: 'i4', code: 'DDDDDD' };
  const c4 = makeClient({
    'from:invites': [
      { error: { code: '23505' } }, { error: { code: '23505' } }, { error: { code: '23505' } },
      { error: { code: '23505' } }, { error: { code: '23505' } }, { error: { code: '23505' } },
    ],
  });
  let threw2 = false;
  try {
    await pushInviteNow(c4, inv4);
  } catch {
    threw2 = true;
  }
  assert(threw2, 'gives up after max regen attempts');
  assert(isUniqueViolation({ code: '23505' }) && !isUniqueViolation({ code: '42501' }), 'unique-violation detection');

  // --- pushEscrowNow --------------------------------------------------------
  const c5 = makeClient({ 'from:escrows': [{ data: null }], 'from:steps': [{ data: null }] });
  await pushEscrowNow(c5, UID, e);
  assert(c5.calls.includes('from:escrows') && c5.calls.includes('from:steps'), 'pushes escrow row + step rows');

  // --- ping -----------------------------------------------------------------
  const p0 = await pingCloud(null);
  assert(p0.ran && !p0.ok, 'ping without client -> not ok, never throws');

  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'fake-key';

  const cNoSession = makeClient({
    'auth.getSession': [{ data: { session: null } }],
  });
  const p1 = await pingCloud(cNoSession);
  assert(p1.ran && !p1.ok && (p1.error ?? '').includes('no realtor session'), 'ping without a session -> not ok, prompts sign-in');
  assert(!cNoSession.calls.includes('auth.signInAnonymously'), 'ping never signs in anonymously');

  const cReadFail = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
    'from:realtor_profiles': [{ error: { code: '42501', message: 'rls blocked' } }],
  });
  const p2 = await pingCloud(cReadFail);
  assert(p2.ran && !p2.ok && (p2.error ?? '').includes('read probe'), 'ping reports RLS read failure');

  // The probe is read-only by design: it must never write to the profile
  // row. (Regression: the old write round-trip upserted { name: null } on
  // every boot, wiping the realtor's saved name and creating phantom
  // all-null rows for brand-new accounts.)
  const cReadOnly = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
    'from:realtor_profiles': [{ data: [{ user_id: UID }] }],
  });
  const p3 = await pingCloud(cReadOnly);
  assert(p3.ran && p3.ok, 'ping succeeds on the read probe alone');
  assert(cReadOnly.writes.length === 0, 'ping never issues a write (upsert/insert/update)');

  const cOk = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
    'from:realtor_profiles': [{ data: [{ user_id: UID }] }],
  });
  const p4 = await pingCloud(cOk);
  assert(p4.ran && p4.ok && p4.userId === UID, 'ping happy path: session + read probe');
  assert(!cOk.calls.includes('auth.signInAnonymously'), 'ping happy path never signs in anonymously');
  assert(cOk.writes.length === 0, 'ping happy path performs zero writes');

  // ensureCloudUser resolves the persisted session's user, or null.
  const cCache = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
  });
  const u1 = await ensureCloudUser(cCache);
  assert(u1 === UID, 'ensureCloudUser resolves existing session');
  const cNone = makeClient({
    'auth.getSession': [{ data: { session: null } }],
  });
  const u2 = await ensureCloudUser(cNone);
  assert(u2 === null, 'ensureCloudUser returns null without a session — no anonymous fallback');
  assert(!cNone.calls.includes('auth.signInAnonymously'), 'ensureCloudUser never signs in anonymously');

  // --- outbox ----------------------------------------------------------------
  const kv = memoryKV();
  await enqueueOutbox(kv, { op: 'pushEscrow', escrowId: e.id, attempts: 0 });
  await enqueueOutbox(kv, { op: 'pushEscrow', escrowId: e.id, attempts: 0 });
  const raw = await kv.getItem('ctc:outbox');
  assert(JSON.parse(raw ?? '[]').length === 1, 'outbox coalesces duplicate ops');

  const failing = makeClient({
    'from:escrows': [{ error: { code: '500', message: 'boom' } }],
  });
  const load = {
    getEscrow: async () => e,
    getProfile: async () => null,
  };
  const d1 = await drainOutbox(failing, UID, kv, load);
  assert(d1.drained === 0 && d1.pending === 1, 'failed push stays queued');

  const succeeding = makeClient({
    'from:escrows': [{ data: null }],
    'from:steps': [{ data: null }],
  });
  const d2 = await drainOutbox(succeeding, UID, kv, load);
  assert(d2.drained === 1 && d2.pending === 0, 'retry drains the outbox');

  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  summary('cloudsync');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
