// push_coalesce_quiet.test.ts — migration 0024 rules: quiet hours, morning
// queueing, coalescing, five-day check-ins, multi-escrow address copy,
// internal cron events, TC deep-link routing.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import {
  buildCoalescedBody,
  buildPushBody,
  buildQuietCheckinBody,
  daysUntilClose,
  isQuietHour,
  nextMorning8am,
  parseTriggerPayload,
  resolveZone,
  withAddress,
} from '../supabase/functions/send-client-push/push';
import { escrowRouteFromResponse } from '../src/lib/push';

declare const process: { exitCode?: number };

const LA = 'America/Los_Angeles';
const KOLKATA = 'Asia/Kolkata';

function main(): void {
  // ---- quiet hours: 21:00–08:00 client-local ----
  assert(isQuietHour(new Date('2026-09-28T21:00:00-07:00'), LA) === true, 'quiet: 21:00 LA is quiet');
  assert(isQuietHour(new Date('2026-09-28T20:59:59-07:00'), LA) === false, 'quiet: 20:59 LA is not');
  assert(isQuietHour(new Date('2026-09-28T07:59:59-07:00'), LA) === true, 'quiet: 07:59 LA is quiet');
  assert(isQuietHour(new Date('2026-09-28T08:00:00-07:00'), LA) === false, 'quiet: 08:00 LA is not');
  assert(isQuietHour(new Date('2026-09-28T12:00:00-07:00'), LA) === false, 'quiet: noon LA is not');
  // Timezone-aware: 15:30 UTC = 21:00 IST -> quiet; 14:00 UTC = 19:30 IST -> not.
  assert(isQuietHour(new Date('2026-09-28T15:30:00Z'), KOLKATA) === true, 'quiet: 21:00 IST is quiet');
  assert(isQuietHour(new Date('2026-09-28T14:00:00Z'), KOLKATA) === false, 'quiet: 19:30 IST is not');
  // Unknown zone falls back, never throws.
  assert(resolveZone(null) === 'America/Los_Angeles', 'null zone falls back to LA');
  assert(resolveZone('Mars/Olympus') === 'America/Los_Angeles', 'garbage zone falls back');
  assert(typeof isQuietHour(new Date(), 'Mars/Olympus') === 'boolean', 'quiet hours tolerate garbage zone');

  // ---- nextMorning8am: next 08:00 local, strictly after now ----
  const wake1 = nextMorning8am(new Date('2026-09-28T22:00:00-07:00'), LA);
  assert(wake1.toISOString() === '2026-09-29T15:00:00.000Z', 'wake: 10pm LA -> next 8am PDT');
  const wake2 = nextMorning8am(new Date('2026-09-28T09:00:00-07:00'), LA);
  assert(wake2.toISOString() === '2026-09-29T15:00:00.000Z', 'wake: 9am LA -> tomorrow 8am');
  const wake3 = nextMorning8am(new Date('2026-09-28T07:00:00-07:00'), LA);
  assert(wake3.toISOString() === '2026-09-28T15:00:00.000Z', 'wake: 7am LA -> same morning 8am');
  const wakeK = nextMorning8am(new Date('2026-09-28T16:00:00Z'), KOLKATA);
  // 16:00Z = 21:30 IST; next 08:00 IST = 02:30Z next day.
  assert(wakeK.toISOString() === '2026-09-29T02:30:00.000Z', 'wake: 21:30 IST -> next 8am IST');

  // ---- daysUntilClose: client-local day counting ----
  assert(daysUntilClose('2026-10-08', new Date('2026-09-28T12:00:00-07:00'), LA) === 10, 'days: 10 to close');
  assert(daysUntilClose('2026-09-28', new Date('2026-09-28T12:00:00-07:00'), LA) === 0, 'days: today is 0');
  assert(daysUntilClose('2026-09-27', new Date('2026-09-28T12:00:00-07:00'), LA) === -1, 'days: past is -1');
  // 23:30 PDT Sept 28 is already Sept 29 in IST -> whole-day boundary is zoned.
  assert(daysUntilClose('2026-09-29', new Date('2026-09-29T06:30:00Z'), KOLKATA) === 0, 'days: zoned day boundary');
  assert(daysUntilClose('not-a-date', new Date(), LA) === 0, 'days: malformed date is 0');

  // ---- coalesced copy (approved Sept 28 2026) ----
  assert(buildCoalescedBody(2) === 'Your realtor completed 2 steps.', 'coalesced: 2 steps');
  assert(buildCoalescedBody(3) === 'Your realtor completed 3 steps.', 'coalesced: 3 steps');

  // ---- quiet check-in bodies ----
  assert(
    buildQuietCheckinBody(4, 12, 10) ===
      'Your escrow is on track: 4 of 12 steps done, closing in 10 days.',
    'checkin: on-track variant',
  );
  assert(
    buildQuietCheckinBody(11, 12, 3) === 'Closing is 3 days away, 1 step still to go.',
    'checkin: closing-soon variant',
  );
  assert(
    buildQuietCheckinBody(11, 12, 1) === 'Closing is 1 day away, 1 step still to go.',
    'checkin: singular day',
  );
  assert(
    buildQuietCheckinBody(12, 12, 10) === null,
    'checkin: all-complete gets nothing',
  );
  assert(buildQuietCheckinBody(0, 0, 10) === null, 'checkin: zero total gets nothing');

  // ---- no em dashes anywhere in push copy (standing rule) ----
  const copies: Array<string | null> = [
    buildPushBody('step_done', 'Maya', 'Home inspection', null),
    buildCoalescedBody(3),
    buildQuietCheckinBody(4, 12, 10),
    buildQuietCheckinBody(11, 12, 3),
    buildPushBody('key_dates_changed', 'Maya', null, null),
    buildPushBody('close_date_changed', 'Maya', null, '2026-11-15'),
    buildPushBody('inspection_deadline_changed', 'Maya', null, null, '2026-10-15'),
  ];
  for (const c of copies) {
    assert(c !== null && !c.includes('—') && !c.includes('–'), `no em/en dash in: ${c}`);
  }

  // ---- multi-escrow address copy ----
  const body = 'Your realtor just completed Home inspection.';
  assert(withAddress(body, '123 Main St', false) === body, 'address: single escrow unchanged');
  assert(
    withAddress(body, '123 Main St', true) === 'Your realtor just completed Home inspection. (123 Main St)',
    'address: multi-escrow names the property',
  );
  assert(withAddress(body, '', true) === body, 'address: blank address leaves copy alone');

  // ---- internal cron events parse bare ----
  const flush = parseTriggerPayload({ event: 'flush_step_pushes' });
  assert(flush !== null && flush.event === 'flush_step_pushes' && flush.escrow_id === null, 'flush event parses bare');
  const sweep = parseTriggerPayload({ event: 'quiet_checkin_sweep' });
  assert(sweep !== null && sweep.event === 'quiet_checkin_sweep' && sweep.escrow_id === null, 'sweep event parses bare');
  assert(parseTriggerPayload({ event: 'step_done' }) === null, 'step_done still requires escrow_id');

  // ---- TC deep-link routing ----
  const tc = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'tc' } } } },
  });
  assert(tc !== null && tc.role === 'tc' && tc.escrowId === 'esc-9', 'tap routes tc role');
  const seller = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'seller' } } } },
  });
  assert(seller !== null && seller.role === 'seller', 'tap routes seller role');
  const unknown = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'weird' } } } },
  });
  assert(unknown !== null && unknown.role === 'buyer', 'unknown role defaults to buyer');

  summary('push_coalesce_quiet');
}

main();
