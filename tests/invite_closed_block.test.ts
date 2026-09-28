// invite_closed_block.test.ts — REGRESSION: no new invite codes may be
// created on a closed or cancelled escrow (Anuraj, Sept 28, 2026). Three
// layers, belt and suspenders:
//  1. App UI: the detail screen hides the "Invite client"/"Invite TC"
//     offer on closed/cancelled escrows ("View clients"/"View TC" stays for
//     legacy live invites); the ClientList "Invite another" form + cap note
//     are hidden via the escrowClosed prop.
//  2. Store: local createInvite throws on closed/cancelled escrows (any
//     role). Per-side-closed escrows (status still 'open') are unaffected.
//  3. Server: migration 0018 adds a BEFORE INSERT trigger on invites that
//     rejects closed/cancelled escrows; the closed-escrow push rejection
//     rolls back the optimistic local invite and records a final
//     non-retryable sync error (never retried forever), exactly like the
//     cap-rejection path.
// Run: see tests/run.sh.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { isClosedEscrowRejection } from '../src/lib/cloudSync';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';
import { readSyncErrors } from '../src/lib/syncErrors';

declare const require: any;
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
};
const fs = require('fs');
const path = require('path');

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const ROOT = process.env.CTC_REPO_ROOT ?? process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ESCROW_INPUT = {
  address: '77 Closed Ln',
  city: 'Santa Clarita',
  side: 'buy' as const,
  buyerName: 'Alice Buyer',
  sellerName: 'Bob Seller',
  openDate: '2026-09-01',
  closeDate: '2026-10-31',
} as never;

type Role = 'buyer' | 'seller' | 'tc';
const ROLES: Role[] = ['buyer', 'seller', 'tc'];

async function checkAll(
  store: ReturnType<typeof createStore>,
  escrowId: string,
  role: Role,
): Promise<void> {
  const e = await store.getEscrow(escrowId);
  const steps = role === 'buyer' ? e!.buyerSteps : e!.sellerSteps;
  for (const s of steps) {
    if (!s.done) await store.toggleStep(escrowId, role, s.id);
  }
}

async function test_storeBlocksClosedAndCancelled() {
  for (const target of ['closed', 'cancelled'] as const) {
    const store = createStore(memoryKV());
    const e = await store.createEscrow(ESCROW_INPUT);
    // Creation works while open...
    const early = await store.createInvite(e.id, 'buyer', 'Early Bird');
    assert(!!early && !early.revokedAt, `${target}: createInvite works while the escrow is open`);
    // ...then the escrow dies, and every role is blocked.
    if (target === 'closed') {
      await checkAll(store, e.id, 'buyer');
    }
    const flipped =
      target === 'closed' ? await store.closeEscrow(e.id, 'buyer') : await store.cancelEscrow(e.id);
    const status = (flipped as { escrow: { status: string } }).escrow.status;
    assert(status === target, `escrow status should be ${target} (got ${status})`);
    for (const role of ROLES) {
      let err: unknown = null;
      try {
        await store.createInvite(e.id, role, 'Someone');
      } catch (e2) {
        err = e2;
      }
      assert(
        !!err && /cannot create invites for a (closed|cancelled) escrow/.test(String((err as Error).message)),
        `${target} escrow: createInvite(${role}) must throw`,
      );
    }
    const live = (await store.listInvites(e.id)).filter((i) => !i.revokedAt);
    assert(live.length === 0, `${target} escrow: no live invite rows may exist`);
  }
}

async function test_openEscrowUnaffected() {
  const store = createStore(memoryKV());
  const e = await store.createEscrow(ESCROW_INPUT);
  for (const role of ROLES) {
    const invite = await store.createInvite(e.id, role, `${role} person`);
    assert(!!invite && !invite.revokedAt, `open escrow: createInvite(${role}) works`);
  }
}

