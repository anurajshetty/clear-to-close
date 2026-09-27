// tc_view.test.ts — transaction coordinator view (Anuraj's decision, Sept 2026):
// on a "both" escrow the TC sees BOTH checklists; on a single-side escrow
// the active side's. Covers the local store's getTcView and the
// get_client_view RPC payload mapping (mapClientViewRpc).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { mapClientViewRpc } from '../src/lib/cloudSync';

declare const process: { exitCode?: number };

async function newEscrow(store: ReturnType<typeof createStore>, side: 'buy' | 'sell' | 'both') {
  return store.createEscrow({
    address: '123 Main St',
    city: 'Santa Clarita',
    side,
    buyerName: 'Alice Buyer',
    sellerName: 'Bob Seller',
    openDate: '2026-09-01',
    closeDate: '2026-10-15',
  });
}

function rpcStep(id: string, title: string, position: number, done: boolean) {
  return {
    id,
    title,
    subtitle: '',
    done,
    custom: false,
    position,
    completed_at: done ? '2026-09-26T10:00:00.000Z' : null,
  };
}

function tcPayload(side: string) {
  return {
    ok: true,
    role: 'tc',
    escrow: {
      id: 'esc-1',
      address: '123 Main St',
      city: 'Santa Clarita',
      close_date: '2026-10-15',
      side,
    },
    buyer_steps: [rpcStep('b1', 'Buyer step one', 0, true), rpcStep('b2', 'Buyer step two', 1, false)],
    seller_steps: [rpcStep('s1', 'Seller step one', 0, false)],
    profile: {
      name: 'Rita Realtor',
      photo_url: null,
      about: '',
      years_experience: '',
      deals_closed: '',
      areas_served: '',
      phone: '',
      dre_license: '',
    },
  };
}

async function main(): Promise<void> {
  const store = createStore(memoryKV());

  // ---- local store: both-side escrow shows both checklists ----
  const both = await newEscrow(store, 'both');
  const bothView = await store.getTcView(both.id);
  assert(bothView.escrowId === both.id, 'tc view escrowId matches');
  assert(bothView.buyer !== null, 'both-side: buyer section present');
  assert(bothView.seller !== null, 'both-side: seller section present');
  if (bothView.buyer && bothView.seller) {
    assert(bothView.buyer.role === 'buyer', 'buyer section role is buyer');
    assert(bothView.seller.role === 'seller', 'seller section role is seller');
    assert(
      bothView.buyer.steps.length > 0 && bothView.seller.steps.length > 0,
      'both sections have steps',
    );
    const buyerTitles = bothView.buyer.steps.map((s) => s.title);
    const sellerTitles = bothView.seller.steps.map((s) => s.title);
    // The templates legitimately share some titles (e.g. "Escrow open");
    // section identity comes from the template-specific steps instead.
    assert(
      buyerTitles.includes('Get keys') && !sellerTitles.includes('Get keys'),
      'buyer-only step appears on the buyer section only',
    );
    assert(
      sellerTitles.includes('Record deed') && !buyerTitles.includes('Record deed'),
      'seller-only step appears on the seller section only',
    );
    const orders = bothView.buyer.steps.map((s) => s.order);
    assert(
      orders.every((o, i) => i === 0 || orders[i - 1] <= o),
      'buyer steps sorted by order',
    );
  }

  // ---- local store: single-side escrows show the active side only ----
  const buy = await newEscrow(store, 'buy');
  const buyView = await store.getTcView(buy.id);
  assert(buyView.buyer !== null && buyView.seller === null, 'buy-side: buyer only, seller null');

  const sell = await newEscrow(store, 'sell');
  const sellView = await store.getTcView(sell.id);
  assert(sellView.seller !== null && sellView.buyer === null, 'sell-side: seller only, buyer null');

  // ---- local store: done counts roll up per section ----
  await store.toggleStep(both.id, 'buyer', bothView.buyer!.steps[0].id);
  const refreshed = await store.getTcView(both.id);
  assert(
    refreshed.buyer!.done === bothView.buyer!.done + 1,
    'checking a buyer step bumps the buyer done count',
  );
  assert(
    refreshed.seller!.done === bothView.seller!.done,
    'seller done count untouched by a buyer check',
  );

  // ---- RPC mapping: TC payload, both-side escrow ----
  const bothRes = mapClientViewRpc(tcPayload('both'));
  assert(bothRes.ok === true, 'tc rpc payload maps ok');
  assert(bothRes.view === undefined, 'tc payload does not populate the single view');
  assert(bothRes.tcView !== undefined, 'tc payload populates tcView');
  if (bothRes.tcView) {
    assert(bothRes.tcView.buyer !== null, 'rpc both-side: buyer section present');
    assert(bothRes.tcView.seller !== null, 'rpc both-side: seller section present');
    assert(
      bothRes.tcView.buyer!.steps.map((s) => s.title).join('|') === 'Buyer step one|Buyer step two',
      'rpc buyer steps mapped in order',
    );
    assert(
      bothRes.tcView.seller!.steps.map((s) => s.title).join('|') === 'Seller step one',
      'rpc seller steps mapped in order',
    );
    assert(bothRes.tcView.buyer!.done === 1, 'rpc buyer done count correct');
    assert(
      bothRes.tcView.buyer!.upNext?.title === 'Buyer step two',
      'rpc buyer upNext is the first remaining step',
    );
    assert(bothRes.tcView.address === '123 Main St', 'rpc address mapped');
  }
  assert(bothRes.profile?.name === 'Rita Realtor', 'rpc profile mapped for tc');

  // ---- RPC mapping: single-side escrows activate one section ----
  const buyRes = mapClientViewRpc(tcPayload('buy'));
  assert(
    buyRes.ok === true && buyRes.tcView !== undefined && buyRes.tcView.buyer !== null && buyRes.tcView.seller === null,
    'rpc buy-side: buyer only, seller null',
  );
  const sellRes = mapClientViewRpc(tcPayload('sell'));
  assert(
    sellRes.ok === true && sellRes.tcView !== undefined && sellRes.tcView.seller !== null && sellRes.tcView.buyer === null,
    'rpc sell-side: seller only, buyer null',
  );

  // ---- RPC mapping: buyer/seller payloads unchanged (regression) ----
  const buyerPayload = {
    ok: true,
    escrow: { id: 'esc-1', address: '123 Main St', city: 'Santa Clarita', close_date: '2026-10-15' },
    buyer_steps: [rpcStep('b1', 'Buyer step one', 0, false)],
    profile: null,
  };
  const buyerRes = mapClientViewRpc(buyerPayload);
  assert(
    buyerRes.ok && buyerRes.view?.role === 'buyer' && buyerRes.tcView === undefined,
    'buyer payload still maps to the single view (no tcView)',
  );

  // ---- RPC mapping: TC payload missing one array degrades to empty, not crash ----
  const sparse = mapClientViewRpc({ ok: true, role: 'tc', escrow: { id: 'e', address: 'a', city: 'c', close_date: '2026-10-15', side: 'both' }, profile: null });
  assert(
    sparse.ok && sparse.tcView?.buyer?.steps.length === 0 && sparse.tcView?.seller?.steps.length === 0,
    'tc payload without step arrays maps to empty sections, not a crash',
  );

  summary('tc_view');
}

main().then(
  () => {},
  (e) => {
    console.error('tc_view FAILED:', e);
    process.exitCode = 1;
  },
);
