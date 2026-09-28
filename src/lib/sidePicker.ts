// Clear to Close — new-escrow side picker logic (single-select radio,
// Anuraj Sept 28, 2026: tapping Sell side deselects Buy side and vice versa,
// only one can be selected at a time).
//
// Pure logic for the side picker, kept out of the sheet component so it can be
// unit-tested. Legacy stored escrows with side 'both' still round-trip
// through selectionToSide/sideToSelection so the edit flow never rewrites
// stored data; the picker itself is radio-only.

import type { Side } from './types';

/** Which side is selected in the new-escrow sheet (exactly one). */
export interface SideSelection {
  buy: boolean;
  sell: boolean;
}

/** Default picker state: Buy side selected, Sell side off. */
export const DEFAULT_SIDE_SELECTION: SideSelection = { buy: true, sell: false };

/**
 * Select one side card. Radio behavior: tapping a card selects it and
 * clears the other. At least one side always stays selected — tapping the
 * already-selected card is a no-op (the guard), never leaves both off.
 */
export function toggleSide(sel: SideSelection, which: 'buy' | 'sell'): SideSelection {
  if (sel[which]) return sel;
  return { buy: which === 'buy', sell: which === 'sell' };
}

/** Maps a picker selection to the escrow side used by createEscrow. */
export function selectionToSide(sel: SideSelection): Side {
  if (sel.buy && sel.sell) return 'both';
  return sel.buy ? 'buy' : 'sell';
}

/**
 * Inverse of selectionToSide (edit round, Sept 2026): pre-populate the
 * picker from a stored escrow side. Legacy 'both' escrows keep their
 * stored value; any tap in the picker forces radio semantics from there.
 */
export function sideToSelection(side: Side): SideSelection {
  return { buy: side === 'buy' || side === 'both', sell: side === 'sell' || side === 'both' };
}

/**
 * How the client-name field adapts: one "Client name" field for a single
 * side, "Buyer name" + "Seller name" fields when a legacy 'both' escrow
 * is being edited.
 */
export function nameFieldMode(sel: SideSelection): 'single' | 'dual' {
  return sel.buy && sel.sell ? 'dual' : 'single';
}
