// invite_sync.test.ts — regression coverage for the web invite-sync bug
// (Sept 2026): invites created in the web UI must reach Supabase and
// survive a logout/login round-trip, and redeem must work cross-device.
//
// Covers:
//  1. create on device A -> invite is pushed to the cloud (not local-only).
//  2. Logout/login (fresh store, same KV, empty local): server-side invites
//     are hydrated into the local store (mergeInvites), so the client list
//     doesn't show "invite client" as if never created.
//  3. Cross-device redeem: device B (different KV) redeems device A's code
//     via the cloud RPC.
//  4. pushInviteNow is idempotent: re-pushing an already-synced invite does
//     not regenerate the code or throw (upsert on id).
//  5. Resolve heals a local-only invite: if the cloud says 'invalid' but
//     the invite exists locally, it is pushed and the resolve retried.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { pullFullInvitesNow, pushInviteNow } from '../src/lib/cloudSync';
import type { Invite } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// In-memory fake Supabase: tables + RPCs, shared across "devices".
function fakeCloud() {
  const invites = new Map<string, Record<string, unknown>>();
  const escrows = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'realtor-uid' } } },
        error: null,
      }),
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        calls.push(`insert ${table} ${row.code ?? ''}`);
        if (table === 'invites') {
          if ([...invites.values()].some((r) => r.code === row.code && r.id !== row.id)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "invites_code_key"' } };
          }
          if (invites.has(row.id as string)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "invites_pkey"' } };
          }
          invites.set(row.id as string, { ...row });
        }
        if (table === 'escrows') {
          escrows.set(row.id as string, { ...row });
        }
        return { error: null };
      },
      upsert: async (row: Record<string, unknown>, _opts?: unknown) => {
        calls.push(`upsert ${table} ${row.code ?? ''}`);
        if (table === 'invites') {
          if ([...invites.values()].some((r) => r.code === row.code && r.id !== row.id)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "invites_code_key"' } };
          }
          invites.set(row.id as string, { ...row });
        }
        if (table === 'escrows') {
          escrows.set(row.id as string, { ...row });
        }
        return { error: null };
      },
      update: async (_patch: unknown) => ({ error: null }),
      select: (_cols?: string) => {
        const eq = (col: string, val: unknown) => {
          let rows: Record<string, unknown>[] = [];
          if (table === 'invites' && col === 'escrow_id') {
            rows = [...invites.values()].filter((r) => r.escrow_id === val);
          }
          const p = Promise.resolve({ data: rows, error: null });
          return Object.assign(p, {
            limit: (_n: number) => Promise.resolve({ data: rows, error: null }),
          });
        };
        const base = { eq };
        // Bare select('*') (used by pullEscrowsNow) must be thenable.
        if (_cols === '*') {
          const rows = table === 'escrows' ? [...escrows.values()] : table === 'steps' ? [] : [];
          const p = Promise.resolve({ data: rows, error: null }) as Promise<{ data: unknown[]; error: null }> & {
            in?: (col: string, vals: unknown[]) => Promise<{ data: unknown[]; error: null }>;
          };
          p.in = async () => ({ data: [], error: null });
          return Object.assign(p, base);
        }
        return base;
      },
    }),
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === 'redeem_invite') {
        const code = String(params.p_code ?? '').toUpperCase();
        const row = [...invites.values()].find((r) => r.code === code);
        if (!row) return { data: { ok: false, error: 'invalid' }, error: null };
        return {
          data: { ok: true, escrow_id: row.escrow_id, role: row.role, party_name: row.party_name, link_id: 'link-1' },
          error: null,
        };
      }
      if (name === 'resolve_invite_realtor') {
        const code = String(params.p_code ?? '').toUpperCase();
        const row = [...invites.values()].find((r) => r.code === code);
        if (!row) return { data: { ok: false, error: 'invalid' }, error: null };
        return {
          data: { ok: true, realtor: { name: 'Rita', photo_url: null, realty_group: '', dre_license: '', realtor_id: 'r1' } },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return { client, invites, calls };
}

async function newEscrow(store: { createEscrow: (a: never) => Promise<{ id: string }> }) {
  return store.createEscrow({
    address: '1 Test Way', city: 'Testville', side: 'buy',
    buyerName: 'Alice', sellerName: '', openDate: '2026-09-01', closeDate: '2026-10-15',
  } as never);
}

async function main(): Promise<void> {
  // 1. Create on device A -> the invite reaches the cloud.
  {
    const { client, invites } = fakeCloud();
    const kvA = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kvA, { cloudClient: () => client as never });
    await initCloudSync();
    const escrow = await newEscrow(store);
    const invite = await store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    await new Promise((r) => setTimeout(r, 300));
    assert(invites.has(invite.id), 'device A createInvite pushes the invite to the cloud');
    assert(invites.get(invite.id)?.code === invite.code, 'pushed code matches the shown code');
  }

  // 2. Logout/login round-trip: server invites merge into a fresh local store.
  // (Unit-level: initCloudSync calls pullFullInvitesNow + mergeInvites for
  // each escrow; here we exercise that path directly.)
  {
    const { client } = fakeCloud();
    const kvA = memoryKV();
    const a = createSyncedStore(kvA, { cloudClient: () => client as never });
    await a.initCloudSync();
    const escrow = await newEscrow(a.store);
    const invite = await a.store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    await new Promise((r) => setTimeout(r, 300));

    // "Logout/login": brand-new store with an EMPTY KV (local lost).
    const kvB = memoryKV();
    const b = createSyncedStore(kvB, { cloudClient: () => client as never });
    const rows = await pullFullInvitesNow(client as never, escrow.id);
    await b.store.mergeInvites(rows);
    const list = await b.store.listInvites(escrow.id);
    assert(list.length === 1 && list[0].code === invite.code,
      'server-side invite hydrates into a fresh local store after login');
  }

  // 3. Cross-device redeem: device B redeems device A's code via the cloud.
  {
    const { client } = fakeCloud();
    const kvA = memoryKV();
    const a = createSyncedStore(kvA, { cloudClient: () => client as never });
    await a.initCloudSync();
    const escrow = await newEscrow(a.store);
    const invite = await a.store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    await new Promise((r) => setTimeout(r, 300));

    const kvB = memoryKV(); // device B: different KV, never saw the invite
    const b = createSyncedStore(kvB, {
      cloudClient: () => client as never,
      redeemTimeoutMs: 2000,
    });
    const res = await b.store.redeemInvite(invite.code, 'Alice Buyer', 'dev-b');
    assert(res.ok === true, 'device B redeems device A invite code via the cloud RPC');
  }

  // 4. pushInviteNow is idempotent for already-synced invites.
  {
    const { client, calls } = fakeCloud();
    const invite = {
      id: 'inv-1', escrowId: 'esc-1', role: 'buyer', partyName: 'Alice',
      code: 'ABCDEF', createdAt: '2026-09-27T00:00:00Z', revokedAt: null, redeemedAt: null,
    } as Invite;
    await pushInviteNow(client as never, invite);
    const codeAfterFirst = invite.code;
    await pushInviteNow(client as never, invite); // re-push (reconcile/outbox retry)
    assert(invite.code === codeAfterFirst, 're-push does not regenerate the code');
    assert(calls.filter((c) => c.startsWith('upsert invites')).length === 2,
      're-push uses upsert (no PK-conflict throw)');
  }

  // 5. Resolve heals a local-only invite whose push failed.
  {
    const { client, invites } = fakeCloud();
    const kvA = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kvA, { cloudClient: () => client as never });
    await initCloudSync();
    const escrow = await newEscrow(store);
    const invite = await store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    await new Promise((r) => setTimeout(r, 300));
    // Simulate the push having failed: wipe the server copy, keep the local.
    invites.clear();
    const res = await store.resolveInviteRealtor(invite.code);
    assert(res.ok === true, 'resolve pushes a local-only invite and retries (heals)');
    assert(invites.has(invite.id), 'healed invite is now on the server');
  }

  summary('invite_sync');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exitCode = 1;
});
