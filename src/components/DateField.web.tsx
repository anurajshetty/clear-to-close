// Clear to Close — shared date field, WEB implementation (Sept 2026).
// Metro resolves this file on web instead of DateField.tsx. Uses the native
// date input styled to match the app's text fields — no popup-overlap
// pattern (the old calendar popup was removed for overlapping the sheet).
// The value is always ISO 'YYYY-MM-DD'; the browser renders the familiar
// native date control around it.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import type { DateFieldProps } from './DateField';

export default function DateField({ label, value, onChange, testID }: DateFieldProps) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
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
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'inherit',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  label: {
    fontSize: 13, fontWeight: '700', color: colors.body, marginBottom: 8,
  },
});
