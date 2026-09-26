// Clear to Close — shared date field (Sept 2026).
// Dead-simple date picking with NO popup-overlap pattern (the old calendar
// popup was removed for overlapping the sheet): the value is always shown as
// YYYY-MM-DD text in a field-styled box, and the picker itself renders inline
// in the layout flow. Web resolves to DateField.web.tsx (native date input);
// this file is the native implementation (inline datetimepicker).
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { colors, radius } from '../theme';

export interface DateFieldProps {
  label: string;
  /** ISO date 'YYYY-MM-DD' ('' when unset). */
  value: string;
  onChange: (isoDate: string) => void;
  testID?: string;
}

function toISODate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

export default function DateField({ label, value, onChange, testID }: DateFieldProps) {
  const selected = parseISODate(value);
  const onPick = (_event: DateTimePickerEvent, date?: Date) => {
    // Android fires twice (set + dismissed); only a real date commits.
    if (date) onChange(toISODate(date));
  };
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.box} testID={testID}>
        <Text style={[styles.boxText, !selected && styles.boxPlaceholder]}>
          {selected ? value : 'Select date'}
        </Text>
      </View>
      <DateTimePicker
        value={selected ?? new Date()}
        mode="date"
        // iOS renders the calendar inline in the layout (never a popup).
        // Android has no inline mode; "default" is the platform-standard
        // dialog (not the broken overlapping web popup).
        display={Platform.OS === 'ios' ? 'inline' : 'default'}
        onChange={onPick}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  label: {
    fontSize: 13, fontWeight: '700', color: colors.body, marginBottom: 8,
  },
  box: {
    borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.input,
    paddingVertical: 13, paddingHorizontal: 14, backgroundColor: colors.inputBg,
  },
  boxText: { fontSize: 15, color: colors.ink },
  boxPlaceholder: { color: colors.muted },
});
