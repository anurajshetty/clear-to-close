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

import { parseDateUTC, localDateISO } from './dates';

/** 'YYYY-MM-DD' -> short calendar label, "Sep 1" (approved timeline sample,
 * Anuraj, Sept 2026). Returns null on invalid input — callers hide the
 * timeline rather than render a wrong date. */
export function formatMonthDay(iso: string | undefined): string | null {
  if (!iso) return null;
  let ms: number;
  try {
    ms = parseDateUTC(iso);
  } catch {
    return null;
  }
  const d = new Date(ms);
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Escrow timeline fill (client top card, Anuraj, Sept 2026): the fraction of
 * time elapsed between the escrow's open date and target close date
 * (local 'YYYY-MM-DD'), clamped to [0, 1] — drives the timeline progress
 * bar below the days-left line. Returns null when either date is
 * missing/invalid: the card then hides the timeline rather than guessing.
 * A degenerate range (close on/before open) reads as complete once the open
 * date arrives, 0 before it.
 */
export function escrowTimelineFill(
  openISO: string | undefined,
  closeISO: string | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!openISO || !closeISO) return null;
  let open: number;
  let close: number;
  try {
    open = parseDateUTC(openISO);
    close = parseDateUTC(closeISO);
  } catch {
    return null;
  }
  const total = close - open;
  const today = parseDateUTC(localDateISO(new Date(nowMs)));
  const elapsed = today - open;
  if (total <= 0) return elapsed >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, elapsed / total));
}

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

/**
 * Viewport-fit ladder (Anuraj's hard requirement, Sept 2026): the ENTIRE
 * top card must fit within the visible screen on ANY phone size — the user
 * never scrolls to see the card; scrolling is only for content BELOW it.
 * Three height classes drive the token scaling below; width keeps the
 * existing 355pt breakpoint untouched.
 */
export type TopCardHeightClass = 'roomy' | 'compact' | 'ultra';

/** Height class for a phone `screenHeight` tall (points): roomy keeps the
 * exact sample sizes, compact and ultra scale the internals down (smaller
 * ring, tighter spacing, smaller type) so the whole card stays visible. */
export function topCardHeightClass(screenHeight: number): TopCardHeightClass {
  if (screenHeight >= 760) return 'roomy';
  if (screenHeight >= 660) return 'compact';
  return 'ultra';
}

/** The full token set the ClientTopCard renders from: the width-class base
 * tokens plus the timeline/realtor-line tokens, scaled by height class. */
export type TopCardTokenSet = {
  [K in keyof (typeof TOPCARD_TOKENS)['large']]: number;
} & {
  /** "{realtor name} completed" line (approved timeline sample). */
  realtorDid: number;
  realtorDidTop: number;
  /** Gap between the completed line and the "N of N steps" caption. */
  stepsGap: number;
  /** Escrow timeline row below the days-left line. */
  timelineTop: number;
  timelineDate: number;
  timelineBarH: number;
  timelineNote: number;
  timelineNoteTop: number;
};

const HEIGHT_SCALE: Record<TopCardHeightClass, number> = {
  roomy: 1,
  compact: 0.9,
  ultra: 0.8,
};

/** Progress ring display size per (width class, height class): roomy keeps
 * the exact sample sizes (210/160); shorter screens shrink the ring so the
 * whole card still fits. */
const RING_BY_TIER: Record<TopCardSizeClass, Record<TopCardHeightClass, number>> = {
  large: { roomy: 210, compact: 185, ultra: 160 },
  small: { roomy: 160, compact: 140, ultra: 120 },
};

/** Banner strip height per (width class, height class): roomy keeps the
 * sample heights (118/96). */
const BANNER_BY_TIER: Record<TopCardSizeClass, Record<TopCardHeightClass, number>> = {
  large: { roomy: 118, compact: 106, ultra: 92 },
  small: { roomy: 96, compact: 86, ultra: 76 },
};

/**
 * Resolve the full token set for a phone (screenWidth x screenHeight, in
 * points). Tall screens get the exact approved-sample numbers; shorter
 * screens scale type/spacing by height class and step the ring and banner
 * down so the entire card fits the viewport. The width breakpoint
 * (TOPCARD_BREAKPOINT) is unchanged.
 */
