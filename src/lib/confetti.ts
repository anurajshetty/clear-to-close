// Clear to Close — confetti-burst physics for the redeem celebration card
// (Anuraj's call, Sept 2026): lots of pieces popping up from the bottom
// edge of the card when the celebration appears, then falling back down.
//
// Pure functions only — the component samples these onto a single 0..1
// Animated.Value (precomputed per-piece sample arrays fed to interpolate),
// so the motion is deterministic and unit-testable. Works identically on
// iOS and web (transform + opacity, native driver).

export const BURST_COUNT = 80;
export const BURST_DURATION_MS = 3000;
/** px/s^2, downward. */
export const BURST_GRAVITY = 1100;
/** Samples per piece for the interpolate input/output ranges. */
export const BURST_SAMPLES = 24;

const BURST_COLORS = ['#F5C66B', '#FFFFFF', '#5FBFAE', '#D9E8E2', '#E8A93D', '#F28B5E'];

export interface BurstPiece {
  /** Start x as a fraction of the card width (0..1), along the bottom edge. */
  x0: number;
  /** Horizontal velocity, px/s. */
  vx: number;
  /** Vertical velocity, px/s (negative = upward pop). */
  vy: number;
  /** Total spin over the flight, degrees. */
  spin: number;
  size: number;
  color: string;
  circle: boolean;
  /** ms before this piece launches. */
  delay: number;
}

/** Deterministic pseudo-random so the burst is stable across renders. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBurstPieces(count: number, seed = 20260927): BurstPiece[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    x0: 0.05 + rand() * 0.9,
    vx: (rand() - 0.5) * 140,
    vy: -(380 + rand() * 320),
    spin: Math.round((rand() - 0.5) * 720),
    size: 6 + Math.round(rand() * 6),
    color: BURST_COLORS[i % BURST_COLORS.length],
    circle: rand() > 0.6,
    delay: Math.round(rand() * 350),
  }));
}

export interface BurstSample {
  x: number;
  y: number;
  opacity: number;
}

/**
 * Position + opacity of one piece at normalized time u (0..1) over
 * BURST_DURATION_MS. Before its delay the piece is hidden at the bottom
 * edge; after it falls ~30px below the edge it is gone (the card clips
 * with overflow:hidden). Fades out over the last stretch of the flight.
 */
export function sampleBurstPiece(
  p: BurstPiece,
  u: number,
  cardW: number,
  cardH: number,
): BurstSample {
  const y0 = cardH - 2;
  const x0 = p.x0 * cardW;
  const t = u * (BURST_DURATION_MS / 1000) - p.delay / 1000;
  if (t <= 0) return { x: x0, y: y0, opacity: 0 };
  const y = y0 + p.vy * t + 0.5 * BURST_GRAVITY * t * t;
  const x = x0 + p.vx * t;
  if (y > cardH + 30) return { x, y, opacity: 0 };
  // Time to return to launch height, plus the fall out of view.
  const tUp = (-p.vy * 2) / BURST_GRAVITY;
  const tEnd = tUp + 0.45;
  const fadeStart = tEnd * 0.75;
  const opacity =
    t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / (tEnd - fadeStart)) : 1;
  return { x, y, opacity };
}
