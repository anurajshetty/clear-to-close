// Clear to Close — recommended banner image size (Anuraj's call, Sept 2026).
//
// The realtor's banner renders with resizeMode="cover" as the background of
// the GUIDED BY strip on the client home (see src/components/ClientTopCard,
// approved mockup screen 7), so the size recommendation is COMPUTED from that
// strip's actual geometry — never a guessed number. The constants below are
// the single source of truth: ClientTopCard's styles reference them, so a
// future redesign of the strip updates the recommendation automatically.
//
// Strip geometry on a phone `screenWidth` points wide:
//   width  = screenWidth − 2 × (screen padding 18 + card padding 20)
//   height = 2 × strip padding 13 + avatar 46 + button gap 12 + buttons 44
//          (baseline: no tagline — the compact strip; a tagline only makes
//          the strip taller, so this is the widest aspect the strip gets)
//
// On the 390pt reference phone: 314 × 128 → ≈ 2.45 : 1.
// The upload pipeline downscales to a ≤1024px long edge, so the concrete
// recommendation is a 1024px-wide image at the strip's aspect ratio.

/** GUIDED BY strip layout numbers, in points. Mirrors ClientTopCard. */
export const GUIDED_BY_STRIP = {
  /** Client-home screen horizontal padding (buyer/seller/TC). */
  screenPadding: 18,
  /** Top-card content horizontal padding. */
  cardPadding: 20,
  /** Strip padding (all sides). */
  stripPadding: 13,
  /** Realtor avatar diameter in the strip. */
  avatarSize: 46,
  /** Gap between the avatar row and the Call/Text button row. */
  buttonGap: 12,
  /** Call/Text button height. */
  buttonHeight: 44,
} as const;

/** Design-reference phone width the recommendation is computed for. */
export const BANNER_REFERENCE_PHONE_WIDTH = 390;

/** Upload pipeline downscales to this long edge (see ProfileForm). */
export const BANNER_MAX_EDGE = 1024;

/** GUIDED BY strip box (points) on a phone `screenWidth` wide. */
export function guidedByStripSize(screenWidth: number): { width: number; height: number } {
  const g = GUIDED_BY_STRIP;
  return {
    width: screenWidth - 2 * (g.screenPadding + g.cardPadding),
    height: 2 * g.stripPadding + g.avatarSize + g.buttonGap + g.buttonHeight,
  };
}

/**
 * Recommended banner pixel size: 1024px wide at the GUIDED BY strip's
 * aspect ratio, so the cover-cropped banner fills the strip with the least
 * cropping.
 */
export function recommendedBannerSize(
  screenWidth: number = BANNER_REFERENCE_PHONE_WIDTH,
): { width: number; height: number } {
  const strip = guidedByStripSize(screenWidth);
  const width = BANNER_MAX_EDGE;
  return { width, height: Math.round((width * strip.height) / strip.width) };
}

/**
 * One-line helper copy for the banner upload in profile settings, e.g.
 * "Best: about 2.5 : 1 (e.g. 1024 × 417 px). Fills the GUIDED BY strip on
 * your client home." No em dashes (user-facing copy rule).
 */
export function bannerSizeHint(
  screenWidth: number = BANNER_REFERENCE_PHONE_WIDTH,
): string {
  const strip = guidedByStripSize(screenWidth);
  const size = recommendedBannerSize(screenWidth);
  const ratio = (strip.width / strip.height).toFixed(1);
  return (
    `Best: about ${ratio} : 1 (e.g. ${size.width} × ${size.height} px). ` +
    'Fills the GUIDED BY strip on your client home.'
  );
}
