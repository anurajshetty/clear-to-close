// sync_chain_broad.test.ts — REGRESSION (Anuraj, Sept 2026).
//
// BUG: NOTHING the realtor updates reaches the client side — not the name,
// not the profile, not the escrow end date. The client page keeps showing
// old data even after refresh.
//
// Chain under test (RLS-faithful mock Supabase backend, no network):
//   realtor edit (name / close date) -> push upsert -> get_client_view ->
//   client getBuyerView -> rendered values.
//
// THE BREAK (proven by the mismatch scenario below): PostgREST upserts
// return SUCCESS with zero affected rows when an RLS owner-policy rejects
// the write — i.e. the target row's user_id differs from the session's
// auth.uid() (e.g. after an account switch, the device edits rows owned by
// the previous account). upsertAll treated "zero rows affected" as success:
// the push was dropped as converged (no outbox entry, no error), the
// server kept the old name / profile / close_date, get_client_view
// faithfully returned the old data, and the client faithfully rendered
// stale data forever — with no error anywhere.
//
// THE FIX: upsertAll verifies the affected row count via .select() and
// throws SyncNotAppliedError when the write silently did nothing, so the
// op stays queued (retryable) instead of being dropped as converged. A
// zero-affected upsert-by-id can only mean the row exists but is owned by
// someone else — the insert path would have succeeded otherwise — so the
// error names the ownership mismatch explicitly.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID_A = 'user-aaa';
const UID_B = 'user-bbb';
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// RLS-faithful mock backend.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Server {
  escrows: Map<string, Row>;
  profiles: Map<string, Row>; // keyed by user_id
  steps: Map<string, Row>;
  invites: Map<string, Row>;
  links: Map<string, Row>; // keyed by link id
  linkSeq: number;
}

/** The session uid this mock connection authenticates as (null = anon). */
interface MockOpts {
  sessionUid: string | null;
}

function makeServer(): Server {
  return { escrows: new Map(), profiles: new Map(), steps: new Map(), invites: new Map(), links: new Map(), linkSeq: 0 };
}

function escrowOwnedBy(server: Server, escrowId: string, uid: string | null): boolean {
  const e = server.escrows.get(String(escrowId));
  return !!e && String(e.user_id ?? '') === String(uid ?? '');
}

/** RLS USING check for an UPDATE of an existing row: silent 0-row no-op on mismatch. */
function ownsRow(server: Server, table: string, row: Row, uid: string | null): boolean {
  if (table === 'escrows' || table === 'realtor_profiles') {
    return String(row.user_id ?? '') === String(uid ?? '');
  }
  if (table === 'steps' || table === 'invites') {
    return escrowOwnedBy(server, String(row.escrow_id ?? ''), uid);
  }
  return true;
}

/** RLS WITH CHECK for an INSERT of a new row: hard error on mismatch. */
function canInsert(server: Server, table: string, row: Row, uid: string | null): boolean {
  return ownsRow(server, table, row, uid);
}

const TABLE_STORE: Record<string, keyof Server> = {
  escrows: 'escrows',
  realtor_profiles: 'profiles',
  steps: 'steps',
  invites: 'invites',
};

