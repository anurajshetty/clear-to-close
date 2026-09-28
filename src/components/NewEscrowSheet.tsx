// Clear to Close — new-escrow sheet.
// Thin wrapper over the shared EscrowFormSheet (create mode). Two-phase
// create (Sept 28, 2026, Anuraj): the form validates on submit, then shows
// a confirmation screen summarizing the entered data ("Create escrow" /
// "Back to edit") instead of creating immediately — a mistaken side
// selection gets caught before creation. Public API is unchanged:
// visible / onClose / onCreated(id).
import React from 'react';
import { store } from '../lib/store-instance';
import type { Escrow } from '../lib/types';
import { EscrowFormSheet } from './EscrowFormSheet';

interface NewEscrowSheetProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function NewEscrowSheet({ visible, onClose, onCreated }: NewEscrowSheetProps) {
  return (
    <EscrowFormSheet
      visible={visible}
      onClose={onClose}
      kicker="New escrow"
      title="Open escrow"
      submitLabel="Open escrow"
      savingLabel="Opening…"
      initial={null}
      confirmCreate
      onSubmit={(input) => store.createEscrow(input)}
      onDone={(e: Escrow) => onCreated(e.id)}
    />
  );
}
