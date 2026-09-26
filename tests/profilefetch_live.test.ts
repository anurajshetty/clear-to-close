// profilefetch_live.test.ts — UNSTUBBED regression for the profile-fetch bug.
//
// This test performs a REAL login against the LIVE Supabase project: real
// sign-up, real sign-in, real session, real network, real database rows. No
// mocks, no stubs anywhere — the code under test (auth service, pingCloud,
// pullProfileNow, syncedStore.pullProfileFromCloud, resolvePostAuthHref) is
// the actual app code.
//
// It reproduces the reported real-account state — a realtor_profiles row
// with name = NULL but about / years_experience / deals_closed /
// areas_served / phone / dre_license all saved — and proves:
//   1. pingCloud never writes to the profile row (regression: the old write
//      round-trip upserted { name: null } on every boot, wiping the saved
//      name — the root cause of the NULL name in the first place).
//   2. pullProfileNow returns the row instead of discarding it (regression:
//      the old name-completeness gate returned null for name-NULL rows).
//   3. The synced store persists the hydrated profile, so the profile edit
//      form and the client-facing realtor profile see the saved fields.
//   4. Post-login routing sends the existing account to the deal list ('/'),
//      not profile creation.
//   5. Phone flows through the shared read path, and a device-local blob:
//      photo URL maps to null (graceful no-photo rendering).
//
// The test is gated on real Supabase credentials. Without them it SKIPS
// loudly instead of failing, so the normal offline suite stays green; run
// it with the live project credentials to get the real-login proof:
//
//   EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key> node out/tests/profilefetch_live.test.js
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createAuthService } from '../src/lib/auth';
import { getSupabaseClient } from '../src/lib/supabase';
import { createSyncedStore } from '../src/lib/syncedStore';
import { resolvePostAuthHref } from '../src/lib/bootRoute';
import { pullProfileNow, pingCloud } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const LIVE = URL !== '' && ANON !== '' && URL !== 'https://example.supabase.co' && ANON !== 'test-anon-key';

async function main(): Promise<void> {
  if (!LIVE) {
    console.log(
      'SKIP - profilefetch_live.test needs real Supabase credentials ' +
        '(EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY); ' +
        'offline suite unaffected.',
    );
    summary('profilefetch_live.test (skipped)');
    return;
  }

  const ts = Date.now();
  const email = `profilefetch-live-${ts}@example.com`;
  const password = `Live-${ts}-Pw!`;

  // Fresh web client: in-memory auth storage, exactly like the real web app.
  const client = getSupabaseClient('web');
  assert(client !== null, 'setup: real supabase client created');

  const kv = memoryKV();
  const svc = createAuthService({ getClient: () => client, kv, platform: 'web' });

  // 1. REAL sign-up + REAL sign-in (this project has no email verification).
  const su = await svc.signUp('Live Test', email, password);
  assert(su.ok, `real sign-up succeeds (${su.ok ? 'ok' : su.code})`);
  const si = await svc.signIn(email, password);
  assert(si.ok, `real sign-in succeeds (${si.ok ? 'ok' : si.code})`);
  if (!si.ok) throw new Error('live test: sign-in failed: ' + si.code);
  const uid = si.userId as string;
  assert(typeof uid === 'string' && uid.length > 0, 'real session carries a user id');

  try {
    // 2. Seed a named profile, then run the REAL pingCloud: the probe must
    // not touch the row — the name must survive the ping.
    const named = {
      user_id: uid,
      name: 'Live Test Realtor',
      photo_url: null,
      about: 'Live test about',
      years_experience: '10',
      deals_closed: '30',
      areas_served: 'Santa Clarita',
      phone: '555-0100',
      dre_license: 'DRE-LIVE',
    };
    const seed = await client.from('realtor_profiles').upsert(named, { onConflict: 'user_id' });
    assert(!seed.error, 'setup: named profile row seeded');

    const ping = await pingCloud(client);
    assert(ping.ran && ping.ok, `real pingCloud succeeds (${ping.ok ? 'ok' : ping.error})`);

    const afterPing = await client
      .from('realtor_profiles')
      .select('name,about')
      .eq('user_id', uid)
      .limit(1);
    assert(afterPing.data?.[0]?.name === 'Live Test Realtor', 'pingCloud never NULLs the saved name');
    assert(afterPing.data?.[0]?.about === 'Live test about', 'pingCloud leaves other fields untouched');

    // 3. The reported real-account state: name NULL, everything else saved,
    // plus a device-local blob: photo URL. The REAL pullProfileNow must
    // return the row with all fields hydrated.
    const reported = {
      user_id: uid,
      name: null,
      photo_url: 'blob:https://example.com/dead-beef-local-only',
      about: 'Live test about',
      years_experience: '10',
      deals_closed: '30',
      areas_served: 'Santa Clarita',
      phone: '555-0100',
      dre_license: 'DRE-LIVE',
    };
    const seed2 = await client.from('realtor_profiles').upsert(reported, { onConflict: 'user_id' });
    assert(!seed2.error, 'setup: reported name-NULL row seeded');

    const pulled = await pullProfileNow(client, uid);
    assert(pulled !== null, 'pullProfileNow returns the name-NULL row instead of discarding it');
    assert(pulled !== null && pulled.about === 'Live test about', 'about hydrates from the live row');
    assert(pulled !== null && pulled.yearsExperience === '10', 'years_experience hydrates');
    assert(pulled !== null && pulled.dealsClosed === '30', 'deals_closed hydrates');
    assert(pulled !== null && pulled.areasServed === 'Santa Clarita', 'areas_served hydrates');
    assert(pulled !== null && pulled.phone === '555-0100', 'phone hydrates through the shared mapper');
    assert(pulled !== null && pulled.dreLicense === 'DRE-LIVE', 'dre_license hydrates');
    assert(pulled !== null && pulled.photoUri === null, 'device-local blob: photo maps to null (graceful)');

    // 4. The full app path: synced-store pull persists the hydrated profile
    // (this is what the profile edit form and the client realtor profile
    // read), and routing lands on the deal list.
    const { store } = createSyncedStore(kv, { cloudClient: () => client });
    const viaStore = await store.pullProfileFromCloud();
    assert(viaStore !== null, 'pullProfileFromCloud returns the existing profile');
    const local = await store.getProfile();
    assert(
      local !== null && local.about === 'Live test about' && local.phone === '555-0100',
      'hydrated profile is persisted locally (edit form + client profile read this)',
    );
    const href = resolvePostAuthHref({ sessionUserId: uid, profile: viaStore, skipped: false });
    assert(href === '/', 'existing account with name-NULL profile routes to the deal list, not profile creation');
  } finally {
    // Cleanup: remove the test profile row (the auth user is harmless test residue).
    await client.from('realtor_profiles').delete().eq('user_id', uid);
  }

  summary('profilefetch_live.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
