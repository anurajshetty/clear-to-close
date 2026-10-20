// Clear to Close — approved auth copy wiring (Anuraj, Oct 15 2026).
//
// Two leftover copy lines from the app-security batch, pinned at the
// source because the components import react-native and cannot run in
// node (the mapping behavior itself is pinned in auth.test.ts):
//   1. Login with an unconfirmed email shows "Please confirm your
//      email, then try again." (was the generic "Something went
//      wrong") — driven by the new 'email_not_confirmed' error code.
//   2. The password-change sheet's revoke_failed path shows "Your
//      password was changed, but we couldn't sign out your other
//      devices. Please try again." (was the generic default).
import { assert, summary } from './assert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs');
const path: { join(...p: string[]): string } = require('path');

const root = process.env.CTC_REPO_ROOT ?? path.join('..');
const login = fs.readFileSync(path.join(root, 'app/login.tsx'), 'utf8');
const changePw = fs.readFileSync(
  path.join(root, 'src/components/ChangePasswordSheet.tsx'),
  'utf8',
);

assert(
  login.includes("error === 'email_not_confirmed'"),
  'login screen branches on the email_not_confirmed code',
);
assert(
  login.includes('Please confirm your email, then try again.'),
  'login screen renders the approved confirm-email copy verbatim',
);
assert(
  /case 'revoke_failed':(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*return "Your password was changed, but we couldn't sign out your other devices\. Please try again\.";/.test(
    changePw,
  ),
  'change-password sheet: revoke_failed renders the approved copy verbatim',
);

summary('auth_copy');
