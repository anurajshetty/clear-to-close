// Clear to Close — shared confetti layer.
//
// Extracted from the redeem celebration card's pattern (Sept 2026 branding):
// confetti falls once on mount (~2.5s, ease-out) and settles. When the OS
// reduced-motion setting is on, pieces render in their settled positions
// with no animation at all.
//
// Used by the redeem celebration card and the client-home 100% triumph
// card. (Merge note: the redeem card still carries its own local copy of
// this layer — point it at this shared component and delete the duplicate.)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';

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
});
