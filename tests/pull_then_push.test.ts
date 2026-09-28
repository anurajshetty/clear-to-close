// pull_then_push.test.ts — Sept 2026, server-is-truth architecture (Anuraj).
//
// Architectural correction: the app must NEVER push saved local data on
// boot/foreground. The old "push everything to converge" background
// reconcile is DELETED as a pattern. PUSH happens only as the direct result
// of an explicit user action (tap Save -> write to server -> wait for
// confirmation -> show error if it fails). Everything else is PULL: boot,
// refresh, and foreground return read fresh server state into the app.
//
// Required behavior:
//   1. Stale local + fresh server -> server wins, ALWAYS, with no push.
//   2. Boot issues ZERO write calls (no upserts, no deletes) while pulling
//      fresh state.
//   3. User-action pushes still work (Save -> server write -> op dequeued).
//   4. Conflict care: a user Save that lands while a pull is in flight still
//      pushes (user intent wins); the pull must not clobber the in-flight
//      save's result.
//   5. A failed save stays queued; a pull must not clobber the unconfirmed
//      local edit; the retry pushes the USER's values, not stale ones.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { readOutboxOps } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-123';
const STALE_NAME = 'Jimmy';
const FRESH_NAME = 'jimmy ola';

interface Backend {
  netUp: boolean;
  failUpsert: boolean;
  writes: string[];
  upsertPayloads: { table: string; rows: Record<string, unknown>[] }[];
  profileRow: Record<string, unknown> | null;
  escrowRows: Record<string, unknown>[];
  stepRows: Record<string, unknown>[];
  inviteRows: Record<string, unknown>[];
  /** When set, the next upsert's response waits for release(). */
  gateUpsert: boolean;
  releaseUpsert: () => void;
  upsertStarted: () => void;
}

function makeBackend(): Backend {
  const be: Backend = {
    netUp: true,
    failUpsert: false,
    writes: [],
    upsertPayloads: [],
    profileRow: null,
    escrowRows: [],
    stepRows: [],
    inviteRows: [],
    gateUpsert: false,
    releaseUpsert: () => {},
    upsertStarted: () => {},
  };
  return be;
}

function profileServerRow(name: string): Record<string, unknown> {
  return {
    user_id: UID,
    name,
    email: 'realtor@example.com',
    photo_url: null,
    banner_image: null,
    about: '',
    years_experience: '',
    areas_served: '',
    phone: '',
    dre_license: '',
    realty_group: '',
  };
}

function escrowServerRow(id: string, address: string): Record<string, unknown> {
  return {
    id,
    user_id: UID,
    address,
    city: 'Santa Clarita',
    side: 'buy',
    buyer_name: 'Buyer',
    seller_name: null,
    open_date: '2026-09-01',
    close_date: '2026-10-15',
    status: 'open',
    created_at: '2026-09-01T00:00:00.000Z',
  };
}

