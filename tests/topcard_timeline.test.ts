// topcard_timeline.test.ts — client top-card timeline + viewport fit
// (approved client-home-timeline sample, Anuraj, Sept 2026).
//
//  1. escrowTimelineFill: time-elapsed fraction between the open and
//     close dates, clamped to [0, 1]; null when either date is
//     missing/invalid (the card hides the timeline instead of guessing);
//     degenerate ranges (close on/before open) read complete once the open
//     date arrives.
//  2. formatMonthDay: "Sep 1" labels; null on invalid input.
//  3. Height ladder: roomy/compact/ultra at the 760/660 breakpoints.
//  4. topCardTokens: on tall screens the tokens ARE the exact approved
//     sample tokens (roomy + 390 = TOPCARD_TOKENS.large, roomy + 320 =
//     TOPCARD_TOKENS.small); shorter screens scale down monotonically and
//     keep the ring geometry inside the display box.
//  5. Viewport fit (Anuraj's hard requirement): the whole card fits the
//     visible screen on every phone size — 390x844, 390x780, 390x760,
//     390x700, 320x667, 320x568, 390x915 — with 2 and 3 address lines.
//  6. Structure (RN components are not importable in the node suite, so
//     the component source is pinned statically via CTC_REPO_ROOT): the
//     "{name} completed" line above the step count, the escrow timeline
//     row (start date left, end date right, gold elapsed bar on the same
//     line, "Escrow timeline" caption), openDate/closeDate props wired
//     from the buyer, seller, and TC screens.
//  7. Copy: no em dashes in the new user-facing strings.
import { assert, summary } from './assert';

declare const require: any;
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
const readFileSync = (p: string, enc: string) => fs.readFileSync(p, enc);
const join = (...parts: string[]) => path.join(...parts);
import {
  TOPCARD_TOKENS,
  escrowTimelineFill,
  estimateTopCardHeight,
  formatMonthDay,
  topCardFitsScreen,
  topCardHeightClass,
  topCardTokens,
} from '../src/lib/topCard';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

// --- 1. escrowTimelineFill ------------------------------------------------
assert(escrowTimelineFill('2026-09-01', '2026-10-31', at('2026-09-01')) === 0, 'fill is 0 on the open date');
assert(escrowTimelineFill('2026-09-01', '2026-10-31', at('2026-10-31')) === 1, 'fill is 1 on the close date');
const mid = escrowTimelineFill('2026-09-01', '2026-10-01', at('2026-09-16'));
assert(mid !== null && Math.abs(mid - 0.5) < 0.001, `midpoint fill is ~0.5 (got ${mid})`);
assert(escrowTimelineFill('2026-09-01', '2026-10-31', at('2026-08-15')) === 0, 'fill clamps at 0 before the open date');
assert(escrowTimelineFill('2026-09-01', '2026-10-31', at('2026-12-01')) === 1, 'fill clamps at 1 past the close date');
assert(escrowTimelineFill(undefined, '2026-10-31') === null, 'missing open date hides the timeline');
assert(escrowTimelineFill('2026-09-01', undefined) === null, 'missing close date hides the timeline');
assert(escrowTimelineFill(undefined, undefined) === null, 'missing dates hide the timeline');
assert(escrowTimelineFill('not-a-date', '2026-10-31') === null, 'invalid open date hides the timeline');
assert(escrowTimelineFill('2026-09-01', 'bogus') === null, 'invalid close date hides the timeline');
// Degenerate range: close on/before open.
assert(escrowTimelineFill('2026-09-01', '2026-09-01', at('2026-09-02')) === 1, 'same-day range reads complete once open arrives');
assert(escrowTimelineFill('2026-09-01', '2026-09-01', at('2026-08-31')) === 0, 'same-day range reads 0 before the open date');
assert(escrowTimelineFill('2026-10-01', '2026-09-01', at('2026-10-02')) === 1, 'inverted range reads complete once open arrives');

// --- 2. formatMonthDay ----------------------------------------------------
assert(formatMonthDay('2026-09-01') === 'Sep 1', 'Sep 1 label');
assert(formatMonthDay('2026-10-26') === 'Oct 26', 'Oct 26 label');
assert(formatMonthDay('2026-01-05') === 'Jan 5', 'Jan 5 label');
assert(formatMonthDay(undefined) === null, 'undefined date has no label');
assert(formatMonthDay('bogus') === null, 'invalid date has no label');

// --- 3. height ladder -----------------------------------------------------
assert(topCardHeightClass(844) === 'roomy', '844pt is roomy');
assert(topCardHeightClass(915) === 'roomy', '915pt is roomy');
assert(topCardHeightClass(760) === 'roomy', '760pt is roomy (boundary)');
assert(topCardHeightClass(759) === 'compact', '759pt is compact');
assert(topCardHeightClass(700) === 'compact', '700pt is compact');
assert(topCardHeightClass(667) === 'compact', '667pt is compact');
assert(topCardHeightClass(660) === 'compact', '660pt is compact (boundary)');
assert(topCardHeightClass(659) === 'ultra', '659pt is ultra');
assert(topCardHeightClass(568) === 'ultra', '568pt is ultra');

