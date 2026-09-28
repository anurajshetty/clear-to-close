// close_revoke_converges.test.ts — REGRESSION (Anuraj, Sept 2026).
//
// The close-revokes-client-access release stamped revokedAt on the local
// client links but the revocation never reached the server when the
// realtor's app stayed open: syncedStore.closeEscrow only ENQUEUED the
// link-revocation outbox op, and the outbox drains only at the next boot
// (initCloudSync). get_client_view therefore kept returning ok:true and the
// client kept access — exactly what Anuraj reproduced.
//
// The fix (Sept 28, 2026 synchronous model): closeEscrow is a CONFIRMED
// WRITE. Its server effect revokes the escrow row, the invites, and every
// live server link for those invites (listed server-side — the realtor's
// device never holds server link ids) BEFORE the local apply. No second
// boot, no outbox, no fire-and-forget: the write throws and leaves local
// state untouched if any part fails.
// This pins the fix:
//  1. Closing an escrow from an already-booted app revokes the server-side
//     client_links rows before the local apply — the client loses access
//     at once, with EMPTY local data.links (the production shape).
//  2. An already-open client app must revalidate its link when foregrounded
//     (AppState 'active' -> silent re-check -> /link-dead on a dead link),
//     because useFocusEffect alone never refires on foreground.
//  3. Regenerate goes through the atomic regenerate_invite RPC (old code +
//     old device links killed, fresh code issued in one transaction) — the
//     old local+outbox fallback path is retired; there is nothing to force.
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
  // Confirmed write: the invite row is on the mock server before this returns.
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
    // The confirmed write revokes the server links before the local apply.
    const { revokedLinks } = await store.closeEscrow(e.id, 'buyer');
    assert(revokedLinks.length === 0, `production shape: local data.links is EMPTY (got ${revokedLinks.length})`);

    const buyerRev = server.links.get(buyerLink);
    const tcRev = server.links.get(tcLink);
    assert(
      !!buyerRev?.revokedAt && typeof buyerRev.revokedAt === 'string',
      `buyer server link revoked_at converged before the local apply (got ${buyerRev?.revokedAt})`,
    );
    assert(
      !!tcRev?.revokedAt && typeof tcRev.revokedAt === 'string',
      `TC server link revoked_at converged before the local apply (got ${tcRev?.revokedAt})`,
    );
    assert(
      server.pushedLinkRevocations.some((r) => r.linkId === buyerLink) &&
        server.pushedLinkRevocations.some((r) => r.linkId === tcLink),
      'the close converged both server links via update, not local state',
    );
  }

  // --- 2. Regenerate kills the old server link atomically -----------------
  // The atomic regenerate_invite RPC kills the old code + old device links
  // and issues the fresh code in one transaction — inside the confirmed
  // write, before the local apply. The old local+outbox fallback path (and
  // its code override) is retired: regenerate always goes through the RPC.
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

    const res = await store.regenerateInvite(inv.id);
    assert(res.revokedLink === null, 'production shape: no local link to kill');
    assert(res.invite.code !== inv.code, 'the fresh server-issued code replaces the old one');

    const link = server.links.get(oldLink);
    assert(
      !!link?.revokedAt && typeof link.revokedAt === 'string',
      `regenerated old server link revoked_at converged before the local apply (got ${link?.revokedAt})`,
    );
    assert(
      (await store.getInvite(res.invite.id))?.revokedAt == null,
      'the replacement invite is live locally',
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
