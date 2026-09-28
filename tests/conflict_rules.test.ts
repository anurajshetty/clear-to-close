// conflict_rules.test.ts — Sept 2026, ARCHITECTURE.md principle 5.
//
// Explicit, documented conflict rules (see docs/CONFLICT_RULES.md), one
// test per rule. Two store instances ("devices" A and B, separate KVs)
// share one stateful mock server, so genuine two-writer divergences can
// be scripted:
//
//   1. Profile: last committed push wins; the server row is the truth.
//   2. Escrows: last committed push wins for the whole escrow unit.
//   3. Steps: step state follows the escrow unit's last committed push
//      (a stale device's unit push can revert a newer check-off —
//      documented sharp edge).
//   4. Invites: terminal states (redeemed/revoked) are write-once and
//      monotonic — a stale server read never clears them.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readConflictLog } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-123';

interface Backend {
  profileRows: Record<string, unknown>[];
  escrowRows: Record<string, unknown>[];
  stepRows: Record<string, unknown>[];
  inviteRows: Record<string, unknown>[];
  writes: string[];
}

function makeBackend(): Backend {
  return { profileRows: [], escrowRows: [], stepRows: [], inviteRows: [], writes: [] };
}

/** Stateful mock Supabase client: upserts persist, selects read them back. */
function mockCloud(be: Backend) {
  const store = (name: string): Record<string, unknown>[] => {
    if (name === 'realtor_profiles') return be.profileRows;
    if (name === 'escrows') return be.escrowRows;
    if (name === 'steps') return be.stepRows;
    if (name === 'invites') return be.inviteRows;
    return [];
  };
  const table = (name: string) => {
    const rows = store(name);
    const qb: Record<string, unknown> = {
      _filters: [] as Array<(r: Record<string, unknown>) => boolean>,
      select(_cols?: string) {
        return qb;
      },
      eq(col: string, val: unknown) {
        (qb._filters as Array<(r: Record<string, unknown>) => boolean>).push(
          (r) => r[col] === val,
        );
        return qb;
      },
      in(col: string, vals: unknown[]) {
        (qb._filters as Array<(r: Record<string, unknown>) => boolean>).push((r) =>
          vals.includes(r[col]),
        );
        return qb;
      },
      limit(_n: number) {
        return qb;
      },
      upsert(upRows: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
        const ck = opts?.onConflict ?? 'id';
        // supabase-js accepts a single object or an array.
        const list = Array.isArray(upRows) ? upRows : [upRows];
        be.writes.push(`upsert:${name}:${ck}`);
        for (const r of list) {
          const idx = rows.findIndex((x) => String(x[ck]) === String(r[ck]));
          if (idx >= 0) rows[idx] = { ...rows[idx], ...r };
          else rows.push({ ...r });
        }
        return {
          select: async (_col?: string) => ({ data: list, error: null }),
        };
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          const filters = qb._filters as Array<(r: Record<string, unknown>) => boolean>;
          const data = rows.filter((r) => filters.every((f) => f(r)));
          resolve({ data, error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return qb;
  };
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: UID } } }, error: null }),
    },
    from: (t: string) => table(t),
  };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await tick();
  }
}

async function makeDevice(be: Backend) {
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: () => mockCloud(be),
  });
  await initCloudSync();
  return { kv, store, initCloudSync };
}

const escrowInput = (address: string) => ({
  address,
  city: 'Santa Clarita',
  side: 'buy' as const,
  openDate: '2026-09-01',
  closeDate: '2026-10-15',
});

