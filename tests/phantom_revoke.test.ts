// phantom_revoke.test.ts — REGRESSION S8 (Benito cancel defect,
// Nov 7-10, 2026): if the local revokedInvites list contains an invite
// id the server has never seen (a phantom, born in the outbox/identity
// incident era), cancel landed step 1 server-side (escrow cancelled,
// H5 revoked the real invites/links), then step 2's PATCH on the
// phantom returned 200 with 0 rows -> SyncNotAppliedError -> the user
// saw "Couldn't save" on every retry while the escrow was already
// cancelled underneath them.
//
// The auditor's pick, (c)+(a) with (b) OUT:
//  (c) cancel AND close build their revoke list from the SERVER's
//      invite list, pulled BEFORE the status upsert inside the
//      confirmed write — a phantom never enters the list; a failed
//      pull aborts the write with nothing landed.
//  (a) pushRevokeNow gains a per-call-site opt-in tolerance used only
//      by the cancel/close loop and the revoke-first site: on a
//      zero-row PATCH it checks server VISIBILITY — visible + zero
//      rows still throws (a real denial), not visible + zero rows
//      proceeds (the phantom raced away). Default behavior unchanged.
//
// Part A/B run cloudSync functions against a scripted fake; Part C-E
// drive the full synced store against the faithful mock server.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  pullServerRevokeTargets,
  pushRevokeNow,
  SyncNotAppliedError,
} from '../src/lib/cloudSync';
import { createSyncedStore } from '../src/lib/syncedStore';
import { createMockServer, mockCloudFromServer } from './mock_server';
import type { ClientRole } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;
const fs = require('fs');
const path = require('path');

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const REVOKED_AT = '2026-11-10T12:00:00Z';

// ---- Part A/B: scripted fake client -------------------------------------
interface RevokeScript {
  patchRows: { id: string }[];
  seenRows?: { id: string }[];
  seenError?: unknown;
  inviteRows?: Record<string, unknown>[];
  inviteError?: unknown;
}

function makeRevokeClient(script: RevokeScript) {
  const calls: string[] = [];
  const builder = (table: string): any => ({
    update: () => ({
      eq: () => ({
        select: () => {
          calls.push(`patch:${table}`);
          return { data: script.patchRows, error: null };
        },
      }),
    }),
    select: () => ({
      eq: () => {
        calls.push(`select:${table}`);
        if (table === 'invites' && (script.inviteRows !== undefined || script.inviteError !== undefined)) {
          return { data: script.inviteRows ?? null, error: script.inviteError ?? null };
        }
        return { data: script.seenRows ?? [], error: script.seenError ?? null };
      },
    }),
  });
  return { client: { from: (t: string) => builder(t) } as never, calls };
}

