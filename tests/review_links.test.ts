// review_links.test.ts — external review links (Oct 2026, Anuraj).
//
// Anuraj's REPLACE decision: the in-app "Leave a review" button and the
// ReviewSheet are GONE. The realtor saves optional Google / realtor.com
// review links on the profile-update screen; after the escrow closes, the
// client home shows a logo card (tapping a logo opens the link in the
// EXTERNAL browser).
//
// Covered here:
//  1. isValidReviewLink: empty/whitespace → true (optional); http/https →
//     true; everything else → false.
//  2. shouldShowReviewLinksCard: the gate predicate — 100% + not cancelled
//     + at least one link.
//  3. reviewLinkTargets: the exact URLs the logos open, Google first.
//  4. The logo-tap wiring: RN components cannot be imported in this node
//     suite (see review_gate.test.ts), so the press-handler contract is
//     pinned statically — the card's onPress passes the target URL to
//     openReviewLink, which calls Linking.openURL (external browser).
//     This is a deliberate source-level assertion, documented here.
//  5. The in-app review entry is removed: no triumph-review button, no
//     onLeaveReviewPress prop, no ReviewSheet/useReviewSheet files or
//     importers (same static-pinning rationale as review_gate.test.ts).
//
// Run: ./tests/run.sh (or: CTC_REPO_ROOT=$PWD npx tsc ... then node).
import { assert, summary } from './assert';
import {
  isValidReviewLink,
  hasReviewLinks,
  shouldShowReviewLinksCard,
  reviewLinkTargets,
} from '../src/lib/reviewLinks';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- 1. Link validation -------------------------------------------------
assert(isValidReviewLink('') === true, 'validation: empty is fine (optional)');
assert(isValidReviewLink('   ') === true, 'validation: whitespace-only is fine');
assert(isValidReviewLink('https://g.page/r/x') === true, 'validation: https passes');
assert(isValidReviewLink('http://example.com/review') === true, 'validation: http passes');
assert(
  isValidReviewLink('  https://www.realtor.com/realestateagents/abc  ') === true,
  'validation: surrounding whitespace is trimmed',
);
assert(isValidReviewLink('ftp://files.example.com/x') === false, 'validation: ftp rejected');
assert(isValidReviewLink('javascript:alert(1)') === false, 'validation: javascript: rejected');
assert(isValidReviewLink('no-protocol.com') === false, 'validation: missing protocol rejected');
assert(isValidReviewLink('not a url') === false, 'validation: plain text rejected');

// ---- 2. Card visibility gate --------------------------------------------
const completed = { done: 5, total: 5, status: 'closed' as const };
const incomplete = { done: 4, total: 5, status: 'open' as const };
const cancelled = { done: 5, total: 5, status: 'cancelled' as const };
const googleOnly = { googleReviewLink: 'https://g.page/r/x', realtorComReviewLink: '' };
const both = {
  googleReviewLink: 'https://g.page/r/x',
  realtorComReviewLink: 'https://www.realtor.com/abc',
};
const none = { googleReviewLink: '', realtorComReviewLink: '   ' };

assert(
  shouldShowReviewLinksCard(completed, googleOnly) === true,
  'card: completed escrow + one link shows the card',
);
assert(
  shouldShowReviewLinksCard(completed, both) === true,
  'card: completed escrow + both links shows the card',
);
assert(
  shouldShowReviewLinksCard(completed, none) === false,
  'card: completed escrow + no links hides the card',
);
assert(
  shouldShowReviewLinksCard(completed, null) === false,
  'card: completed escrow + null profile hides the card',
);
assert(
  shouldShowReviewLinksCard(incomplete, both) === false,
  'card: incomplete escrow + links hides the card',
);
assert(
  shouldShowReviewLinksCard(cancelled, both) === false,
  'card: cancelled escrow + links hides the card (cancelled never shows)',
);

