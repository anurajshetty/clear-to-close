// pace.test.ts — client top-card name helpers (pure, unit-tested).
//
// The pace pill AND the completion pill are GONE (Anuraj's call, Sept
// 2026): no pace pill, no completion pill, no pace logic anywhere. This
// suite covers what remains (firstNameOf, for share/review copy) and pins
// the pill logic as removed from the module.
import { assert, summary } from './assert';
import { firstNameOf } from '../src/lib/pace';
import * as paceModule from '../src/lib/pace';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // Realtor referred by first name only — never a pronoun, never the surname.
  assert(firstNameOf('Maya Sharma') === 'Maya', 'first name extracted');
  assert(firstNameOf('  Maya  ') === 'Maya', 'first name trimmed');
  assert(firstNameOf('') === '', 'empty name -> empty first name');

  // The pill logic is gone from the module (Anuraj, Sept 2026).
  assert(!('completionPill' in paceModule), 'completionPill removed from src/lib/pace');

  summary('pace');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
