// redeem_no_local_fallback.test.ts — regression coverage for the Sept 28,
// 2026 redeem conformance fix: the synced store's redeemInvite goes through
// the redeem_invite RPC as the single authority. The old local fallback
// (local.redeemInvite minting a device link the server never authorized) and
// the local-invite push-and-retry path are DELETED.
//
// Covers:
//  1. Unconfigured (no cloud) -> { ok: false, error: 'network' }, not a
//     local success. Offline/unreachable fails fast with the retryable copy.
//  2. A locally present invite the server rejects (RPC 'invalid') reports
//     the server's verdict — never a local success, never a minted device
//     link, and no local invite state is mutated.
//  3. An RPC that hangs past redeemTimeoutMs reports 'network', never
//     'invalid' (a timeout must not produce a code verdict).
//  4. A server success still caches the cloud link and returns ok.

import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const CLOUD_LINKS_KEY = 'ctc:cloudlinks';

// Fake cloud: invites table + redeem_invite RPC with controllable behavior.
function fakeCloud(opts?: {
  redeemBehavior?: 'ok' | 'invalid' | 'hang';
}) {
  const invites = new Map<string, Record<string, unknown>>();
  const behavior = opts?.redeemBehavior ?? 'ok';
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'realtor-uid' } } },
        error: null,
      }),
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'invites') invites.set(row.id as string, { ...row });
        return { error: null };
      },
      upsert: (rows: Record<string, unknown>[] | Record<string, unknown>, _opts?: unknown) => {
        const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
        for (const row of list) {
          if (table === 'invites') invites.set(row.id as string, { ...row });
        }
        // .select(onConflict) asks PostgREST for the affected rows
        // (RETURNING); the write-verification check needs data.length.
        return { select: async () => ({ data: list, error: null }) };
      },
      select: (cols?: string) => ({
        eq: (col: string, val: unknown) => {
          if (table === 'invites') {
            const rows = [...invites.values()].filter((r) => r[col] === val || (col === 'escrow_id' && r.escrow_id === val));
            return Promise.resolve({ data: rows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      }),
    }),
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== 'redeem_invite') return { data: null, error: null };
      if (behavior === 'hang') {
        await new Promise(() => {}); // never resolves
      }
      const code = String(params.p_code ?? '').toUpperCase();
      const row = [...invites.values()].find((r) => r.code === code);
      if (!row || behavior === 'invalid') {
        return { data: { ok: false, error: 'invalid' }, error: null };
      }
      return {
        data: {
          ok: true,
          escrow_id: row.escrow_id,
          role: row.role,
          party_name: row.party_name,
          link_id: 'link-rpc-1',
        },
        error: null,
      };
    },
  };
  return { client, invites };
}

async function configuredStore(cloud: unknown, opts?: { redeemTimeoutMs?: number }) {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: () => cloud as never,
    redeemTimeoutMs: opts?.redeemTimeoutMs ?? 1500,
  });
  await initCloudSync();
  return { store, kv };
}

async function newEscrow(store: { createEscrow: (a: never) => Promise<{ id: string }> }) {
  return store.createEscrow({
    address: '1 Test Way', city: 'Testville', side: 'buy',
    buyerName: 'Alice', sellerName: '', openDate: '2026-09-01', closeDate: '2026-10-15',
  } as never);
}

async function main(): Promise<void> {
  // 1. Unconfigured: no cloud client, no env -> network error, no local success.
  {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => null as never });
    const res = await store.redeemInvite('ABCDEF', 'Alice Buyer', 'dev-1');
    assert(res.ok === false && res.error === 'network',
      'unconfigured redeem reports network, not a local success');
    assert((await kv.getItem(CLOUD_LINKS_KEY)) === null,
      'unconfigured redeem persists no cloud link');
  }

  // 2. Server rejects a locally present invite -> the server's verdict,
  // never a local success; nothing is minted or mutated locally.
  {
    const { client, invites } = fakeCloud({ redeemBehavior: 'invalid' });
    const { store, kv } = await configuredStore(client);
    const escrow = await newEscrow(store);
    const invite = await store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    // The invite IS present locally (confirmed create) — the server now
    // rejects the code (revoked out-of-band / unknown to this RPC view).
    const res = await store.redeemInvite(invite.code, 'Alice Buyer', 'dev-2');
    assert(res.ok === false && res.error === 'invalid',
      'server-invalid code reports the server verdict, never a local success');
    const link = await store.getLinkForInvite(invite.id);
    assert(link === null || link === undefined,
      'rejected redeem mints no local device link');
    assert((await kv.getItem(CLOUD_LINKS_KEY)) === null,
      'rejected redeem persists no cloud link');
    const listed = await store.listInvites(escrow.id);
    assert(listed.length === 1 && listed[0].code === invite.code && !listed[0].redeemedAt,
      'rejected redeem leaves the local invite row untouched');
    assert(invites.has(invite.id), 'server still holds the invite row');
  }

  // 3. RPC hang -> timeout reports 'network', never a code verdict.
  {
    const { client } = fakeCloud({ redeemBehavior: 'hang' });
    const { store, kv } = await configuredStore(client, { redeemTimeoutMs: 300 });
    const started = Date.now();
    const res = await store.redeemInvite('ANYCODE', 'Alice Buyer', 'dev-3');
    const elapsed = Date.now() - started;
    assert(res.ok === false && res.error === 'network',
      'timed-out redeem reports network, never invalid');
    assert(elapsed < 5000, `timeout bounded by redeemTimeoutMs (took ${elapsed}ms)`);
    assert((await kv.getItem(CLOUD_LINKS_KEY)) === null,
      'timed-out redeem persists no cloud link');
  }

  // 4. Server success -> ok, and the cloud link is cached.
  {
    const { client } = fakeCloud({ redeemBehavior: 'ok' });
    const { store, kv } = await configuredStore(client);
    const escrow = await newEscrow(store);
    const invite = await store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
    const res = await store.redeemInvite(invite.code, 'Alice Buyer', 'dev-4');
    assert(res.ok === true, 'server-accepted redeem still succeeds');
    const raw = await kv.getItem(CLOUD_LINKS_KEY);
    assert(raw !== null && raw.includes('link-rpc-1'),
      'server-accepted redeem caches the cloud link id');
  }

  summary('redeem_no_local_fallback');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exitCode = 1;
});
