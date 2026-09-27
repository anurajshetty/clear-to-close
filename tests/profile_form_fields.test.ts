// profile_form_fields.test.ts — the realtor profile form spec (Anuraj, Sept 2026).
//
// Field order: 1. Profile pic, 2. Banner image, 3. Full name, 4. Email,
// 5. Phone, 6. Broker (renamed from "Realty group"), 7. About,
// 8. Years of experience, 9. Areas served, 10. License number.
// Email and Phone are stored on the profile; the client-facing profile's
// Call/Text buttons use the phone number (tel:/sms:). "Avg days to close"
// is removed from the form AND from every screen that showed it, including
// the public profile page.
//
// RN components are not importable in the node suite, so the component/
// route sources are pinned statically (repo root via CTC_REPO_ROOT,
// exported by tests/run.sh).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';

// tests/run.sh compiles with a bare tsc invocation (no node types), so the
// globals are declared the same way tests/auth.test.ts declares them.
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

/* eslint-disable @typescript-eslint/no-require-imports */
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const form = src('src/components/ProfileForm.tsx');
const profileView = src('src/components/RealtorProfileView.tsx');
const types = src('src/lib/types.ts');
const storeSrc = src('src/lib/store.ts');
const cloudSync = src('src/lib/cloudSync.ts');
const shareCopy = src('src/lib/shareCopy.ts');
const triumph = src('src/components/ClientTriumph.tsx');
const route = src('app/realtor-profile.tsx');
const publicRoute = src('app/realtor/[id].tsx');

// --- 1. Field order -------------------------------------------------------
const ORDER = [
  '1. Profile pic', // photo picker row
  '2. Banner image', // banner picker row
  'label="Full name"',
  'label="Email (optional)"',
  'label="Phone (optional)"',
  'label="Broker (optional)"',
  'label="About"',
  'label="Years of experience"',
  'label="Areas served"',
  'label="License number (optional)"',
];
let last = -1;
for (const token of ORDER) {
  const at = form.indexOf(token);
  assert(at > last, `field order: "${token}" appears in order`);
  last = at;
}

// --- 2. Broker rename -----------------------------------------------------
assert(form.indexOf('label="Realty group"') === -1, '"Realty group" label is gone');
assert(form.indexOf('label="Broker (optional)"') !== -1, '"Broker (optional)" label present');
assert(form.indexOf('realty_group') !== -1, 'realty_group field key kept (contractual)');

// --- 3. Email/Phone on the draft and in storage ---------------------------
assert(form.indexOf('email: string') !== -1, 'ProfileDraft has email');
assert(form.indexOf("email: ''") !== -1, 'EMPTY_PROFILE_DRAFT has email');
assert(types.indexOf('email: string') !== -1, 'RealtorProfile has email');
assert(
  storeSrc.indexOf("data.profile.email = ''") !== -1,
  'store backfills email to empty for legacy profiles',
);

// Store round-trip: email persists on the profile.
async function main(): Promise<void> {
  const store = createStore(memoryKV());
  await store.saveProfile({
    name: 'Maya Sharma',
    email: 'maya@compass.com',
    phone: '(555) 010-2030',
    photoUri: null,
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    banner_image: null,
    about: '',
    yearsExperience: '9',
    areasServed: '',
    dreLicense: '',
    realty_group: 'Compass Realty',
    reviews: [],
    rating: null,
  });
  const p = await store.getProfile();
  assert(p !== null && p.email === 'maya@compass.com', 'saved email round-trips on the profile');
  assert(p !== null && p.phone === '(555) 010-2030', 'saved phone round-trips on the profile');

  // --- 4. Call/Text use the phone number ----------------------------------
  assert(route.indexOf('tel:${phone}') !== -1, 'Call button opens tel: with the profile phone');
  assert(route.indexOf('sms:${phone}') !== -1, 'Text button opens sms: with the profile phone');

  // --- 5. Avg days to close is gone everywhere user-facing ---------------
  for (const [name, s] of [
    ['ProfileForm', form],
    ['RealtorProfileView', profileView],
    ['shareCopy', shareCopy],
    ['ClientTriumph', triumph],
    ['public profile route', publicRoute],
  ] as Array<[string, string]>) {
    assert(s.indexOf('Avg days') === -1, `${name}: no "Avg days" copy`);
    assert(s.indexOf('avgDaysToClose') === -1, `${name}: no avgDaysToClose reference`);
  }
  assert(types.indexOf('avgDaysToClose') === -1, 'RealtorProfile: no avgDaysToClose field');
  assert(cloudSync.indexOf('avg_days_to_close') === -1, 'cloudSync: no avg_days_to_close column');
  assert(cloudSync.indexOf('email: p?.email ?? null') !== -1, 'cloudSync pushes email');
  assert(cloudSync.indexOf('email: s(row.email)') !== -1, 'cloudSync pulls email');
  assert(
    profileView.indexOf('label="Avg days to close"') === -1,
    'public profile stat row: Avg days stat removed',
  );
  assert(profileView.indexOf('label="Years in"') !== -1, 'public profile keeps the Years in stat');
  assert(profileView.indexOf('label="Client rating"') !== -1, 'public profile keeps the Client rating stat');

  // --- 6. The 0016 email migration ----------------------------------------
  const migration = src('supabase/migrations/0016_profile_email.sql');
  assert(migration.indexOf('add column if not exists email text') !== -1, '0016 adds the email column');

  summary('profile-form-fields');
}

main().catch((e) => {
  console.error('profile_form_fields.test failed:', e);
  process.exitCode = 1;
});
