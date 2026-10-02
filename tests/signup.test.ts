// Signup fallback + check-inbox card — structural regression tests.
// The signup screen is verified structurally (source assertions) because the
// repo's unit harness has no React renderer; Anuraj does UI testing himself.
// Behavioral coverage (fallback branches, resend mapping) lives in
// tests/auth.test.ts against the auth service.
import { assert, summary } from './assert';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: (id: string) => { readFileSync: (...args: unknown[]) => string; join: (...args: string[]) => string };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function repoFile(rel: string): string {
  const fs = require('fs');
  const path = require('path');
  const root = (process.env['CTC_REPO_ROOT'] as string) ?? '';
  return fs.readFileSync(path.join(root, rel), 'utf8') as string;
}

const signup = repoFile('app/signup.tsx');
const profileCreate = repoFile('app/profile-create.tsx');

// ---------------------------------------------------------------------------
// A. duplicate_email copy (Anuraj-approved, Oct 2, 2026)
// ---------------------------------------------------------------------------
assert(
  signup.includes('Account already exists. Try logging in.'),
  'duplicate_email card renders Anuraj-approved copy "Account already exists. Try logging in."',
);
assert(
  !signup.includes('An account with this email already exists</Text>'),
  'old duplicate_email title is gone',
);

// ---------------------------------------------------------------------------
// B. Check-inbox card state: form hidden, card-only, three actions
// ---------------------------------------------------------------------------
assert(
  signup.includes('testID="check-inbox-card"'),
  'check-inbox card carries testID="check-inbox-card"',
);
// The card is the true-branch of the email_confirmation_required ternary;
// the form (styles.form) and the Create account button must not appear in
// that branch. Extract the true-branch text and check.
{
  const tIdx = signup.indexOf("error === 'email_confirmation_required' ? (");
  assert(tIdx >= 0, 'inbox card is gated on error === email_confirmation_required');
  // Find the matching " : (" that starts the else branch by scanning for the
  // form's opening inside the false branch instead: simpler and robust —
  // the true branch ends before the "<>" fragment opens the form branch.
  const trueBranch = signup.slice(tIdx, signup.indexOf('<>', tIdx));
  assert(!trueBranch.includes('styles.form'), 'inbox card state renders no form fields');
  assert(!trueBranch.includes('<PrimaryButton'), 'inbox card state renders no Create account button');
  assert(!trueBranch.includes('styles.loginRow'), 'inbox card state renders no bottom login row');
}
assert(signup.includes('Go to login →'), 'inbox card keeps the "Go to login →" action');
assert(signup.includes('testID="back-to-signup"'), 'inbox card has a "Back to sign up" action');
assert(signup.includes('Back to sign up'), 'inbox card "Back to sign up" copy present');
assert(signup.includes('testID="resend-confirmation"'), 'inbox card has a resend action');
assert(
  signup.includes("Didn't get the email? Resend"),
  'inbox card "Didn\'t get the email? Resend" copy present',
);

// "Back to sign up" restores the form: it clears the error (form returns)
// without clearing the typed values, which live in ephemeral useState only.
{
  const hIdx = signup.indexOf('const onBackToSignUp');
  assert(hIdx >= 0, 'onBackToSignUp handler exists');
  const handler = signup.slice(hIdx, signup.indexOf('};', hIdx));
  assert(handler.includes('setError(null)'), 'back-to-sign-up clears the error');
  assert(!handler.includes("setName('')") && !handler.includes('setName("")'),
    'back-to-sign-up does not clear the typed name');
  assert(!handler.includes("setEmail('')") && !handler.includes('setEmail("")'),
    'back-to-sign-up does not clear the typed email');
  assert(!handler.includes("setPassword('')") && !handler.includes('setPassword("")'),
    'back-to-sign-up does not clear the typed password');
}
// Auditor requirement: credentials never touch persistent storage here.
assert(!signup.includes('AsyncStorage') && !signup.includes('localStorage'),
  'signup screen persists nothing itself (values stay in useState)');

// Resend wiring: calls the service with the entered email; rate-limit maps
// to the existing rate_limited copy inline; success shows no error.
assert(
  signup.includes('auth.resendConfirmation(email)'),
  'resend action calls auth.resendConfirmation with the entered email',
);
assert(
  signup.includes('testID="resend-rate-limited"'),
  'resend rate-limit renders an inline error marker',
);
assert(
  signup.includes('Too many sign-up attempts. Please wait a few minutes and try again.'),
  'resend rate-limit uses the existing rate_limited copy',
);

// ---------------------------------------------------------------------------
// C. Profile-create: signed-in banner + name pre-fill precedence
// ---------------------------------------------------------------------------
assert(
  profileCreate.includes('testID="existing-account-notice"'),
  'profile-create renders the signed-in notice with a testID',
);
assert(
  profileCreate.includes('An account with this email already exists — we&apos;ve signed you in.'),
  'signed-in banner uses Anuraj-approved verbatim copy (em dash)',
);
assert(
  profileCreate.includes('takeExistingAccountNotice'),
  'profile-create consumes the one-time notice flag',
);
assert(
  profileCreate.includes('existing?.name'),
  'name pre-fill reads the existing profile name',
);
assert(
  profileCreate.includes('takePendingProfileName'),
  'name pre-fill still consumes the pending typed name (discarded when a profile exists)',
);

summary('signup');
