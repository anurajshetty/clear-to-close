// escrow_detail_hooks.test.ts — the escrow detail white-screen
// regression (Oct 22, 2026, owner-reproduced live). Root cause: the
// Team Access build derived `nameById` with a useMemo placed AFTER
// the screen's `if (!loaded)` / `if (!escrow)` early returns. The
// loading render skipped the hook; the render that received the
// escrow called one hook MORE than the previous render; React
// (error #310) unmounted the tree and, with no error boundary, the
// screen rendered as a blank white page for EVERY escrow.
//
// Two guards are pinned here:
//  (1) Hooks order: in app/escrow/[id].tsx, no React hook call may
//      appear after the first early return of the detail component.
//  (2) The screen is wrapped in ScreenErrorBoundary with a visible
//      fallback, so a future render crash can never white-screen
//      silently again.
//
// RN screens are not importable in node, so both are pinned
// statically against the sources — the same pattern as
// home_invited_section.
import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = String(process.env.CTC_REPO_ROOT || '');
const detailSrc = fs.readFileSync(path.join(root, 'app', 'escrow', '[id].tsx'), 'utf8');
const boundarySrc = fs.readFileSync(
  path.join(root, 'src', 'components', 'ScreenErrorBoundary.tsx'),
  'utf8',
);

// --- (1) hooks order ------------------------------------------------
// Scoped to the TransactionDetail component body (the route wrapper
// at the end of the file has its own hooks, in its own component).
const compStart = detailSrc.indexOf('export function TransactionDetail()');
const compEnd = detailSrc.indexOf('const styles', compStart);
assert(compStart > 0 && compEnd > compStart, 'the detail component body is locatable');
const comp = detailSrc.slice(compStart, compEnd);
const firstReturnAt = comp.indexOf('if (!loaded) {');
assert(firstReturnAt > 0, 'the detail screen still has its loading early return');
const afterReturn = comp.slice(firstReturnAt);
const hookCall = /\b(useState|useMemo|useEffect|useCallback|useRef|useFocusEffect)\s*\(/;
assert(
  !hookCall.test(afterReturn),
  'no React hook is called after the detail screen early returns (hooks-order law)',
);
const memoAt = comp.indexOf('participantNameMap(participants)');
assert(memoAt > 0 && memoAt < firstReturnAt, 'nameById memo is derived above the early returns');

// --- (2) error boundary ---------------------------------------------
assert(
  detailSrc.includes("from '../../src/components/ScreenErrorBoundary'"),
  'the detail screen imports ScreenErrorBoundary',
);
assert(
  /export default function EscrowDetailRoute\(\)/.test(detailSrc)
    && detailSrc.includes('<ScreenErrorBoundary')
    && detailSrc.includes('<TransactionDetail />'),
  'the default export wraps the detail screen in ScreenErrorBoundary',
);
assert(
  boundarySrc.includes('getDerivedStateFromError') && boundarySrc.includes('componentDidCatch'),
  'the boundary is a real error boundary (derived state + catch)',
);
assert(
  boundarySrc.includes('Something went wrong showing this screen. Your data is safe.'),
  'the boundary fallback carries the visible plain-language message',
);
assert(
  detailSrc.includes('actionLabel="Back to escrows"'),
  'the boundary fallback offers the way back to the escrow list',
);

summary('escrow_detail_hooks.test');
