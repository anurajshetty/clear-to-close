// topcard_responsive.test.ts — REGRESSION: client top card responsive
// design (approved client-home-card sample, Anuraj, Sept 2026).
//
//  1. Size class: the sample pins exact sizes at the 390pt and 320pt
//     phones; the class flips at the TOPCARD_BREAKPOINT midpoint. Large
//     screens keep the full-size layout; small phones scale down.
//  2. Tokens: the exact sample numbers per size class — banner height,
//     photo size/offset, type sizes, ring geometry.
//  3. Ring geometry fits: radius + stroke/2 stays inside the display box.
//  4. Structure (RN components are not importable in the node suite, so
//     the component source is pinned statically via CTC_REPO_ROOT): the
//     banner strip is back on top of the card with the realtor photo on
//     its right side, tappable to the in-app realtor profile; the old
//     top-right photo position is gone; the ahead-of-pace pill, the
//     completion pill, and their logic are gone.
import { assert, summary } from './assert';
import {
  TOPCARD_BREAKPOINT,
  TOPCARD_TOKENS,
  topCardSizeClass,
} from '../src/lib/topCard';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

// ---- 1. Size class ---------------------------------------------------------
assert(topCardSizeClass(390) === 'large', '390pt phone -> large size class');
assert(topCardSizeClass(320) === 'small', '320pt phone -> small size class');
assert(topCardSizeClass(TOPCARD_BREAKPOINT) === 'large', 'breakpoint itself -> large');
assert(topCardSizeClass(TOPCARD_BREAKPOINT - 1) === 'small', 'below the breakpoint -> small');
assert(topCardSizeClass(500) === 'large', 'wider screens keep the large layout');

// ---- 2. Exact sample tokens -------------------------------------------------
const large = TOPCARD_TOKENS.large;
const small = TOPCARD_TOKENS.small;

assert(large.banner === 118, `large banner 118px (got ${large.banner})`);
assert(small.banner === 96, `small banner 96px (got ${small.banner})`);

assert(large.photo === 88 && large.photoRight === 18,
  `large photo 88px at right 18 (got ${large.photo}/${large.photoRight})`);
assert(small.photo === 68 && small.photoRight === 14,
  `small photo 68px at right 14 (got ${small.photo}/${small.photoRight})`);
assert(large.photoBorder === 3 && small.photoBorder === 2.5,
  'photo white border 3px / 2.5px');

assert(large.greeting === 30, `large "Hi" 30px (got ${large.greeting})`);
assert(small.greeting === 25, `small "Hi" 25px (got ${small.greeting})`);

assert(large.ring === 210, `large ring 210px (got ${large.ring})`);
assert(small.ring === 160, `small ring 160px (got ${small.ring})`);
assert(large.ringRadius === 88.2 && large.ringStroke === 18.9,
  `large ring geometry r=88.2 stroke=18.9 (got ${large.ringRadius}/${large.ringStroke})`);
assert(small.ringRadius === 67.2 && small.ringStroke === 14.4,
  `small ring geometry r=67.2 stroke=14.4 (got ${small.ringRadius}/${small.ringStroke})`);
assert(large.pct === 44 && small.pct === 34,
  `ring label 44px / 34px (got ${large.pct}/${small.pct})`);

assert(large.days === 16 && large.daysNum === 26,
  `large days line 16px, number 26px (got ${large.days}/${large.daysNum})`);
assert(small.days === 14 && small.daysNum === 21,
  `small days line 14px, number 21px (got ${small.days}/${small.daysNum})`);

assert(large.addr === 15.5 && small.addr === 13.5,
  `address 15.5px / 13.5px (got ${large.addr}/${small.addr})`);
assert(large.steps === 15 && small.steps === 13.5,
  `steps caption 15px / 13.5px (got ${large.steps}/${small.steps})`);

// Small scales down everywhere the sample scales down.
for (const key of ['banner', 'photo', 'greeting', 'addr', 'steps', 'ring', 'pct', 'days', 'daysNum'] as const) {
  assert(small[key] < large[key], `small ${key} scales down (${small[key]} < ${large[key]})`);
}

// ---- 3. Ring geometry fits the display box ----------------------------------
for (const [name, tk] of [['large', large], ['small', small]] as const) {
  const outer = tk.ringRadius + tk.ringStroke / 2;
  assert(outer <= tk.ring / 2,
    `${name} ring fits: r + stroke/2 = ${outer} <= ${tk.ring / 2}`);
}

// ---- 4. Component structure (static source pins) -----------------------------
/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const card = srcFile('src/components/ClientTopCard.tsx');
const strip = srcFile('src/components/BannerStrip.tsx');

// Banner strip is back on top of the card. It is the shared BannerStrip
// component (built once, reused by the client top card and the realtor
// home screen — Sept 2026 refactor), so the banner testIDs ride in as prop
// values on the BannerStrip element.
assert(card.includes('<BannerStrip'), 'client top card renders the shared BannerStrip');
assert(card.includes('"topcard-banner-header"'), 'banner header strip testID wired to BannerStrip');
assert(card.includes('"topcard-banner"'), 'synced banner image testID wired to BannerStrip');
assert(strip.includes('resizeMode="cover"'), 'shared strip: banner is cover-cropped');
assert(card.includes('"topcard-gradient"'), 'teal gradient fallback testID wired to BannerStrip');
assert(strip.includes('TealGradientFallback'), 'shared strip: teal gradient fallback when no banner is set');
assert(card.includes('t.banner'), 'strip height comes from the responsive tokens');

// The realtor photo sits ON the banner's right side and opens the profile.
assert(card.includes('"topcard-banner-photo"'), 'banner photo testID wired to BannerStrip');
assert(card.includes('onProfilePress'), 'banner photo wired to onProfilePress (in-app profile)');
assert(card.includes("View ${name}'s profile"), 'banner photo keeps the profile accessibility label');
assert(card.includes('t.photoRight'), 'photo offset comes from the responsive tokens');

// The old top-right photo position is gone.
assert(!card.includes('testID="greeting-avatar"'), 'old top-right photo removed');
assert(!card.includes('avatarCircle'), 'old avatar circle styles removed');

// The ahead-of-pace pill, the completion pill, and their logic are gone.
assert(!card.includes('testID="pace-pill"'), 'pace pill markup removed');
assert(!card.includes('pacePill'), 'pace pill styles removed');
assert(!card.includes('testID="completion-banner"'), 'completion pill markup removed');
assert(!card.includes('CompletionPill'), 'CompletionPill component removed');
assert(!card.includes('TriumphCard'), 'TriumphCard removed from the top-card component');
assert(!card.includes('Just closed!'), '"Just closed!" copy removed from the top-card component');
const paceLib = srcFile('src/lib/pace.ts');
assert(!paceLib.includes('aheadOfPace'), 'aheadOfPace helper removed');
assert(!paceLib.includes('PACE_GAP_POINTS'), 'pace threshold constant removed');
assert(!paceLib.includes('completionPill'), 'completionPill helper removed');
const topCardLib = srcFile('src/lib/topCard.ts');
assert(!topCardLib.includes('topCardPill'), 'topCardPill removed from topCard.ts');
assert(!topCardLib.includes('aheadOfPace'), 'topCardPill no longer calls the pace logic');

summary('topcard_responsive');
