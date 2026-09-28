// Clear to Close — cancel-escrow confirm sheet (deal-list edit round, Sept 2026).
// "Cancel this escrow?" / "The escrow moves to the Cancelled section on your
// deal list." / danger "Cancel escrow" + quiet "Keep it".
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { store } from '../lib/store-instance';
import type { Escrow } from '../lib/types';
import { Kicker, Sheet } from './ui';
import { colors } from '../theme';

interface CancelEscrowSheetProps {
  escrow: Escrow | null;
  onClose: () => void;
  onCancelled: (escrow: Escrow) => void;
}

/**
 * The confirmation content without the Sheet wrapper (Sept 28, 2026): the
 * Update escrow sheet renders this INSIDE its own already-open Modal.
 * iOS silently drops a second Modal presented while another is visible
 * (verified in react-native 0.86.3: RCTModalHostViewComponentView presents
 * from the root view controller, so the second present is ignored), which
 * is why the stacked CancelEscrowSheet never appeared from the Update
 * sheet's "Cancel this escrow" action. One Modal on screen at a time.
 */
export function CancelEscrowBody({ escrow, onClose, onCancelled }: CancelEscrowSheetProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!escrow || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { escrow: updated } = await store.cancelEscrow(escrow.id);
      onCancelled(updated);
    } catch (err) {
      console.warn('cancelEscrow failed', err);
      setError('Could not cancel the escrow. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Kicker>Cancel escrow</Kicker>
      <Text style={styles.h2}>Cancel this escrow?</Text>
      <Text style={styles.body}>
        The escrow moves to the Cancelled section on your deal list.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          onPress={confirm}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Cancel escrow"
          testID="confirm-cancel-escrow"
          style={({ pressed }) => [
            styles.dangerBtn,
            pressed && { opacity: 0.85 },
            saving && { opacity: 0.6 },
          ]}
        >
          <Text style={styles.dangerText}>{saving ? 'Cancelling…' : 'Cancel escrow'}</Text>
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Keep it"
          testID="keep-escrow"
          style={({ pressed }) => [styles.quietBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.quietText}>Keep it</Text>
        </Pressable>
      </View>
    </>
  );
}

// Deal-list usage (app/index.tsx): the confirmation in its own Sheet. This
// stays a standalone Modal because the deal list has no other Modal open.
export default function CancelEscrowSheet({ escrow, onClose, onCancelled }: CancelEscrowSheetProps) {
  return (
    <Sheet visible={!!escrow} onClose={onClose}>
      <CancelEscrowBody escrow={escrow} onClose={onClose} onCancelled={onCancelled} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  h2: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 6,
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
  error: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.red,
    marginTop: 12,
  },
  actions: {
    marginTop: 20,
  },
  dangerBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    backgroundColor: colors.red,
    borderRadius: 14,
  },
  dangerText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  quietBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginTop: 6,
  },
  quietText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.body,
  },
});
