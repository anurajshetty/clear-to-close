// invite_resolve.test.ts — branded invite deep link resolution (Sept 2026).
//
// Contract:
//   * store.resolveInviteRealtor(code) returns the inviting realtor's public
//     branding (name, photo, realty_group, DRE) for a live invite, and the
//     redeem_invite-style error for a dead one — without redeeming anything.
//   * Local path resolves against the local invite + profile.
//   * Cloud path calls the resolve_invite_realtor RPC (p_code, uppercased)
//     and maps its payload; RPC/timeout failure reports 'network', never a
//     code verdict.
//   * Field names are contractual: realtor.name / photoUrl / realtyGroup /
//     dreLicense.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { resolveInviteRealtor } from '../src/lib/cloudSync';
import type { RealtorProfile } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

function fullProfile(): RealtorProfile {
  return {
    name: 'Maya Sharma',
    realty_group: 'Compass Realty',
    photoUri: null,
    banner_image: null,
    about: 'About Maya',
    yearsExperience: '9',
    avgDaysToClose: '21',
    areasServed: 'Santa Clarita',
    phone: '555-0100',
    dreLicense: '01998877',
    reviews: [],
    rating: null,
  };
}

/** Mock cloud client capturing rpc() calls. */
function mockRpc(handler: (fn: string, params: Record<string, unknown>) => unknown) {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      return handler(fn, params);
    },
  };
  return { client: client as never, calls };
}

async function main(): Promise<void> {
  async function seededStore() {
    const store = createStore(memoryKV());
    await store.saveProfile(fullProfile());
    const escrow = await store.createEscrow({
      address: '123 Test St',
      city: 'Testville',
      side: 'buy',
      buyerName: 'Jordan Lee',
      openDate: '2026-09-01',
      closeDate: '2026-11-01',
    });
    return { store, escrowId: escrow.id };
  }

  // 1. local: live invite resolves to the realtor's branding
  {
    const { store, escrowId } = await seededStore();
    const inv = await store.createInvite(escrowId, 'buyer', 'Jordan Lee');
    const res = await store.resolveInviteRealtor(inv.code);
    assert(res.ok === true, 'live invite resolves ok');
    if (res.ok) {
      assert(res.realtor.name === 'Maya Sharma', 'branding carries the realtor name');
      assert(res.realtor.realtyGroup === 'Compass Realty', 'branding carries realty_group');
      assert(res.realtor.dreLicense === '01998877', 'branding carries the DRE');
    }
    // Resolving must not redeem: the code still redeems afterwards.
    const redeem = await store.redeemInvite(inv.code, 'Jordan Lee', 'dev-1');
    assert(redeem.ok === true, 'resolve does not consume the invite');
  }

  // 2. local: dead codes get the specific error
  {
    const { store, escrowId } = await seededStore();
    const inv = await store.createInvite(escrowId, 'buyer', 'Jordan Lee');
    const bad = await store.resolveInviteRealtor('ZZZZZZ');
    assert(!bad.ok && bad.error === 'invalid', 'unknown code -> invalid');
    await store.revokeInvite(inv.id);
    const revoked = await store.resolveInviteRealtor(inv.code);
    assert(!revoked.ok && revoked.error === 'revoked', 'revoked invite -> revoked');
    const inv2 = await store.createInvite(escrowId, 'seller', 'Asha Rao');
    await store.redeemInvite(inv2.code, 'Asha Rao', 'dev-2');
    const used = await store.resolveInviteRealtor(inv2.code);
    assert(!used.ok && used.error === 'already_used', 'redeemed invite -> already_used');
  }

  // 3. cloud: RPC name, uppercased code param, payload mapping
  {
    const { client, calls } = mockRpc((fn, params) => {
      assert(fn === 'resolve_invite_realtor', 'cloud path calls resolve_invite_realtor');
      assert(params.p_code === 'ABC123', 'code is uppercased for the RPC');
      return {
        data: {
          ok: true,
          realtor: {
            name: 'Maya Sharma',
            photo_url: 'https://cdn.example/maya.jpg',
            realty_group: 'Compass Realty',
            dre_license: '01998877',
            realtor_id: 'user-9',
          },
        },
        error: null,
      };
    });
    const res = await resolveInviteRealtor(client, 'abc123');
    assert(calls.length === 1, 'one RPC call');
    assert(res.ok === true, 'cloud resolve ok');
    if (res.ok) {
      assert(res.realtor.photoUrl === 'https://cdn.example/maya.jpg', 'photo_url maps to photoUrl');
      assert(res.realtor.realtyGroup === 'Compass Realty', 'realty_group maps to realtyGroup');
      assert(res.realtor.realtorId === 'user-9', 'realtor_id maps to realtorId');
    }
  }

  // 4. cloud: error payload mapping + failure -> network
  {
    const { client } = mockRpc(() => ({ data: { ok: false, error: 'revoked' }, error: null }));
    const res = await resolveInviteRealtor(client, 'ABC123');
    assert(!res.ok && res.error === 'revoked', 'revoked payload maps to revoked');
    const { client: badClient } = mockRpc(() => {
      throw new Error('boom');
    });
    const net = await resolveInviteRealtor(badClient, 'ABC123');
    assert(!net.ok && net.error === 'network', 'RPC throw -> network, never a code verdict');
    const empty = await resolveInviteRealtor(badClient, '   ');
    assert(!empty.ok && empty.error === 'invalid', 'blank code -> invalid without RPC');
  }

  summary('invite_resolve');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