async function test_perSideCloseUnaffected() {
  // Per-side close keeps status 'open' — this rule is status-based by
  // design, so the other side can still be invited.
  const store = createStore(memoryKV());
  const e = await store.createEscrow({
    address: '77 Both Ln',
    city: 'Santa Clarita',
    side: 'both' as const,
    buyerName: 'Alice Buyer',
    sellerName: 'Bob Seller',
    openDate: '2026-09-01',
    closeDate: '2026-10-31',
  } as never);
  await checkAll(store, e.id, 'buyer');
  await store.closeEscrow(e.id, 'buyer');
  const after = await store.getEscrow(e.id);
  assert(after!.status === 'open', 'per-side close keeps status open');
  const invite = await store.createInvite(e.id, 'seller', 'Seller Two');
  assert(!!invite && !invite.revokedAt, 'per-side-closed escrow: other side can still be invited');
}

function test_isClosedEscrowRejection() {
  assert(
    isClosedEscrowRejection(new Error('cannot create invites for a closed escrow')),
    'matches the trigger message for closed',
  );
  assert(
    isClosedEscrowRejection(new Error('cannot create invites for a cancelled escrow')),
    'matches the trigger message for cancelled',
  );
  assert(
    !isClosedEscrowRejection(new Error('two clients per side max — revoke one to invite someone new')),
    'does not match the cap message',
  );
  assert(!isClosedEscrowRejection(new Error('network timeout')), 'does not match unrelated errors');
  assert(!isClosedEscrowRejection(null), 'null-safe');
}

// --- Synced path: the closed-escrow push rejection ------------------------
// Mirror of tests/invite_cap_sync.test.ts: the Supabase client is injected
// (no network); the upsert is rejected with the 0018 trigger message.
type ServerRow = Record<string, unknown>;
interface MockState {
  rows: ServerRow[];
  pushError: string | null;
  upserts: number;
}

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
        state.upserts++;
        const result =
          table === 'invites' && state.pushError
            ? { error: { message: state.pushError } }
            : { data: [{ id: 'x' }], error: null };
        return { select: () => Promise.resolve(result) };
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  };
}

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

async function test_serverClosedRejectionRollsBack() {
  // Race: invite created while the escrow was open; the escrow is
  // closed/cancelled before the push lands. The server trigger rejects the
  // push: the optimistic local row must be rolled back (not left as a
  // phantom), a final non-retryable sync error must be recorded, and the
  // push must not be retried forever.
  const state: MockState = {
    rows: [],
    pushError: 'cannot create invites for a closed escrow',
    upserts: 0,
  };
  const { store, escrow, kv } = await makeSynced(state);
  const invite = await store.createInvite(escrow.id, 'buyer', 'Ada');
  await tick();
  const after = await store.getInvite(invite.id);
  assert(!!after?.revokedAt, 'closed-rejected push: optimistic invite must be revoked locally');
  const active = (await store.listInvites(escrow.id)).filter(
    (i) => i.role === 'buyer' && !i.revokedAt,
  );
  assert(active.length === 0, 'no active buyer invite may survive the rollback');
  const ops = await readOutboxOps(kv);
  assert(
    !ops.some((o) => o.op === 'pushInvite' && o.inviteId === invite.id),
    'closed-rejected push must not be queued for retry',
  );
  const errors = await readSyncErrors(kv);
  const rec = errors.find((e) => e.inviteId === invite.id);
  assert(!!rec, 'a sync error record must exist for the rejected invite');
  assert(rec!.op === 'inviteClosed', `record op should be inviteClosed (got ${rec!.op})`);
  assert(rec!.retryable === false, 'the closed-escrow record must be final, not retryable');
  assert(
    /closed or cancelled/.test(rec!.why),
    `plain-words why must mention closed/cancelled (got: ${rec!.why})`,
  );
}

