// sidepicker.test.ts — two-toggle side picker logic: deselect-last guard,
// dual-agency selection, name-field mode. Run: see tests/run.sh.
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

  // Toggling the OFF card turns it on -> dual agency.
  const dual = toggleSide({ buy: true, sell: false }, 'sell');
  assert(dual.buy === true && dual.sell === true, 'selecting both cards = dual agency');

  // Toggling one card off from dual leaves the other selected.
  const backToSell = toggleSide({ buy: true, sell: true }, 'buy');
  assert(backToSell.buy === false && backToSell.sell === true, 'dual -> sell only');
  const backToBuy = toggleSide({ buy: true, sell: true }, 'sell');
  assert(backToBuy.buy === true && backToBuy.sell === false, 'dual -> buy only');

  // Selection maps to the escrow side used by createEscrow.
  assert(selectionToSide({ buy: true, sell: false }) === 'buy', 'buy only -> buy side');
  assert(selectionToSide({ buy: false, sell: true }) === 'sell', 'sell only -> sell side');
  assert(selectionToSide({ buy: true, sell: true }) === 'both', 'both toggles -> both side');

  // Client-name field adapts to the selection.
  assert(nameFieldMode({ buy: true, sell: false }) === 'single', 'single side -> one Client name field');
  assert(nameFieldMode({ buy: false, sell: true }) === 'single', 'single side -> one Client name field');
  assert(nameFieldMode({ buy: true, sell: true }) === 'dual', 'dual agency -> Buyer + Seller name fields');

  summary('sidepicker');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