export function topCardTokens(screenWidth: number, screenHeight: number): TopCardTokenSet {
  const wc = topCardSizeClass(screenWidth);
  const hc = topCardHeightClass(screenHeight);
  const base = TOPCARD_TOKENS[wc];
  const k = HEIGHT_SCALE[hc];
  // Round to 0.1pt; at scale 1 every base value (all multiples of 0.5 or
  // integers) round-trips exactly, so roomy tokens ARE the sample tokens.
  const s = (n: number) => Math.round(n * k * 10) / 10;
  const ring = RING_BY_TIER[wc][hc];
  return {
    banner: BANNER_BY_TIER[wc][hc],
    photo: s(base.photo),
    photoRight: s(base.photoRight),
    photoBorder: s(base.photoBorder),
    photoInitials: s(base.photoInitials),
    bodyPadT: s(base.bodyPadT),
    bodyPadH: s(base.bodyPadH),
    bodyPadB: s(base.bodyPadB),
    greeting: s(base.greeting),
    kickerTop: s(base.kickerTop),
    kicker: s(base.kicker),
    status: s(base.status),
    statusPadV: s(base.statusPadV),
    statusPadH: s(base.statusPadH),
    addr: s(base.addr),
    addrTop: s(base.addrTop),
    steps: s(base.steps),
    stepsTop: s(base.stepsTop),
    ring,
    ringRadius: Math.round(ring * 0.42 * 10) / 10,
    ringStroke: Math.round(ring * 0.09 * 10) / 10,
    ringTop: s(base.ringTop),
    pct: Math.round(ring * 0.21),
    days: s(base.days),
    daysNum: s(base.daysNum),
    daysTop: s(base.daysTop),
    // Approved timeline sample (Anuraj, Sept 2026): "{name} completed" reads
    // at the steps-caption size, bold ink; the timeline row sits below the
    // days-left line — start date left, end date right, elapsed bar between.
    realtorDid: s(base.steps),
    realtorDidTop: s(base.stepsTop),
    stepsGap: s(3),
    timelineTop: s(14),
    timelineDate: s(12.5),
    timelineBarH: s(8),
    timelineNote: s(11.5),
    timelineNoteTop: s(6),
  };
}

/**
 * Conservative stacked estimate of the rendered card height from a token
 * set: banner + body padding + every text row at ~1.25-1.45x its font size
 * + the ring + the timeline row. Text-row multipliers are upper bounds, so
 * the estimate errs on the tall side — if the estimate fits, the real card
 * fits. `addressLines` counts the address + city lines (the address can
 * wrap on narrow phones).
 */
export function estimateTopCardHeight(t: TopCardTokenSet, addressLines: number = 2): number {
  const kickerRowH = Math.max(t.kicker * 1.5, t.status + 2 * t.statusPadV + 3);
  const timelineRowH = Math.max(t.timelineDate * 1.3, t.timelineBarH);
  return (
    t.banner +
    t.bodyPadT +
    t.greeting * 1.25 +
    t.kickerTop +
    kickerRowH +
    t.addrTop +
    addressLines * t.addr * 1.45 +
    t.realtorDidTop +
    t.realtorDid * 1.35 +
    t.stepsGap +
    t.steps * 1.4 +
    t.ringTop +
    t.ring +
    t.daysTop +
    t.daysNum * 1.25 +
    t.timelineTop +
    timelineRowH +
    t.timelineNoteTop +
    t.timelineNote * 1.4 +
    t.bodyPadB
  );
}

/**
 * Fixed chrome between the viewport top and the card's bottom edge on the
 * client home screens: the screen content's top padding (10) + the card's
 * own top margin (14) + bottom margin (18), plus a 20pt safety margin so
 * the card never kisses the fold.
 */
export const TOPCARD_FIT_CHROME = 10 + 14 + 18 + 20;

/** True when the whole card (estimate + chrome) fits the visible screen —
 * the card is fully visible without scrolling (Anuraj, Sept 2026). */
export function topCardFitsScreen(
  screenWidth: number,
  screenHeight: number,
  addressLines: number = 2,
): boolean {
  return (
    estimateTopCardHeight(topCardTokens(screenWidth, screenHeight), addressLines) +
      TOPCARD_FIT_CHROME <=
    screenHeight
  );
}