async function expectThrow(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

// ---- Store-level helpers (Parts C-E) ------------------------------------
function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

async function main(): Promise<void> {
  // ===== Part A: pushRevokeNow tolerance semantics ======================
  // A1. Default: zero-row PATCH throws, and NO visibility probe runs.
  {
    const { client, calls } = makeRevokeClient({ patchRows: [] });
    const err = await expectThrow(() => pushRevokeNow(client, 'inv-x', REVOKED_AT));
    assert(err instanceof SyncNotAppliedError, 'A1: default zero-row revoke throws SyncNotAppliedError');
    assert(!calls.some((c) => c.startsWith('select:')), 'A1: default path never probes visibility');
  }
  // A2. Default: a landed PATCH resolves (unchanged behavior).
  {
    const { client } = makeRevokeClient({ patchRows: [{ id: 'inv-x' }] });
    await pushRevokeNow(client, 'inv-x', REVOKED_AT);
    assert(true, 'A2: default landed revoke resolves');
  }
  // A3. Opt-in + phantom (not visible): zero rows proceeds.
  {
    const { client, calls } = makeRevokeClient({ patchRows: [], seenRows: [] });
    await pushRevokeNow(client, 'inv-ghost', REVOKED_AT, { tolerateInvisible: true });
    assert(calls.some((c) => c === 'select:invites'), 'A3: opt-in probes visibility before proceeding');
  }
  // A4. Opt-in + visible but denied: zero rows still throws.
  {
    const { client } = makeRevokeClient({ patchRows: [], seenRows: [{ id: 'inv-real' }] });
    const err = await expectThrow(() =>
      pushRevokeNow(client, 'inv-real', REVOKED_AT, { tolerateInvisible: true }),
    );
    assert(err instanceof SyncNotAppliedError, 'A4: visible + zero-row PATCH still throws');
  }
  // A5. Opt-in + visibility probe errors: fail loud (throw), never proceed.
  {
    const { client } = makeRevokeClient({
      patchRows: [],
      seenError: { code: 'PGRST000', message: 'connection reset' },
    });
    const err = await expectThrow(() =>
      pushRevokeNow(client, 'inv-x', REVOKED_AT, { tolerateInvisible: true }),
    );
    assert(err instanceof SyncNotAppliedError, 'A5: an errored visibility probe still throws');
  }
  // A6. Opt-in + landed PATCH: resolves without probing.
  {
    const { client, calls } = makeRevokeClient({ patchRows: [{ id: 'inv-x' }] });
    await pushRevokeNow(client, 'inv-x', REVOKED_AT, { tolerateInvisible: true });
    assert(!calls.some((c) => c.startsWith('select:')), 'A6: landed revoke never probes');
  }

  // ===== Part B: pullServerRevokeTargets ================================
  const fullRows = [
    { id: 'i1', code: 'AAAA11', escrow_id: 'e1', role: 'buyer', party_name: 'B', created_at: '2026-09-25T00:00:00Z', revoked_at: null, redeemed_at: null },
    { id: 'i2', code: 'BBBB22', escrow_id: 'e1', role: 'tc', party_name: 'T', created_at: '2026-09-25T00:00:00Z', revoked_at: '2026-10-01T00:00:00Z', redeemed_at: null },
    { id: 'i3', code: 'CCCC33', escrow_id: 'e1', role: 'seller', party_name: 'S', created_at: '2026-09-25T00:00:00Z', revoked_at: null, redeemed_at: '2026-10-02T00:00:00Z' },
  ];
  {
    const { client } = makeRevokeClient({ patchRows: [], inviteRows: fullRows });
    const all = await pullServerRevokeTargets(client, 'e1', null, REVOKED_AT);
    assert(all.length === 2 && all.every((t) => t.revokedAt === REVOKED_AT),
      'B1: cancel scope = every not-yet-revoked server invite, stamped with the write timestamp');
    assert(all.some((t) => t.id === 'i1') && all.some((t) => t.id === 'i3'),
      'B1: the already-revoked invite is excluded; the redeemed-but-live one is included');
    const scoped = await pullServerRevokeTargets(client, 'e1', ['seller'] as ClientRole[], REVOKED_AT);
    assert(scoped.length === 1 && scoped[0].id === 'i3', 'B2: close scope filters by role');
    const failing = makeRevokeClient({ patchRows: [], inviteRows: undefined, inviteError: { code: 'PGRST000', message: 'down' } });
    // inviteRows undefined + inviteError set: the fake returns the error.
    const err = await expectThrow(async () => {
      await pullServerRevokeTargets(failing.client, 'e1', null, REVOKED_AT);
    });
    assert(!!err, 'B3: a failed server pull throws (the write aborts before anything lands)');
  }

  // ===== Part C: S8 at store level — cancel with a phantom invite ======
  {
    const { openDate, closeDate } = dates();
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '8 Phantom Way', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Test Buyer', openDate, closeDate,
    });
    const real = await store.createInvite(e.id, 'buyer', 'Test Buyer');
    const linkRes = await store.redeemInvite(real.code, 'Test Buyer', 'dev-phantom');
    const linkId = linkRes.ok ? linkRes.linkId : null;
    assert(!!linkId, 'C: real invite redeemed (server link exists)');
    const ghost = await store.createInvite(e.id, 'buyer', 'Ghost Party');
    // The phantom: local holds the invite; the server has never seen it.
    server.invites.delete(ghost.id);

    const res = await store.cancelEscrow(e.id);
    assert(res.escrow.status === 'cancelled', 'C: cancel succeeds despite the phantom invite');
    const realRow = server.invites.get(real.id);
    assert(!!realRow?.revokedAt, 'C: the real invite is verified revoked server-side after');
    const link = server.links.get(linkId as string);
    assert(!!link?.revokedAt, 'C: the real invite\u2019s server link was converged (killed)');
    const escrowUpserts = server.upsertLog.filter((u) => u.table === 'escrows');
    const lastEscrowRows = escrowUpserts[escrowUpserts.length - 1]?.rows as Record<string, unknown>[];
    assert(lastEscrowRows?.[0]?.status === 'cancelled',
      'C: the escrow status upsert landed server-side');
  }

  // ===== Part D: pull failure aborts — nothing landed, escrow open =====
  {
    const { openDate, closeDate } = dates();
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '9 Abort Ave', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Test Buyer', openDate, closeDate,
    });
    await store.createInvite(e.id, 'buyer', 'Test Buyer');
    const landedBefore = server.upsertLog.length;
    server.failInvitesSelect = true;
    const err = await expectThrow(async () => {
      await store.cancelEscrow(e.id);
    });
    server.failInvitesSelect = false;
    assert(!!err, 'D: cancel fails loudly when the server invite pull fails');
    assert(server.upsertLog.length === landedBefore,
      'D: nothing landed server-side (no escrow upsert, no steps upsert)');
    const local = await store.getEscrow(e.id);
    assert(local?.status === 'open', 'D: the escrow is still open locally (honest error, retryable)');
  }

  // ===== Part E: close — identical construction, role-scoped ============
  {
    const { openDate, closeDate } = dates();
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '10 Scope St', city: 'Valencia, CA 91355', side: 'both',
      buyerName: 'Test Buyer', sellerName: 'Test Seller', openDate, closeDate,
    });
    const buyerReal = await store.createInvite(e.id, 'buyer', 'Test Buyer');
    const buyerGhost = await store.createInvite(e.id, 'buyer', 'Ghost Buyer');
    const sellerReal = await store.createInvite(e.id, 'seller', 'Test Seller');
    server.invites.delete(buyerGhost.id);
    // Close requires every buyer-side step done.
    const full = await store.getEscrow(e.id);
    for (const s of full!.buyerSteps) {
      if (!s.done) await store.toggleStep(e.id, 'buyer', s.id);
    }
    await store.closeEscrow(e.id, 'buyer');
    assert(!!server.invites.get(buyerReal.id)?.revokedAt, 'E: the real buyer invite is revoked at close');
    assert(server.invites.get(sellerReal.id)?.revokedAt == null,
      'E: the other side\u2019s invite is untouched (role scope from the server list)');
  }

  // ===== Part F: call-site discipline (source pins) ======================
  {
    const root = process.env.CTC_REPO_ROOT ?? path.join('..');
    const synced = fs.readFileSync(path.join(root, 'src', 'lib', 'syncedStore.ts'), 'utf8');
    const optIns = (synced.match(/tolerateInvisible: true/g) ?? []).length;
    assert(optIns >= 3, 'F: tolerance is opted into at exactly the cancel/close/revoke-first sites');
    const cloud = fs.readFileSync(path.join(root, 'src', 'lib', 'cloudSync.ts'), 'utf8');
    const drainStart = cloud.indexOf('export async function drainOutbox');
    const drainEnd = cloud.indexOf('\nexport ', drainStart + 10);
    const drainBody = cloud.slice(drainStart, drainEnd > drainStart ? drainEnd : undefined);
    assert(drainStart >= 0 && !drainBody.includes('tolerateInvisible'),
      'F: the outbox drain does NOT opt in (default stays throw)');
  }

  summary('phantom_revoke');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
