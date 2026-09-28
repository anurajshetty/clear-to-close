// sidepicker.test.ts — single-select radio side picker: tapping one side
// clears the other, deselect-last guard, stored-side mapping, name-field
// mode. Run: see tests/run.sh.
import { assert, summary } from './assert';
import {
  DEFAULT_SIDE_SELECTION,
  nameFieldMode,
  selectionToSide,
  toggleSide,
} from '../src/lib/sidePicker';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // Default: Buy side selected alone.
  assert(
    DEFAULT_SIDE_SELECTION.buy === true && DEFAULT_SIDE_SELECTION.sell === false,
    'default selection is Buy side only',
  );

  // Deselect-last guard: tapping the only selected card is a no-op.
  const guardBuy = toggleSide({ buy: true, sell: false }, 'buy');
  assert(guardBuy.buy === true && guardBuy.sell === false, 'cannot deselect last (buy)');
  const guardSell = toggleSide({ buy: false, sell: true }, 'sell');
  assert(guardSell.buy === false && guardSell.sell === true, 'cannot deselect last (sell)');

  // Radio behavior (Anuraj, Sept 28, 2026): tapping a side selects it and
  // clears the other — both can never be selected at once.
  const toSell = toggleSide({ buy: true, sell: false }, 'sell');
  assert(toSell.buy === false && toSell.sell === true, 'tapping Sell clears Buy');
  const toBuy = toggleSide({ buy: false, sell: true }, 'buy');
  assert(toBuy.buy === true && toBuy.sell === false, 'tapping Buy clears Sell');

  // Selection maps to the escrow side used by createEscrow.
  assert(selectionToSide({ buy: true, sell: false }) === 'buy', 'buy only -> buy side');
  assert(selectionToSide({ buy: false, sell: true }) === 'sell', 'sell only -> sell side');
  // Legacy stored 'both' still maps through unchanged (the picker is
  // radio-only, but the edit flow must never rewrite stored data).
  assert(selectionToSide({ buy: true, sell: true }) === 'both', 'legacy both -> both side');

  // Client-name field adapts to the selection.
  assert(nameFieldMode({ buy: true, sell: false }) === 'single', 'single side -> one Client name field');
  assert(nameFieldMode({ buy: false, sell: true }) === 'single', 'single side -> one Client name field');
  assert(nameFieldMode({ buy: true, sell: true }) === 'dual', 'legacy both -> Buyer + Seller name fields');

  summary('sidepicker');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
