// Clear to Close — client top-card visual tokens + composition helpers
// (pure, unit-tested). Celebration redesign (Anuraj's call, Sept 2026):
//
//  - All client cards are back on the LIGHT theme: the paper screen, white
//    cards. The top card is a white card with a subtle border and a soft
//    shadow.
//  - The card is responsive (Anuraj's call, Sept 2026): it is built to the
//    approved client-home-card sample, which specifies EXACT sizes at two
//    reference phones — large (390pt) and small (320pt). The size class
//    flips at the TOPCARD_BREAKPOINT midpoint; small phones scale the
//    banner, photo, type, spacing, and ring down so nothing clips or
//    overflows, while large screens keep the full-size layout.
//  - The banner header strip is back on top: the realtor's synced banner,
//    cover-cropped, with the brand-teal gradient fallback. The realtor
//    photo sits ON the banner's right side (tappable to the in-app realtor
//    profile).
//  - The escrow status tag ("In progress" / "Completed") sits next to the
//    kicker: amber outline while in progress, filled amber once completed.
//  - The days-left number is ink normally, amber at 7 or fewer days, red at
//    3 or fewer days. Overdue and "due today" keep their own treatments.
//  - At 100% the ONLY per-status changes on the top card are the status tag
//    flip and the confetti burst popping from below the card. There is no
//    mid-card pill in any state (Anuraj's call, Sept 2026): the pace pill
//    and the completion pill are both gone — no pace logic anywhere.

/** Solid background of the client top card (white, on the paper screen). */
export const CLIENT_TOPCARD_BG = '#FFFFFF';

/** "days left" number colors on the light top card. */
export const DAYS_LEFT_COLORS = {
  /** Default number color (ink). */
  default: '#211D17',
  /** 7 or fewer days left (amber, readable on white). */
  warn: '#A86A12',
  /** 3 or fewer days left (red). */
  alert: '#B23B3B',
} as const;

/** Which color band the "days left" number falls in. */
export type DaysLeftTone = 'default' | 'warn' | 'alert';

/**
 * Days-left color threshold (Sept 2026, Anuraj's call): the number is the
 * default (ink) color normally, amber at 7 or fewer days, red at 3 or fewer
 * days. Callers apply it to the positive "days left" state only; "due today"
 * and overdue keep their own treatments.
 */
export function daysLeftTone(daysToClose: number): DaysLeftTone {
  if (daysToClose <= 3) return 'alert';
  if (daysToClose <= 7) return 'warn';
  return 'default';
}

/** Screen-width breakpoint between the two top-card size classes: the
 * midpoint between the 320pt and 390pt reference phones. */
export const TOPCARD_BREAKPOINT = 355;

/** Which size class the top card renders at for a phone `screenWidth` wide:
 * 'large' (390pt-class phones) keeps the full-size layout; 'small'
 * (320pt-class phones) scales banner, photo, type, spacing, and the ring
 * down so nothing clips or overflows. */
export type TopCardSizeClass = 'large' | 'small';

export function topCardSizeClass(screenWidth: number): TopCardSizeClass {
  return screenWidth >= TOPCARD_BREAKPOINT ? 'large' : 'small';
}

/** Exact top-card layout numbers per size class, in points — taken straight
 * from the approved client-home-card sample (Anuraj, Sept 2026). The
 * component reads these so a future sample revision updates every surface
 * at once. */
export const TOPCARD_TOKENS = {
  large: {
    /** Banner header strip height. */
    banner: 118,
    /** Realtor photo on the banner's right side. */
    photo: 88,
    photoRight: 18,
    photoBorder: 3,
    /** Initials fallback size on the photo circle. */
    photoInitials: 32,
    /** Card body padding. */
    bodyPadT: 20,
    bodyPadH: 22,
    bodyPadB: 26,
    /** "Hi {name}". */
    greeting: 30,
    /** Kicker row. */
    kickerTop: 10,
    kicker: 12.5,
    /** Status tag. */
    status: 11,
    statusPadV: 5,
    statusPadH: 12,
    /** Address lines. */
    addr: 15.5,
    addrTop: 10,
    /** "N of N steps" caption. */
    steps: 15,
    stepsTop: 18,
    /** Progress ring (210px display, r=42/stroke=9 in the sample's
     * 100-unit viewBox: stroke = 210 * 0.09, radius = 210 * 0.42). */
    ring: 210,
    ringRadius: 88.2,
    ringStroke: 18.9,
    ringTop: 8,
    /** Centered % label inside the ring. */
    pct: 44,
    /** Days-left line. */
    days: 16,
    daysNum: 26,
    daysTop: 10,
  },
  small: {
    banner: 96,
    photo: 68,
    photoRight: 14,
    photoBorder: 2.5,
    photoInitials: 25,
    bodyPadT: 16,
    bodyPadH: 18,
    bodyPadB: 22,
    greeting: 25,
    kickerTop: 10,
    kicker: 11,
    status: 9.5,
    statusPadV: 4,
    statusPadH: 10,
    addr: 13.5,
    addrTop: 8,
    steps: 13.5,
    stepsTop: 14,
    ring: 160,
    ringRadius: 67.2,
    ringStroke: 14.4,
    ringTop: 6,
    pct: 34,
    days: 14,
    daysNum: 21,
    daysTop: 8,
  },
} as const;
