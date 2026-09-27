// triumph_removed.test.ts — REGRESSION (Anuraj, Sept 2026):
//  1. The "Just closed!" TriumphCard is gone from the buyer, seller, and
//     TC client screens: no TriumphCard render at 100%, no TriumphCard
//     export left in the shared top-card component file.
//  2. No pace-pill copy anywhere in any state: no "days to spare" or
//     ahead-of-pace copy in src/ or app/, no completion-pill markup.
//  3. The 100% completed state is still the main top card (status tag flips
//     to "Completed") with the confetti burst popping from below it.
import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

const path: { join(...p: string[]): string } = require('path');
const fs: { readFileSync(p: string, enc: string): string } = require('fs');

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const buyer = srcFile('app/client/buyer/[id].tsx');
const seller = srcFile('app/client/seller/[id].tsx');
const tc = srcFile('app/client/tc/[id].tsx');
const card = srcFile('src/components/ClientTopCard.tsx');

// ---- 1. TriumphCard gone from all three client screens ---------------------
for (const [label, src] of [
  ['buyer', buyer],
  ['seller', seller],
  ['tc', tc],
] as Array<[string, string]>) {
  assert(!src.includes('TriumphCard'), `${label} screen renders no TriumphCard`);
  assert(!src.includes('Just closed!'), `${label} screen has no "Just closed!" copy`);
  // The top card still renders in every state.
  assert(src.includes('<ClientTopCard'), `${label} screen still renders the top card`);
}
assert(!card.includes('export function TriumphCard'), 'TriumphCard export removed');
assert(!card.includes('Just closed!'), '"Just closed!" copy removed from the component file');

// ---- 2. No pace/completion pill copy anywhere -------------------------------
const tree = [buyer, seller, tc, card, srcFile('src/lib/pace.ts'), srcFile('src/lib/topCard.ts')];
const banned = [
  'days to spare',
  'ahead of schedule',
  'Ahead of pace',
  'ahead-of-pace',
  'completion-banner',
  'CompletionPill',
  'completionPill',
  'topCardPill',
  'pace-pill',
];
for (const copy of banned) {
  const hit = tree.some((src) => src.includes(copy));
  assert(!hit, `no "${copy}" anywhere in the client screens or pill modules`);
}

// ---- 3. 100% state: top card + burst, status tag flips ----------------------
assert(card.includes('testID="topcard-confetti-burst"'), 'confetti burst still pops from the top card');
assert(card.includes('ConfettiBurst'), 'burst uses the shared ConfettiBurst');
assert(card.includes('testID="escrow-status"'), 'status tag still on the top card');
assert(card.includes("'Completed'"), 'status tag still flips to Completed at 100%');
// The burst renders exactly on the 100% condition — nothing else gates it.
assert(card.includes('isComplete'), 'burst gated on the 100% completion flag');

summary('triumph_removed');
