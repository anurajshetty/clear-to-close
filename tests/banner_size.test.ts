// banner_size.test.ts — REGRESSION: banner upload helper text (Anuraj's
// call, Sept 2026). The recommended banner size is COMPUTED from the
// client-home banner header strip geometry constants (src/lib/bannerSize.ts)
// — never a guessed number — so the cover-cropped banner fills the top card
// header strip with the least cropping. Covered here since RN components are
// not importable in the node suite; the component styles reference the same
// constants.
//
// Correction pass (Sept 2026): the banner is a header strip at the very top
// of the top card (full card width x stripHeight), replacing the old
// GUIDED BY strip geometry.
import { assert, summary } from './assert';
import {
  BANNER_MAX_EDGE,
  BANNER_REFERENCE_PHONE_WIDTH,
  TOPCARD_BANNER_HEADER,
  bannerSizeHint,
  topCardBannerHeaderSize,
  recommendedBannerSize,
} from '../src/lib/bannerSize';

// The strip geometry must match the approved client-home layout numbers.
assert(TOPCARD_BANNER_HEADER.screenPadding === 18, 'screen padding 18');
assert(TOPCARD_BANNER_HEADER.stripHeight === 128, 'banner header strip 128pt tall');

const strip = topCardBannerHeaderSize(BANNER_REFERENCE_PHONE_WIDTH);
assert(
  strip.width === 390 - 2 * 18,
  `strip spans the full card width (got ${strip.width})`,
);
assert(strip.height === 128, `strip height is the header constant (got ${strip.height})`);
const aspect = strip.width / strip.height;
assert(
  aspect > 2.7 && aspect < 2.8,
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
assert(size.height === 370, `reference recommendation is 1024 x 370 (got ${size.width} x ${size.height})`);

const hint = bannerSizeHint();
assert(hint.includes('1024'), `hint names the pixel width (${hint})`);
assert(hint.includes('2.8'), `hint names the strip aspect (${hint})`);
assert(hint.includes('top card'), 'hint names the top card banner it fills');
assert(
  !hint.includes('—') && !hint.includes('–'),
  'hint has no em/en dashes (user-facing copy rule)',
);

summary('banner_size');
