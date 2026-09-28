// close_revoke_converges.test.ts — REGRESSION (Anuraj, Sept 2026).
//
// The close-revokes-client-access release stamped revokedAt on the local
// client links but the revocation never reached the server when the
// realtor's app stayed open: syncedStore.closeEscrow only ENQUEUED the
// link-revocation outbox op, and the outbox drains only at the next boot
// (initCloudSync). get_client_view therefore kept returning ok:true and the
// client kept access — exactly what Anuraj reproduced.
//
// This pins the fix:
//  1. Closing an escrow from an already-booted app must push the
//     client_links revocation to the cloud immediately — no second
//     initCloudSync, no app restart. The convergence is
//     server-authoritative: one retryable convergeLinkRevokes op per
//     revoked invite, whose drain lists the invite's live server links and
//     stamps revoked_at (local data.links is a production no-op — the
//     realtor's device never holds server link ids).
//  2. An already-open client app must revalidate its link when foregrounded
//     (AppState 'active' -> silent re-check -> /link-dead on a dead link),
//     because useFocusEffect alone never refires on foreground.
//  3. The regenerate fallback path (local + outbox, when the RPC path is
//     unavailable) gets the same immediate drain — it enqueues the
//     identical convergeLinkRevokes op.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { createMockServer, mockCloudFromServer } from './mock_server';
import type { ClientRole } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const path: { join(...p: string[]): string } = require('path');
const fs: { readFileSync(p: string, enc: string): string } = require('fs');

// ---- Mock Supabase client -------------------------------------------------
// FAITHFUL server (Sept 28, 2026): client_links rows are created server-side
// by the redeem_invite RPC — the realtor's device never holds them locally.
// The old version of this mock made the server "know nothing of our local
// codes", so every redeem fell back to the local path and the links were
// seeded locally: it passed for the wrong reason. This version drives the
// shared faithful mock (./mock_server) so convergence is proven against
// server-side links with EMPTY local data.links (the production shape).

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
  deviceId: string,
): Promise<{ invite: any; linkId: string }> {
  const invite = await store.createInvite(escrowId, role, partyName);
  await tick(150); // let bgPush land the invite row on the mock server
  const res = await store.redeemInvite(invite.code, partyName, deviceId);
  if (!res.ok || !res.linkId) throw new Error(`redeem failed for ${partyName}: ${JSON.stringify(res)}`);
  const linkId = res.linkId as string;
  if (!linkId.startsWith('srv-link-')) {
    throw new Error(`redeem must go through the server RPC (got ${linkId})`);
  }
  return { invite, linkId };
}

// ---- Main ------------------------------------------------------------------
async function main(): Promise<void> {
  const { openDate, closeDate } = dates();

  // --- 1. Close converges to the cloud WITHOUT a second boot ----------------
  // Production shape: the links live ONLY on the mock server (created by
  // the redeem_invite RPC); the realtor's local data.links is EMPTY.
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    // Boot once: the outbox drain runs here (empty).
    await initCloudSync();

    const e = await store.createEscrow({
      address: '77 Converge Ct',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });
    const buyerLink = (await redeem(store, e.id, 'buyer', 'Test Buyer', 'dev-c1')).linkId;
    const tcLink = (await redeem(store, e.id, 'tc', 'Tina Coord', 'dev-c2')).linkId;
    await checkAll(store, e.id, 'buyer');
    assert(server.links.get(buyerLink)?.revokedAt === null, 'buyer server link live before close');
    assert(server.links.get(tcLink)?.revokedAt === null, 'TC server link live before close');

    // The realtor closes from the already-open app. NO second initCloudSync.
    const { revokedLinks } = await store.closeEscrow(e.id, 'buyer');
    assert(revokedLinks.length === 0, `production shape: local data.links is EMPTY (got ${revokedLinks.length})`);
    await tick(200); // the immediate drain is fire-and-forget; let it land

    const buyerRev = server.links.get(buyerLink);
    const tcRev = server.links.get(tcLink);
    assert(
      !!buyerRev?.revokedAt && typeof buyerRev.revokedAt === 'string',
      `buyer server link revoked_at converged without a reboot (got ${buyerRev?.revokedAt})`,
    );
    assert(
      !!tcRev?.revokedAt && typeof tcRev.revokedAt === 'string',
      `TC server link revoked_at converged without a reboot (got ${tcRev?.revokedAt})`,
    );
    assert(
      server.pushedLinkRevocations.some((r) => r.linkId === buyerLink) &&
        server.pushedLinkRevocations.some((r) => r.linkId === tcLink),
      'convergeLinkRevokes ops reached pushLinkRevokeNow for both server links',
    );
  }

  // --- 2. Regenerate fallback also converges without a reboot ---------------
  // Production shape: the old link lives ONLY on the mock server.
  {
    const server = createMockServer();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: mockCloudFromServer(server) as never,
      redeemTimeoutMs: 2000,
    });
    await initCloudSync();

    const e = await store.createEscrow({
      address: '78 Regen Ct',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });
    const { invite: inv, linkId: oldLink } = await redeem(store, e.id, 'buyer', 'Test Buyer', 'dev-r1');

    // Force the local+outbox fallback path (the RPC path would converge
    // atomically server-side on its own).
    const res = await store.regenerateInvite(inv.id, 'NEWCODE1');
    assert(res.revokedLink === null, 'production shape: no local link to kill');
    await tick(200);

    const link = server.links.get(oldLink);
    assert(
      !!link?.revokedAt && typeof link.revokedAt === 'string',
      `regenerated old server link revoked_at converged without a reboot (got ${link?.revokedAt})`,
    );
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
