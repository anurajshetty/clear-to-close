// close_revokes_links.test.ts — REGRESSION (Anuraj, Sept 2026): when the
// realtor EXPLICITLY closes an escrow, the client LOSES access to it — the
// same treatment as an expired code or a removed client.
//
//  1. Closing an escrow revokes its client links: buyer, seller, and TC
//     links die at close time; validateClientLink reports them dead and
//     closeEscrow returns the killed links (for cloud convergence).
//  2. Dual agency: closing one side kills only that side's links — the
//     other side's clients keep access until their side closes; the TC
//     links die once the whole escrow is closed.
//  3. A revoked client sees the dead-link state: /link-dead carries the
//     "This code no longer works" copy and the link gate routes there when
//     validation fails.
//  4. 100%-complete-but-open is NOT a close: links stay valid and the
//     celebration state shows normally until the realtor explicitly closes.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import type { ClientRole } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

const path: { join(...p: string[]): string } = require('path');
const fs: { readFileSync(p: string, enc: string): string } = require('fs');

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

async function redeem(
  store: ReturnType<typeof createStore>,
  escrowId: string,
  role: ClientRole,
  partyName: string,
): Promise<string> {
  const inv = await store.createInvite(escrowId, role, partyName);
  const res = await store.redeemInvite(inv.code, partyName);
  if (!res.ok || !res.linkId) throw new Error(`redeem failed for ${partyName}`);
  return res.linkId;
}

async function main(): Promise<void> {
  const { openDate, closeDate } = dates();

  // --- 1. Single-side close revokes buyer + TC links ------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '77 Close Ct',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Test Buyer',
      openDate,
      closeDate,
    });
    const buyerLink = await redeem(store, e.id, 'buyer', 'Test Buyer');
    const tcLink = await redeem(store, e.id, 'tc', 'Tina Coord');
    assert((await store.validateClientLink(buyerLink)).valid, 'buyer link valid before close');
    assert((await store.validateClientLink(tcLink)).valid, 'TC link valid before close');

    await checkAll(store, e.id, 'buyer');
    const { escrow: closed, revokedLinks } = await store.closeEscrow(e.id, 'buyer');
    assert(closed.status === 'closed', 'single-side escrow reads closed');
    assert(revokedLinks.length === 2, `close returns both killed links (got ${revokedLinks.length})`);
    assert(
      revokedLinks.every((l) => typeof l.revokedAt === 'string' && l.revokedAt.length > 0),
      'killed links carry a revokedAt timestamp for cloud convergence',
    );
    assert(!(await store.validateClientLink(buyerLink)).valid, 'buyer link dead after close');
    assert(!(await store.validateClientLink(tcLink)).valid, 'TC link dead after close');
  }

  // --- 2. Dual agency: per-side link death -----------------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '88 Both Blvd',
      city: 'Stevenson Ranch, CA 91381',
      side: 'both',
      buyerName: 'Ana Ruiz',
      sellerName: 'Mark Doyle',
      openDate,
      closeDate,
    });
    const buyerLink = await redeem(store, e.id, 'buyer', 'Ana Ruiz');
    const sellerLink = await redeem(store, e.id, 'seller', 'Mark Doyle');
    const tcLink = await redeem(store, e.id, 'tc', 'Tina Coord');
    await checkAll(store, e.id, 'buyer');
    await checkAll(store, e.id, 'seller');

    const afterBuyer = await store.closeEscrow(e.id, 'buyer');
    assert(afterBuyer.escrow.status === 'open', 'escrow stays open while the seller side is active');
    assert(!(await store.validateClientLink(buyerLink)).valid, 'buyer link dead when the buyer side closes');
    assert((await store.validateClientLink(sellerLink)).valid, 'seller keeps access while their side is active');
    assert((await store.validateClientLink(tcLink)).valid, 'TC keeps access until the whole escrow closes');

    const afterSeller = await store.closeEscrow(e.id, 'seller');
    assert(afterSeller.escrow.status === 'closed', 'escrow closed when both sides close');
    assert(!(await store.validateClientLink(sellerLink)).valid, 'seller link dead when the seller side closes');
    assert(!(await store.validateClientLink(tcLink)).valid, 'TC link dead once the whole escrow is closed');
  }

  // --- 3. Revoked client -> the dead-link state -------------------------------
  {
    const ROOT = process.env.CTC_REPO_ROOT ?? '';
    assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
    const linkDead = fs.readFileSync(path.join(ROOT, 'app/link-dead.tsx'), 'utf8');
    assert(
      linkDead.includes('This code no longer works'),
      'dead-link screen shows "This code no longer works"',
    );
    const gate = fs.readFileSync(path.join(ROOT, 'src/hooks/useClientLinkGate.ts'), 'utf8');
    assert(
      gate.includes("router.replace('/link-dead')"),
      'link gate routes to /link-dead when the stored link fails validation',
    );
  }

  // --- 4. 100%-complete-but-open: no link death ------------------------------
  {
    const store = createStore(memoryKV());
    const e = await store.createEscrow({
      address: '99 Open Ave',
      city: 'Newhall, CA 91321',
      side: 'buy',
      buyerName: 'Open Buyer',
      openDate,
      closeDate,
    });
    const buyerLink = await redeem(store, e.id, 'buyer', 'Open Buyer');
    const tcLink = await redeem(store, e.id, 'tc', 'Tina Coord');
    await checkAll(store, e.id, 'buyer');
    const view = await store.getBuyerView(e.id);
    assert(view.total > 0 && view.done >= view.total, 'checklist is 100% complete');
    const stillOpen = await store.getEscrow(e.id);
    assert(stillOpen!.status === 'open', 'escrow stays open until the realtor explicitly closes');
    assert((await store.validateClientLink(buyerLink)).valid, 'buyer link stays valid at 100%-complete-but-open');
    assert((await store.validateClientLink(tcLink)).valid, 'TC link stays valid at 100%-complete-but-open');
  }

  summary('close_revokes_links');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
