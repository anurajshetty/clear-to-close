// safe_area_top_controls.test.ts — REGRESSION: the Buyer/TC intake
// screens ignored the top safe-area inset in the native build — their
// "‹ Details" BackChevron is the first element of the ScrollView
// content with only static padding, so it rendered UNDER the status
// bar (Anuraj's screenshot, Nov 10, 2026: the clock printed on top of
// the link; taps landed on a sliver). The correctly-rendering screens
// apply the DEVICE inset (useSafeAreaInsets().top) to their header or
// scroll-content top. This file pins the audit end-state for every
// screen with a top back/close control:
//  - intakes: content top padding = insets.top + 10 (the buyer-details
//    exemplar pattern);
//  - the shared BackChevron guarantees a >=44pt hit target;
//  - login/signup/profile-update use the safe-area-context
//    SafeAreaView (the one supported pattern), not react-native's
//    deprecated built-in;
//  - the realtor profile's 38pt visual back circle gains hitSlop so
//    its effective target is >=44pt without a visual change;
//  - the already-correct screens keep applying insets.top.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'components', 'ui.tsx');
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const root = findRepoRoot();
assert(root !== '', 'could not locate the repo root');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// 1. THE DEFECT: both intake screens pad their scroll content with
// the device top inset.
for (const f of ['app/buyer-intake/[escrowId].tsx', 'app/tc-intake/[escrowId].tsx']) {
  assert(
    /contentContainerStyle=\{\[styles\.content, \{[^}]*paddingTop: insets\.top \+ 10/.test(read(f)),
    `${f}: scroll content clears the status bar via insets.top + 10`,
  );
}

// 2. The shared BackChevron guarantees the hit target.
const ui = read('src/components/ui.tsx');
assert(/backChevron: \{[^}]*minHeight: 44/.test(ui), 'BackChevron style guarantees minHeight 44');
assert(
  /export function BackChevron[\s\S]{0,400}?hitSlop=/.test(ui),
  'BackChevron Pressable carries hitSlop',
);

// 3. Auth + edit-profile screens use the safe-area-context SafeAreaView.
for (const f of ['app/login.tsx', 'app/signup.tsx', 'app/profile-update.tsx']) {
  const src = read(f);
  assert(
    /import \{ SafeAreaView \} from 'react-native-safe-area-context'/.test(src),
    `${f}: SafeAreaView comes from react-native-safe-area-context`,
  );
  assert(
    !/SafeAreaView,\s*\n\s*ScrollView,/.test(src),
    `${f}: react-native no longer supplies SafeAreaView`,
  );
}

// 4. Realtor profile (client-facing): the 38pt visual circle stays,
// its touch target grows via hitSlop.
const rp = read('app/realtor-profile.tsx');
assert(
  /hitSlop=[\s\S]{0,260}?testID="profile-back"|testID="profile-back"[\s\S]{0,260}?hitSlop=/.test(rp),
  'realtor profile back circle carries hitSlop',
);
assert(/backBtn: \{[^}]*width: 38,[^}]*height: 38/.test(rp), 'realtor profile back circle visual size unchanged (38pt)');

// 5. Already-correct screens keep applying the device top inset
// (regression pins for the audit's pass set).
for (const f of [
  'app/activity/[id].tsx',
  'app/escrow/[id].tsx',
  'app/share/[id].tsx',
  'app/team/[id].tsx',
  'app/buyer-details/[escrowId].tsx',
  'app/tc-listing-details/[escrowId].tsx',
  'app/client/buyer/[id].tsx',
  'app/client/seller/[id].tsx',
  'app/client/tc/[id].tsx',
  'app/client/escrows.tsx',
  'app/client/profile.tsx',
  'app/index.tsx',
]) {
  assert(/insets\.top/.test(read(f)), `${f}: still applies insets.top`);
}

// 6. Escrow detail's custom back Pressable keeps its 44pt minimum.
assert(
  /backBtn: \{[^}]*minHeight: 44/.test(read('app/escrow/[id].tsx')),
  'escrow detail back control keeps minHeight 44',
);

summary('safe_area_top_controls');
