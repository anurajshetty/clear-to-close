// Clear to Close — "Edit dates" sheet.
// Approved escrow lifecycle (mockup 01 · devices 2/3/12, Sept 2026): opened
// from the pencil icons on the time-tracker card; both dates are plain
// text-box inputs exactly like the create-escrow form's date inputs
// (YYYY-MM-DD) — the calendar picker popup was dropped Sept 2026 (Anuraj:
// it rendered broken/overlapping). The target close must be on or after the
// opened date; saving recomputes day X of Y, the bar, and days-left.
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Field, Kicker, PrimaryButton, Sheet } from './ui';
import { colors } from '../theme';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same real-date guard as the create-escrow form's date inputs.
function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function toMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function EditDatesSheet({
  visible, openDate, closeDate, saving, onClose, onSave,
}: {
  visible: boolean;
  /** Current dates, used to prefill the inputs when the sheet opens. */
  openDate: string;
  closeDate: string;
  saving: boolean;
  onClose: () => void;
  onSave: (open: string, close: string) => void;
}) {
  const [opened, setOpened] = useState(openDate);
  const [target, setTarget] = useState(closeDate);
  const [error, setError] = useState<string | null>(null);

  // Prefill fresh every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setOpened(openDate);
      setTarget(closeDate);
      setError(null);
    }
  }, [visible, openDate, closeDate]);

  const submit = () => {
    if (!isRealDate(opened) || !isRealDate(target)) {
      setError('Use YYYY-MM-DD.');
      return;
    }
    if (toMs(target) < toMs(opened)) {
      setError("The target close can't be before the opened date.");
      return;
    }
    setError(null);
    onSave(opened, target);
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Kicker>Escrow dates</Kicker>
      <Text style={styles.title}>Edit dates</Text>

      <Field
        label="Escrow open date"
        value={opened}
        onChangeText={(v) => {
          setOpened(v);
          setError(null);
        }}
        placeholder="YYYY-MM-DD"
        testID="edit-open-date"
      />
      <Field
        label="Target close date"
        value={target}
        onChangeText={(v) => {
          setTarget(v);
          setError(null);
        }}
        placeholder="YYYY-MM-DD"
        testID="edit-target-date"
      />

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