function mockCloud(server: Server, opts: MockOpts): any {
  // NOTE: opts.sessionUid is read LAZILY (per call) so tests can flip the
  // live session mid-test — modelling a session change (account switch /
  // expired session) that the store's boot-captured userId never saw.
  const sessionUid = () => opts.sessionUid;
  const uid = () => sessionUid();

  function upsert(table: string, rows: Row[], onConflict: string): { data: Row[] | null; error: any } {
    const storeKey = TABLE_STORE[table];
    const store = server[storeKey] as Map<string, Row>;
    const affected: Row[] = [];
    for (const row of rows) {
      const key = String(row[onConflict] ?? '');
      const existing = store.get(key);
      if (existing) {
        // UPDATE path: RLS USING failure = 0 rows affected, NO error
        // (this is the PostgREST behavior the bug hinges on).
        if (!ownsRow(server, table, existing, uid())) continue;
        store.set(key, { ...existing, ...row });
        affected.push({ [onConflict]: key });
      } else {
        // INSERT path: RLS WITH CHECK failure = hard error.
        if (!canInsert(server, table, row, uid())) {
          return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
        }
        store.set(key, { ...row });
        affected.push({ [onConflict]: key });
      }
    }
    return { data: affected, error: null };
  }

  function selectAll(table: string): Row[] {
    // RLS SELECT: only rows visible to this session.
    const all: Row[] = [];
    if (table === 'escrows') {
      for (const r of server.escrows.values()) if (String(r.user_id ?? '') === String(uid() ?? '')) all.push({ ...r });
    } else if (table === 'realtor_profiles') {
      // Ping probe selects with eq(user_id, uid()) — visibility = owner.
      for (const r of server.profiles.values()) if (String(r.user_id ?? '') === String(uid() ?? '')) all.push({ ...r });
    } else if (table === 'steps') {
      for (const r of server.steps.values()) if (escrowOwnedBy(server, String(r.escrow_id ?? ''), uid())) all.push({ ...r });
    } else if (table === 'invites') {
      for (const r of server.invites.values()) if (escrowOwnedBy(server, String(r.escrow_id ?? ''), uid())) all.push({ ...r });
    }
    return all;
  }

  function chainable(table: string, op: { kind: 'upsert'; rows: Row[]; onConflict: string } | { kind: 'select' }): any {
    const q: any = {
      _filters: [] as Array<[string, unknown]>,
      _in: [] as Array<[string, unknown[]]>,
      _limit: null as number | null,
      _selectCols: null as string | null,
      select(cols?: string) {
        q._selectCols = cols ?? '*';
        return q;
      },
      eq(col: string, val: unknown) {
        q._filters.push([col, val]);
        return q;
      },
      in(col: string, vals: unknown[]) {
        q._in.push([col, vals]);
        return q;
      },
      limit(n: number) {
        q._limit = n;
        return q;
      },
      then(resolve: (v: any) => void, reject: (e: any) => void) {
        try {
          resolve(q._run());
        } catch (e) {
          reject(e);
        }
      },
    };
    q._run = () => {
      if (op.kind === 'upsert') return upsert(table, op.rows, op.onConflict);
      let rows = selectAll(table);
      for (const [col, val] of q._filters) rows = rows.filter((r) => String(r[col] ?? '') === String(val ?? ''));
      for (const [col, vals] of q._in) {
        const set = new Set((vals as unknown[]).map((v) => String(v ?? '')));
        rows = rows.filter((r) => set.has(String(r[col] ?? '')));
      }
      if (q._limit != null) rows = rows.slice(0, q._limit);
      return { data: rows, error: null };
    };
    return q;
  }

  // get_client_view, faithful to supabase/migrations/0017 (explicit profile
  // field list; escrow via to_jsonb; profile joined by the ESCROW's user_id).
  function getClientView(p_link_id: string): { data: any; error: any } {
    const link = server.links.get(String(p_link_id));
    if (!link) return { data: { ok: false, error: 'invalid' }, error: null };
    if (link.revoked_at) return { data: { ok: false, error: 'revoked' }, error: null };
    const escrow = server.escrows.get(String(link.escrow_id ?? ''));
    if (!escrow) return { data: { ok: false, error: 'invalid' }, error: null };
    const realtorId = String(escrow.user_id ?? '');
    const p = server.profiles.get(realtorId);
    const profile = p
      ? {
          name: p.name ?? null,
          photo_url: p.photo_url ?? null,
          banner_image: p.banner_image ?? null,
          about: p.about ?? null,
          years_experience: p.years_experience ?? null,
          areas_served: p.areas_served ?? null,
          phone: p.phone ?? null,
          dre_license: p.dre_license ?? null,
          realty_group: p.realty_group ?? null,
          rating: p.rating ?? null,
          reviews: [],
        }
      : null;
    const role = String(link.role ?? 'buyer');
    const steps = [...server.steps.values()]
      .filter((s) => String(s.escrow_id ?? '') === String(escrow.id ?? '') && String(s.role ?? '') === role)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
    const payload: Record<string, unknown> = {
      ok: true,
      role,
      escrow: { ...escrow, status: escrow.status ?? 'open' },
      profile,
      my_review_id: null,
    };
    payload[role === 'seller' ? 'seller_steps' : 'buyer_steps'] = steps;
    return { data: payload, error: null };
  }

  function redeemInvite(p_code: string, p_name: string, p_device_id: string | null): { data: any; error: any } {
    const code = String(p_code ?? '').toUpperCase().trim();
    const invite = [...server.invites.values()].find((r) => String(r.code ?? '').toUpperCase() === code);
    if (!invite) return { data: { ok: false, error: 'invalid' }, error: null };
    if (invite.revoked_at) return { data: { ok: false, error: 'revoked' }, error: null };
    if (invite.redeemed_at) return { data: { ok: false, error: 'already_used' }, error: null };
    if (String(invite.party_name ?? '').toLowerCase().trim() !== String(p_name ?? '').toLowerCase().trim()) {
      return { data: { ok: false, error: 'name_mismatch' }, error: null };
    }
    invite.redeemed_at = new Date().toISOString();
    server.linkSeq += 1;
    const linkId = `link-${server.linkSeq}`;
    server.links.set(linkId, {
      id: linkId,
      escrow_id: invite.escrow_id,
      invite_id: invite.id,
      role: invite.role,
      party_name: invite.party_name,
      device_id: p_device_id,
      revoked_at: null,
    });
    return {
      data: {
        ok: true,
        escrow_id: invite.escrow_id,
        role: invite.role,
        party_name: invite.party_name,
        link_id: linkId,
      },
      error: null,
    };
  }

  return {
    auth: {
      getSession: async () => ({
        data: { session: uid() ? { user: { id: uid() } } : null },
        error: null,
      }),
    },
    from: (table: string) => ({
      select: (cols?: string) => chainable(table, { kind: 'select' }).select(cols),
      upsert: (rows: Row[] | Row, opts?: { onConflict?: string }) =>
        chainable(table, {
          kind: 'upsert',
          rows: Array.isArray(rows) ? rows : [rows],
          onConflict: opts?.onConflict ?? 'id',
        }),
      update: (payload: Row) => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === 'get_client_view') return getClientView(String(params.p_link_id ?? ''));
      if (name === 'redeem_invite')
        return redeemInvite(String(params.p_code ?? ''), String(params.p_name ?? ''), (params.p_device_id as string) ?? null);
      return { data: null, error: new Error(`unknown rpc ${name}`) };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario helpers.
// ---------------------------------------------------------------------------

function profileNamed(name: string): any {
  return {
    name,
    photoUri: null,
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    about: 'About',
    yearsExperience: '5',
    email: '',
    areasServed: 'Valencia',
    phone: '',
    dreLicense: '',
    realty_group: '',
    banner_image: null,
    reviews: [],
    rating: null,
  };
}

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 60);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

function bumped(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

async function readOutboxOps(kv: { getItem(k: string): Promise<string | null> }): Promise<any[]> {
  const raw = await kv.getItem('ctc:outbox');
  try {
    const ops = raw ? JSON.parse(raw) : [];
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 (baseline): aligned identity — the full chain converges.
// Realtor changes name + escrow end date; client refreshes; client receives
// both new values.
// ---------------------------------------------------------------------------

async function scenarioAligned(): Promise<void> {
  const server = makeServer();
  const session = { sessionUid: UID_A as string | null };
  const kvR = memoryKV();
  const realtor = createSyncedStore(kvR, { cloudClient: () => mockCloud(server, session) });
  await realtor.initCloudSync();

  const { openDate, closeDate } = dates();
  const escrowInput = {
    address: '10 Sync Way',
    city: 'Valencia, CA 91355',
    side: 'buy' as const,
    buyerName: 'Sam Buyer',
    openDate,
    closeDate,
  };
  const esc = await realtor.store.createEscrow(escrowInput);
  await tick(150);

  const invite = await realtor.store.createInvite(esc.id, 'buyer', 'Sam Buyer');
  await tick(150);

  await realtor.store.saveProfile(profileNamed('Anuraj'));
  await tick(250);

  const newClose = bumped(closeDate, 14);
  await realtor.store.updateEscrow(esc.id, { ...escrowInput, closeDate: newClose });
  await tick(150);

  // Server converged on both edits.
  assert(String(server.escrows.get(esc.id)?.close_date) === newClose, 'server escrow has the new close date');
  assert(String(server.profiles.get(UID_A)?.name) === 'Anuraj', 'server profile has the new name');

  // Client device (anon): redeem, then refresh the view.
  const kvC = memoryKV();
  const client = createSyncedStore(kvC, { cloudClient: () => mockCloud(server, { sessionUid: null }) });
  const redeem = await client.store.redeemInvite(invite.code, 'Sam Buyer');
  assert(redeem.ok === true, 'client redeem succeeds');
  const view = await client.store.getBuyerView(esc.id);
  assert(view.closeDate === newClose, `client sees the new close date (got ${view.closeDate})`);
  const profile = await client.store.getLinkedProfile(esc.id);
  assert(profile?.name === 'Anuraj', `client sees the new realtor name (got ${profile?.name})`);
}

// ---------------------------------------------------------------------------
// Scenario 2 (the bug): the live session diverges from the identity the
// store captured at boot (account switch / second tab / silently refreshed
// session — no fresh initCloudSync). Every push still stamps the captured
// UID while auth.uid() is someone else, so RLS owner-policies reject every
// write with a SUCCESS + zero affected rows.
//
// Pre-fix: the pushes are dropped as "converged" — no error, no outbox
// entry — the server keeps the old name / close date forever, and the
// client renders stale data after every refresh.
//
// Post-fix: upsertAll throws SyncNotAppliedError on the zero-row no-op, so
// the ops stay queued (never silently dropped); when the owning identity
// returns, the next drain converges them and the client sees the new
// values. That self-heal is the only physically possible resolution — RLS
// forbids anyone else from writing those rows.
// ---------------------------------------------------------------------------

async function scenarioMismatch(): Promise<void> {
  const server = makeServer();
  const session = { sessionUid: UID_A as string | null };
  const kvR = memoryKV();
  const realtor = createSyncedStore(kvR, { cloudClient: () => mockCloud(server, session) });
  await realtor.initCloudSync();

  const { openDate, closeDate } = dates();
  const escrowInput = {
    address: '20 Mismatch Ln',
    city: 'Valencia, CA 91355',
    side: 'buy' as const,
    buyerName: 'Sam Buyer',
    openDate,
    closeDate,
  };
  const esc = await realtor.store.createEscrow(escrowInput);
  await tick(150);
  const invite = await realtor.store.createInvite(esc.id, 'buyer', 'Sam Buyer');
  await tick(150);
  await realtor.store.saveProfile(profileNamed('Anuraj'));
  await tick(250);
  assert(String(server.escrows.get(esc.id)?.close_date) === closeDate, 'setup: server has the original close date');
  assert(String(server.profiles.get(UID_A)?.name) === 'Anuraj', 'setup: server has the original name');

  // The live session changes to account B. The store's boot-captured userId
  // is still A (no fresh initCloudSync — e.g. a second tab signed in as B).
  session.sessionUid = UID_B;

  const newClose = bumped(closeDate, 21);
  await realtor.store.updateEscrow(esc.id, { ...escrowInput, closeDate: newClose });
  await realtor.store.saveProfile(profileNamed('Rita Realtor'));
  await tick(300);

  // The failure must be RETAINED, never silently dropped as converged.
  const ops = await readOutboxOps(kvR);
  const hasEscrowOp = ops.some((o) => o.op === 'pushEscrow' && o.escrowId === esc.id);
  const hasProfileOp = ops.some((o) => o.op === 'pushProfile');
  assert(
    hasEscrowOp && hasProfileOp,
    `ownership-mismatched pushes stay queued for retry (outbox=${JSON.stringify(ops.map((o) => o.op))})`,
  );

  // No partial/corrupt writes: the server still has the old data.
  assert(
    String(server.escrows.get(esc.id)?.close_date) === closeDate,
    'server escrow untouched by the mismatched push',
  );
  assert(String(server.profiles.get(UID_A)?.name) === 'Anuraj', 'server profile untouched by the mismatched push');

  // Self-heal: the owning identity returns; the next init drains the queue
  // and the server converges on the realtor's actual edits.
  session.sessionUid = UID_A;
  await realtor.initCloudSync();
  await tick(300);
  assert(
    String(server.escrows.get(esc.id)?.close_date) === newClose,
    `server escrow converged after the owning identity returned (got ${server.escrows.get(esc.id)?.close_date})`,
  );
  assert(
    String(server.profiles.get(UID_A)?.name) === 'Rita Realtor',
    `server profile converged after the owning identity returned (got ${server.profiles.get(UID_A)?.name})`,
  );

  // Client refresh now receives both new values.
  const kvC = memoryKV();
  const client = createSyncedStore(kvC, { cloudClient: () => mockCloud(server, { sessionUid: null }) });
  const redeem = await client.store.redeemInvite(invite.code, 'Sam Buyer');
  assert(redeem.ok === true, 'client redeem succeeds');
  const view = await client.store.getBuyerView(esc.id);
  assert(view.closeDate === newClose, `client sees the new close date (got ${view.closeDate})`);
  const profile = await client.store.getLinkedProfile(esc.id);
  assert(profile?.name === 'Rita Realtor', `client sees the new realtor name (got ${profile?.name})`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await scenarioAligned();
  await scenarioMismatch();
  summary('sync_chain_broad');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
