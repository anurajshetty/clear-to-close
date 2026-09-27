// Clear to Close — recommended banner image size (Anuraj's call, Sept 2026).
//
// The realtor's banner renders with resizeMode="cover" as the header strip
// at the very TOP of the client home top card (see src/components/
// ClientTopCard, correction pass Sept 2026), so the size recommendation is
// COMPUTED from that strip's actual geometry — never a guessed number. The
// constants below are the single source of truth: ClientTopCard's styles
// reference them, so a future redesign of the strip updates the
// recommendation automatically.
//
// Strip geometry on a phone `screenWidth` points wide:
//   width  = screenWidth − 2 × screen padding 18 (the card has no horizontal
//            margin; it spans the full screen content width)
//   height = TOPCARD_BANNER_HEADER.stripHeight
//
// On the 390pt reference phone: 354 × 128 → ≈ 2.8 : 1.
// The upload pipeline downscales to a ≤1024px long edge, so the concrete
// recommendation is a 1024px-wide image at the strip's aspect ratio.

/** Top-card banner header layout numbers, in points. Mirrors ClientTopCard. */
export const TOPCARD_BANNER_HEADER = {
  /** Client-home screen horizontal padding (buyer/seller/TC). */
  screenPadding: 18,
  /** Banner header strip height at the top of the top card. */
  stripHeight: 128,
} as const;

/** Design-reference phone width the recommendation is computed for. */
export const BANNER_REFERENCE_PHONE_WIDTH = 390;

/** Upload pipeline downscales to this long edge (see ProfileForm). */
export const BANNER_MAX_EDGE = 1024;

/** Top-card banner header box (points) on a phone `screenWidth` wide. */
export function topCardBannerHeaderSize(screenWidth: number): {
  width: number;
  height: number;
} {
  const g = TOPCARD_BANNER_HEADER;
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
  const strip = topCardBannerHeaderSize(screenWidth);
  const width = BANNER_MAX_EDGE;
  return { width, height: Math.round((width * strip.height) / strip.width) };
}

/**
 * One-line helper copy for the banner upload in profile settings, e.g.
 * "Best: about 2.8 : 1 (e.g. 1024 × 370 px). Fills the banner on your
 * client home top card." No em dashes (user-facing copy rule).
 */
export function bannerSizeHint(
  screenWidth: number = BANNER_REFERENCE_PHONE_WIDTH,
): string {
  const strip = topCardBannerHeaderSize(screenWidth);
  const size = recommendedBannerSize(screenWidth);
  const ratio = (strip.width / strip.height).toFixed(1);
  return (
    `Best: about ${ratio} : 1 (e.g. ${size.width} × ${size.height} px). ` +
    'Fills the banner on your client home top card.'
  );
}
