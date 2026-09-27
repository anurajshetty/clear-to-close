// celebration_kicker.test.ts — REGRESSION: redeem celebration kicker
// (Anuraj's call, Sept 2026). The celebration card kicker is personalized:
// "Congratulations, {client name}" using the redeemed invite's party name.
// The React component itself is not unit-rendered (RN components are not
// importable in the node suite); the pure copy helper is covered here.
import { assert, summary } from './assert';
import { celebrationKicker } from '../src/lib/shareCopy';

assert(celebrationKicker('Jim') === 'Congratulations, Jim', 'personalized kicker');
assert(
  celebrationKicker('Alice Buyer') === 'Congratulations, Alice Buyer',
  'full party name',
);
assert(
  celebrationKicker('  Jim  ') === 'Congratulations, Jim',
  'name is trimmed',
);
assert(celebrationKicker('') === 'Congratulations!', 'empty name falls back');
assert(celebrationKicker(null) === 'Congratulations!', 'null name falls back');
assert(celebrationKicker(undefined) === 'Congratulations!', 'undefined falls back');
assert(
  !celebrationKicker('Jim').includes('—') && !celebrationKicker('Jim').includes('–'),
  'no em dashes in kicker',
);
assert(
  !celebrationKicker('Jim').toUpperCase().includes('WELCOME ABOARD'),
  'old kicker copy is gone',
);

summary('celebration_kicker');