async function test_syncedGateBlocksClosedEscrow() {
  // The app-level gate: synced createInvite throws before any push attempt
  // when the local escrow is closed.
  const state: MockState = { rows: [], pushError: null, upserts: 0 };
  const { store, escrow, kv } = await makeSynced(state);
  await checkAll(store, escrow.id, 'buyer');
  await store.closeEscrow(escrow.id, 'buyer');
  // Let the close's own pushes drain so the upsert counter is quiescent.
  for (let i = 0; i < 100 && (await readOutboxOps(kv)).length > 0; i++) {
    await tick(50);
  }
  const upsertsBefore = state.upserts;
  let err: unknown = null;
  try {
    await store.createInvite(escrow.id, 'buyer', 'Late');
  } catch (e) {
    err = e;
  }
  assert(!!err, 'synced createInvite on a closed escrow must throw');
  await tick();
  const ops = await readOutboxOps(kv);
  assert(
    !ops.some((o) => o.op === 'pushInvite'),
    'no pushInvite may be queued for a closed escrow',
  );
  assert(state.upserts === upsertsBefore, 'no push attempt may be made for a closed escrow');
}

// --- Structural UI tests (RN components are not importable in node) -------
function test_detailButtonsGated() {
  const src = read('app/escrow/[id].tsx');
  assert(
    src.includes("escrow.status !== 'open'") && src.includes('renderInviteButton'),
    'detail: invite buttons must be gated on escrow.status',
  );
  // The "Invite client"/"Invite TC" offer disappears; "View clients"/"View TC"
  // stays for legacy live invites.
  assert(
    /renderInviteButton[\s\S]{0,600}if \(escrow && escrow\.status !== 'open' && count === 0\) return null/.test(
      src,
    ),
    'detail: renderInviteButton hides the offer when closed/cancelled with no live invites',
  );
  assert(
    /renderTcButton[\s\S]{0,600}if \(escrow && escrow\.status !== 'open' && count === 0\) return null/.test(
      src,
    ),
    'detail: renderTcButton hides the offer when closed/cancelled with no live invites',
  );
  assert(
    src.includes('escrowClosed={escrow.status'),
    'detail: ClientList receives the escrowClosed prop',
  );
}

function test_clientListInlineFormGated() {
  const src = read('src/components/ClientList.tsx');
  assert(src.includes('escrowClosed?: boolean'), 'ClientList: escrowClosed prop declared');
  assert(
    src.includes('!escrowClosed && invites.length < cap'),
    'ClientList: "Invite another" offer gated on !escrowClosed',
  );
  assert(
    src.includes(') : !escrowClosed ? ('),
    'ClientList: cap note also hidden when escrowClosed',
  );
  // InviteSheet (first-invite flow) is only reachable through the detail
  // buttons, which are gated above; its create path is covered by the
  // store-level throw backstop.
  const sheet = read('src/components/InviteSheet.tsx');
  assert(
    sheet.includes('store.createInvite'),
    'InviteSheet: still goes through store.createInvite (backstopped by the status gate)',
  );
}

function test_migration0018() {
  const sql = read('supabase/migrations/0018_no_invites_on_closed_escrow.sql');
  assert(
    sql.includes('create trigger invites_no_closed_escrow'),
    'migration 0018: creates the invites_no_closed_escrow trigger',
  );
  assert(
    sql.includes('before insert on invites'),
    'migration 0018: trigger fires before insert on invites',
  );
  assert(
    /v_status in \('closed', 'cancelled'\)/.test(sql),
    'migration 0018: blocks closed and cancelled escrows',
  );
  assert(
    sql.includes('cannot create invites for a % escrow'),
    'migration 0018: rejection message matches isClosedEscrowRejection',
  );
}

async function main(): Promise<void> {
  await test_storeBlocksClosedAndCancelled();
  await test_openEscrowUnaffected();
  await test_perSideCloseUnaffected();
  test_isClosedEscrowRejection();
  await test_serverClosedRejectionRollsBack();
  await test_syncedGateBlocksClosedEscrow();
  test_detailButtonsGated();
  test_clientListInlineFormGated();
  test_migration0018();
  summary('invite_closed_block');
}

main().catch((e) => {
  console.error('invite_closed_block FAILED', e);
  process.exitCode = 1;
});
