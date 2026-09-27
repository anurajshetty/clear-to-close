// topcard_colors.test.ts — REGRESSION: client top-card light theme
// (celebration redesign, Anuraj's call, Sept 2026).
//
//  1. All client cards are back on the LIGHT theme: the top card sits on
//     solid white (token shared with the component's hero style) — no dark
//     teal anywhere.
//  2. The "days left" number is ink normally, amber at 7 or fewer days, red
//     at 3 or fewer days (restyled to read on the light background).
//  3. At 100% the mid-card completion pill stays visible: the ONLY
//     per-status changes on the top card are the status tag flip and the
//     confetti burst. topCardPill therefore returns the completion pill at
//     100% instead of suppressing it. The ahead-of-pace pill is gone
//     (Anuraj's call, Sept 2026): mid-escrow, topCardPill returns null.
import { assert, summary } from './assert';
import {
  CLIENT_TOPCARD_BG,
  DAYS_LEFT_COLORS,
  daysLeftTone,
  topCardPill,
} from '../src/lib/topCard';

// 1. Light theme: white card, no dark teal.
assert(CLIENT_TOPCARD_BG === '#FFFFFF', `card background is white (got ${CLIENT_TOPCARD_BG})`);
assert(String(CLIENT_TOPCARD_BG) !== '#011E1D', 'no dark-teal top card');
assert(/^#[0-9A-Fa-f]{6}$/.test(CLIENT_TOPCARD_BG), 'background token is a 6-digit hex');
assert(
  DAYS_LEFT_COLORS.default === '#211D17' &&
  DAYS_LEFT_COLORS.warn === '#A86A12' &&
  DAYS_LEFT_COLORS.alert === '#B23B3B',
  'days-left palette is ink / amber / red (readable on white)',
);

// 2. Days-left color thresholds.
assert(daysLeftTone(10) === 'default', '10 days left -> default color');
assert(daysLeftTone(8) === 'default', '8 days left -> default color');
assert(daysLeftTone(7) === 'warn', '7 days left -> amber');
assert(daysLeftTone(5) === 'warn', '5 days left -> amber');
assert(daysLeftTone(4) === 'warn', '4 days left -> amber');
assert(daysLeftTone(3) === 'alert', '3 days left -> red');
assert(daysLeftTone(1) === 'alert', '1 day left -> red');
assert(daysLeftTone(30) === 'default', '30 days left -> default color');

// 3. Completion/pace pill stays visible at 100%.
const spare = topCardPill({ done: 5, total: 5, daysToClose: 10, name: 'Jane Rao' });
assert(spare?.kind === 'completion', '100% with 10 days left returns the completion pill');
assert(
  spare?.kind === 'completion' && spare.text.includes('10 days to spare'),
  '100% spare copy names the days to spare',
);

const plain = topCardPill({ done: 5, total: 5, daysToClose: 2, name: 'Jane Rao' });
assert(
  plain?.kind === 'completion' && plain.text === 'Congratulations, your checklist is complete',
  '100% with few days left keeps the unchanged congratulations line',
);

// Mid-escrow: no pill at all (the ahead-of-pace pill is gone).
assert(
  topCardPill({ done: 8, total: 10, daysToClose: 30, name: 'Jane Rao' }) === null,
  'mid-escrow -> no pill (ahead-of-pace removed)',
);

// Empty checklist: no pill.
assert(
  topCardPill({ done: 0, total: 0, daysToClose: 30, name: 'Jane Rao' }) === null,
  '0/0 checklist -> no pill',
);

summary('topcard_colors');
