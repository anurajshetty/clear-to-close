// client_home_celebration.test.ts — at 100% the share + review cards move
// to the TOP of the client home, highlighted (Anuraj, Oct 14, 2026).
//
// Buyer + seller homes only, and only in the showTriumphActions state
// (100% complete, not cancelled — the gates themselves are unchanged):
//   1. ClientTopCard (unchanged)
//   2. ShareProfileCard — a proper highlighted Card with the share action
//      and the referral line (moved out of the bottom triumph section)
//   3. ReviewLinksCard — directly below it, same highlight, same gate
//   4. LatestFromCard, then KeyDatesEntryPoint (relative order unchanged)
//   5. ClientTriumphSection — now just the CollapsibleChecklist
// Below 100% nothing changes. The rendered-outcome guard (DOM order +
// computed highlight styles) is tests/rendered/client_home_celebration.py.

import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- 1. Order + gates on both homes -----------------------------------------
for (const screen of ['app/client/buyer/[id].tsx', 'app/client/seller/[id].tsx']) {
  const s = srcFile(screen);
  const order = [
    '<ClientTopCard',
    '<ShareProfileCard',
    '<ReviewLinksCard',
    '<LatestFromCard',
    '<KeyDatesEntryPoint',
    '<ClientTriumphSection',
  ];
  let last = -1;
  for (const token of order) {
    const at = s.indexOf(token);
    assert(at > last, `${screen}: ${token} renders in the celebration order`);
    last = at;
  }
  // The share card is gated on the triumph state (below 100% it is absent),
  // exactly like the bottom section: two showTriumphActions gates total.
  assert(
    s.split('{showTriumphActions ? (').length - 1 === 2,
    `${screen}: share card and bottom section are both gated on showTriumphActions`,
  );
  assert(
    s.includes('shouldShowReviewLinksCard(view, profile)'),
    `${screen}: review-links gate unchanged (100% + links set)`,
  );
}

// TC home has neither card — untouched.
{
  const s = srcFile('app/client/tc/[id].tsx');
  assert(!s.includes('ShareProfileCard'), 'tc home: no share card');
  assert(!s.includes('ReviewLinksCard'), 'tc home: no review-links card');
  assert(!s.includes('ClientTriumphSection'), 'tc home: no triumph section');
}

// --- 2. Share card contents; triumph section is checklist-only -------------
const triumph = srcFile('src/components/ClientTriumph.tsx');
assert(triumph.includes('export function ShareProfileCard'), 'triumph: ShareProfileCard is exported');
assert(triumph.includes('testID="share-profile-card"'), 'triumph: share card testID');
assert(triumph.includes('testID="triumph-share"'), 'triumph: share action keeps its testID inside the card');
assert(triumph.includes('testID="triumph-referral"'), 'triumph: referral line lives inside the card');
assert(triumph.includes("'Copied to clipboard'"), 'triumph: clipboard note behavior unchanged');
assert(triumph.includes('shareRealtorProfile({'), 'triumph: share behavior unchanged (share sheet / clipboard)');
const section = triumph.slice(triumph.indexOf('export function ClientTriumphSection'));
assert(section.includes('<CollapsibleChecklist'), 'triumph section: renders the collapsible checklist');
assert(!section.includes('triumph-share'), 'triumph section: the share block is gone from the bottom section');
assert(!section.includes('GhostButton'), 'triumph section: no share button remains at the bottom');

// --- 3. The highlight: gold border + warm tint on BOTH cards ----------------
const theme = srcFile('src/theme.ts');
assert(theme.includes("gold:'#E3B95C'"), 'theme: completion gold token (#E3B95C, the top-card gold)');
assert(theme.includes("goldTint:'#FBF3DC'"), 'theme: warm tint token for the celebration cards');
for (const [rel, name] of [
  ['src/components/ClientTriumph.tsx', 'share card'],
  ['src/components/ReviewLinksCard.tsx', 'review-links card'],
] as const) {
  const s = srcFile(rel);
  assert(s.includes('borderColor: colors.gold'), `${name}: gold border`);
  assert(s.includes('backgroundColor: colors.goldTint'), `${name}: warm tint background`);
  assert(s.includes('borderWidth: 1.5'), `${name}: emphasized border width`);
}

summary('client-home-celebration');
