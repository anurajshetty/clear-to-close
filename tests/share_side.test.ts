// share_side.test.ts — share screen follows escrow side (Oct 2026, Anuraj).
//
// - visibleShareSections: section filtering by side.
// - isInviteRoleAllowedForSide: the cross-side rule matrix.
// - store.createInvite: the compute-path guard rejects cross-side invites.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import {
  isInviteRoleAllowedForSide,
  visibleShareSections,
} from '../src/lib/shareSections';

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

async function main(): Promise<void> {
  // visibleShareSections: buy-side shows Buyers + TC only.
  const buySections = visibleShareSections('buy').map((s) => s.role);
  assert(JSON.stringify(buySections) === JSON.stringify(['buyer', 'tc']), 'buy side shows buyer + tc sections');

  // visibleShareSections: sell-side shows Sellers + TC only.
  const sellSections = visibleShareSections('sell').map((s) => s.role);
  assert(JSON.stringify(sellSections) === JSON.stringify(['seller', 'tc']), 'sell side shows seller + tc sections');

  // visibleShareSections: legacy both shows all three.
  const bothSections = visibleShareSections('both').map((s) => s.role);
  assert(
    JSON.stringify(bothSections) === JSON.stringify(['buyer', 'seller', 'tc']),
    'both side shows all three sections',
  );

  // visibleShareSections: null/undefined fails open to all three.
  assert(visibleShareSections(null).length === 3, 'null side fails open to all sections');
  assert(visibleShareSections(undefined).length === 3, 'undefined side fails open to all sections');

  // isInviteRoleAllowedForSide: the full matrix.
  assert(isInviteRoleAllowedForSide('buyer', 'buy') === true, 'buyer allowed on buy side');
  assert(isInviteRoleAllowedForSide('seller', 'buy') === false, 'seller rejected on buy side');
  assert(isInviteRoleAllowedForSide('buyer', 'sell') === false, 'buyer rejected on sell side');
  assert(isInviteRoleAllowedForSide('seller', 'sell') === true, 'seller allowed on sell side');
  assert(isInviteRoleAllowedForSide('buyer', 'both') === true, 'buyer allowed on both side');
  assert(isInviteRoleAllowedForSide('seller', 'both') === true, 'seller allowed on both side');
  assert(isInviteRoleAllowedForSide('tc', 'buy') === true, 'tc allowed on buy side');
  assert(isInviteRoleAllowedForSide('tc', 'sell') === true, 'tc allowed on sell side');
  assert(isInviteRoleAllowedForSide('tc', 'both') === true, 'tc allowed on both side');

  // store.createInvite: cross-side guard lives in the compute path.
  const store = createStore(memoryKV());

  const buyEscrow = await newEscrow(store, 'buy');
  const sellEscrow = await newEscrow(store, 'sell');
  const bothEscrow = await newEscrow(store, 'both');

  // Same-side invites succeed.
  await store.createInvite(buyEscrow.id, 'buyer', 'Alice Buyer');
  assert(true, 'buyer invite on buy-side escrow succeeds');
  await store.createInvite(sellEscrow.id, 'seller', 'Bob Seller');
  assert(true, 'seller invite on sell-side escrow succeeds');

  // TC invites always succeed.
  await store.createInvite(buyEscrow.id, 'tc', 'Tina TC');
  assert(true, 'tc invite on buy-side escrow succeeds');
  await store.createInvite(sellEscrow.id, 'tc', 'Tina TC');
  assert(true, 'tc invite on sell-side escrow succeeds');

  // Cross-side invites throw.
  let threw = false;
  try {
    await store.createInvite(buyEscrow.id, 'seller', 'Bob Seller');
  } catch {
    threw = true;
  }
  assert(threw, 'seller invite on buy-side escrow throws');

  threw = false;
  try {
    await store.createInvite(sellEscrow.id, 'buyer', 'Alice Buyer');
  } catch {
    threw = true;
  }
  assert(threw, 'buyer invite on sell-side escrow throws');

  // Legacy both-side escrows accept both roles.
  await store.createInvite(bothEscrow.id, 'buyer', 'Alice Buyer');
  await store.createInvite(bothEscrow.id, 'seller', 'Bob Seller');
  assert(true, 'both-side escrow accepts buyer and seller invites');

  // The preview path rejects too (same compute).
  threw = false;
  try {
    await store.previewCreateInvite(buyEscrow.id, 'seller', 'Bob Seller');
  } catch {
    threw = true;
  }
  assert(threw, 'previewCreateInvite rejects cross-side invite');

  summary('share_side');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exitCode = 1;
});
