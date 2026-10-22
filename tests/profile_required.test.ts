// profile_required.test.ts — Email and Phone are REQUIRED in the
// profile form (Anuraj, Oct 14, 2026: "Those marked fields cannot be
// optional", annotated Update-profile screenshot), and email/phone also
// carry FORMAT validation (Amendment 3, same day). Broker was required
// by the same Oct 14 call and is OPTIONAL again since Oct 22, 2026
// (Anuraj's reversal: with Team Access, Associates/TCs hold accounts
// and may not belong to a brokerage).
//
// The matrix:
//   - each required field empty (or whitespace-only) -> save blocked and
//     that field gets the inline "Required" error; all missing -> all
//     errors together on one save attempt;
//   - all filled and well-formed -> no errors, saves;
//   - email: non-empty but malformed (no @, two @, no dot in the domain,
//     spaces, empty local part) -> "Enter a valid email address", blocked;
//   - phone: strip spaces/dashes/parentheses/leading + -> must be 10
//     digits, or 11 beginning with 1; anything else ->
//     "Enter a valid phone number", blocked. Values are stored/displayed
//     exactly as typed (validation only, no reformatting);
//   - Broker never blocks and never errors (optional, Oct 22, 2026);
//     License number and the review links stay optional;
//   - onboarding stays skippable: the Skip path never validates.
//
// Behavior is tested against the shared helpers (src/lib/profileRequired.ts)
// that all three screens and the form use; the screens and the form are
// pinned statically below (repo root via CTC_REPO_ROOT, exported by
// tests/run.sh).

import { assert, summary } from './assert';
import {
  missingRequiredProfileFields,
  requiredErrorFor,
  isValidProfileEmail,
  isValidProfilePhone,
  profileEmailError,
  profilePhoneError,
  profileFieldErrors,
  hasProfileFieldErrors,
  prefillProfileEmail,
} from '../src/lib/profileRequired';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const FULL = { name: 'Maya Chen', email: 'maya@compass.com', phone: '818-331-2795', realty_group: 'Compass Realty' };

// --- 1. The matrix ----------------------------------------------------------
assert(
  JSON.stringify(missingRequiredProfileFields({ name: '', email: '', phone: '', realty_group: '' })) ===
    JSON.stringify(['name', 'email', 'phone']),
  'all empty -> the three required fields missing, in form order (errors shown together)',
);
for (const [field, patch] of [
  ['name', { name: '' }],
  ['email', { email: '' }],
  ['phone', { phone: '' }],
] as const) {
  const missing = missingRequiredProfileFields({ ...FULL, ...patch });
  assert(
    JSON.stringify(missing) === JSON.stringify([field]),
    `only ${field} empty -> only ${field} blocks the save`,
  );
  assert(requiredErrorFor(missing, field) === 'Required', `${field} empty -> inline "Required" error`);
}
assert(
  missingRequiredProfileFields({ ...FULL, email: '   ' }).includes('email'),
  'whitespace-only email counts as empty',
);
assert(
  missingRequiredProfileFields({ ...FULL, phone: '  ' }).includes('phone'),
  'whitespace-only phone counts as empty',
);
assert(
  missingRequiredProfileFields({ ...FULL, realty_group: '' }).length === 0 &&
    missingRequiredProfileFields({ ...FULL, realty_group: ' ' }).length === 0,
  'empty or whitespace broker never blocks (optional since Oct 22, 2026)',
);
assert(
  missingRequiredProfileFields(FULL).length === 0,
  'all filled -> nothing missing (save proceeds)',
);
assert(
  requiredErrorFor([], 'email') === null && requiredErrorFor([], 'phone') === null &&
    requiredErrorFor([], 'name') === null,
  'all filled -> no inline errors',
);
// --- 1b. Format validation (Amendment 3) ------------------------------------
for (const ok of ['maya@compass.com', 'a.b@x.io', 'maya+tag@realty.co.uk']) {
  assert(isValidProfileEmail(ok), `email valid: ${ok}`);
  assert(profileEmailError(ok) === null, `email error null: ${ok}`);
}
for (const bad of ['not-an-email', 'maya@compass', 'maya@@compass.com', '@compass.com', 'maya@', 'maya chen@compass.com', 'maya@compass .com']) {
  assert(!isValidProfileEmail(bad), `email invalid: ${bad}`);
  assert(profileEmailError(bad) === 'Enter a valid email address', `email format error copy: ${bad}`);
}
assert(profileEmailError('') === 'Required', 'empty email -> Required (not the format error)');
assert(profileEmailError('   ') === 'Required', 'whitespace email -> Required');

