// home_invited_section.test.ts — the home "Invited escrows" section
// ALWAYS renders (Anuraj, Oct 22, 2026). Before this change it only
// appeared when a pending invite or an invited escrow existed, which
// made the two-section home model look broken on a fresh account
// (live test, Oct 21, 2026). When both lists are empty the section
// shows the single line "No invites yet."; pending-invite cards still
// lead the section when present, and "Your Escrows" is untouched.
//
// RN screens are not importable in node, so the section is pinned
// statically against its source (repo root via CTC_REPO_ROOT,
// exported by tests/run.sh) — the same pattern as profile_required.
import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const home = fs.readFileSync(path.join(ROOT, 'app/index.tsx'), 'utf8');

assert(
  home.includes('<Text style={styles.groupLabel}>Invited escrows</Text>'),
  'home: the Invited escrows group label renders',
);
assert(
  !home.includes('(pendingInvites.length > 0 || invitedEscrows.length > 0) &&'),
  'home: the section is no longer gated on non-empty content',
);
assert(
  home.includes('pendingInvites.length === 0 && invitedEscrows.length === 0'),
  'home: the empty state keys on both lists being empty',
);
assert(
  home.includes('<Text style={styles.emptyText}>No invites yet.</Text>'),
  'home: empty section shows the exact "No invites yet." line',
);

const pendingAt = home.indexOf('pendingInvites.map(renderPendingInvite)');
const sharedAt = home.indexOf('title="Shared with you"');
const emptyAt = home.indexOf('<Text style={styles.emptyText}>No invites yet.</Text>');
assert(pendingAt !== -1 && sharedAt !== -1 && pendingAt < sharedAt, 'home: pending invites still lead the section');
assert(emptyAt > sharedAt, 'home: the empty line follows the shared-with-you block');

summary('home_invited_section');
