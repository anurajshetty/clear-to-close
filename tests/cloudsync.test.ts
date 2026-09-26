// cloudsync.test.ts — unit tests for the Supabase sync layer.
// The supabase client is a scripted mock (no network). These pin:
//  - row mappers (snake_case, position/completed_at, no created_at overwrite)
//  - redeem_invite / get_client_view RPC payload mapping
//  - invite-code regenerate-on-collision (DB 23505 -> new code -> retry)
//  - boot ping: auth + read/write round-trip, graceful failure paths
//  - outbox: failed pushes queue and later drain
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  drainOutbox,
  enqueueOutbox,
  ensureCloudUser,
  isUniqueViolation,
  mapClientViewRpc,
  mapRedeemRpc,
  pingCloud,
  pushEscrowNow,
  pushInviteNow,
  toEscrowRow,
  toProfileRow,
  toStepRows,
} from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

// Scripted mock of the supabase client: each keyed call consumes one
// scripted {data, error}. Query builders are thenable, like postgrest-js.
function makeClient(script: Record<string, { data?: unknown; error?: unknown }[]>) {
  const calls: string[] = [];
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
    upsert: () => builder(key),
    insert: () => builder(key),
    update: () => builder(key),
    then: (res: (v: unknown) => void) => {
      res(next(key));
    },
  });
  return {
    calls,
    auth: {
      getSession: async () => next('auth.getSession'),
      signInAnonymously: async () => next('auth.signInAnonymously'),
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

  const srows = toStepRows(e.id, 'buyer', e.buyerSteps);
  assert(srows.length === 2, 'two step rows');
  assert(srows[0].position === 0 && srows[1].position === 1, 'position mirrors order');
  assert(srows[0].completed_at === '2026-09-25T10:00:00Z', 'completed_at passes through');
  assert(!('created_at' in srows[0]), 'created_at omitted (DB default fills it)');
  assert(srows[1].custom === true, 'custom flag passes through');

  const prow = toProfileRow(UID, {
    name: 'Rita', photoUri: 'file://x.jpg', about: 'Hi',
    yearsExperience: '5', dealsClosed: '20', areasServed: 'SCV', phone: '555',
  });
  assert(prow.user_id === UID && prow.photo_url === 'file://x.jpg', 'profile row maps photoUri -> photo_url');
  assert(toProfileRow(UID, null).name === null, 'null profile maps to nulls');

  // --- RPC mapping --------------------------------------------------------
  const rok = mapRedeemRpc({ ok: true, escrow_id: 'eid', role: 'seller', party_name: 'Bob', link_id: 'lid' });
  assert(rok.ok === true && rok.linkId === 'lid' && rok.role === 'seller', 'redeem ok maps link id + role');
  const rerr = mapRedeemRpc({ ok: false, error: 'already_used' });
  assert(rerr.ok === false && rerr.error === 'already_used', 'redeem already_used maps');
  const rbogus = mapRedeemRpc({ ok: false, error: 'zzz' });
  assert(rbogus.ok === false && rbogus.error === 'invalid', 'unknown redeem error -> invalid');

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

  const cAuthFail = makeClient({
    'auth.getSession': [{ data: { session: null } }],
    'auth.signInAnonymously': [{ data: { user: null, session: null }, error: { message: 'anonymous_provider_disabled' } }],
  });
  const p1 = await pingCloud(cAuthFail);
  assert(p1.ran && !p1.ok && (p1.error ?? '').length > 0, 'ping reports anonymous sign-in failure cleanly');

  const cReadFail = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
    'from:realtor_profiles': [{ error: { code: '42501', message: 'rls blocked' } }],
  });
  const p2 = await pingCloud(cReadFail);
  assert(p2.ran && !p2.ok && (p2.error ?? '').includes('read probe'), 'ping reports RLS read failure');

  const cWriteFail = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
    'from:realtor_profiles': [{ data: [] }, { error: { code: '42501', message: 'rls blocked' } }],
  });
  const p3 = await pingCloud(cWriteFail);
  assert(p3.ran && !p3.ok && (p3.error ?? '').includes('write probe'), 'ping reports RLS write failure');

  const cOk = makeClient({
    'auth.getSession': [{ data: { session: null } }],
    'auth.signInAnonymously': [{ data: { user: { id: UID }, session: { access_token: 't' } } }],
    'from:realtor_profiles': [{ data: [] }, { data: null }, { data: [{ user_id: UID }] }],
  });
  const p4 = await pingCloud(cOk);
  assert(p4.ran && p4.ok && p4.userId === UID, 'ping happy path: auth + read + write round-trip');

  // ensureCloudUser caches the session user.
  const cCache = makeClient({
    'auth.getSession': [{ data: { session: { user: { id: UID } } } }],
  });
  const u1 = await ensureCloudUser(cCache);
  assert(u1 === UID, 'ensureCloudUser resolves existing session');

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
