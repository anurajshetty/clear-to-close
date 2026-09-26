// Clear to Close — collapsible deal-list section header (Sept 2026).
// Bordered dropdown-style card: white card, 16px radius, 1px border, subtle
// shadow, 52px min-height, 16px/800 ink title with the count in muted, and an
// up chevron when expanded / down chevron when collapsed.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';

const CHEVRON_DOWN = 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z';
const CHEVRON_UP = 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z';

export function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
  testID,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${title}, ${expanded ? 'expanded' : 'collapsed'}`}
      testID={testID}
      style={({ pressed }) => [styles.head, pressed && { opacity: 0.75 }]}
    >
      <Text style={styles.title}>
        {title} <Text style={styles.count}>· {count}</Text>
      </Text>
      <View style={styles.chevron}>
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Path d={expanded ? CHEVRON_UP : CHEVRON_DOWN} fill={colors.body} />
        </Svg>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(231,224,211,0.7)',
    shadowColor: '#1E1910',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.ink,
  },
  count: {
    color: colors.muted,
    fontWeight: '700',
  },
  chevron: {
    width: 44,
    height: 44,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
