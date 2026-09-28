// Clear to Close — new-escrow two-phase confirmation summary (Sept 28,
// 2026, Anuraj): the new-escrow form validates on submit but no longer
// creates immediately — it shows a confirmation screen summarizing the
// entered data first, so a mistaken side selection gets caught before
// creation. Pure logic lives here so it can be unit-tested; the sheet
// renders the rows with the existing components/tokens.

import type { CreateEscrowInput, Side } from './types';

/** Human label for the escrow side on the confirmation summary. */
export function sideDisplayLabel(side: Side): 'Buy side' | 'Sell side' | 'Dual agency' {
  if (side === 'buy') return 'Buy side';
  if (side === 'sell') return 'Sell side';
  return 'Dual agency';
}

export interface ConfirmSummaryRow {
  /** testID used by the sheet's rendered row. */
  testID: string;
  label: string;
  value: string;
}

/**
 * The confirmation summary rows for a validated new-escrow input, in
 * display order: Side, Property address, Client name, Escrow open date,
 * Target close date. (The 'both' branch exists for legacy data; the
 * new-escrow picker is radio-only so it cannot produce it.)
 */
export function confirmSummaryRows(input: CreateEscrowInput): ConfirmSummaryRow[] {
  const rows: ConfirmSummaryRow[] = [
    { testID: 'confirm-side', label: 'Side', value: sideDisplayLabel(input.side) },
    { testID: 'confirm-address', label: 'Property address', value: input.address },
  ];
  if (input.side === 'both') {
    rows.push({
      testID: 'confirm-buyer-name',
      label: 'Buyer name',
      value: input.buyerName ?? '',
    });
    rows.push({
      testID: 'confirm-seller-name',
      label: 'Seller name',
      value: input.sellerName ?? '',
    });
  } else {
    rows.push({
      testID: 'confirm-client-name',
      label: 'Client name',
      value: (input.side === 'buy' ? input.buyerName : input.sellerName) ?? '',
    });
  }
  rows.push({ testID: 'confirm-open-date', label: 'Escrow open date', value: input.openDate });
  rows.push({ testID: 'confirm-close-date', label: 'Target close date', value: input.closeDate });
  return rows;
}
