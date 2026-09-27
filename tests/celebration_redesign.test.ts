// celebration_redesign.test.ts — REGRESSION: celebration redesign
// (APPROVED by Anuraj, Sept 2026).
//
//  1. Celebration copy (src/lib/shareCopy.ts): amber kicker
//     "Congratulations, {client name}", "Your escrow is open!" headline,
//     "<realtor name> has your checklist ready." + "Follow your progress
//     right here." No em dashes.
//  2. Celebration card structure (src/components/RedeemCelebration.tsx):
//     white card, banner header strip, unified confetti burst from below the
//     card; the centered photo, the "has got this" paragraph, and the
//     realtor byline are GONE; the YOUR REALTOR footer photo is a Pressable
//     wired to onProfilePress (in-app profile).
//  3. In-app realtor profile (app/realtor-profile.tsx): renders the shared
//     RealtorProfileView with a back chevron returning to the celebration,
//     Call/Text buttons, and the same profile data wiring as the
//     celebration.
//  4. Shared profile content (src/components/RealtorProfileView.tsx):
//     photo, name, subline, about, Years in / Avg days to close / Client
//     rating, areas, reviews — the same content as the public profile.
//
// RN components are not importable in the node suite, so parts 2-4 pin the
// component/route sources statically (repo root via CTC_REPO_ROOT, exported
// by tests/run.sh).
import { assert, summary } from './assert';

// tests/run.sh compiles with a bare tsc invocation (no node types), so the
// globals are declared the same way tests/auth.test.ts declares them.
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

import {
  celebrationChecklistReady,
  celebrationFollowProgress,
  celebrationHeadline,
  celebrationKicker,
  celebrationRealtorLabel,
} from '../src/lib/shareCopy';

// ---------------------------------------------------------------------------
// 1. Celebration copy.
// ---------------------------------------------------------------------------
assert(
  celebrationKicker('Sam') === 'Congratulations, Sam',
  `kicker is personalized (got "${celebrationKicker('Sam')}")`,
);
assert(
  celebrationKicker('  ') === 'Congratulations!',
  'kicker falls back when the name is empty',
);
assert(
  celebrationHeadline() === 'Your escrow\nis open!',
  `headline is the two-line "Your escrow is open!" (got ${JSON.stringify(celebrationHeadline())})`,
);
assert(
  celebrationChecklistReady('Anuraj') === 'Anuraj has your checklist ready.',
  `checklist-ready line names the realtor (got "${celebrationChecklistReady('Anuraj')}")`,
);
assert(
  celebrationFollowProgress() === 'Follow your progress right here.',
  `follow line copy (got "${celebrationFollowProgress()}")`,
);
assert(
  celebrationRealtorLabel() === 'Your realtor',
  `realtor footer label (got "${celebrationRealtorLabel()}")`,
);
for (const s of [
  celebrationKicker('Sam'),
  celebrationHeadline(),
  celebrationChecklistReady('Anuraj'),
  celebrationFollowProgress(),
  celebrationRealtorLabel(),
]) {
  assert(!s.includes('—') && !s.includes('–'), `no em/en dashes in "${s}"`);
}

// ---------------------------------------------------------------------------
// 2-4. Component/route structure (static source pins).
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const celebration = src('src/components/RedeemCelebration.tsx');

// The card renders the copy through the shared builders (one source of truth).
for (const fn of [
  'celebrationKicker(',
  'celebrationHeadline()',
  'celebrationChecklistReady(',
  'celebrationFollowProgress()',
  'celebrationRealtorLabel()',
]) {
  assert(celebration.includes(fn), `celebration renders via ${fn}`);
}
// Banner header strip: the realtor's banner (cover), teal gradient fallback,
// geometry from the shared constants — and NO profile photo on the banner.
assert(celebration.includes('testID="celebration-banner-strip"'), 'banner header strip present');
assert(celebration.includes('CELEBRATION_BANNER.stripHeight'), 'strip height from the shared constants');
assert(celebration.includes('testID="celebration-banner"'), 'synced banner image in the strip');
assert(celebration.includes('resizeMode="cover"'), 'banner is cover-cropped');
// The unified confetti burst pops from below the card — the falling layer is
// gone on the celebration (the burst is the one shared implementation).
assert(celebration.includes('ConfettiBurst'), 'unified confetti burst from below the card');
assert(!celebration.includes('ConfettiLayer'), 'no falling confetti layer on the celebration');
// Removed by the redesign: the centered photo, the "has got this"
// paragraph, the reassuring body copy, and the realtor byline.
for (const gone of [
  'has got this',
  'Every inspection, signature, and deadline',
  'byline',
  'avatarRow',
]) {
  assert(!celebration.includes(gone), `redesign removed "${gone}"`);
}
// Light card: white, 24pt radius, 1px #E7E0D3 border.
assert(celebration.includes("backgroundColor: '#FFFFFF'"), 'celebration card is white');
assert(celebration.includes('borderRadius: 24'), 'celebration card radius 24');
assert(celebration.includes("borderColor: LINE"), 'celebration card has the subtle border');
// Kicker: amber, 13px, letterspaced, uppercase.
assert(celebration.includes("color: AMBER"), 'kicker is amber');
// Footer: YOUR REALTOR label + centered realtor photo (~124px) as a
// Pressable wired to onProfilePress (in-app profile, never a browser tab).
assert(celebration.includes('testID="celebration-realtor"'), 'YOUR REALTOR footer present');
assert(
  celebration.includes('testID="celebration-realtor-photo"'),
  'tappable realtor photo present',
);
assert(
  /<Pressable[\s\S]*?testID="celebration-realtor-photo"/.test(celebration),
  'realtor photo is a Pressable (tap target)',
);
assert(
  celebration.includes('onPress={onProfilePress}'),
  'photo tap is wired to onProfilePress',
);
assert(
  celebration.includes('width: 124') && celebration.includes('height: 124'),
  'realtor photo is ~124px',
);
// The CTA sits directly below the card (pulled close), start-over unchanged.
assert(celebration.includes('title="View my escrow"'), '"View my escrow" button present');
assert(celebration.includes('marginTop: 18'), 'CTA pulled close to the card');
assert(
  celebration.includes('title="Not your escrow? Start over"'),
  '"Not your escrow? Start over" unchanged',
);

