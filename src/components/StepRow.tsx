// Clear to Close — tappable checklist step row with drag grip
// Faithful to APPROVED mockup 01 · Escrow tracker v1.
import React, { ReactNode } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';
import { Grip } from './ui';

export function StepRow({
  title, subtitle, done, custom, onToggle, dragHandle,
}: {
  title: string;
  subtitle?: string;
  done: boolean;
  custom?: boolean;
  onToggle: () => void;
  dragHandle?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ checked: done }}
      onPress={onToggle}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.node, done && styles.nodeDone]}>
        {done && (
          <Svg width={13} height={11} viewBox="0 0 11 9" aria-hidden={true}>
            <Path
              d="M1 4.5L4 7.5L10 1"
              stroke="#FFFFFF" strokeWidth={2.2}
              strokeLinecap="round" strokeLinejoin="round" fill="none"
            />
          </Svg>
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, done && styles.titleDone]}>
          {title}
          {custom ? <Text style={styles.customTag}>  Custom</Text> : null}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>

      <View style={styles.gripZone}>
        {dragHandle ?? <Grip />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    minHeight: 64, paddingVertical: 13, paddingHorizontal: 4,
  },
  node: {
    width: 28, height: 28, borderRadius: 14, flexShrink: 0,
    backgroundColor: colors.card, borderWidth: 2.5, borderColor: colors.photoBorder,
    alignItems: 'center', justifyContent: 'center', marginTop: 2, marginLeft: 14, marginRight: 14,
  },
  nodeDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  body: { flex: 1, paddingTop: 1 },
  title: { fontSize: 15.5, fontWeight: '600', color: colors.ink },
  titleDone: { color: colors.body },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 3, lineHeight: 18.5 },
  customTag: {
    fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase',
    color: colors.sellBrown, backgroundColor: colors.sellSoft, borderRadius: 5,
  },
  gripZone: {
    flexShrink: 0, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 4, minWidth: 44, minHeight: 44,
  },
});
