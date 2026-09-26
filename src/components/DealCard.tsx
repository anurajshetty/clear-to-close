// Clear to Close — deal list card (tap to open the transaction)
// Faithful to APPROVED mockup 01 · Escrow tracker v1.
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { colors } from '../theme';
import { Card } from './ui';

export type DealSide = 'buy' | 'sell' | 'both';

const SIDE_LABEL: Record<DealSide, string> = { buy: 'Buy side', sell: 'Sell side', both: 'Both' };
const SIDE_FG: Record<DealSide, string> = {
  buy: colors.accent, sell: colors.sellBrown, both: colors.bothInk,
};
const SIDE_BG: Record<DealSide, string> = {
  buy: colors.accentSoft, sell: colors.sellSoft, both: colors.bothSoft,
};

export function DealCard({
  address, city, partyLine, side, chip, chipUrgent, chipClosed, fracLabel, frac, onPress,
}: {
  address: string;
  city: string;
  partyLine: string;
  side: DealSide;
  chip: string;
  chipUrgent?: boolean;
  chipClosed?: boolean;
  fracLabel: string;
  frac: number;
  onPress: () => void;
}) {
  const chipFg = chipClosed ? colors.sage : chipUrgent ? colors.amber : colors.accent;
  const chipBg = chipClosed ? colors.sageSoft : chipUrgent ? colors.amberSoft : colors.accentSoft;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [chipClosed && { opacity: 0.62 }, pressed && { transform: [{ scale: 0.99 }] }]}
    >
      <Card>
        <View style={styles.row1}>
          <Text style={styles.addr} numberOfLines={2}>{address}</Text>
          <View style={[styles.sidePill, { backgroundColor: SIDE_BG[side] }]}>
            <Text style={[styles.sidePillText, { color: SIDE_FG[side] }]}>
              {SIDE_LABEL[side]}
            </Text>
          </View>
        </View>

        <Text style={styles.sub} numberOfLines={1}>
          {city} · {partyLine}
        </Text>

        <View style={styles.meta}>
          <View style={[styles.chip, { backgroundColor: chipBg }]}>
            <Text style={[styles.chipText, { color: chipFg }]}>{chip}</Text>
          </View>
          <Text style={styles.frac}>{fracLabel}</Text>
        </View>

        <View style={styles.bar} accessibilityRole="image"
          accessibilityLabel={`${Math.round(frac * 100)}% of steps complete`}>
          <View style={[styles.fill, { width: `${Math.min(Math.max(frac * 100, 0), 100)}%` }]} />
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row1: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10,
  },
  addr: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 2 },
  sidePill: {
    flexShrink: 0, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 9, marginTop: 2,
  },
  sidePillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase' },
  sub: { fontSize: 13.5, color: colors.muted, marginBottom: 12 },
  meta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, marginBottom: 10,
  },
  chip: { borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  chipText: { fontSize: 12.5, fontWeight: '700' },
  frac: { fontSize: 13, fontWeight: '700', color: colors.body },
  bar: { height: 7, borderRadius: 99, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 99, backgroundColor: colors.accent },
});
