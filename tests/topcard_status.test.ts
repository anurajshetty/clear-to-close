// topcard_status.test.ts — REGRESSION: client top-card escrow status tag
// (Anuraj's call, Sept 2026).
//
// The top card shows the escrow status next to the "YOUR TRANSACTION"
// kicker: "In progress" or "Completed". The label mirrors the
// get_client_view status semantics (migration 0015): "Completed" once the
// checklist is 100% done or the escrow row itself is closed; anything else
// (including an absent status on older cached views) is "In progress".
//
// The React component itself is not unit-rendered (RN components are not
// importable in the node suite); the pure label helper is covered here.
import { assert, summary } from './assert';
import { escrowStatusLabel } from '../src/lib/clientView';

// Mid-escrow: in progress.
assert(escrowStatusLabel({ done: 0, total: 0 }) === 'In progress',
  'empty checklist (0/0) is In progress');
assert(escrowStatusLabel({ done: 4, total: 5, status: 'open' }) === 'In progress',
  'partial checklist on an open escrow is In progress');
assert(escrowStatusLabel({ done: 0, total: 5, status: 'cancelled' }) === 'In progress',
  'cancelled escrow with an incomplete checklist is In progress');

// 100%: Completed.
assert(escrowStatusLabel({ done: 5, total: 5, status: 'open' }) === 'Completed',
  '100% checklist flips the tag to Completed');
assert(escrowStatusLabel({ done: 5, total: 5 }) === 'Completed',
  '100% with absent status still flips to Completed');
assert(escrowStatusLabel({ done: 6, total: 5, status: 'open' }) === 'Completed',
  'done exceeding total is Completed');
assert(escrowStatusLabel({ done: 5, total: 5, status: 'cancelled' }) === 'Completed',
  '100% on a cancelled escrow still flips to Completed (the review gate, not the tag, handles cancelled)');

// Closed escrow row: Completed even mid-checklist.
assert(escrowStatusLabel({ done: 4, total: 5, status: 'closed' }) === 'Completed',
  'closed escrow is Completed even with a partial checklist');
assert(escrowStatusLabel({ done: 0, total: 0, status: 'closed' }) === 'Completed',
  'closed escrow with no steps is Completed');

summary('topcard_status');
