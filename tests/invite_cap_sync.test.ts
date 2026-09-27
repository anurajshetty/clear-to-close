// invite_cap_sync.test.ts — execute-time coverage for the Sept 2026 invite-cap
// fix (src/lib/syncedStore.ts createInvite). The local cap check was reading a
// stale invite cache: invites created on another device lived on the server
// but never appeared locally until login hydration, so the local check could
// see fewer than two active invites and optimistically create a third. This
// pins the two halves of the fix:
//  - createInvite pulls full server invite rows before the local cap check,
//    so a server-side third buyer (or second TC) is rejected at creation time;
//  - a server cap rejection on push rolls back the optimistic local invite
//    instead of leaving a phantom over-cap row (and is not retried forever).
// The Supabase client is injected (no network); the public gate is enabled
// with fake env vars (this file runs in its own node process).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

type Role = 'buyer' | 'seller' | 'tc';
type ServerRow = Record<string, unknown>;

interface MockState {
  rows: ServerRow[];
  capErrorOnPush: boolean;
}

function serverInvite(escrowId: string, role: Role, name: string, n: number): ServerRow {
  return {
    id: `srv-${role}-${n}`,
    code: `CODE-${role.toUpperCase()}-${n}`,
    escrow_id: escrowId,
    role,
    party_name: name,
    created_at: new Date().toISOString(),
    revoked_at: null,
    redeemed_at: null,
  };
}

// Minimal thenable query builder covering the chains syncedStore/cloudSync
// use: from().select().eq() (awaited directly), .select().eq().limit(1),
// and from().upsert().
function mockClient(state: MockState): unknown {
  const thenable = (result: unknown) => ({
    limit: async (_n: number) => result,
    then: (resolve: (v: unknown) => void) => resolve(result),
  });
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
    },
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, val: unknown) => {
          if (table === 'invites') {
            return thenable({
              data: state.rows.filter((r) => r.escrow_id === val),
              error: null,
            });
          }
          return thenable({ data: [], error: null });
        },
      }),
      upsert: (_row: unknown, _opts?: unknown) => {
        let result: { data?: unknown; error?: unknown };
        if (table === 'invites' && state.capErrorOnPush) {
          // The invites_cap trigger's cap rejection (migration 0012).
          result = {
            error: {
              message: 'two clients per side max — revoke one to invite someone new',
            },
          };
        } else {
          result = { data: [{ id: 'x' }], error: null };
        }
        return { select: () => Promise.resolve(result) };
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  };
}

const ESCROW_INPUT = {
  address: '123 Cap St',
  city: 'Santa Clarita',
  side: 'buy' as const,
  buyerName: 'Alice Buyer',
  sellerName: 'Bob Seller',
  openDate: '2026-09-01',
  closeDate: '2026-10-31',
} as never;

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function makeSynced(state: MockState) {
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: () => mockClient(state) as never,
  });
  const ping = await initCloudSync();
  assert(ping.ok, 'initCloudSync should report a healthy cloud');
  const escrow = await store.createEscrow(ESCROW_INPUT);
  await tick();
  return { store, escrow, kv };
}

async function test_staleCacheBlocksThirdBuyer() {
  const state: MockState = { rows: [], capErrorOnPush: false };
  const { store, escrow } = await makeSynced(state);
  // Two buyers already exist on the SERVER (created on another device after
  // this device logged in), so the local cache is stale and empty.
  state.rows = [
    serverInvite(escrow.id, 'buyer', 'Ada', 1),
    serverInvite(escrow.id, 'buyer', 'Bo', 2),
  ];
  let err: unknown = null;
  try {
    await store.createInvite(escrow.id, 'buyer', 'Cy');
  } catch (e) {
    err = e;
  }
  assert(!!err, 'third buyer with two server-side invites should be rejected at creation');
  const active = (await store.listInvites(escrow.id)).filter((i) => i.role === 'buyer' && !i.revokedAt);
  assert(active.length === 2, `active buyer invites should be 2 (got ${active.length})`);
}

async function test_staleCacheBlocksSecondTC() {
  const state: MockState = { rows: [], capErrorOnPush: false };
  const { store, escrow } = await makeSynced(state);
  state.rows = [serverInvite(escrow.id, 'tc', 'Tess', 1)];
  let err: unknown = null;
  try {
    await store.createInvite(escrow.id, 'tc', 'Tom');
  } catch (e) {
    err = e;
  }
  assert(!!err, 'second TC with one server-side TC invite should be rejected at creation');
  const active = (await store.listInvites(escrow.id)).filter((i) => i.role === 'tc' && !i.revokedAt);
  assert(active.length === 1, `active TC invites should be 1 (got ${active.length})`);
}

async function test_serverCapRejectionRollsBackOptimisticInvite() {
  // Server is empty (pre-pull merges nothing), but the push is rejected by
  // the authoritative cap trigger — the optimistic local row must not
  // survive as a phantom, and the push must not be retried forever.
  const state: MockState = { rows: [], capErrorOnPush: true };
  const { store, escrow, kv } = await makeSynced(state);
  const invite = await store.createInvite(escrow.id, 'buyer', 'Cy');
  await tick();
  const after = await store.getInvite(invite.id);
  assert(!!after?.revokedAt, 'optimistic invite rejected by the server cap should be revoked locally');
  const active = (await store.listInvites(escrow.id)).filter((i) => i.role === 'buyer' && !i.revokedAt);
  assert(active.length === 0, `no active buyer invite should survive the rollback (got ${active.length})`);
  const ops = await readOutboxOps(kv);
  assert(
    !ops.some((o) => o.op === 'pushInvite' && o.inviteId === invite.id),
    'cap-rejected push must not be queued for retry',
  );
}

async function test_normalInviteStillCreatesAndPushes() {
  // Sanity: when the server is empty and the push succeeds, creation works
  // exactly as before (no phantom rollback, no spurious rejection).
  const state: MockState = { rows: [], capErrorOnPush: false };
  const { store, escrow } = await makeSynced(state);
  const invite = await store.createInvite(escrow.id, 'buyer', 'Ada');
  await tick();
  const after = await store.getInvite(invite.id);
  assert(!!after && !after.revokedAt, 'normally created invite should stay active');
  const active = (await store.listInvites(escrow.id)).filter((i) => i.role === 'buyer' && !i.revokedAt);
  assert(active.length === 1, `one active buyer invite expected (got ${active.length})`);
}

async function main() {
  await test_staleCacheBlocksThirdBuyer();
  await test_staleCacheBlocksSecondTC();
  await test_serverCapRejectionRollsBackOptimisticInvite();
  await test_normalInviteStillCreatesAndPushes();
  summary('invite_cap_sync');
}

main().catch((e) => {
  console.error('invite_cap_sync FAILED', e);
  process.exitCode = 1;
});
