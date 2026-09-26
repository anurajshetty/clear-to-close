// uniqueness.test.ts — invite codes are globally unique across escrows.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  const store = createStore(memoryKV());

  const escrowIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = await store.createEscrow({
      address: `${100 + i} Test Way`,
      city: 'Santa Clarita',
      side: i % 2 === 0 ? 'both' : 'buy',
      buyerName: `Buyer ${i}`,
      sellerName: `Seller ${i}`,
      openDate: '2026-09-01',
      closeDate: '2026-12-01',
    });
    escrowIds.push(e.id);
  }

  const codes = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const escrowId = escrowIds[i % escrowIds.length];
    const role = i % 2 === 0 ? 'buyer' : 'seller';
    // The two-per-side cap is active: revoke each invite right after minting
    // so the next one fits under the cap — uniqueness is unaffected.
    const inv = await store.createInvite(escrowId, role, `Party ${i}`);
    codes.add(inv.code);
    await store.revokeInvite(inv.id);
  }

  assert(codes.size === 5000, `all 5000 codes unique across escrows (Set size ${codes.size})`);

  summary('uniqueness.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
