// invite_expiry.test.ts — invite codes die with the escrow (Anuraj, Sept 28, 2026):
// cancel kills ALL active invites (buyer, seller, TC); a whole-escrow close
// kills ALL active invites; a per-side close kills only that side's invites
// (the other side and the TC stay live); already-revoked invites are
// untouched; revocation uses the existing revoke semantics (code invalidated
// + device link killed at the same moment), so redeeming a dead code lands
// on the dead-code state ('revoked'), never a blank screen.
// Every test below fails on the pre-expiry code and passes with it.
// Run: see tests/run.sh. Dates are computed at runtime, never hardcoded.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import type { ClientRole } from '../src/lib/types';

declare const process: { exitCode?: number };

function dates(): { openDate: string; closeDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const close = new Date(now);
  close.setDate(close.getDate() + 61);
  return { openDate: fmt(now), closeDate: fmt(close) };
}

async function checkAll(
  store: ReturnType<typeof createStore>,
  escrowId: string,
  role: ClientRole,
): Promise<void> {
  const e = await store.getEscrow(escrowId);
  const steps = role === 'buyer' ? e!.buyerSteps : e!.sellerSteps;
  for (const s of steps) {
    if (!s.done) await store.toggleStep(escrowId, role, s.id);
  }
}

async function main(): Promise<void> {
  const { openDate, closeDate } = dates();

  // --- cancel kills ALL active invites; already-revoked untouched --------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '4187 Oakmont Dr', city: 'Valencia, CA 91355', side: 'both',
      buyerName: 'B', sellerName: 'S', openDate, closeDate,
    });
    const buyer = await store.createInvite(e.id, 'buyer', 'Buyer One');
    const seller = await store.createInvite(e.id, 'seller', 'Seller One');
    const tc = await store.createInvite(e.id, 'tc', 'TC One');
    // An already-dead invite must not be touched.
    const dead = await store.createInvite(e.id, 'buyer', 'Buyer Gone');
    await store.revokeInvite(dead.id);
    const deadBefore = (await store.listInvites(e.id)).find((i) => i.id === dead.id)!;

    const { escrow, revokedInvites } = await store.cancelEscrow(e.id);
    assert(escrow.status === 'cancelled', 'cancel: status flips');

    const ids = new Set(revokedInvites.map((r) => r.id));
    assert(ids.has(buyer.id) && ids.has(seller.id) && ids.has(tc.id),
      'cancel: result lists buyer, seller, and TC invites as revoked');
    assert(!ids.has(dead.id), 'cancel: already-revoked invite is not re-revoked');

    const after = await store.listInvites(e.id);
    const byId = new Map(after.map((i) => [i.id, i]));
    assert(!!byId.get(buyer.id)!.revokedAt, 'cancel: buyer invite revoked');
    assert(!!byId.get(seller.id)!.revokedAt, 'cancel: seller invite revoked');
    assert(!!byId.get(tc.id)!.revokedAt, 'cancel: TC invite revoked');
    assert(byId.get(dead.id)!.revokedAt === deadBefore.revokedAt,
      'cancel: already-revoked invite timestamp untouched');

    // Redeeming a dead code lands on the dead-code state.
    const r1 = await store.redeemInvite(buyer.code, 'Buyer One');
    assert(!r1.ok && r1.error === 'revoked', 'cancel: buyer code redeems as revoked');
    const r2 = await store.redeemInvite(tc.code, 'TC One');
    assert(!r2.ok && r2.error === 'revoked', 'cancel: TC code redeems as revoked');
  }

  // --- cancel kills the redeemed device link too --------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '1 Main St', city: 'X', side: 'buy',
      buyerName: 'B', openDate, closeDate,
    });
    const buyer = await store.createInvite(e.id, 'buyer', 'Buyer One');
    const redeem = await store.redeemInvite(buyer.code, 'Buyer One', 'device-1');
    assert(redeem.ok, 'setup: buyer invite redeemed');
    const linkId = redeem.ok ? redeem.linkId : '';
    assert((await store.validateClientLink(linkId)).valid, 'setup: link live before cancel');

    await store.cancelEscrow(e.id);
    assert(!(await store.validateClientLink(linkId)).valid,
      'cancel: redeemed device link dies with the escrow');
  }

  // --- per-side close kills only that side's invites ----------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '99 Side St', city: 'Y', side: 'both',
      buyerName: 'B', sellerName: 'S', openDate, closeDate,
    });
    const buyer = await store.createInvite(e.id, 'buyer', 'Buyer One');
    const seller = await store.createInvite(e.id, 'seller', 'Seller One');
    const tc = await store.createInvite(e.id, 'tc', 'TC One');

    await checkAll(store, e.id, 'buyer');
    const { escrow: partial, revokedInvites } = await store.closeEscrow(e.id, 'buyer');
    assert(partial.status === 'open', 'per-side close: escrow stays open');

    const ids = new Set(revokedInvites.map((r) => r.id));
    assert(ids.has(buyer.id), 'per-side close: buyer invite revoked');
    assert(!ids.has(seller.id) && !ids.has(tc.id),
      'per-side close: seller and TC invites stay live');

    const after = new Map((await store.listInvites(e.id)).map((i) => [i.id, i]));
    assert(!!after.get(buyer.id)!.revokedAt, 'per-side close: buyer invite dead');
    assert(!after.get(seller.id)!.revokedAt, 'per-side close: seller invite live');
    assert(!after.get(tc.id)!.revokedAt, 'per-side close: TC invite live');

    const dead = await store.redeemInvite(buyer.code, 'Buyer One');
    assert(!dead.ok && dead.error === 'revoked', 'per-side close: buyer code redeems as revoked');
    const live = await store.redeemInvite(seller.code, 'Seller One');
    assert(live.ok, 'per-side close: seller code still redeems');
  }

  // --- whole-escrow close kills buyer, seller, AND TC ---------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '7 Whole St', city: 'Z', side: 'both',
      buyerName: 'B', sellerName: 'S', openDate, closeDate,
    });
    const buyer = await store.createInvite(e.id, 'buyer', 'Buyer One');
    const seller = await store.createInvite(e.id, 'seller', 'Seller One');
    const tc = await store.createInvite(e.id, 'tc', 'TC One');

    await checkAll(store, e.id, 'buyer');
    await checkAll(store, e.id, 'seller');
    await store.closeEscrow(e.id, 'buyer');
    const { escrow: closed, revokedInvites } = await store.closeEscrow(e.id, 'seller');
    assert(closed.status === 'closed', 'whole close: status flips to closed');

    const ids = new Set(revokedInvites.map((r) => r.id));
    assert(ids.has(seller.id) && ids.has(tc.id),
      'whole close: seller and TC invites revoked with the final side');
    assert(!ids.has(buyer.id), 'whole close: buyer invite (already dead) not re-revoked');

    const after = new Map((await store.listInvites(e.id)).map((i) => [i.id, i]));
    assert(!!after.get(buyer.id)!.revokedAt, 'whole close: buyer invite dead');
    assert(!!after.get(seller.id)!.revokedAt, 'whole close: seller invite dead');
    assert(!!after.get(tc.id)!.revokedAt, 'whole close: TC invite dead');

    const dead = await store.redeemInvite(tc.code, 'TC One');
    assert(!dead.ok && dead.error === 'revoked', 'whole close: TC code redeems as revoked');
  }

  summary('invite_expiry');
}

main().catch((err) => {
  console.error('invite_expiry FAILED:', err);
  process.exitCode = 1;
});