// ---------------------------------------------------------------------------
// 3. In-app realtor profile route.
// ---------------------------------------------------------------------------
const inApp = src('app/realtor-profile.tsx');
assert(inApp.includes('RealtorProfileView'), 'in-app screen reuses the shared profile content');
assert(inApp.includes('variant="inApp"'), 'in-app screen uses the inApp profile variant');
// Approved v3: banner strip on top with the back chevron OVERLAID — no
// title text.
assert(inApp.includes('height: 150'), 'banner strip is 150px');
assert(inApp.includes('LinearGradient'), 'banner strip is the teal gradient');
assert(inApp.includes("testID=\"profile-back\""), 'back chevron present');
assert(
  inApp.includes("position: 'absolute'") && inApp.includes('top: 14') && inApp.includes('left: 14'),
  'back chevron is overlaid on the banner',
);
assert(!inApp.includes('Your realtor'), 'no title text on the banner (chevron only)');
assert(inApp.includes('router.back()'), 'back chevron returns to the celebration screen');
// Call/Text buttons (wired to the dialer/SMS), not the public page's
// Share/Start-escrow buttons.
assert(inApp.includes('title="Call"'), 'Call button present');
assert(inApp.includes('title="Text"'), 'Text button present');
assert(inApp.includes('tel:${phone}'), 'Call opens the dialer');
assert(inApp.includes('sms:${phone}'), 'Text opens SMS');
assert(!inApp.includes('Share profile'), 'no public Share button in-app');
assert(!inApp.includes('Start your escrow'), 'no public Start-escrow button in-app');
// Same data wiring as the celebration: the resolved invite realtor for this
// escrow (linked-first, local fallback).
assert(inApp.includes('escrowId'), 'route takes the escrow id');
assert(inApp.includes('store.getClientProfile('), 'profile via the shared store wiring');

// redeem.tsx pushes the in-app profile (never a browser tab).
const redeem = src('app/redeem.tsx');
assert(redeem.includes("pathname: '/realtor-profile'"), 'celebration pushes /realtor-profile');
assert(redeem.includes('params: { escrowId: linked.escrowId }'), 'profile push carries the escrow id');

// The boot redirect never bounces the in-app profile.
const layout = src('app/_layout.tsx');
assert(layout.includes("pathname === '/realtor-profile'"), 'boot redirect skips /realtor-profile');

// ---------------------------------------------------------------------------
// 4. Shared profile content: every public-profile field is present, and the
//    inApp variant (approved v3) pares it down — big overlapping photo,
//    Years in only, no reviews.
// ---------------------------------------------------------------------------
const shared = src('src/components/RealtorProfileView.tsx');
for (const field of [
  'testID="realtor-profile-photo"',
  'testID="realtor-profile-name"',
  'testID="realtor-profile-subline"',
  'testID="realtor-profile-about"',
  'Years in',
  'Avg days to close',
  'Client rating',
  'Areas I serve',
  'What clients say',
]) {
  assert(shared.includes(field), `shared profile content has ${field}`);
}
assert(shared.includes("variant?: 'public' | 'inApp'"), 'variant prop declared');
assert(shared.includes("variant = 'public'"), 'public is the default variant');
// In-app variant: big photo overlapping below the banner.
assert(shared.includes('photoLarge'), 'inApp variant has the big photo style');
assert(shared.includes('width: 140'), 'in-app photo is 140px');
assert(shared.includes('marginTop: -52'), 'in-app photo overlaps below the banner');
// In-app variant: stats pared to Years in only — styled exactly like
// "Areas I serve" (section title + chip, no white card; Sept 2026 fix for
// the white box Anuraj caught on the live profile).
assert(shared.includes('>Years of experience</Text>'), 'inApp variant titles the years section "Years of experience"');
assert(!shared.includes('statSingle'), 'inApp variant has no white-box single-stat card');
// In-app variant: the "What clients say" reviews section is removed.
assert(shared.includes('{!inApp && ('), 'reviews section only renders for the public variant');
// The public page renders the same shared content (no divergent copy) in
// the default full variant.
const publicPage = src('app/realtor/[id].tsx');
assert(publicPage.includes('<RealtorProfileView'), 'public page uses the shared profile content');
assert(!publicPage.includes('variant='), 'public page uses the default full variant');
for (const dup of ['What clients say', 'Areas I serve', 'function Stat(', 'function ReviewCard(']) {
  assert(
    !publicPage.includes(dup),
    `public page does not duplicate "${dup}" (the shared component owns it)`,
  );
}

summary('celebration_redesign');