function mockCloud(be: Backend) {
  const tableRows = (name: string): Record<string, unknown>[] => {
    if (name === 'realtor_profiles') return be.profileRow ? [be.profileRow] : [];
    if (name === 'escrows') return be.escrowRows;
    if (name === 'steps') return be.stepRows;
    if (name === 'invites') return be.inviteRows;
    return [];
  };
  const table = (name: string) => {
    const rows = tableRows(name);
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
      upsert(upRows: Record<string, unknown>[], _opts?: unknown) {
        be.writes.push(`upsert:${name}`);
        be.upsertPayloads.push({ table: name, rows: upRows });
        return {
          select: async (_col?: string) => {
            be.upsertStarted();
            if (be.gateUpsert) {
              await new Promise<void>((resolve) => {
                be.releaseUpsert = resolve;
              });
            }
            if (be.failUpsert) return { data: null, error: new Error('boom') };
            return { data: upRows, error: null };
          },
        };
      },
      then(
        resolve: (v: unknown) => void,
        reject: (e: unknown) => void,
      ) {
        try {
          if (!be.netUp) throw new Error('offline');
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

function seedLocalProfile(kv: ReturnType<typeof memoryKV>, name: string): void {
  void kv.setItem('ctc:profile', JSON.stringify({ name, email: 'local@example.com' }));
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await tick();
  }
}

async function main(): Promise<void> {
  // 1. Boot issues ZERO writes while pulling fresh state — the regression
  // that motivated this architecture: a stale local "Jimmy" was pushed
  // over the server's "jimmy ola" by the old boot push-reconcile.
  {
    const be = makeBackend();
    be.profileRow = profileServerRow(FRESH_NAME);
    be.escrowRows = [escrowServerRow('esc-1', '123 Main St')];
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME);
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    // The real boot sequence (app/_layout.tsx): profile + escrow pulls are
    // awaited, then initCloudSync runs. All of it must be pull-only.
    await store.pullProfileFromCloud();
    await store.pullEscrowsFromCloud();
    await initCloudSync();
    // Give any stray fire-and-forget push a chance to run: zero must stay zero.
    await tick(150);
    assert(
      be.writes.length === 0,
      `boot issues zero write calls (got [${be.writes.join(', ')}])`,
    );
    const local = await store.getProfile();
    assert(
      local !== null && local.name === FRESH_NAME,
      `stale local converges to the server row on boot (got ${local?.name})`,
    );
    const escrows = await store.listEscrows();
    assert(
      escrows.some((e) => e.id === 'esc-1' && e.address === '123 Main St'),
      'boot pulls the server escrow list with no push involved',
    );
  }

  // 2. No-push boot even when the local snapshot is dirty-clean and the
  // server row is missing fields the local has (no "converge by pushing").
  {
    const be = makeBackend();
    be.profileRow = profileServerRow(FRESH_NAME);
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME);
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    await store.pullProfileFromCloud();
    await tick(100);
    assert(
      be.writes.length === 0,
      `boot profile pull never pushes (got [${be.writes.join(', ')}])`,
    );
  }

  // 3. User-action pushes still work: Save -> server write -> op dequeued.
  {
    const be = makeBackend();
    be.profileRow = profileServerRow(FRESH_NAME);
    const kv = memoryKV();
    seedLocalProfile(kv, FRESH_NAME);
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    await initCloudSync();
    await store.saveProfile({ name: 'Explicit Save', email: 's@example.com' } as never);
    await waitFor(
      () => be.upsertPayloads.some((p) => p.table === 'realtor_profiles'),
      'profile upsert from explicit Save',
    );
    const payload = be.upsertPayloads.find((p) => p.table === 'realtor_profiles');
    assert(
      payload !== undefined && payload.rows[0]['name'] === 'Explicit Save',
      'explicit Save pushes the new values to the server',
    );
    await waitFor(async () => (await readOutboxOps(kv)).length === 0, 'op dequeued');
    assert(true, 'successful push dequeues its outbox op');
  }

  // 4. Conflict care: the user taps Save while a pull is in flight. The
  // explicit push still goes through (user intent wins) and the pull must
  // not clobber the in-flight save's result.
  {
    const be = makeBackend();
    be.profileRow = profileServerRow('Server Old');
    let upsertBegun = false;
    be.upsertStarted = () => {
      upsertBegun = true;
    };
    be.gateUpsert = true; // hold the push mid-flight
    const kv = memoryKV();
    seedLocalProfile(kv, 'Local Before');
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    await initCloudSync();
    // Fire the save; its push hangs at the upsert.
    void store.saveProfile({ name: 'User Edit', email: 'u@example.com' } as never);
    await waitFor(() => upsertBegun, 'push in flight');
    // While the push is in flight, a pull runs (e.g. foreground return).
    await store.refreshProfile();
    const during = await store.getProfile();
    assert(
      during !== null && during.name === 'User Edit',
      `in-flight save is not clobbered by a concurrent pull (got ${during?.name})`,
    );
    // Let the push land: the server gets the user's values...
    be.releaseUpsert();
    await waitFor(async () => (await readOutboxOps(kv)).length === 0, 'op dequeued');
    const payload = be.upsertPayloads.find((p) => p.table === 'realtor_profiles');
    assert(
      payload !== undefined && payload.rows[0]['name'] === 'User Edit',
      'in-flight save still pushes (user intent wins)',
    );
    // ...and the local snapshot keeps the confirmed values.
    const after = await store.getProfile();
    assert(
      after !== null && after.name === 'User Edit',
      `save confirmation is the last word locally (got ${after?.name})`,
    );
  }

  // 5. A failed save stays queued; a pull must not clobber the unconfirmed
  // local edit; the retry pushes the USER's values, not stale ones.
  {
    const be = makeBackend();
    be.profileRow = profileServerRow('Server Old');
    be.failUpsert = true;
    const kv = memoryKV();
    seedLocalProfile(kv, 'Local Before');
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    await initCloudSync();
    await store.saveProfile({ name: 'User Edit', email: 'u@example.com' } as never);
    await waitFor(async () => (await readOutboxOps(kv)).length > 0, 'failed push queued');
    // A pull while the edit is unconfirmed must not wipe it.
    await store.refreshProfile();
    const kept = await store.getProfile();
    assert(
      kept !== null && kept.name === 'User Edit',
      `pull does not clobber the unconfirmed local edit (got ${kept?.name})`,
    );
    // Retry (the boot drain path) pushes the user's values.
    be.failUpsert = false;
    const writesBefore = be.upsertPayloads.length;
    await store.retrySync();
    await waitFor(
      async () => (await readOutboxOps(kv)).length === 0,
      'retry drains the queued op',
    );
    const retryPayload = be.upsertPayloads
      .slice(writesBefore)
      .find((p) => p.table === 'realtor_profiles');
    assert(
      retryPayload !== undefined && retryPayload.rows[0]['name'] === 'User Edit',
      'retry pushes the user-confirmed values, not stale server data',
    );
  }

  summary('pull_then_push');
}

void main();
