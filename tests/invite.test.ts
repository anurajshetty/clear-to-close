// invite.test.ts — invite lifecycle: create, redeem, revoke, errors, concurrency.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  const store = createStore(memoryKV());

  const escrow = await store.createEscrow({
    address: '123 Main St',
    city: 'Santa Clarita',
    side: 'both',
    buyerName: 'Alice Buyer',
    sellerName: 'Bob Seller',
    openDate: '2026-09-01',
    closeDate: '2026-10-15',
  });

  // Code format: 6 chars from the unambiguous alphabet.
  const buyerInvite = await store.createInvite(escrow.id, 'buyer', 'Alice Buyer');
  assert(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(buyerInvite.code), 'buyer code is 6 chars from the safe alphabet');

  // Happy buyer redeem.
  const r1 = await store.redeemInvite(buyerInvite.code, 'Alice Buyer');
  assert(r1.ok === true, 'happy buyer redeem ok');
  if (r1.ok) {
    assert(r1.role === 'buyer', 'buyer redeem role is buyer');
    assert(r1.escrowId === escrow.id, 'buyer redeem escrowId matches');
    assert(r1.partyName === 'Alice Buyer', 'buyer redeem partyName matches');
    assert(typeof r1.linkId === 'string' && r1.linkId.length > 0, 'buyer redeem returns linkId');
  }

  // Happy seller redeem.
  const sellerInvite = await store.createInvite(escrow.id, 'seller', 'Bob Seller');
  const r2 = await store.redeemInvite(sellerInvite.code, 'Bob Seller');
  assert(r2.ok === true, 'happy seller redeem ok');
  if (r2.ok) {
    assert(r2.role === 'seller', 'seller redeem role is seller');
    assert(r2.role !== 'buyer', 'seller role can never be buyer');
    assert(r2.escrowId === escrow.id, 'seller redeem escrowId matches');
  }
  assert(r1.ok && r1.role !== 'seller', 'buyer redeem role can never be seller');

  // Second redeem of the same code -> already_used.
  const r3 = await store.redeemInvite(buyerInvite.code, 'Alice Buyer');
  assert(!r3.ok && r3.error === 'already_used', 'second redeem of same code -> already_used');

  // Wrong name (right code) -> name_mismatch.
  const inv3 = await store.createInvite(escrow.id, 'buyer', 'Carol Buyer');
  const r4 = await store.redeemInvite(inv3.code, 'Wrong Name');
  assert(!r4.ok && r4.error === 'name_mismatch', 'wrong name -> name_mismatch');

  // Revoked code -> revoked (revoke blocks future redemption).
  const inv4 = await store.createInvite(escrow.id, 'seller', 'Dave Seller');
  await store.revokeInvite(inv4.id);
  const r5 = await store.redeemInvite(inv4.code, 'Dave Seller');
  assert(!r5.ok && r5.error === 'revoked', 'revoked code -> revoked');

  // Unknown code -> invalid.
  const r6 = await store.redeemInvite('ZZZZZZ', 'Nobody');
  assert(!r6.ok && r6.error === 'invalid', 'unknown code -> invalid');

  // Name normalization: different case / extra spaces still redeem.
  const inv5 = await store.createInvite(escrow.id, 'buyer', 'Eve Buyer');
  const r7 = await store.redeemInvite('  ' + inv5.code.toLowerCase() + ' ', '  eVe bUYER ');
  assert(r7.ok === true, 'code/name normalization (case + spaces) redeems ok');

  // Concurrent double redeem: exactly one winner.
  const inv6 = await store.createInvite(escrow.id, 'buyer', 'Frank Buyer');
  const [c1, c2] = await Promise.all([
    store.redeemInvite(inv6.code, 'Frank Buyer'),
    store.redeemInvite(inv6.code, 'Frank Buyer'),
  ]);
  const oks = [c1, c2].filter((r) => r.ok).length;
  const alreadyUsed = [c1, c2].filter((r) => !r.ok && r.error === 'already_used').length;
  assert(oks === 1 && alreadyUsed === 1, 'concurrent double redeem -> exactly one ok, one already_used');

  // listInvites returns invites for the escrow.
  const invites = await store.listInvites(escrow.id);
  assert(invites.length === 6, `listInvites returns all 6 invites (got ${invites.length})`);

  summary('invite.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
