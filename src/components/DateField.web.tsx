// Clear to Close — shared date field, WEB implementation (Sept 2026).
// Metro resolves this file on web instead of DateField.tsx. Uses the native
// date input styled to match the app's text fields — no popup-overlap
// pattern (the old calendar popup was removed for overlapping the sheet).
// The value is always ISO 'YYYY-MM-DD'; the browser renders the familiar
// native date control around it.
//
// Clear affordance (Sept 28, 2026, Anuraj-approved): when the owner passes
// `onClear` and a date is set, a red × renders at the trailing end of the
// field — same glyph + styling as the checklist edit-mode remove control
// (native DateField): red Material close X, 44pt target.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, radius } from '../theme';
import { AutoFilledPill } from './ui';
import type { DateFieldProps } from './DateField';

// Same glyph as the native DateField clear control.
const CLEAR_X_PATH =
  'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

export default function DateField({ label, value, onChange, onClear, autoFilled, testID }: DateFieldProps) {
  // '' is the only unset state on web (the native side additionally guards
  // with parseISODate; the form rejects invalid dates before they land).
  const canClear = !!onClear && !!value.trim();
  return (
    <View style={styles.wrap}>
      {autoFilled ? (
        <View style={styles.labelRow}>
          <Text style={styles.labelNoMargin}>{label}</Text>
          <AutoFilledPill />
        </View>
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
      <View style={styles.fieldRow}>
        <input
          type="date"
          value={value}
          aria-label={label}
          data-testid={testID}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          style={{
            borderWidth: '1.5px',
            borderStyle: 'solid',
            borderColor: colors.line,
            borderRadius: radius.input,
            padding: '13px 14px',
            fontSize: 15,
            color: colors.ink,
            backgroundColor: colors.inputBg,
            // The input fills the row exactly as it filled the column
            // before, so fields without a clear control look unchanged.
            flex: 1,
            // iOS Safari's native date input has a large intrinsic min-width
            // and will not shrink to its container (it overflows the sheet
            // at phone widths). These two lines constrain it without changing
            // any other styling.
            maxWidth: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
        {canClear && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            testID={testID ? `${testID}-clear` : undefined}
            onPress={onClear}
            style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.55 }]}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24" aria-hidden={true}>
              <Path d={CLEAR_X_PATH} fill={colors.red} />
            </Svg>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  label: {
    fontSize: 13, fontWeight: '700', color: colors.body, marginBottom: 8,
  },
  // Label row for the autoFilled pill (Oct 1, 2026, buyer intake): the row
  // carries the 8px bottom margin the label used to carry alone.
  labelRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 8,
  },
  labelNoMargin: {
    fontSize: 13, fontWeight: '700', color: colors.body,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Clear ×: checklist edit-mode remove-control styling (StepRow.removeBtn).
  clearBtn: {
    flexShrink: 0,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
