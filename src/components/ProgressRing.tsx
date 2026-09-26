// Clear to Close — progress ring (react-native-svg; works on native + web)
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../theme';

const R = 30;

export function ProgressRing({
  done, total, size = 72,
}: { done: number; total: number; size?: number }) {
  const frac = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 0;
  const pct = Math.round(frac * 100);
  const k = size / 72;
  const center = size / 2;
  const r = R * k;
  const stroke = 7 * k;
  // The dash pattern must be derived from the ACTUAL rendered radius, which
  // scales with `size`. A hardcoded dasharray (e.g. 2π·30 ≈ 188.5, correct
  // only for size=72) leaves a visible gap at 100% at any other size — the
  // arc and the % text then disagree. (Sept 2026: client top card at size=84
  // showed 100% text with an incomplete arc.)
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - frac);

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel={`${pct}% complete`}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={center} cy={center} r={r} fill="none"
          stroke={colors.line} strokeWidth={stroke} />
        <Circle cx={center} cy={center} r={r} fill="none"
          stroke={colors.accent} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={String(circumference)} strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`} />
      </Svg>
      <View style={styles.labelWrap} pointerEvents="none">
        <Text style={[styles.label, { fontSize: Math.round(size * 0.222) }]}>
          {pct}%
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  labelWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  label: { fontWeight: '800', color: colors.ink, textAlign: 'center' },
});
