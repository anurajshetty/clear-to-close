// profile_view_fixes.test.ts — REGRESSION: the three issues Anuraj caught
// on the live in-app realtor profile (Sept 2026, user-verified).
//
//  1. Photo clipping BUG: the profile photo rendered as a square
//     overflowing its circular frame. The clip is borderRadius +
//     overflow: hidden applied to the IMAGE itself (not just a wrapper)
//     on both the 96px and the in-app 140px photo styles
//     (src/components/RealtorProfileView.tsx).
//  2. Banner BUG: the banner strip rendered a plain teal gradient even
//     when a banner was uploaded. It now loads the realtor's ACTUAL
//     banner via displayBannerUri (synced Storage banner.jpg first,
//     device-local file offline — the same contract the client home top
//     card uses) and falls back to the teal gradient only when no banner
//     exists (app/realtor-profile.tsx).
//  3. Years of experience STYLING: the white box around "Years in" is
//     gone; the section is styled exactly like "Areas I serve" — section
//     title + chip, no white card (src/components/RealtorProfileView.tsx).
//
// RN components are not importable in the node suite, so the component/
// route sources are pinned statically (repo root via CTC_REPO_ROOT,
// exported by tests/run.sh).
import { assert, summary } from './assert';

// tests/run.sh compiles with a bare tsc invocation (no node types), so the
// globals are declared the same way tests/auth.test.ts declares them.
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const profileView = src('src/components/RealtorProfileView.tsx');
const route = src('app/realtor-profile.tsx');
const libProfile = src('src/lib/profile.ts');

// ---------------------------------------------------------------------------
// 1. Photo clipped inside the circular frame (borderRadius + overflow hidden
//    on the image itself).
// ---------------------------------------------------------------------------
assert(profileView.includes('overflow: \'hidden\''), 'photo styles set overflow hidden');
assert(
  /photoLarge: \{[^}]*borderRadius: 70[^}]*overflow: 'hidden'/s.test(profileView) ||
    /photoLarge: \{[^}]*overflow: 'hidden'[^}]*borderRadius: 70/s.test(profileView),
  'in-app 140px photo clips inside its circle (borderRadius + overflow hidden)',
);
assert(
  /photo: \{[^}]*borderRadius: 48[^}]*overflow: 'hidden'/s.test(profileView) ||
    /photo: \{[^}]*overflow: 'hidden'[^}]*borderRadius: 48/s.test(profileView),
  '96px photo clips inside its circle (borderRadius + overflow hidden)',
);

// ---------------------------------------------------------------------------
// 2. Banner: the real banner, not a plain gradient.
// ---------------------------------------------------------------------------
assert(
  route.includes('displayBannerUri'),
  'route resolves the banner through the shared displayBannerUri helper',
);
assert(
  route.includes('import { displayBannerUri }') || route.includes('displayBannerUri } from'),
  'displayBannerUri is imported from src/lib/profile',
);
assert(
  route.includes('bannerUri ?') || route.includes('{bannerUri ?'),
  'banner strip renders the banner image only when a banner exists',
);
assert(route.includes('testID="profile-banner"'), 'actual banner image rendered with testID');
assert(route.includes('resizeMode="cover"'), 'banner is cover-cropped');
assert(
  route.includes('testID="profile-banner-gradient"'),
  'teal gradient stays as the fallback when no banner exists',
);
assert(route.includes('ProfileBanner onBack={goBack} bannerUri={bannerUri}'), 'banner uri wired into the strip');

// displayBannerUri itself: remote Storage URL first, device-local fallback,
// null when neither exists.
assert(
  libProfile.includes('bannerRemoteUrl ?? p?.banner_image'),
  'displayBannerUri prefers the synced Storage URL, falls back to the local file',
);

// ---------------------------------------------------------------------------
// 3. Years of experience: section title + chip, no white box.
// ---------------------------------------------------------------------------
assert(
  profileView.includes('>Years of experience</Text>'),
  'years section uses the "Years of experience" section title',
);
for (const gone of ['statSingle', 'statSingleRow', 'statSingleValue', 'statSingleLabel']) {
  assert(
    !profileView.includes(gone),
    `white-box "${gone}" styling is gone from the years section`,
  );
}
assert(
  !profileView.includes('>Years in</Text>'),
  'the old "Years in" stat label is gone from the in-app profile',
);
const statsBlock = profileView.slice(
  profileView.indexOf('testID="realtor-profile-stats"'),
  profileView.indexOf('testID="realtor-profile-stats"') + 500,
);
assert(statsBlock.includes('styles.sectionTitle'), 'years section uses the shared section title style');
assert(statsBlock.includes('styles.chip'), 'years value renders in the shared chip');
assert(
  profileView.includes('testID="realtor-profile-stats"'),
  'stats testID is preserved for the years section',
);

// ---------------------------------------------------------------------------
// 4. Photo taps resolve to the IN-APP profile, never the public page.
//
// REGRESSION (Sept 2026): the client-home banner photo pushed the PUBLIC
// /realtor/<id> page (no banner, no back chevron, old three-stat white
// box). Every photo-tap entry point — the celebration card and the
// buyer/seller/tc home banner photos — must route to /realtor-profile.
// ---------------------------------------------------------------------------
const redeem = src('app/redeem.tsx');
for (const [name, page] of [
  ['redeem celebration', redeem],
  ['buyer home', src('app/client/buyer/[id].tsx')],
  ['seller home', src('app/client/seller/[id].tsx')],
  ['tc home', src('app/client/tc/[id].tsx')],
] as Array<[string, string]>) {
  assert(
    page.includes("pathname: '/realtor-profile'"),
    `${name}: photo tap routes to the in-app /realtor-profile`,
  );
}
for (const [name, page] of [
  ['buyer home', src('app/client/buyer/[id].tsx')],
  ['seller home', src('app/client/seller/[id].tsx')],
  ['tc home', src('app/client/tc/[id].tsx')],
] as Array<[string, string]>) {
  assert(
    !page.includes('/realtor/${view.realtorId}'),
    `${name}: photo tap no longer misroutes to the public /realtor/<id> page`,
  );
}

// ---------------------------------------------------------------------------
// 5. The back chevron ALWAYS lands on the client home screen.
//
// router.back() alone is not enough on web (deep link = no in-app
// history). The control must check canGoBack() and fall back to an
// explicit replace to this device's client home screen.
// ---------------------------------------------------------------------------
assert(route.includes('router.canGoBack()'), 'back chevron checks for in-app history first');
assert(
  route.includes('router.replace(`/client/${link?.role ?? \'buyer\'}/${homeId}`)'),
  'no-history fallback replaces to the client home screen (role + escrow from the device link)',
);
assert(route.includes('testID="profile-back"'), 'back chevron stays clearly visible on the banner');

// ---------------------------------------------------------------------------
// 6. Top-card kicker: buyer and seller share one kicker, "YOUR TRANSACTION"
//    (Anuraj, Sept 2026 — the client can be a buyer or a seller).
// ---------------------------------------------------------------------------
const buyerHome = src('app/client/buyer/[id].tsx');
const sellerHome = src('app/client/seller/[id].tsx');
assert(buyerHome.includes('kicker="Your transaction"'), 'buyer home uses the "Your transaction" kicker');
assert(sellerHome.includes('kicker="Your transaction"'), 'seller home uses the "Your transaction" kicker');
assert(!buyerHome.includes('kicker="Your purchase"'), 'buyer home no longer uses "Your purchase"');
assert(!sellerHome.includes('kicker="Your sale"'), 'seller home no longer uses "Your sale"');

summary('profile-view-fixes');
