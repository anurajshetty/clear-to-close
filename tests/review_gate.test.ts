// review_gate.test.ts — REGRESSION: client review gate on escrow status
// (Anuraj's rule, Sept 2026).
//
// A client can leave a review ONLY when the full checklist is 100% complete
// AND the escrow was not cancelled. A cancelled escrow never shows the
// review button, even if its checklist happens to be complete. The escrow
// status rides in the client view (get_client_view carries it explicitly
// since migration 0015); the local store maps it too.
//
// Covered here:
//  1. canLeaveReview: the exact gate predicate (100% + not cancelled,
//     fail-open on absent status, fails without the fix when a cancelled
//     escrow is 100% complete).
//  2. mapClientViewRpc maps escrow.status onto ClientView.status
//     (present value, absent payload, non-status garbage).
//
// The React screens are not unit-rendered (RN components are not importable
// in the node suite); the gate they call is covered here.
import { assert, summary } from './assert';
import { canLeaveReview } from '../src/lib/clientView';
import { mapClientViewRpc } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

// ---- 1. The gate predicate -----------------------------------------------
assert(canLeaveReview({ done: 5, total: 5, status: 'open' }) === true,
  'gate: 100% on an open escrow shows the review section');
assert(canLeaveReview({ done: 5, total: 5, status: 'closed' }) === true,
  'gate: 100% on a closed escrow shows the review section');
assert(canLeaveReview({ done: 5, total: 5, status: 'cancelled' }) === false,
  'gate: a cancelled escrow never shows the review button, even at 100%');
assert(canLeaveReview({ done: 4, total: 5, status: 'open' }) === false,
  'gate: an incomplete checklist hides the review section');
assert(canLeaveReview({ done: 0, total: 0, status: 'open' }) === false,
  'gate: an empty checklist (0/0) is not reviewable');
assert(canLeaveReview({ done: 5, total: 5 }) === true,
  'gate: absent status fails open (older cached views keep working)');
assert(canLeaveReview({ done: 6, total: 5, status: 'cancelled' }) === false,
  'gate: cancelled wins even when done exceeds total');

// ---- 2. The status reaches the client view from the RPC -------------------
function payloadWithStatus(status: unknown) {
  return {
    ok: true,
    escrow: { id: 'eid', address: 'A', city: 'C', close_date: '2026-11-25', status },
    buyer_steps: [
      { id: 's1', title: 'One', subtitle: '', done: true, custom: false, position: 0, completed_at: null },
    ],
    profile: { name: 'Rita' },
  };
}

const open = mapClientViewRpc(payloadWithStatus('open'));
assert(open.ok === true && open.view!.status === 'open',
  'rpc: escrow.status "open" maps onto ClientView.status');

const cancelled = mapClientViewRpc(payloadWithStatus('cancelled'));
assert(cancelled.ok === true && cancelled.view!.status === 'cancelled',
  'rpc: escrow.status "cancelled" maps onto ClientView.status');

const missing = mapClientViewRpc(payloadWithStatus(undefined));
assert(missing.ok === true && missing.view!.status === undefined,
  'rpc: absent escrow.status maps to undefined (gate fails open)');

const garbage = mapClientViewRpc(payloadWithStatus('on_hold'));
assert(garbage.ok === true && garbage.view!.status === undefined,
  'rpc: unknown escrow.status values are dropped, not trusted');

// The mapped status drives the real gate end to end.
const gatedView = cancelled.ok ? cancelled.view! : null;
assert(gatedView !== null && canLeaveReview(gatedView) === false,
  'end to end: a 100% cancelled escrow from the RPC is not reviewable');

summary('review_gate');
