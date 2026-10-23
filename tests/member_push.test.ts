// member_push.test.ts — the Defect 1 regression (Oct 23, 2026): a
// Team Access member's escrow push must never upsert the escrow row.
// Live replays proved the upsert is owner-only by construction
// (guard trigger with the member's uid stamped; RLS INSERT check
// with the owner's). pushEscrowForRole routes members to a targeted
// UPDATE whose body carries no ownership or lifecycle fields, while
// the owner path is byte-for-byte the old upsert.
import { assert, summary } from './assert';
import {
  pushEscrowForRole,
  SyncNotAppliedError,
} from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const SESSION_UID = '11111111-1111-4111-8111-111111111111';
const OWNER_UID = '99999999-9999-4999-8999-999999999999';

interface Captured {
  table: string;
  method: string;
  body: unknown;
}

// Capturing mock of the supabase client: records every write's table,
// method and body; reads resolve from a per-table script.
function makeClient(script: Record<string, { data?: unknown; error?: unknown }[]>) {
  const writes: Captured[] = [];
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`mock: no script for "${key}"`);
    const r = q.shift()!;
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const builder = (table: string): unknown => ({
    select: () => builder(table),
    eq: () => builder(table),
    limit: () => builder(table),
    upsert: (body: unknown) => {
      writes.push({ table, method: 'upsert', body });
      return builder(table);
    },
    update: (body: unknown) => {
      writes.push({ table, method: 'update', body });
      return builder(table);
    },
    then: (res: (v: unknown) => void) => {
      res(next(`from:${table}`));
    },
  });
  return {
    writes,
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: null, error: null }) },
  };
}

function escrowFixture(accessRole?: 'associate' | 'tc') {
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
      {
        id: 's1', title: 'Escrow open', subtitle: '', done: true, custom: false,
        order: 0, completedAt: '2026-09-25T10:00:00Z', completedBy: OWNER_UID, createdBy: null,
      },
      {
        id: 's2', title: 'Earnest money', subtitle: '', done: true, custom: true,
        order: 1, completedAt: '2026-09-26T10:00:00Z', completedBy: SESSION_UID, createdBy: SESSION_UID,
      },
    ],
    sellerSteps: [],
    status: 'open' as const,
    buyerClosedAt: null,
    sellerClosedAt: null,
    createdAt: '2026-09-25T09:00:00Z',
    ...(accessRole ? { accessRole } : {}),
  };
}

async function main(): Promise<void> {
  const okScript = () => ({
    'from:escrows': [{ data: [{ id: '22222222-2222-4222-8222-222222222222' }] }],
    'from:steps': [{ data: [{ id: 's1' }, { id: 's2' }] }],
  });

  // --- owner path unchanged: whole-row upsert stamped with the uid ---
  {
    const c = makeClient(okScript());
    await pushEscrowForRole(c as never, SESSION_UID, escrowFixture() as never);
    const escrowWrite = c.writes.find((w) => w.table === 'escrows');
    assert(!!escrowWrite && escrowWrite.method === 'upsert', 'owner push upserts the escrow row');
    const rows = escrowWrite!.body as Record<string, unknown>[];
    assert(rows[0].user_id === SESSION_UID, 'owner upsert stamps the session uid as user_id');
    assert(rows[0].status === 'open', 'owner upsert carries lifecycle fields');
  }

  // --- member path: targeted UPDATE, no ownership/lifecycle fields ---
  for (const role of ['associate', 'tc'] as const) {
    const c = makeClient(okScript());
    await pushEscrowForRole(c as never, SESSION_UID, escrowFixture(role) as never);
    const escrowWrite = c.writes.find((w) => w.table === 'escrows');
    assert(!!escrowWrite && escrowWrite.method === 'update', `${role} push PATCHes the escrow row (no upsert)`);
    const fields = escrowWrite!.body as Record<string, unknown>;
    assert(!('user_id' in fields), `${role} PATCH body carries no user_id`);
    assert(!('status' in fields), `${role} PATCH body carries no status`);
    assert(!('buyer_closed_at' in fields) && !('seller_closed_at' in fields), `${role} PATCH body carries no close stamps`);
    assert(!('created_at' in fields) && !('id' in fields), `${role} PATCH body carries no id/created_at`);
    assert(fields.close_date === '2026-11-25', `${role} PATCH body carries the content fields`);
    const stepsWrite = c.writes.find((w) => w.table === 'steps');
    assert(!!stepsWrite && stepsWrite.method === 'upsert', `${role} push still upserts the steps`);
    const stepRows = stepsWrite!.body as Record<string, unknown>[];
    const owners = stepRows.find((r) => r.id === 's1');
    assert(!!owners && owners.completed_by === OWNER_UID, `${role} steps upsert re-sends the owner's stamp unchanged (0046 allows it)`);
  }

  // --- member PATCH that touches no row fails loudly ---
  {
    const c = makeClient({
      'from:escrows': [{ data: [] }],
      'from:steps': [{ data: [{ id: 's1' }] }],
    });
    let threw: unknown = null;
    try {
      await pushEscrowForRole(c as never, SESSION_UID, escrowFixture('associate') as never);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof SyncNotAppliedError, 'zero-row member PATCH throws SyncNotAppliedError');
  }

  summary('member_push.test');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
