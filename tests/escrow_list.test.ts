// escrow_list.test.ts — multi-escrow list logic (Anuraj-approved, Sept 28, 2026).
//
// The list screen's decisions are pure functions in src/lib/escrowList.ts:
//  - routing: 0 links -> redeem, 1 link -> open directly, 2+ links -> list
//  - conditional "My escrows" back (2+ links)
//  - completed entries are read-only (dimmed, no navigation target)
//  - approved sort: in-progress first, completed second, newest-updated
//    first within each group
//  - realtor initials fallback (teal circle) when no photo
import { assert, summary } from './assert';
import {
  routeForLinks,
  showEscrowListBack,
  isReadOnlyEntry,
  buildEscrowListEntry,
  sortEscrowListEntries,
  type EscrowListEntry,
} from '../src/lib/escrowList';
import type { DeviceClientLink } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const link = (over: Partial<DeviceClientLink> = {}): DeviceClientLink => ({
  linkId: 'l1', escrowId: 'e1', role: 'buyer', partyName: 'Priya Nair', deviceId: 'dev-1', ...over,
});
const summary_ = (over: Partial<EscrowListEntry['summary']> = {}): EscrowListEntry['summary'] => ({
  address: '1 Main St', city: 'Santa Clarita', done: 0, total: 3, ...over,
});

async function main(): Promise<void> {
  // ------------------------------------------------------- routing --------
  assert(routeForLinks([]).kind === 'redeem', '0 links -> redeem');
  const one = routeForLinks([link()]);
  assert(one.kind === 'direct' && one.link.escrowId === 'e1',
    '1 link -> direct to that escrow');
  assert(routeForLinks([link(), link({ linkId: 'l2', escrowId: 'e2' })]).kind === 'list',
    '2 links -> the escrow list');
  assert(routeForLinks([link(), link({ linkId: 'l2', escrowId: 'e2' }), link({ linkId: 'l3', escrowId: 'e3' })]).kind === 'list',
    '3 links -> the escrow list');

  // --------------------------------------- conditional "My escrows" -------
  assert(showEscrowListBack(2) === true, '2 links -> My escrows back shown');
  assert(showEscrowListBack(1) === false, '1 link -> no My escrows back');
  assert(showEscrowListBack(0) === false, '0 links -> no My escrows back');

  // -------------------------------------- completed read-only ------------
  assert(isReadOnlyEntry('completed') === true, 'completed entry is read-only');
  assert(isReadOnlyEntry('progress') === false, 'in-progress entry is tappable');

  // --------------------------------------------- row construction ----------
  const entry = buildEscrowListEntry(link(), summary_(), 'Rita Realtor', null);
  assert(entry.summary.address === '1 Main St' && entry.summary.city === 'Santa Clarita',
    'row shows address/city');
  assert(entry.realtorName === 'Rita Realtor', 'realtor name shown');
  assert(entry.realtorInitials === 'RR', 'initials from first+last name');
  assert(entry.realtorPhoto === null, 'no photo -> initials fallback');
  assert(entry.state === 'progress', 'open escrow -> in-progress state');
  assert(buildEscrowListEntry(link(), summary_(), 'Madonna', null).realtorInitials === 'M',
    'single-name initial');
  assert(buildEscrowListEntry(link(), summary_(), '  ', null).realtorInitials === '?',
    'blank name -> placeholder initial');
  const closed = buildEscrowListEntry(link(), summary_({ status: 'closed' }), 'Rita Realtor', 'https://x/p.jpg');
  assert(closed.state === 'completed' && closed.realtorPhoto === 'https://x/p.jpg',
    'closed escrow -> completed state, photo kept');
  const allDone = buildEscrowListEntry(link(), summary_({ done: 3, total: 3 }), 'Rita Realtor', null);
  assert(allDone.state === 'completed', 'all steps done -> completed state');

  // ------------------------------------------------------- sorting --------
  const e = (id: string, status: 'open' | 'closed' | 'cancelled' | undefined, updatedAt?: string): EscrowListEntry =>
    buildEscrowListEntry(link({ linkId: id, escrowId: id }), summary_({ status, updatedAt }), 'R', null);
  const sorted = sortEscrowListEntries([
    e('done-old', 'closed', '2026-09-20T00:00:00Z'),
    e('prog-old', 'open', '2026-09-21T00:00:00Z'),
    e('done-new', 'closed', '2026-09-27T00:00:00Z'),
    e('prog-new', 'open', '2026-09-28T00:00:00Z'),
    e('prog-nodate', 'open', undefined),
  ]);
  const ids = sorted.map((x) => x.link.escrowId);
  assert(JSON.stringify(ids) === JSON.stringify(['prog-new', 'prog-old', 'prog-nodate', 'done-new', 'done-old']),
    `in-progress first, completed second, newest-updated first in each group (got ${JSON.stringify(ids)})`);
  // Sort does not mutate its input.
  const input = [e('a', 'closed'), e('b', 'open')];
  sortEscrowListEntries(input);
  assert(input[0].link.escrowId === 'a', 'sort is non-mutating');

  summary('escrow_list');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
