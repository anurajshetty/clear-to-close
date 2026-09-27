// topcard_colors.test.ts — REGRESSION: client top-card light theme
// (celebration redesign, Anuraj's call, Sept 2026).
//
//  1. All client cards are back on the LIGHT theme: the top card sits on
//     solid white (token shared with the component's hero style) — no dark
//     teal anywhere.
//  2. The "days left" number is ink normally, amber at 7 or fewer days, red
//     at 3 or fewer days (restyled to read on the light background).
//  3. No pill logic anywhere (Anuraj's call, Sept 2026): the ahead-of-pace
//     pill AND the completion pill are both gone — topCardPill no longer
//     exists.
import { assert, summary } from './assert';
import {
  CLIENT_TOPCARD_BG,
  DAYS_LEFT_COLORS,
  daysLeftTone,
} from '../src/lib/topCard';
import * as topCardModule from '../src/lib/topCard';

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

// 3. No pill logic anywhere (Anuraj's call, Sept 2026): the ahead-of-pace
// pill and the completion pill are both gone — topCardPill is removed.
assert(!('topCardPill' in topCardModule), 'topCardPill removed from src/lib/topCard');

summary('topcard_colors');