for (const ok of ['8183312795', '(818) 331-2795', '+1 818-331-2795', '818-331-2795', '18183312795', '+18183312795']) {
  assert(isValidProfilePhone(ok), `phone valid: ${ok}`);
  assert(profilePhoneError(ok) === null, `phone error null: ${ok}`);
}
for (const bad of ['3312795', '818331279', '81833127951', '28183312795', 'call-me-now', '818-331-279a', '+44 20 7946 0958']) {
  assert(!isValidProfilePhone(bad), `phone invalid: ${bad}`);
  assert(profilePhoneError(bad) === 'Enter a valid phone number', `phone format error copy: ${bad}`);
}
assert(profilePhoneError('') === 'Required', 'empty phone -> Required (not the format error)');
assert(profilePhoneError('  ') === 'Required', 'whitespace phone -> Required');

// Combined gate: the screens' single check.
assert(!hasProfileFieldErrors(profileFieldErrors(FULL)), 'combined: valid draft has no errors');
assert(hasProfileFieldErrors(profileFieldErrors({ ...FULL, email: 'nope' })), 'combined: malformed email blocks');
assert(hasProfileFieldErrors(profileFieldErrors({ ...FULL, phone: '123' })), 'combined: malformed phone blocks');
assert(
  profileFieldErrors({ ...FULL, realty_group: '' }).broker === null,
  'combined: broker carries no error even when empty (Oct 22, 2026)',
);
assert(
  !hasProfileFieldErrors(profileFieldErrors({ ...FULL, realty_group: '' })),
  'combined: a broker-empty profile saves (Oct 22, 2026)',
);
assert(
  profileFieldErrors({ name: '', email: '', phone: '', realty_group: '' }).email === 'Required',
  'combined: empty email reports Required through the combined gate too',
);

// --- 2. Form: labels and error slots ----------------------------------------
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const srcFile = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const form = srcFile('src/components/ProfileForm.tsx');
assert(form.includes('label="Email"'), 'form: Email label has no "(optional)"');
assert(form.includes('label="Phone"'), 'form: Phone label has no "(optional)"');
assert(form.includes('label="Broker (optional)"'), 'form: Broker carries the "(optional)" suffix like the other optional fields (Anuraj, Oct 22, 2026)');
assert(!form.includes('label="Email (optional)"'), 'form: old Email (optional) label gone');
assert(!form.includes('label="Phone (optional)"'), 'form: old Phone (optional) label gone');
assert(form.includes('label="License number (optional)"'), 'form: License stays optional');
assert(form.includes('label="Google review link · optional"'), 'form: Google link stays optional');
assert(form.includes('label="Other review link · optional"'), 'form: Other link stays optional');
// Name/broker errors arrive via parent props and render under the fields;
// email/phone errors are computed live in the form (review-link pattern:
// touched/blur or submitAttempted) and render through the Field error prop.
assert(form.includes('brokerError ? <Text style={styles.nameError}>'), 'form: brokerError renders the inline error under its field');
assert(form.includes('profileEmailError(value.email)'), 'form: email error computed live from the draft value');
assert(form.includes('profilePhoneError(value.phone)'), 'form: phone error computed live from the draft value');
assert(form.includes('error={emailFieldError}'), 'form: email Field carries its inline error');
assert(form.includes('error={phoneFieldError}'), 'form: phone Field carries its inline error');
assert(form.includes('onBlur={() => setEmailTouched(true)}'), 'form: email error reveals on blur (touched)');
assert(form.includes('onBlur={() => setPhoneTouched(true)}'), 'form: phone error reveals on blur (touched)');
assert(form.includes('emailTouched || submitAttempted'), 'form: email error also reveals on a save attempt');
assert(form.includes('phoneTouched || submitAttempted'), 'form: phone error also reveals on a save attempt');

