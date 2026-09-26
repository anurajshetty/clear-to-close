// Clear to Close — deal list card (tap to open the transaction)
// Faithful to APPROVED mockup 01 · Escrow tracker v1.
//
// Deal-list edit round (Sept 2026): a pencil (edit) and X (cancel) icon sit
// in the upper-right corner (44pt targets; pencil in accent teal, X in red);
// the side tag moves down next to the city line; the buyer/seller name gets
// its own line below. Cancelled cards render greyed with a Cancelled tag and
// the pencil only. Icons are drawn with react-native-svg (Material edit/close
// paths) so they render identically on iOS and web with no native module.
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
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

// Material "edit" (pencil) and "close" (X) paths, 24x24 viewBox.
const PENCIL_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
const X_PATH =
  'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

function IconButton({
  d,
  color,
  onPress,
  label,
  testID,
}: {
  d: string;
  color: string;
  onPress: () => void;
  label: string;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.55 }]}
    >
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d={d} fill={color} />
      </Svg>
    </Pressable>
  );
}

export function DealCard({
  escrowId,
  address,
  city,
  partyLine,
  side,
  chip,
  chipUrgent,
  chipClosed,
  cancelled,
  fracLabel,
  frac,
  onPress,
  onEdit,
  onCancel,
}: {
  escrowId: string;
  address: string;
  city: string;
  partyLine: string;
  side: DealSide;
  chip: string;
  chipUrgent?: boolean;
  chipClosed?: boolean;
  cancelled?: boolean;
  fracLabel: string;
  frac: number;
  onPress: () => void;
  onEdit: () => void;
  /** null = no cancel affordance (closed and cancelled cards show the pencil only). */
  onCancel: (() => void) | null;
}) {
  const chipFg = cancelled
    ? colors.muted
    : chipClosed
      ? colors.sage
      : chipUrgent
        ? colors.amber
        : colors.accent;
  const chipBg = cancelled
    ? colors.line
    : chipClosed
      ? colors.sageSoft
      : chipUrgent
        ? colors.amberSoft
        : colors.accentSoft;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={`deal-${escrowId}`}
      style={({ pressed }) => [
        (chipClosed || cancelled) && { opacity: cancelled ? 0.55 : 0.62 },
        pressed && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <Card>
        <View style={styles.row1}>
          <Text style={styles.addr} numberOfLines={2}>{address}</Text>
          <View style={styles.icons}>
            <IconButton
              d={PENCIL_PATH}
              color={colors.accent}
              onPress={onEdit}
              label="Edit escrow"
              testID={`edit-${escrowId}`}
            />
            {onCancel ? (
              <IconButton
                d={X_PATH}
                color={colors.red}
                onPress={onCancel}
                label="Cancel escrow"
                testID={`cancel-${escrowId}`}
              />
            ) : null}
          </View>
        </View>

        <View style={styles.row2}>
          <Text style={styles.city} numberOfLines={1}>{city}</Text>
          <View style={[styles.sidePill, { backgroundColor: SIDE_BG[side] }]}>
            <Text style={[styles.sidePillText, { color: SIDE_FG[side] }]}>
              {SIDE_LABEL[side]}
            </Text>
          </View>
        </View>

        <Text style={styles.client} numberOfLines={1}>{partyLine}</Text>

        <View style={styles.meta}>
          <View style={[styles.chip, { backgroundColor: chipBg }]}>
            <Text style={[styles.chipText, { color: chipFg }]}>
              {cancelled ? 'Cancelled' : chip}
            </Text>
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
  icons: {
    flexDirection: 'row', flexShrink: 0, marginTop: -6, marginRight: -8,
  },
  iconBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
  },
  row2: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2,
  },
  city: { fontSize: 13.5, color: colors.muted, flexShrink: 1 },
  sidePill: {
    flexShrink: 0, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 9,
  },
  sidePillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase' },
  client: { fontSize: 13.5, color: colors.muted, marginBottom: 12 },
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
