// confetti.test.ts — REGRESSION: redeem celebration confetti burst
// (Anuraj's call, Sept 2026). The burst pops lots of pieces up from the
// bottom edge of the celebration card when it appears, then they fall
// back down. The component samples these pure physics helpers onto a
// single Animated.Value; covered here since RN components are not
// importable in the node suite.
import { assert, summary } from './assert';
import {
  BURST_COUNT,
  BURST_DURATION_MS,
  BURST_GRAVITY,
  makeBurstPieces,
  sampleBurstPiece,
  type BurstPiece,
} from '../src/lib/confetti';

const pieces = makeBurstPieces(BURST_COUNT);
assert(pieces.length === BURST_COUNT, `burst has ${BURST_COUNT} pieces`);
assert(
  JSON.stringify(makeBurstPieces(BURST_COUNT)) === JSON.stringify(pieces),
  'burst is deterministic across renders',
);
assert(
  pieces.every((p) => p.vy < 0),
  'every piece pops upward (negative vy)',
);
assert(
  pieces.every((p) => p.x0 >= 0 && p.x0 <= 1),
  'start x is a fraction of the card width',
);
assert(
  pieces.every((p) => p.delay >= 0 && p.delay <= 350),
  'delays are within the launch window',
);
assert(
  pieces.every((p) => p.size >= 6 && p.size <= 12),
  'piece sizes in range',
);

const W = 350;
const H = 420;
const p0: BurstPiece = pieces[0];

// Before launch (u=0, t<=0): hidden at the bottom edge.
const s0 = sampleBurstPiece(p0, 0, W, H);
assert(s0.opacity === 0, 'piece hidden before its delay');
assert(s0.y === H - 2, 'piece waits at the bottom edge');

// Mid-flight: above the bottom edge, fully visible.
let midVisible = false;
for (let s = 1; s < 23; s++) {
  const smp = sampleBurstPiece(p0, s / 23, W, H);
  if (smp.opacity === 1 && smp.y < H - 2) midVisible = true;
}
assert(midVisible, 'piece rises above the bottom edge mid-flight');

// Flight ends well within the duration: at u=1 every piece is gone.
assert(
  pieces.every((p) => sampleBurstPiece(p, 1, W, H).opacity === 0),
  'all pieces are gone by the end of the burst',
);

// Apex sanity: the strongest pop rises a celebratory height but stays
// within a plausible card (no piece teleports off the top).
const strongest = pieces.reduce((a, b) => (a.vy < b.vy ? a : b));
const apex = (strongest.vy * strongest.vy) / (2 * BURST_GRAVITY);
assert(apex > 60 && apex < H, `apex ${Math.round(apex)}px is a real pop, inside the card`);

// Opacity never leaves [0,1] over the whole flight.
let opacityOk = true;
for (const p of pieces) {
  for (let s = 0; s <= 23; s++) {
    const o = sampleBurstPiece(p, s / 23, W, H).opacity;
    if (o < 0 || o > 1) opacityOk = false;
  }
}
assert(opacityOk, 'opacity stays in [0,1]');

assert(BURST_DURATION_MS === 3000, 'burst duration constant');

summary('confetti');