// --- 3. All three screens validate on save with the shared helpers ---------
for (const screen of ['app/profile-update.tsx', 'app/profile-create.tsx', 'app/profile-setup.tsx']) {
  const s = srcFile(screen);
  assert(s.includes("from '../src/lib/profileRequired'"), `${screen}: imports the shared validation helpers`);
  assert(s.includes('profileFieldErrors(draft)'), `${screen}: save computes every field error in one pass`);
  assert(s.includes('hasProfileFieldErrors(errors)'), `${screen}: any field error blocks the save`);
  assert(s.includes('brokerError={brokerError}'), `${screen}: passes brokerError into the form`);
  assert(s.includes('setNameError(errors.name)'), `${screen}: name error comes from the combined result`);
  assert(s.includes('setBrokerError(errors.broker)'), `${screen}: broker error comes from the combined result`);
}

// --- 4. Skip path is exempt (onboarding) ------------------------------------
const create = srcFile('app/profile-create.tsx');
const skipGuardAt = create.indexOf('if (!skipped) {');
const validateAt = create.indexOf('profileFieldErrors(draft)');
assert(
  skipGuardAt !== -1 && validateAt > skipGuardAt,
  'create: required validation runs inside the non-skip branch only',
);
assert(create.includes("onPress={() => finish(true)}"), 'create: Skip still calls finish(true) (no validation)');

// --- 5. Blocked-save summary line (Oct 22, 2026) -----------------------------
// A blocked save used to only red-mark fields inline, which read as
// "nothing happened". Every save screen now also shows the summary
// line directly above its save button, gated on a blocked attempt AND
// the draft still failing validation (fixing the fields hides it).
for (const screen of ['app/profile-update.tsx', 'app/profile-create.tsx', 'app/profile-setup.tsx']) {
  const s = srcFile(screen);
  assert(s.includes('Please fill in the required fields above.'), `${screen}: carries the blocked-save summary copy (exact)`);
  assert(s.includes('validationBlocked && hasProfileFieldErrors(profileFieldErrors(draft))'), `${screen}: summary shows only for a blocked attempt with errors still present`);
  assert(s.includes('setValidationBlocked(true)'), `${screen}: a blocked attempt sets the summary state`);
  assert(s.includes('setValidationBlocked(false)'), `${screen}: a passing attempt clears the summary state`);
}

// --- 6. Email pre-fill (Oct 22, 2026) -----------------------------------------
// The contact Email pre-fills with the signed-in account's email when
// the stored profile email is empty; a stored email always wins.
assert(prefillProfileEmail('', 'signup@mail.com') === 'signup@mail.com', 'prefill: fresh account (empty stored) -> signup email');
assert(prefillProfileEmail(null, 'signup@mail.com') === 'signup@mail.com', 'prefill: fresh account (no profile) -> signup email');
assert(prefillProfileEmail(undefined, 'signup@mail.com') === 'signup@mail.com', 'prefill: undefined stored -> signup email');
assert(prefillProfileEmail('  ', 'signup@mail.com') === 'signup@mail.com', 'prefill: whitespace stored counts as empty');
assert(
  prefillProfileEmail('stored@mail.com', 'signup@mail.com') === 'stored@mail.com',
  'prefill: a stored email always wins, shown unchanged',
);
assert(prefillProfileEmail('', null) === '' && prefillProfileEmail(null, null) === '', 'prefill: no session email -> stays empty');
// Cleared after pre-fill, the field is just empty again: the required
// check (and the item-2 summary gate) still applies.
assert(
  profileEmailError('') === 'Required' && hasProfileFieldErrors(profileFieldErrors({ ...FULL, email: '' })),
  'prefill: a cleared email still hits the required check on save',
);
// Wiring pins: create reads the session email and prefills once per
// mount (never resurrecting a cleared value on refocus); setup/update
// prefill at draft build from the stored profile.
const createSrc = srcFile('app/profile-create.tsx');
assert(createSrc.includes('auth.getSessionEmail()'), 'create: reads the signed-in account email');
assert(createSrc.includes('prefillProfileEmail(existing?.email, sessionEmail)'), 'create: prefill goes through the shared helper (stored wins)');
assert(createSrc.includes('emailPrefilledRef'), 'create: prefill is once-per-mount (no resurrection on refocus)');
for (const screen of ['app/profile-setup.tsx', 'app/profile-update.tsx']) {
  const s = srcFile(screen);
  assert(s.includes('prefillProfileEmail(p.email, sessionEmail)'), `${screen}: draft email pre-fills via the shared helper`);
  assert(s.includes('auth.getSessionEmail()'), `${screen}: reads the signed-in account email`);
}
const authSrc = srcFile('src/lib/auth.ts');
assert(authSrc.includes('async getSessionEmail()'), 'auth: exposes the session email accessor');

summary('profile-required');
