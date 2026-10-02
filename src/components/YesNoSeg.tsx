// Clear to Close — shared Yes/No segmented control (Oct 1, 2026).
//
// The mockup's segmented control (TC intake mockup 04 device ②, buyer
// intake mockup 08 device ②): a two-or-more-option pill group with the
// selected option on a white card. Extracted from app/tc-intake/[escrowId]
// when the buyer intake needed the identical control — one component, no
// divergent copies. Byte-identical rendering to the original.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

export interface SegOption {
  label: string;
  value: string;
}

export function YesNoSeg({
  label,
  value,
  onChange,
  options,
  testID,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SegOption[];
  testID?: string;
  /**
   * Inline validation error shown under the control (Oct 2026, buyer
   * intake conditional validation) — mirrors Field's error pattern, same
   * red hint style. Purely additive: existing callers render byte-identical
   * output.
   */
  error?: string | null;
}) {
  return (
    <View style={styles.segWrap} testID={testID}>
      <Text style={styles.segLabel}>{label}</Text>
      <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.value)}
              style={[styles.segBtn, on && styles.segBtnOn]}
            >
              <Text style={[styles.segBtnText, on && styles.segBtnTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text style={styles.segError} testID={testID ? `${testID}-error` : undefined}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export const YES_NO: SegOption[] = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
];

export const LEASED_OWNED: SegOption[] = [
  { label: 'Leased', value: 'leased' },
  { label: 'Owned', value: 'owned' },
];

const styles = StyleSheet.create({
  segWrap: {
    marginBottom: 10,
  },
  segLabel: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.body,
    marginBottom: 6,
  },
  seg: {
    flexDirection: 'row',
    backgroundColor: colors.tabBg,
    borderRadius: radius.input,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  segBtnOn: {
    backgroundColor: colors.card,
    shadowColor: '#1E190F',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  segBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.muted,
  },
  segBtnTextOn: {
    color: colors.ink,
  },
  /** Mirrors Field's fieldError style (Oct 2026, buyer intake conditional
   * validation) — same red hint line under the control. */
  segError: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
    lineHeight: 18,
  },
});
