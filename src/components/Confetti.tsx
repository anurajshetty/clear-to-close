// Clear to Close — shared confetti animations (Anuraj's standing UI-reuse
// rule, Sept 2026): every confetti animation in the app lives here, one
// implementation reused everywhere — the redeem celebration card, the
// client-home 100% triumph card, and any future surface. Same look, same
// motion; no divergent copies.
//
// - ConfettiLayer: 16 pieces falling from the top once on mount (~2.5s,
//   ease-out), then settled. With OS reduced-motion on, pieces render in
//   their settled positions with no animation at all.
// - ConfettiBurst: 80 pieces popping up from the bottom edge of the card
//   (~3s, physics sampled from src/lib/confetti.ts), then falling back
//   down. With OS reduced-motion on, the pieces render as a static
//   mid-burst scatter with no animation at all.
//
// Pure React Native Animated (transform + opacity, native driver) —
// identical on iOS and web, no new native modules.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import {
  BURST_COUNT,
  BURST_DURATION_MS,
  BURST_SAMPLES,
  makeBurstPieces,
  sampleBurstPiece,
} from '../lib/confetti';

const CONFETTI_COUNT = 16;
const CONFETTI_COLORS = ['#F5C66B', '#FFFFFF', '#5FBFAE', '#D9E8E2', '#E8A93D'];
const CONFETTI_FALL_MS = 2500;

type ConfettiPiece = {
  /** Fraction of the card width (0..1) where the piece falls. */
  left: number;
  /** Fraction of the card height (0..1) where the piece settles. */
  finalY: number;
  size: number;
  color: string;
  circle: boolean;
  /** ms before this piece starts falling. */
  delay: number;
  /** degrees of rotation over the fall. */
  spin: number;
};

/** Deterministic pseudo-random so the layout is stable across renders. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePieces(): ConfettiPiece[] {
  const rand = mulberry32(20260926);
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    left: 0.04 + rand() * 0.92,
    finalY: 0.08 + rand() * 0.84,
    size: 6 + Math.round(rand() * 4),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    circle: rand() > 0.5,
    delay: Math.round(rand() * 500),
    spin: Math.round((rand() - 0.5) * 240),
  }));
}

/**
 * Confetti that falls from the top of the card once and settles.
 * When the OS reduced-motion setting is on, pieces render in their settled
 * positions with no animation at all.
 */
export function ConfettiLayer({
  cardHeight,
  testID = 'confetti',
}: {
  cardHeight: number;
  testID?: string;
}) {
  const pieces = useMemo(makePieces, []);
  const anims = useRef<Animated.Value[] | null>(null);
  if (anims.current === null) {
    anims.current = pieces.map(() => new Animated.Value(0));
  }
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (!active) return;
        const r = !!v;
        setReduced(r);
        if (r && anims.current) {
          // Skip the fall entirely: snap pieces to their settled positions.
          anims.current.forEach((a) => {
            a.stopAnimation();
            a.setValue(1);
          });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (reduced || cardHeight <= 0 || !anims.current) return;
    const timers = anims.current.map((a, i) =>
      Animated.timing(a, {
        toValue: 1,
        duration: CONFETTI_FALL_MS,
        delay: pieces[i].delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    const all = Animated.parallel(timers);
    all.start();
    return () => {
      all.stop();
    };
  }, [reduced, cardHeight, pieces]);

  if (cardHeight <= 0) return null;

  return (
    <View style={styles.confetti} pointerEvents="none" testID={testID}>
      {pieces.map((p, i) => {
        const a = (anims.current as Animated.Value[])[i];
        const translateY = a.interpolate({
          inputRange: [0, 1],
          outputRange: [-30, p.finalY * cardHeight],
        });
        const rotate = a.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', `${p.spin}deg`],
        });
        return (
          <Animated.View
            key={i}
            testID="confetti-piece"
            style={[
              styles.piece,
              {
                left: `${Math.round(p.left * 100)}%`,
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                borderRadius: p.circle ? p.size / 2 : 2,
                opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0, 0.95] }),
                transform: [{ translateY }, { rotate }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

/**
 * Confetti burst: lots of pieces popping up from the bottom edge of the
 * card when the celebration appears, then falling back down (Anuraj's
 * call, Sept 2026 — celebratory and generous, not a few static dots).
 * One shared 0..1 Animated.Value drives every piece through precomputed
 * physics samples (see src/lib/confetti.ts). With the OS reduced-motion
 * setting on, the pieces render as a static mid-burst scatter with no
 * animation at all.
 */
export function ConfettiBurst({
  cardWidth,
  cardHeight,
  testID = 'confetti-burst',
}: {
  cardWidth: number;
  cardHeight: number;
  testID?: string;
}) {
  const pieces = useMemo(() => makeBurstPieces(BURST_COUNT), []);
  const anim = useRef<Animated.Value | null>(null);
  if (anim.current === null) {
    anim.current = new Animated.Value(0);
  }
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (active) setReduced(!!v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (reduced || cardWidth <= 0 || cardHeight <= 0 || !anim.current) return;
    const a = Animated.timing(anim.current, {
      toValue: 1,
      duration: BURST_DURATION_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [reduced, cardWidth, cardHeight]);

  const inputRange = useMemo(
    () => Array.from({ length: BURST_SAMPLES }, (_, i) => i / (BURST_SAMPLES - 1)),
    [],
  );

  if (cardWidth <= 0 || cardHeight <= 0) return null;

  return (
    <View style={styles.confetti} pointerEvents="none" testID={testID}>
      {pieces.map((p, i) => {
        if (reduced) {
          const s = sampleBurstPiece(p, 0.4, cardWidth, cardHeight);
          return (
            <View
              key={i}
              testID="confetti-burst-piece"
              style={[
                styles.burstPiece,
                {
                  left: s.x - p.size / 2,
                  top: s.y - p.size / 2,
                  width: p.size,
                  height: p.size,
                  backgroundColor: p.color,
                  borderRadius: p.circle ? p.size / 2 : 2,
                  opacity: 0.9,
                },
              ]}
            />
          );
        }
        const a = anim.current as Animated.Value;
        const xs: number[] = [];
        const ys: number[] = [];
        const os: number[] = [];
        for (let s = 0; s < BURST_SAMPLES; s++) {
          const smp = sampleBurstPiece(p, s / (BURST_SAMPLES - 1), cardWidth, cardHeight);
          xs.push(smp.x - p.size / 2);
          ys.push(smp.y - p.size / 2);
          os.push(smp.opacity);
        }
        return (
          <Animated.View
            key={i}
            testID="confetti-burst-piece"
            style={[
              styles.burstPiece,
              {
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                borderRadius: p.circle ? p.size / 2 : 2,
                opacity: a.interpolate({ inputRange, outputRange: os }),
                transform: [
                  { translateX: a.interpolate({ inputRange, outputRange: xs }) },
                  { translateY: a.interpolate({ inputRange, outputRange: ys }) },
                  {
                    rotate: a.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', `${p.spin}deg`],
                    }),
                  },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  confetti: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  piece: {
    position: 'absolute',
    top: 0,
  },
  burstPiece: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