// ---- 3. Logo targets: the exact URLs the logos open ----------------------
assert(
  JSON.stringify(reviewLinkTargets(googleOnly)) ===
    JSON.stringify([{ key: 'google', url: 'https://g.page/r/x' }]),
  'targets: one link yields exactly the Google URL',
);
assert(
  JSON.stringify(reviewLinkTargets(both)) ===
    JSON.stringify([
      { key: 'google', url: 'https://g.page/r/x' },
      { key: 'realtorCom', url: 'https://www.realtor.com/abc' },
    ]),
  'targets: two links yield both URLs, Google first',
);
assert(reviewLinkTargets(none).length === 0, 'targets: no links yields nothing');
assert(
  hasReviewLinks(googleOnly) === true && hasReviewLinks(none) === false,
  'hasReviewLinks: whitespace-only counts as unset',
);

// ---- 4. Logo-tap wiring (static pin — see header) ------------------------
// The card renders one Pressable per target with
//   onPress={() => openReviewLink(t.url)}
// and openReviewLink is:
//   export function openReviewLink(url: string): void { void Linking.openURL(url); }
// i.e. the EXACT link URL reaches the EXTERNAL browser (never a webview).
const card = srcFile('src/components/ReviewLinksCard.tsx');
assert(
  /import \{[^}]*Linking[^}]*\} from 'react-native'/.test(card),
  'card: Linking is imported from react-native',
);
assert(
  card.includes('export function openReviewLink(url: string): void'),
  'card: openReviewLink is an exported, unit-testable press handler',
);
assert(
  card.includes('void Linking.openURL(url)'),
  'card: the press handler opens the URL via Linking.openURL (external browser)',
);
assert(
  card.includes('onPress={() => openReviewLink(t.url)}'),
  'card: each logo button passes its exact target URL to the press handler',
);
// Mockup contract: the two SVGs are copied from the approved mockup.
assert(card.includes('viewBox="0 0 48 48"'), 'card: Google G SVG viewBox intact');
assert(
  card.includes('M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z'),
  'card: realtor.com house SVG path intact',
);
assert(card.includes("backgroundColor: '#D4232F'"), 'card: realtor.com badge red intact');

// ---- 5. The in-app review entry is removed (static pin — see header) -----
const triumph = srcFile('src/components/ClientTriumph.tsx');
assert(!triumph.includes('triumph-review'), 'triumph: the review button testID is gone');
assert(
  !triumph.includes('onLeaveReviewPress'),
  'triumph: the onLeaveReviewPress prop is gone from the section',
);
assert(
  !triumph.includes('Leave ${first} a review'),
  'triumph: the "Leave a review" button copy is gone',
);
assert(triumph.includes('triumph-share'), 'triumph: the share-profile button stays');
assert(triumph.includes('triumph-checklist'), 'triumph: the checklist stays');

// The sheet and its hook are deleted — nothing may import them.
for (const rel of ['src/components/ReviewSheet.tsx', 'src/hooks/useReviewSheet.ts']) {
  let exists = true;
  try {
    fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    exists = false;
  }
  assert(!exists, `${rel} is deleted`);
}
for (const screen of ['app/client/buyer/[id].tsx', 'app/client/seller/[id].tsx']) {
  const s = srcFile(screen);
  assert(!s.includes('ReviewSheet'), `${screen}: no ReviewSheet reference remains`);
  assert(!s.includes('useReviewSheet'), `${screen}: no useReviewSheet reference remains`);
  assert(!s.includes('onLeaveReviewPress'), `${screen}: no onLeaveReviewPress remains`);
  assert(
    !s.includes('REVIEWS_ENABLED'),
    `${screen}: the dead REVIEWS_ENABLED gate is gone`,
  );
  assert(
    s.includes('shouldShowReviewLinksCard(view, profile)'),
    `${screen}: the review-links card is gated on shouldShowReviewLinksCard`,
  );
  assert(s.includes('<ReviewLinksCard'), `${screen}: the review-links card is rendered`);
}

summary('review_links');
