// Clear to Close — "Edit dates" sheet.
// Approved escrow lifecycle (mockup 01 · devices 2/3/12, Sept 2026): opened
// from the pencil icons on the time-tracker card; both dates editable via the
// NATIVE date picker — iOS spinner / Android dialog via
// @react-native-community/datetimepicker, and a real <input type="date"> on
// web (the community picker renders nothing on web, so web gets its own
// branch); the target close must be on or after the opened date; saving
// recomputes day X of Y, the bar, and days-left.
//
// NOTE: this adds the first new native module to the app. The iOS and web
// exports stay green (JS-only), but Anuraj's next `eas build` picks the
// native module up via autolinking — flag it as a binary-rebuild item.
import React, { createElement, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Kicker, PrimaryButton, Sheet } from './ui';
import { colors } from '../theme';
import { formatClosedDate } from '../lib/lifecycle';

function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateToISO(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function toMs(iso: string): number {
  return isoToDate(iso).getTime();
}

type Picking = 'opened' | 'target' | null;

export function EditDatesSheet({
  visible, openDate, closeDate, saving, onClose, onSave,
}: {
  visible: boolean;
  /** Current dates, used to prefill the picker when the sheet opens. */
  openDate: string;
  closeDate: string;
  saving: boolean;
  onClose: () => void;
  onSave: (open: string, close: string) => void;
}) {
  const [opened, setOpened] = useState(openDate);
  const [target, setTarget] = useState(closeDate);
  const [picking, setPicking] = useState<Picking>(null);
  const [error, setError] = useState<string | null>(null);

  // Prefill fresh every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setOpened(openDate);
      setTarget(closeDate);
      setPicking(null);
      setError(null);
    }
  }, [visible, openDate, closeDate]);

  const onPick = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === 'android') setPicking(null);
    if (event.type === 'dismissed') return;
    if (!date || !picking) return;
    const iso = dateToISO(date);
    if (picking === 'opened') setOpened(iso);
    else setTarget(iso);
  };

  const submit = () => {
    if (toMs(target) < toMs(opened)) {
      setError("The target close can't be before the opened date.");
      return;
    }
    setError(null);
    setPicking(null);
    onSave(opened, target);
  };

  const row = (key: Exclude<Picking, null>, label: string, value: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Change ${label}, currently ${formatClosedDate(value)}`}
      onPress={() => setPicking((p) => (p === key ? null : key))}
      style={({ pressed }) => [styles.dateRow, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.dateLabel}>{label}</Text>
      <Text style={styles.dateValue}>{formatClosedDate(value)}</Text>
    </Pressable>
  );

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Kicker>Escrow dates</Kicker>
      <Text style={styles.title}>Edit dates</Text>

      {row('opened', 'Opened', opened)}
      {row('target', 'Target close', target)}

      {picking !== null && (
        <View style={styles.pickerWrap}>
          {Platform.OS === 'web' ? (
            // The community picker renders nothing on web — use the real
            // native date input instead. Value stays 'YYYY-MM-DD' (local).
            createElement('input', {
              type: 'date',
              value: picking === 'opened' ? opened : target,
              'aria-label': picking === 'opened' ? 'Opened date' : 'Target close date',
              onChange: (e: { target?: { value?: string } }) => {
                const v = e?.target?.value;
                if (!v) return;
                if (picking === 'opened') setOpened(v);
                else setTarget(v);
              },
              style: styles.webDateInput,
            })
          ) : (
            <>
              {Platform.OS === 'ios' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done picking date"
                  onPress={() => setPicking(null)}
                  style={styles.pickerDone}
                >
                  <Text style={styles.pickerDoneText}>Done</Text>
                </Pressable>
              )}
              <DateTimePicker
                value={isoToDate(picking === 'opened' ? opened : target)}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onPick}
              />
            </>
          )}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.hint}>The time tracker recomputes from these dates.</Text>

      <View style={styles.actions}>
        <View style={styles.saveWrap}>
          <PrimaryButton title={saving ? 'Saving…' : 'Save'} onPress={submit} disabled={saving} />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 6,
    marginBottom: 14,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: 'rgba(231,224,211,.9)',
    marginBottom: 10,
  },
  dateLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.body,
  },
  dateValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent,
  },
  pickerWrap: {
    marginBottom: 10,
  },
  // Web-only: the native date input rendered via createElement.
  webDateInput: {
    width: '100%',
    fontSize: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    color: colors.ink,
  },
  pickerDone: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  pickerDoneText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent,
  },
  error: {
    fontSize: 13.5,
    color: '#B3261E',
    marginBottom: 6,
  },
  hint: {
    fontSize: 13,
    color: colors.muted,
    marginBottom: 14,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  saveWrap: {
    flex: 1,
  },
  cancel: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.muted,
  },
});
