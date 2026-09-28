// Clear to Close — "Update escrow" sheet (deal-list edit round, Sept 2026).
// Field-identical to the new-escrow form, with every value pre-populated from
// the card and everything editable EXCEPT the side (Sept 28, 2026, Anuraj):
// the side picker is locked after creation (lockSide) — no buyer↔seller
// switches in the edit flow, which kills the ghost-invite problem at the
// root. The side value submits unchanged, including 'both' for older
// dual-agency escrows.
// Save → card updates in place; the deal list shows an "Escrow updated."
// toast and stays on the list. The sheet also carries the "Cancel this
// escrow" danger action (open escrows only — closed cards show the pencil
// only, and cancelled escrows have no X).
// Activate escrow (Sept 2026): the same sheet edits closed/cancelled
// escrows. On those, the submit button reads "Activate escrow" and saving
// flips the status back to open (the escrow moves to the Active list with
// its steps, invites, and client links carried over). There is no plain
// "save without reactivating" — the label makes the action explicit.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { store } from '../lib/store-instance';
import type { Escrow } from '../lib/types';
import { EscrowFormSheet, escrowToInitial } from './EscrowFormSheet';
import { CancelEscrowBody } from './CancelEscrowSheet';
import { colors } from '../theme';

interface UpdateEscrowSheetProps {
  escrow: Escrow | null;
  onClose: () => void;
  onSaved: (escrow: Escrow) => void;
}

export default function UpdateEscrowSheet({ escrow, onClose, onSaved }: UpdateEscrowSheetProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const activating = !!escrow && escrow.status !== 'open';

  // The confirmation renders INSIDE this sheet's already-open Modal (via
  // confirmBody), never as a second stacked Sheet: iOS silently drops a
  // Modal presented while another is visible (verified in react-native
  // 0.86.3), which is why tapping "Cancel this escrow" used to do nothing.
  // While confirming, the overlay/back dismissal only backs out of the
  // confirmation — the update sheet (and its form state) stays put.
  return (
    <EscrowFormSheet
      visible={!!escrow}
      onClose={confirmingCancel ? () => setConfirmingCancel(false) : onClose}
      kicker="Edit escrow"
      title="Update escrow"
      submitLabel={activating ? "Activate escrow" : "Update escrow"}
      savingLabel={activating ? "Activating…" : "Saving…"}
      initial={escrow ? escrowToInitial(escrow) : null}
      lockSide
      onSubmit={(input) =>
        activating
          ? store.activateEscrow(escrow!.id, input)
          : store.updateEscrow(escrow!.id, input)
      }
      onDone={onSaved}
      confirmBody={
        confirmingCancel && escrow ? (
          <CancelEscrowBody
            escrow={escrow}
            onClose={() => setConfirmingCancel(false)}
            onCancelled={(updated) => {
              setConfirmingCancel(false);
              onClose();
              onSaved(updated);
            }}
          />
        ) : undefined
      }
      footer={
        escrow && escrow.status === 'open' ? (
          <Pressable
            onPress={() => setConfirmingCancel(true)}
            accessibilityRole="button"
            accessibilityLabel="Cancel this escrow"
            testID="cancel-this-escrow"
            style={({ pressed }) => [styles.danger, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.dangerText}>Cancel this escrow</Text>
          </Pressable>
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  danger: {
    marginTop: 22,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.red,
  },
});
