// share_button_label.test.ts — REGRESSION: "Share this escrow" button label.
// (Anuraj, Oct 2026.)
//
// On the realtor transaction-detail screen the bottom button reads
// "Share this escrow" when no clients are added, and "View clients" once
// one or more clients are added. "Clients added" = at least one
// non-revoked buyer/seller invite for the escrow (TC invites do not
// count). Tap behavior is unchanged: it always pushes the share screen.
import { assert, summary } from './assert';
import { hasClientInvites, shareButtonTitle, visibleInvites } from '../src/lib/invites';
import type { Invite } from '../src/lib/types';

function invite(over: Partial<Invite>): Invite {
  return {
    id: 'inv-1',
    code: 'ABC123',
    escrowId: 'esc-1',
    role: 'buyer',
    partyName: 'Test Buyer',
    createdAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    redeemedAt: null,
    ...over,
  };
}

// ---- visibleInvites: revoked rows disappear, oldest first ----
assert(visibleInvites([]).length === 0, 'visibleInvites: empty stays empty');
const revoked = invite({ id: 'r', revokedAt: '2026-09-02T00:00:00.000Z' });
assert(visibleInvites([revoked]).length === 0, 'visibleInvites: revoked invite is hidden');
const newer = invite({ id: 'n', createdAt: '2026-09-03T00:00:00.000Z' });
const older = invite({ id: 'o', createdAt: '2026-09-01T00:00:00.000Z' });
const ordered = visibleInvites([newer, older]);
assert(
  ordered.length === 2 && ordered[0].id === 'o' && ordered[1].id === 'n',
  'visibleInvites: oldest first',
);

// ---- hasClientInvites ----
assert(hasClientInvites([]) === false, 'hasClientInvites: no invites -> false');
assert(
  hasClientInvites([invite({ revokedAt: '2026-09-02T00:00:00.000Z' })]) === false,
  'hasClientInvites: only revoked invites -> false',
);
assert(
  hasClientInvites([invite({ role: 'tc', partyName: 'Test TC' })]) === false,
  'hasClientInvites: only a TC invite -> false (TC does not count)',
);
assert(
  hasClientInvites([invite({ role: 'buyer' })]) === true,
  'hasClientInvites: one buyer invite -> true',
);
assert(
  hasClientInvites([invite({ role: 'seller', partyName: 'Test Seller' })]) === true,
  'hasClientInvites: one seller invite -> true',
);
assert(
  hasClientInvites([
    invite({ id: 'a', role: 'tc', partyName: 'Test TC' }),
    invite({ id: 'b', role: 'seller', partyName: 'Test Seller' }),
  ]) === true,
  'hasClientInvites: mixed TC + seller -> true',
);
assert(
  hasClientInvites([
    invite({ id: 'a', role: 'buyer', revokedAt: '2026-09-02T00:00:00.000Z' }),
    invite({ id: 'b', role: 'seller', partyName: 'Test Seller' }),
  ]) === true,
  'hasClientInvites: revoked buyer + live seller -> true',
);

// ---- shareButtonTitle ----
assert(
  shareButtonTitle(false) === 'Share this escrow',
  'shareButtonTitle: no clients -> "Share this escrow"',
);
assert(
  shareButtonTitle(true) === 'View clients',
  'shareButtonTitle: clients added -> "View clients"',
);

summary('share_button_label');
