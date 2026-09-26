// Clear to Close — new-escrow side picker logic (two multi-select toggles).
//
// Pure logic for the side picker, kept out of the sheet component so it can be
// unit-tested. Selecting BOTH toggles = dual agency ("both").

import type { Side } from './types';

/** Which side toggles are selected in the new-escrow sheet. */
export interface SideSelection {
  buy: boolean;
  sell: boolean;
}

/** Default picker state: Buy side selected, Sell side off. */
export const DEFAULT_SIDE_SELECTION: SideSelection = { buy: true, sell: false };

/**
 * Toggle one side card. At least one side always stays selected — tapping the
 * last selected card is a no-op (the guard), never leaves both off.
 */
export function toggleSide(sel: SideSelection, which: 'buy' | 'sell'): SideSelection {
  if (which === 'buy' && sel.buy && !sel.sell) return sel;
  if (which === 'sell' && sel.sell && !sel.buy) return sel;
  return { ...sel, [which]: !sel[which] };
}

/** Maps a picker selection to the escrow side used by createEscrow. */
export function selectionToSide(sel: SideSelection): Side {
  if (sel.buy && sel.sell) return 'both';
  return sel.buy ? 'buy' : 'sell';
}

/**
 * Inverse of selectionToSide (edit round, Sept 2026): pre-populate the
 * picker toggles from a stored escrow side.
 */
export function sideToSelection(side: Side): SideSelection {
  return { buy: side === 'buy' || side === 'both', sell: side === 'sell' || side === 'both' };
}

/**
 * How the client-name field adapts: one "Client name" field for a single
 * side, "Buyer name" + "Seller name" fields when both are picked.
 */
export function nameFieldMode(sel: SideSelection): 'single' | 'dual' {
  return sel.buy && sel.sell ? 'dual' : 'single';
}