async function main(): Promise<void> {
  // 1. Profile: last committed push wins; the server row is the truth.
  {
    const be = makeBackend();
    const A = await makeDevice(be);
    const B = await makeDevice(be);
    await A.store.saveProfile({ name: 'Device A', email: 'a@x.com' } as never);
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:realtor_profiles')).length >= 1,
      'A profile push',
    );
    await B.store.saveProfile({ name: 'Device B', email: 'b@x.com' } as never);
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:realtor_profiles')).length >= 2,
      'B profile push',
    );
    assert(
      be.profileRows[0]['name'] === 'Device B',
      `last committed push wins on the server (got ${be.profileRows[0]['name']})`,
    );
    await A.store.pullProfileFromCloud();
    const aLocal = await A.store.getProfile();
    assert(
      aLocal !== null && aLocal.name === 'Device B',
      `device A converges to the later write (got ${aLocal?.name})`,
    );
    const log = await readConflictLog(A.kv);
    assert(
      log.some((e) => e.entity === 'profile' && e.resolution === 'server-wins'),
      'profile conflict resolution is logged for audit',
    );
  }

  // 2. Escrows: last committed push wins for the whole escrow unit.
  {
    const be = makeBackend();
    const A = await makeDevice(be);
    const B = await makeDevice(be);
    const created = await A.store.createEscrow(escrowInput('1 A St'));
    const id = created.id;
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:escrows')).length >= 1,
      'A escrow push',
    );
    await B.initCloudSync(); // B pulls the escrow at '1 A St'
    await A.store.updateEscrow(id, escrowInput('2 A St'));
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:escrows')).length >= 2,
      'A address edit push',
    );
    // B's snapshot still says '1 A St' — its push is based on stale state.
    await B.store.updateEscrow(id, escrowInput('3 B St'));
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:escrows')).length >= 3,
      'B address edit push',
    );
    const serverRow = be.escrowRows.find((r) => r['id'] === id);
    assert(
      serverRow !== undefined && serverRow['address'] === '3 B St',
      `last committed unit push wins on the server (got ${serverRow?.['address']})`,
    );
    await A.store.pullEscrowsFromCloud();
    const aLocal = await A.store.getEscrow(id);
    assert(
      aLocal !== null && aLocal.address === '3 B St',
      `device A converges to the last write (got ${aLocal?.address})`,
    );
    const log = await readConflictLog(A.kv);
    assert(
      log.some((e) => e.entity === 'escrow' && e.id === id && e.resolution === 'server-wins'),
      'escrow conflict resolution is logged for audit',
    );
  }

  // 3. Steps follow the escrow unit's last committed push — including the
  // documented sharp edge: B's stale unit push reverts A's newer check-off.
  {
    const be = makeBackend();
    const A = await makeDevice(be);
    const B = await makeDevice(be);
    const created = await A.store.createEscrow(escrowInput('9 Test Way'));
    const id = created.id;
    const step1 = created.buyerSteps[0].id;
    const step2 = created.buyerSteps[1].id;
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:escrows')).length >= 1,
      'A escrow push',
    );
    await B.initCloudSync(); // B's steps are all unchecked
    await A.store.toggleStep(id, 'buyer', step1); // A checks step 1
    await waitFor(
      () => be.stepRows.find((r) => r['id'] === step1)?.['done'] === true,
      'server step 1 checked',
    );
    // B never saw the check-off; its unit still has step 1 unchecked.
    await B.store.toggleStep(id, 'buyer', step2); // B checks step 2
    await waitFor(
      () => be.stepRows.find((r) => r['id'] === step2)?.['done'] === true,
      'server step 2 checked',
    );
    const s1 = be.stepRows.find((r) => r['id'] === step1)?.['done'];
    assert(
      s1 === false,
      `stale unit push reverted the newer check-off on the server (step1 done=${s1})`,
    );
    await A.store.pullEscrowsFromCloud();
    const aLocal = await A.store.getEscrow(id);
    const aStep1 = aLocal?.buyerSteps.find((s) => s.id === step1)?.done;
    assert(
      aStep1 === false,
      `device A converges to the unit state (step1 done=${aStep1})`,
    );
  }

  // 4. Invites: terminal states are write-once — a stale server read never
  // clears redeemed_at / revoked_at.
  {
    const be = makeBackend();
    const A = await makeDevice(be);
    const esc = await A.store.createEscrow(escrowInput('4 Invite Ln'));
    await waitFor(
      () => be.writes.filter((w) => w.startsWith('upsert:escrows')).length >= 1,
      'A escrow push',
    );
    const inv = await A.store.createInvite(esc.id, 'buyer', 'Client One');
    await waitFor(
      () => be.writes.some((w) => w.startsWith('upsert:invites')),
      'invite pushed',
    );
    // Server-side revoke (another device / dashboard).
    const serverInvite = be.inviteRows.find((r) => r['id'] === inv.id);
    assert(serverInvite !== undefined, 'invite row exists on the server');
    serverInvite!['revoked_at'] = '2026-09-27T12:00:00.000Z';
    await A.initCloudSync(); // invite hydration pulls + merges
    let local = (await A.store.listInvites(esc.id)).find((i) => i.id === inv.id);
    assert(
      local !== undefined && local.revokedAt === '2026-09-27T12:00:00.000Z',
      'server revoke merges into the local invite',
    );
    // A stale server read without revoked_at must NOT clear it.
    serverInvite!['revoked_at'] = null;
    await A.initCloudSync();
    local = (await A.store.listInvites(esc.id)).find((i) => i.id === inv.id);
    assert(
      local !== undefined && local.revokedAt === '2026-09-27T12:00:00.000Z',
      'stale server read never clears a terminal timestamp',
    );
  }

  summary('conflict_rules');
}

void main();
