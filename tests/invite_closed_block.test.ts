// invite_closed_block.test.ts — REGRESSION: no new invite codes may be
// created on a closed or cancelled escrow (Anuraj, Sept 28, 2026). Three
// layers, belt and suspenders:
//  1. App UI (Sept 29, 2026 redesign): the detail screen has ONE "Share
//     this escrow" entry button that pushes /share/[escrowId] and stays
//     visible on open, closed, AND cancelled escrows. Invite CREATION is
//     gated inside app/share/[id].tsx: no invite buttons, inline forms,
//     or cap notes when the escrow is closed/cancelled — while existing
//     rows, remove, and regenerate stay available.
//  2. Store: local createInvite throws on closed/cancelled escrows (any
//     role). Per-side-closed escrows (status still 'open') are unaffected.
//  3. Server: migration 0018 adds a BEFORE INSERT trigger on invites that
//     rejects closed/cancelled escrows; a closed-escrow push rejection
//     (the race where the escrow dies between the gate and the push) fails
//     the confirmed write atomically — nothing local is created, the
//     realtor sees the plain-words reason, and nothing is queued for retry.
// Run: see tests/run.sh.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { isClosedEscrowRejection } from '../src/lib/cloudSync';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';

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
  // 'both' so all three roles are side-valid; the point is the closed-block
  // doesn't affect open escrows, not the side rule.
  const e = await store.createEscrow({
    address: '77 Closed Ln',
    city: 'Santa Clarita',
    side: 'both' as const,
    buyerName: 'Alice Buyer',
    sellerName: 'Bob Seller',
    openDate: '2026-09-01',
    closeDate: '2026-10-31',
  } as never);
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
        // One affected row per input row (PostgREST RETURNING semantics):
        // the escrow push upserts the escrow + all step rows in bulk calls,
        // and the zero-row underflow guard counts affected rows.
        const rows = (Array.isArray(_row) ? _row : [_row]) as Record<string, unknown>[];
        const result =
          table === 'invites' && state.pushError
            ? { error: { message: state.pushError } }
            : { data: rows.map((r, i) => ({ id: r.id ?? `x-${i}` })), error: null };
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

async function test_serverClosedRejectionFailsAtomically() {
  // Race: the invite passed the app-level gate while the escrow was open,
  // but the escrow was closed/cancelled before the push landed and the
  // 0018 server trigger rejected the insert. Synchronous-write semantics
  // (Anuraj, Sept 28, 2026): nothing local was ever created, so there is
  // nothing to roll back — the confirmed write throws the plain-words
  // reason, the local invite list stays empty, and the rejection is final
  // (no outbox op may be queued for retry).
  const state: MockState = {
    rows: [],
    pushError: 'cannot create invites for a closed escrow',
    upserts: 0,
  };
  const { store, escrow, kv } = await makeSynced(state);
  let err: unknown = null;
  try {
    await store.createInvite(escrow.id, 'buyer', 'Ada');
  } catch (e) {
    err = e;
  }
  assert(!!err, 'a closed-rejected push must throw');
  assert(
    /closed or cancelled/.test(String((err as Error).message)),
    `thrown message must name closed/cancelled (got: ${String((err as Error).message)})`,
  );
  const active = (await store.listInvites(escrow.id)).filter(
    (i) => i.role === 'buyer' && !i.revokedAt,
  );
  assert(active.length === 0, 'no local invite row may exist after the failed write');
  const ops = await readOutboxOps(kv);
  assert(
    !ops.some((o) => o.op === 'pushInvite'),
    'a closed-rejected push must not be queued for retry',
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
function test_shareEntryPoint() {
  const src = read('app/escrow/[id].tsx');
  // ONE entry button, visible on every escrow status (no dead-escrow hide).
  assert(src.includes("Share this escrow"), 'detail: single "Share this escrow" button exists');
  assert(
    /router\.push\(`\/share\/\$\{escrow\.id\}`\)/.test(src),
    'detail: "Share this escrow" pushes /share/[escrowId]',
  );
  assert(
    !/escrow\.status !== 'open'[\s\S]{0,200}Share this escrow/.test(src),
    'detail: share button is NOT gated on escrow status (stays visible on closed/cancelled)',
  );
  // The old three-button flow and its overlays are gone.
  for (const gone of [
    'renderInviteButton',
    'renderTcButton',
    '<InviteSheet',
    '<ClientList',
    "'Invite client'",
    "'View clients'",
    "'Invite TC'",
    "'View TC'",
  ]) {
    assert(!src.includes(gone), `detail: old invite flow removed (${gone})`);
  }
}

function test_shareScreenDeadEscrowGate() {
  const src = read('app/share/[id].tsx');
  // Invite CREATION is gated inside the share screen on dead escrows via a
  // single escrowOpen flag: the invite button, the inline form, and the cap
  // note all hide when the escrow is closed/cancelled, while existing rows
  // (remove/regenerate) keep rendering.
  assert(
    src.includes("const escrowOpen = escrow.status === 'open'"),
    'share: single escrowOpen creation gate defined from escrow.status',
  );
  assert(
    src.includes('showInviteUi = escrowOpen'),
    'share: invite button gated on escrowOpen',
  );
  assert(
    src.includes('showCapNote = escrowOpen'),
    'share: cap note gated on escrowOpen',
  );
  // The inline form only ever opens through the gated invite button
  // (openForm's sole call site), so no creation UI exists on dead escrows.
  assert(
    (src.match(/openForm\(s\.role\)/g) || []).length === 1,
    'share: form opens only via the gated invite button',
  );
  assert(
    !/escrow\.status !== 'open'[\s\S]{0,120}return null/.test(src.split('return (')[0]),
    'share: dead escrows still render their invite rows (no early return before render)',
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
  await test_serverClosedRejectionFailsAtomically();
  await test_syncedGateBlocksClosedEscrow();
  test_shareEntryPoint();
  test_shareScreenDeadEscrowGate();
  test_migration0018();
  summary('invite_closed_block');
}

main().catch((e) => {
  console.error('invite_closed_block FAILED', e);
  process.exitCode = 1;
});
