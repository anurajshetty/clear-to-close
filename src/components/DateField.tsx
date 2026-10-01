// Clear to Close — shared date field (Sept 2026).
// Dead-simple date picking with NO popup-overlap pattern (the old calendar
// popup was removed for overlapping the sheet): the value is always shown as
// YYYY-MM-DD text in a field-styled box, and the picker only opens when the
// user taps the field (Sept 28, 2026: the iOS inline calendar used to render
// expanded on sheet open and the field box was not even tappable). Web
// resolves to DateField.web.tsx (native date input); this file is the native
// implementation (inline datetimepicker).
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import Svg, { Path } from 'react-native-svg';
import { colors, radius } from '../theme';
import { AutoFilledPill } from './ui';

export interface DateFieldProps {
  label: string;
  /** ISO date 'YYYY-MM-DD' ('' when unset). */
  value: string;
  onChange: (isoDate: string) => void;
  /**
   * When provided AND a date is set, a red × clear control renders at the
   * trailing end of the field (key-date clearing, Sept 28, 2026,
   * Anuraj-approved). Clearing the field stages '' — the owning form maps
   * blank to NULL on the confirmed write path. Styling reuses the checklist
   * edit-mode remove control (StepRow): same Material close glyph, red,
   * 44pt target, pressed opacity — no new design language.
   */
  onClear?: () => void;
  /**
   * "Auto-filled" pill after the label (Oct 1, 2026, buyer intake mockup
   * 08). Purely additive — existing callers render byte-identical output.
   */
  autoFilled?: boolean;
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

// Material "close" (X) path, 24x24 viewBox — the SAME glyph as the checklist
// edit-mode remove control (StepRow): red X, 44pt target. UI-reuse
// principle: no new design language for the key-date clear affordance.
const CLEAR_X_PATH =
  'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

export default function DateField({ label, value, onChange, onClear, autoFilled, testID }: DateFieldProps) {
  // Collapsed until the user taps the field (Sept 28, 2026: the calendar
  // used to render expanded inline on sheet open, with no way to dismiss).
  const [open, setOpen] = React.useState(false);
  const selected = parseISODate(value);
  // The × only exists once a date is set (and only where the owner passes
  // onClear — open/close dates are required and never clearable).
  const canClear = !!onClear && !!selected;
  const onPick = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === 'android') {
      // Android fires for both set and dismissed; only a real date commits.
      if (event.type === 'set' && date) onChange(toISODate(date));
      setOpen(false);
      return;
    }
    // iOS inline calendar: tapping a day commits; collapse right after so
    // the calendar never stays expanded in the sheet.
    if (date) onChange(toISODate(date));
    setOpen(false);
  };
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
        <Pressable
          style={[styles.box, styles.boxFill]}
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={open ? 'Close the calendar' : 'Open the calendar'}
          onPress={() => setOpen((o) => !o)}
        >
          <Text style={[styles.boxText, !selected && styles.boxPlaceholder]}>
            {selected ? value : 'Select date'}
          </Text>
        </Pressable>
        {canClear && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            testID={testID ? `${testID}-clear` : undefined}
            hitSlop={10}
            onPress={onClear}
            style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.55 }]}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24" aria-hidden={true}>
              <Path d={CLEAR_X_PATH} fill={colors.red} />
            </Svg>
          </Pressable>
        )}
      </View>
      {open && (
        <DateTimePicker
          value={selected ?? new Date()}
          mode="date"
          // iOS renders the calendar inline in the layout (never a popup).
          // Android has no inline mode; "default" is the platform-standard
          // dialog (not the broken overlapping web popup).
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={onPick}
        />
      )}
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
  // The field box and the (optional) clear × sit in a row: the box fills
  // the row exactly as it filled the column before, so fields without a
  // clear control render byte-identical to the old layout.
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  box: {
    borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.input,
    paddingVertical: 13, paddingHorizontal: 14, backgroundColor: colors.inputBg,
  },
  boxFill: { flex: 1 },
  // Clear ×: checklist edit-mode remove-control styling (StepRow.removeBtn).
  clearBtn: {
    flexShrink: 0,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxText: { fontSize: 15, color: colors.ink },
  boxPlaceholder: { color: colors.muted },
});
