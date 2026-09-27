// banner_size.test.ts — REGRESSION: banner upload helper text (Anuraj's
// call, Sept 2026). The recommended banner size is COMPUTED from the
// celebration-card banner header strip geometry constants
// (src/lib/bannerSize.ts) — never a guessed number — so the cover-cropped
// banner fills the celebration card's header strip with the least cropping.
// Covered here since RN components are not importable in the node suite;
// the celebration card's styles reference the same constants.
//
// Celebration redesign (Sept 2026): the banner moved from the client-home
// top card to the redeem celebration card — the recommendation is recomputed
// from the celebration banner geometry (strip height + card width).
import { assert, summary } from './assert';
import {
  BANNER_MAX_EDGE,
  BANNER_REFERENCE_PHONE_WIDTH,
  CELEBRATION_BANNER,
  bannerSizeHint,
  celebrationBannerSize,
  recommendedBannerSize,
} from '../src/lib/bannerSize';

// The strip geometry must match the approved celebration layout numbers.
assert(CELEBRATION_BANNER.screenPadding === 20, 'screen padding 20');
assert(CELEBRATION_BANNER.stripHeight === 132, 'banner header strip 132pt tall');

const strip = celebrationBannerSize(BANNER_REFERENCE_PHONE_WIDTH);
assert(
  strip.width === 390 - 2 * 20,
  `strip spans the full card width (got ${strip.width})`,
);
assert(strip.height === 132, `strip height is the header constant (got ${strip.height})`);
const aspect = strip.width / strip.height;
assert(
  aspect > 2.6 && aspect < 2.7,
  `strip is a wide banner box (aspect ${aspect.toFixed(2)})`,
);

const size = recommendedBannerSize();
assert(
  size.width === BANNER_MAX_EDGE,
  `recommended width matches the upload downscale cap (${size.width})`,
);
assert(
  size.height === Math.round((BANNER_MAX_EDGE * strip.height) / strip.width),
  `recommended height keeps the strip aspect (got ${size.height})`,
);
assert(
  Math.abs(size.width / size.height - aspect) < 0.01,
  'recommended size matches the strip aspect ratio',
);
assert(size.height === 386, `reference recommendation is 1024 x 386 (got ${size.width} x ${size.height})`);

const hint = bannerSizeHint();
assert(hint.includes('1024'), `hint names the pixel width (${hint})`);
assert(hint.includes('386'), `hint names the pixel height (${hint})`);
assert(hint.includes('2.7'), `hint names the strip aspect (${hint})`);
assert(hint.includes('celebration card'), 'hint names the celebration card banner it fills');
assert(
  !hint.includes('—') && !hint.includes('–'),
  'hint has no em/en dashes (user-facing copy rule)',
);

summary('banner_size');
