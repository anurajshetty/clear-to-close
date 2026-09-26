// invite.test.ts — invite lifecycle: create, redeem, revoke, errors, concurrency,
// plus the two-per-side matrix (approved invite-client flow, Sept 2026).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { MAX_CLIENTS_PER_SIDE } from '../src/lib/store';

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
  const store = createStore(memoryKV());

  const escrow = await newEscrow(store, 'both');

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

  // Name normalization: different case / extra spaces still redeem (fresh escrow).
  const normEscrow = await newEscrow(store, 'buy');
  const inv5 = await store.createInvite(normEscrow.id, 'buyer', 'Eve Buyer');
  const r7 = await store.redeemInvite('  ' + inv5.code.toLowerCase() + ' ', '  eVe bUYER ');
  assert(r7.ok === true, 'code/name normalization (case + spaces) redeems ok');

  // Concurrent double redeem: exactly one winner (fresh escrow).
  const concEscrow = await newEscrow(store, 'buy');
  const inv6 = await store.createInvite(concEscrow.id, 'buyer', 'Frank Buyer');
  const [c1, c2] = await Promise.all([
    store.redeemInvite(inv6.code, 'Frank Buyer'),
    store.redeemInvite(inv6.code, 'Frank Buyer'),
  ]);
  const oks = [c1, c2].filter((r) => r.ok).length;
  const alreadyUsed = [c1, c2].filter((r) => !r.ok && r.error === 'already_used').length;
  assert(oks === 1 && alreadyUsed === 1, 'concurrent double redeem -> exactly one ok, one already_used');

  // listInvites returns invites for the escrow.
  const invites = await store.listInvites(escrow.id);
  assert(invites.length === 4, `listInvites returns all 4 invites (got ${invites.length})`);

  // ---------------------------------------------------------------------------
  // Two-per-side matrix (approved invite-client flow, Sept 2026).
  // ---------------------------------------------------------------------------
  assert(MAX_CLIENTS_PER_SIDE === 2, 'MAX_CLIENTS_PER_SIDE is 2');
  const m = await newEscrow(store, 'both');

  // 1-2. First and second same-side invite succeed; third active same-side
  // invite fails.
  const b1 = await store.createInvite(m.id, 'buyer', 'Buyer One');
  const b2 = await store.createInvite(m.id, 'buyer', 'Buyer Two');
  assert(b1.role === 'buyer' && b2.role === 'buyer', 'first and second buyer invite succeed');
  let thirdErr: unknown = null;
  try {
    await store.createInvite(m.id, 'buyer', 'Buyer Three');
  } catch (e) {
    thirdErr = e;
  }
  assert(thirdErr !== null, 'third active buyer invite fails (cap of 2)');

  // 3. Buyer/seller caps are independent: two sellers succeed alongside.
  const s1 = await store.createInvite(m.id, 'seller', 'Seller One');
  const s2 = await store.createInvite(m.id, 'seller', 'Seller Two');
  assert(s1.role === 'seller' && s2.role === 'seller', 'seller cap is independent of buyer cap');
  let thirdSellerErr: unknown = null;
  try {
    await store.createInvite(m.id, 'seller', 'Seller Three');
  } catch (e) {
    thirdSellerErr = e;
  }
  assert(thirdSellerErr !== null, 'third active seller invite fails (cap of 2)');

  // 4. Revoking one frees the slot: a new buyer invite succeeds.
  await store.revokeInvite(b1.id);
  const b3 = await store.createInvite(m.id, 'buyer', 'Buyer Three');
  assert(b3.role === 'buyer', 'revoking one frees the slot for a new buyer invite');
  // The revoked invite no longer counts toward the cap: the cap is at 2 again.
  let fourthErr: unknown = null;
  try {
    await store.createInvite(m.id, 'buyer', 'Buyer Four');
  } catch (e) {
    fourthErr = e;
  }
  assert(fourthErr !== null, 'cap still enforced after revoke (2 active buyers)');
  // listInvites surfaces all rows (including revoked); the client-list UI
  // filters to active ones — the revoked row is gone from the list.
  const activeBuyerInvites = (await store.listInvites(m.id)).filter(
    (i) => i.role === 'buyer' && !i.revokedAt,
  );
  assert(
    activeBuyerInvites.length === 2 &&
      activeBuyerInvites.some((i) => i.partyName === 'Buyer Two') &&
      activeBuyerInvites.some((i) => i.partyName === 'Buyer Three'),
    'listInvites shows the two active buyers after revoke',
  );

  // 5. Redeem changes only that row to Accepted.
  const cap = await newEscrow(store, 'both');
  const c1i = await store.createInvite(cap.id, 'buyer', 'Buyer Alpha');
  const c2i = await store.createInvite(cap.id, 'buyer', 'Buyer Beta');
  const rc1 = await store.redeemInvite(c1i.code, 'Buyer Alpha');
  assert(rc1.ok === true, 'first buyer redeems ok');
  const after = (await store.listInvites(cap.id)).filter((i) => i.role === 'buyer');
  const rowA = after.find((i) => i.id === c1i.id);
  const rowB = after.find((i) => i.id === c2i.id);
  assert(!!rowA?.redeemedAt && !rowB?.redeemedAt, 'redeem sets Accepted only on that row');

  // 6. Regeneration affects only the selected client.
  const regen = await store.regenerateInvite(c1i.id);
  assert(regen.invite.partyName === 'Buyer Alpha', 'regenerated code keeps the same party');
  assert(regen.invite.code !== c1i.code, 'regenerated code is fresh');
  assert(!regen.invite.redeemedAt, 'regenerated code is unredeemed (Invited)');
  const postRegen = await store.listInvites(cap.id);
  const rowBAfter = postRegen.find((i) => i.id === c2i.id);
  assert(rowBAfter?.code === c2i.code, 'other client row is untouched by regeneration');
  const rb = await store.redeemInvite(c2i.code, 'Buyer Beta');
  assert(rb.ok === true, 'other client code still redeems after regeneration');
  const oldCodeRedeem = await store.redeemInvite(c1i.code, 'Buyer Alpha');
  assert(!oldCodeRedeem.ok && oldCodeRedeem.error === 'revoked', 'old code dies on regeneration');
  const newCodeRedeem = await store.redeemInvite(regen.invite.code, 'Buyer Alpha', 'regen-device-1');
  assert(newCodeRedeem.ok === true, 'new code redeems ok');

  // 7. Revoke kills only the selected client's link/access.
  const rev = await newEscrow(store, 'both');
  const k1 = await store.createInvite(rev.id, 'buyer', 'Buyer K1');
  const k2 = await store.createInvite(rev.id, 'buyer', 'Buyer K2');
  const rk1 = await store.redeemInvite(k1.code, 'Buyer K1', 'device-k1');
  const rk2 = await store.redeemInvite(k2.code, 'Buyer K2', 'device-k2');
  assert(rk1.ok && rk2.ok, 'both buyers redeem ok');
  const link1 = rk1.ok ? rk1.linkId : '';
  const link2 = rk2.ok ? rk2.linkId : '';
  await store.revokeInvite(k1.id);
  const v1 = await store.validateClientLink(link1);
  const v2 = await store.validateClientLink(link2);
  assert(v1.valid === false, 'revoked client link is dead');
  assert(v2.valid === true, 'other client link stays alive');
  const reRedeemK1 = await store.redeemInvite(k1.code, 'Buyer K1');
  assert(!reRedeemK1.ok && reRedeemK1.error === 'revoked', 'revoked invite code can never redeem again');

  summary('invite.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
