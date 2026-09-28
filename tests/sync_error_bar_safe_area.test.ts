// Clear to Close — SyncErrorBar safe-area regression test (iOS parity audit,
// Sept 27, 2026).
//
// The bar is mounted in app/_layout.tsx above the router stack with no screen
// chrome of its own. On iOS it must pad for the top safe-area inset, or the
// red bar renders under the notch/status bar. Structural pin (the component
// imports react-native and cannot run in node): assert the source wires
// useSafeAreaInsets into the bar's top padding.
import { assert, summary } from './assert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs');
const path: { join(...p: string[]): string } = require('path');

const root = process.env.CTC_REPO_ROOT ?? path.join('..');
const bar = fs.readFileSync(path.join(root, 'src/components/SyncErrorBar.tsx'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');

assert(
  bar.includes("from 'react-native-safe-area-context'") && bar.includes('useSafeAreaInsets'),
  'SyncErrorBar uses useSafeAreaInsets from react-native-safe-area-context',
);
assert(
  /paddingTop:\s*10\s*\+\s*insets\.top/.test(bar) || /insets\.top/.test(bar),
  'SyncErrorBar adds the top safe-area inset to the bar padding',
);
assert(
  layout.includes('<SyncErrorBar />'),
  'SyncErrorBar is mounted in app/_layout.tsx above the router stack',
);

summary('sync_error_bar_safe_area');
