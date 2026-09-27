// close_revoke_converges.test.ts — REGRESSION (Anuraj, Sept 2026).
//
// The close-revokes-client-access release stamped revokedAt on the local
// client links but the revocation never reached the server when the
// realtor's app stayed open: syncedStore.closeEscrow only ENQUEUED the
// revokeClientLink outbox op, and the outbox drains only at the next boot
// (initCloudSync). get_client_view therefore kept returning ok:true and the
// client kept access — exactly what Anuraj reproduced.
//
// This pins the fix:
//  1. Closing an escrow from an already-booted app must push the
//     client_links revocation to the cloud immediately — no second
//     initCloudSync, no app restart.
//  2. An already-open client app must revalidate its link when foregrounded
//     (AppState 'active' -> silent re-check -> /link-dead on a dead link),
//     because useFocusEffect alone never refires on foreground.
//  3. The regenerate fallback path (local + outbox, when the RPC path is
//     unavailable) gets the same immediate drain — it queues the identical
//     revokeClientLink op with the identical latent bug.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import type { ClientRole } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const path: { join(...p: string[]): string } = require('path');
const fs: { readFileSync(p: string, enc: string): string } = require('fs');

// ---- Mock Supabase client -------------------------------------------------
// Records every UPDATE call (table + payload + eq filters) so the test can
// prove whether the revocation actually reached the "server".
interface UpdateCall {
  table: string;
  payload: Record<string, unknown>;
  filters: unknown[][];
}
const updateCalls: UpdateCall[] = [];

function chainableFor(table: string): any {
  const p = Promise.resolve({ data: [] as unknown[], error: null as unknown });
  return new Proxy(p, {
    get(t, prop: string) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return (t as any)[prop].bind(t);
      }
      return (...args: unknown[]) => {
        if (prop === 'update') {
          updateCalls.push({ table, payload: args[0] as Record<string, unknown>, filters: [] });
        }
        if (prop === 'eq') {
          const last = updateCalls[updateCalls.length - 1];
          if (last && last.table === table) last.filters.push(args);
        }
        return chainableFor(table);
      };
    },
  });
}

function mockCloud() {
  return {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'realtor-1' } } },
        error: null,
      }),
    },
    from: (table: string) => chainableFor(table),
    rpc: async (name: string) => {
      // The server knows nothing of our local codes: every redeem falls
      // back to the local path (the wrapper's documented behavior).
      if (name === 'redeem_invite') return { data: { ok: false, error: 'invalid' }, error: null };
      return { data: null, error: null };
    },
  };
}

// ---- Helpers ---------------------------------------------------------------
function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function checkAll(store: any, escrowId: string, role: ClientRole): Promise<void> {
  const e = await store.getEscrow(escrowId);
  const steps = role === 'buyer' ? e!.buyerSteps : e!.sellerSteps;
  for (const s of steps) {
    if (!s.done) await store.toggleStep(escrowId, role, s.id);
  }
}

async function redeem(
  store: any,
  escrowId: string,
  role: ClientRole,
  partyName: string,
): Promise<{ invite: any; linkId: string }> {
  const invite = await store.createInvite(escrowId, role, partyName);
  const res = await store.redeemInvite(invite.code, partyName);
  if (!res.ok || !res.linkId) throw new Error(`redeem failed for ${partyName}`);
  return { invite, linkId: res.linkId as string };
}

function clientLinkRevocations(): UpdateCall[] {
  return updateCalls.filter(
    (c) => c.table === 'client_links' && c.payload && c.payload.revoked_at != null,
  );
}

// ---- Main ------------------------------------------------------------------
async function main(): Promise<void> {
  const { openDate, closeDate } = dates();

  // --- 1. Close converges to the cloud WITHOUT a second boot ----------------
  {
    updateCalls.length = 0;
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud() as any });
    // Boot once: the outbox drain runs here (empty).
    await initCloudSync();
    updateCalls.length = 0; // ignore boot-time traffic

    const e = await store.createEscrow({
      address: '77 Converge Ct',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });
    const buyerLink = (await redeem(store, e.id, 'buyer', 'Test Buyer')).linkId;
    const tcLink = (await redeem(store, e.id, 'tc', 'Tina Coord')).linkId;
    await checkAll(store, e.id, 'buyer');

    // The realtor closes from the already-open app. NO second initCloudSync.
    const { revokedLinks } = await store.closeEscrow(e.id, 'buyer');
    assert(revokedLinks.length === 2, 'closeEscrow kills buyer + TC links locally');
    await tick(150); // the immediate drain is fire-and-forget; let it land

    const revs = clientLinkRevocations();
    const revokedIds = revs.map((r) => String(r.filters.flat()[1] ?? ''));
    assert(
      revs.length >= 2,
      `revocation reaches the server without a reboot (client_links updates: ${revs.length})`,
    );
    const buyerRev = revs.find((r) => String(r.filters.flat()[1]) === buyerLink);
    const tcRev = revs.find((r) => String(r.filters.flat()[1]) === tcLink);
    assert(!!buyerRev, 'buyer link revoked_at pushed to the server');
    assert(!!tcRev, 'TC link revoked_at pushed to the server');
    assert(
      !!buyerRev && typeof buyerRev.payload.revoked_at === 'string',
      'buyer revoked_at is a timestamp string',
    );
    void revokedIds;
  }

  // --- 2. Regenerate fallback also converges without a reboot ---------------
  {
    updateCalls.length = 0;
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => mockCloud() as any });
    await initCloudSync();
    updateCalls.length = 0;

    const e = await store.createEscrow({
      address: '78 Regen Ct',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });
    const { invite: inv, linkId: oldLink } = await redeem(store, e.id, 'buyer', 'Test Buyer');

    // Force the local+outbox fallback path (the RPC path would converge
    // atomically server-side on its own).
    const res = await store.regenerateInvite(inv.id, 'NEWCODE1');
    assert(!!res.revokedLink, 'regenerate kills the old device link locally');
    await tick(150);

    const rev = clientLinkRevocations().find(
      (r) => String(r.filters.flat()[1]) === oldLink,
    );
    assert(!!rev, 'regenerated old link revoked_at pushed to the server without a reboot');
  }

  // --- 3. Already-open client apps revalidate on foreground ------------------
  // The gate hook is not importable in the node suite (expo-router/react),
  // so this is a structural pin of the contract, the same pattern as
  // tests/topcard_redesign.py.
  {
    const root = process.env.CTC_REPO_ROOT ?? path.join('..');
    const src = fs.readFileSync(path.join(root, 'src/hooks/useClientLinkGate.ts'), 'utf8');
    assert(src.includes("from 'react-native'") && src.includes('AppState'), 'gate imports AppState');
    assert(
      src.includes("addEventListener('change'") || src.includes('addEventListener("change"'),
      'gate subscribes to AppState change events',
    );
    assert(
      src.includes("'active'") || src.includes('"active"'),
      'gate revalidates when the app becomes active',
    );
    assert(
      /silent/.test(src),
      'foreground revalidation is silent (no loading flash on a live link)',
    );
    assert(src.includes('.remove()'), 'foreground subscription is cleaned up on unmount');
  }

  summary('close_revoke_converges');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
