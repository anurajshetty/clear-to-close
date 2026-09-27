// Clear to Close — recommended banner image size (Anuraj's call, Sept 2026).
//
// The realtor's banner renders with resizeMode="cover" as the header strip
// at the top of the redeem celebration card (see src/components/
// RedeemCelebration, celebration redesign Sept 2026), so the size
// recommendation is COMPUTED from that strip's actual geometry — never a
// guessed number. The constants below are the single source of truth: the
// celebration card's styles reference them, so a future redesign of the
// strip updates the recommendation automatically.
//
// Strip geometry on a phone `screenWidth` points wide:
//   width  = screenWidth − 2 × screen padding 20 (the celebration card has
//            no horizontal margin; it spans the full screen content width of
//            the redeem screen)
//   height = CELEBRATION_BANNER.stripHeight
//
// On the 390pt reference phone: 350 × 132 → ≈ 2.7 : 1.
// The upload pipeline downscales to a ≤1024px long edge, so the concrete
// recommendation is a 1024px-wide image at the strip's aspect ratio.

/** Celebration-card banner header layout numbers, in points. Mirrors RedeemCelebration. */
export const CELEBRATION_BANNER = {
  /** Redeem/celebration screen horizontal padding. */
  screenPadding: 20,
  /** Banner header strip height at the top of the celebration card. */
  stripHeight: 132,
} as const;

/** Design-reference phone width the recommendation is computed for. */
export const BANNER_REFERENCE_PHONE_WIDTH = 390;

/** Upload pipeline downscales to this long edge (see ProfileForm). */
export const BANNER_MAX_EDGE = 1024;

/** Celebration-card banner header box (points) on a phone `screenWidth` wide. */
export function celebrationBannerSize(screenWidth: number): {
  width: number;
  height: number;
} {
  const g = CELEBRATION_BANNER;
  return {
    width: screenWidth - 2 * g.screenPadding,
    height: g.stripHeight,
  };
}

/**
 * Recommended banner pixel size: 1024px wide at the banner header strip's
 * aspect ratio, so the cover-cropped banner fills the strip with the least
 * cropping.
 */
export function recommendedBannerSize(
  screenWidth: number = BANNER_REFERENCE_PHONE_WIDTH,
): { width: number; height: number } {
  const strip = celebrationBannerSize(screenWidth);
  const width = BANNER_MAX_EDGE;
  return { width, height: Math.round((width * strip.height) / strip.width) };
}

/**
 * One-line helper copy for the banner upload in profile settings, e.g.
 * "Best: about 2.7 : 1 (e.g. 1024 × 386 px). Fills the banner strip on the
 * celebration card." No em dashes (user-facing copy rule).
 */
export function bannerSizeHint(
  screenWidth: number = BANNER_REFERENCE_PHONE_WIDTH,
): string {
  const strip = celebrationBannerSize(screenWidth);
  const size = recommendedBannerSize(screenWidth);
  const ratio = (strip.width / strip.height).toFixed(1);
  return (
    `Best: about ${ratio} : 1 (e.g. ${size.width} × ${size.height} px). ` +
    'Fills the banner strip on the celebration card.'
  );
}