// --- 4. tokens -------------------------------------------------------------
// Tall screens keep the EXACT approved-sample tokens.
const roomyLarge = topCardTokens(390, 844);
for (const k of Object.keys(TOPCARD_TOKENS.large) as (keyof typeof TOPCARD_TOKENS.large)[]) {
  assert(roomyLarge[k] === TOPCARD_TOKENS.large[k], `roomy/large token ${k} equals the sample token`);
}
const roomySmall = topCardTokens(320, 844);
for (const k of Object.keys(TOPCARD_TOKENS.small) as (keyof typeof TOPCARD_TOKENS.small)[]) {
  assert(roomySmall[k] === TOPCARD_TOKENS.small[k], `roomy/small token ${k} equals the sample token`);
}
// Shorter screens scale down monotonically.
for (const w of [390, 320]) {
  const roomy = topCardTokens(w, 844);
  const compact = topCardTokens(w, 700);
  const ultra = topCardTokens(w, 568);
  assert(compact.ring < roomy.ring && ultra.ring < compact.ring, `ring shrinks with height tier (w=${w})`);
  assert(compact.banner < roomy.banner && ultra.banner < compact.banner, `banner shrinks with height tier (w=${w})`);
  assert(compact.greeting < roomy.greeting && ultra.greeting < compact.greeting, `type shrinks with height tier (w=${w})`);
  assert(compact.bodyPadB < roomy.bodyPadB && ultra.bodyPadB < compact.bodyPadB, `spacing shrinks with height tier (w=${w})`);
}
// Ring geometry stays inside the display box at every tier.
for (const w of [390, 320]) {
  for (const h of [844, 700, 568]) {
    const t = topCardTokens(w, h);
    assert(t.ringRadius + t.ringStroke / 2 <= t.ring / 2 + 0.001, `ring geometry fits at ${w}x${h}`);
  }
}
// New tokens track the width-class base at roomy.
assert(roomyLarge.realtorDid === TOPCARD_TOKENS.large.steps, 'realtor-did line matches the steps caption size');
assert(roomyLarge.realtorDidTop === TOPCARD_TOKENS.large.stepsTop, 'realtor-did gap matches the steps gap');

// --- 5. viewport fit -------------------------------------------------------
for (const [w, h] of [[390, 844], [390, 915], [390, 780], [390, 760], [390, 700], [320, 667], [320, 568]] as const) {
  for (const lines of [2, 3]) {
    assert(topCardFitsScreen(w, h, lines), `whole card fits ${w}x${h} with ${lines} address lines`);
  }
}
// The estimate is a real number that grows with more address lines.
assert(
  estimateTopCardHeight(topCardTokens(390, 844), 3) > estimateTopCardHeight(topCardTokens(390, 844), 2),
  'taller address stacks estimate taller',
);

// --- 6. component structure (static pins) ----------------------------------
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const card = readFileSync(join(ROOT, 'src/components/ClientTopCard.tsx'), 'utf8');
assert(card.includes('testID="realtor-completed-line"'), '"{name} completed" line testID present');
assert(card.includes('completed`'), '"completed" suffix on the realtor line');
assert(card.includes('testID="escrow-timeline"'), 'escrow timeline testID present');
assert(card.includes('testID="timeline-track"'), 'timeline bar track testID present');
assert(card.includes('testID="timeline-fill"'), 'timeline elapsed-fill testID present');
assert(card.includes('Escrow timeline'), '"Escrow timeline" caption present');
assert(card.includes('timelineFill * 100'), 'bar fill driven by the elapsed fraction');
assert(card.includes('timelineFill !== null'), 'timeline hidden when dates are absent');
assert(card.includes('openDate?: string'), 'openDate prop declared');
assert(card.includes('closeDate?: string'), 'closeDate prop declared');
assert(card.includes('topCardTokens(screenW, screenH)'), 'tokens resolve from width AND height');
assert(card.includes('preserveAspectRatio="none"'), 'timeline gradient stretches to the bar width');
// Screens wire the dates into the shared card.
for (const f of ['app/client/buyer/[id].tsx', 'app/client/seller/[id].tsx', 'app/client/tc/[id].tsx'] as const) {
  const screen = readFileSync(join(ROOT, f), 'utf8');
  assert(screen.includes('openDate='), `${f} passes openDate to the top card`);
  assert(screen.includes('closeDate='), `${f} passes closeDate to the top card`);
}

// --- 7. copy: no em dashes --------------------------------------------------
for (const s of ['Your realtor completed', 'Escrow timeline']) {
  assert(!s.includes('\u2014'), `no em dash in "${s}"`);
}
// The new rendered lines carry no em dash either.
assert(card.includes('${name} completed'), 'completed line renders the name + "completed"');
assert(!card.match(/realtor-completed-line[\s\S]{0,400}\u2014/), 'no em dash near the completed line markup');
assert(!card.match(/Escrow timeline[\s\S]{0,80}\u2014/), 'no em dash near the timeline caption');

summary('topcard_timeline');
