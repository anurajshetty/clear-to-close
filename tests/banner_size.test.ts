// banner_size.test.ts — REGRESSION: banner upload helper text (Anuraj's
// call, Sept 2026). The recommended banner size is COMPUTED from the
// GUIDED BY strip's actual geometry on the client home — never a guessed
// number — so the cover-cropped banner fills the strip with the least
// cropping. Covered here since RN components are not importable in the
// node suite; the component styles reference the same constants.
import { assert, summary } from './assert';
import {
  BANNER_MAX_EDGE,
  BANNER_REFERENCE_PHONE_WIDTH,
  GUIDED_BY_STRIP,
  bannerSizeHint,
  guidedByStripSize,
  recommendedBannerSize,
} from '../src/lib/bannerSize';

// The strip geometry must match the approved client-home layout numbers.
assert(GUIDED_BY_STRIP.screenPadding === 18, 'screen padding 18');
assert(GUIDED_BY_STRIP.cardPadding === 20, 'card padding 20');
assert(GUIDED_BY_STRIP.stripPadding === 13, 'strip padding 13');
assert(GUIDED_BY_STRIP.avatarSize === 46, 'strip avatar 46');
assert(GUIDED_BY_STRIP.buttonGap === 12, 'button gap 12');
assert(GUIDED_BY_STRIP.buttonHeight === 44, 'button height 44');

const strip = guidedByStripSize(BANNER_REFERENCE_PHONE_WIDTH);
assert(
  strip.width === 390 - 2 * (18 + 20),
  `strip width derives from screen width (got ${strip.width})`,
);
assert(
  strip.height === 2 * 13 + 46 + 12 + 44,
  `strip height derives from row geometry (got ${strip.height})`,
);
const aspect = strip.width / strip.height;
assert(
  aspect > 2.4 && aspect < 2.5,
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

const hint = bannerSizeHint();
assert(hint.includes('1024'), `hint names the pixel width (${hint})`);
assert(hint.includes('GUIDED BY'), 'hint names the strip it fills');
assert(
  !hint.includes('—') && !hint.includes('–'),
  'hint has no em/en dashes (user-facing copy rule)',
);

summary('banner_size');
