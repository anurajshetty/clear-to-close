// profilepull.test.ts — post-login profile reconcile + routing.
//
// The bug: logging in with an existing realtor account whose profile was
// already set landed on profile creation instead of the deal list. The
// routing decision read the profile from the local KV only; on a
// device/browser whose local store was never seeded, getProfile() returned
// null even though the profile existed in Supabase — so resolvePostAuthHref
// sent the realtor to '/profile-create'.
//
// The fix: store.pullProfileFromCloud() pulls the cloud row when the local
// copy is missing (and persists it), and resolvePostAuthHref only treats a
// profile with a non-empty name as completed.
//
// Routing cases (must fail without the fix, pass with it):
//   1. existing account with completed profile -> deal list ('/')
//   2. brand-new sign-up without profile -> profile setup ('/profile-create')
//   3. "Skip for now" -> deal list ('/'), never a trap
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { resolvePostAuthHref } from '../src/lib/bootRoute';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-123';

function completedRow(): Record<string, unknown> {
  return {
    user_id: UID,
    name: 'Rita Realtor',
    photo_url: null,
    about: 'About Rita',
    years_experience: '8',
    deals_closed: '42',
    areas_served: 'Valencia',
    phone: '555-0100',
    dre_license: 'DRE-123',
  };
}

/** All-null row: the shape left behind by the sync ping probe's write round-trip. */
function emptyRow(): Record<string, unknown> {
  return {
    user_id: UID,
    name: null,
    photo_url: null,
    about: null,
    years_experience: null,
    deals_closed: null,
    areas_served: null,
    phone: null,
    dre_license: null,
  };
}

/** Mock Supabase client: rows=null means the query itself fails. */
function mockProfileClient(rows: Record<string, unknown>[] | null) {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: UID } } } }),
    },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          limit: async (_n: number) =>
            rows === null ? { data: null, error: { message: 'boom' } } : { data: rows, error: null },
        }),
      }),
    }),
  };
}

async function main(): Promise<void> {
  // 1. Existing account with a completed cloud profile, empty local store ->
  //    pull returns the profile and the login routing lands on the deal list.
  {
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockProfileClient([completedRow()]) });
    const before = await store.getProfile();
    assert(before === null, 'setup: local profile is missing (new device/browser)');
    const pulled = await store.pullProfileFromCloud();
    assert(pulled !== null && pulled.name === 'Rita Realtor', 'pullProfileFromCloud returns the cloud profile');
    assert(pulled !== null && pulled.dreLicense === 'DRE-123', 'pulled profile maps all columns');
    const after = await store.getProfile();
    assert(after !== null && after.name === 'Rita Realtor', 'pulled profile is persisted locally');
    const href = resolvePostAuthHref({ sessionUserId: UID, profile: pulled, skipped: false });
    assert(href === '/', 'existing account with completed profile -> deal list after login');
  }

  // 2. Brand-new sign-up: no cloud row either -> profile creation (step 2).
  {
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockProfileClient([]) });
    const pulled = await store.pullProfileFromCloud();
    assert(pulled === null, 'no cloud profile -> pull returns null');
    const href = resolvePostAuthHref({ sessionUserId: UID, profile: pulled, skipped: false });
    assert(href === '/profile-create', 'brand-new sign-up without profile -> profile setup');
  }

  // 3. "Skip for now" -> deal list, never a trap.
  {
    const href = resolvePostAuthHref({ sessionUserId: UID, profile: null, skipped: true });
    assert(href === '/', '"Skip for now" -> deal list (no trap)');
  }

  // 4. An all-null cloud row (ping probe artifact) is NOT a completed
  //    profile -> the realtor still gets profile creation, not the deal list.
  {
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockProfileClient([emptyRow()]) });
    const pulled = await store.pullProfileFromCloud();
    assert(pulled === null, 'all-null cloud row does not count as a completed profile');
    const href = resolvePostAuthHref({ sessionUserId: UID, profile: pulled, skipped: false });
    assert(href === '/profile-create', 'empty cloud row -> profile setup, not the deal list');
  }

  // 5. Cloud failure fails open to the local copy and never throws.
  {
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockProfileClient(null) });
    let threw = false;
    let pulled = null;
    try {
      pulled = await store.pullProfileFromCloud();
    } catch {
      threw = true;
    }
    assert(!threw, 'cloud failure never throws');
    assert(pulled === null, 'cloud failure -> null (routing falls through to profile setup)');
  }

  // 6. Local profile already present -> no cloud call needed, deal list.
  {
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: () => mockProfileClient([]) });
    await store.saveProfile({
      name: 'Local Rita',
      photoUri: null,
      about: '',
      yearsExperience: '',
      dealsClosed: '',
      areasServed: '',
      phone: '',
      dreLicense: '',
    });
    const pulled = await store.pullProfileFromCloud();
    assert(pulled !== null && pulled.name === 'Local Rita', 'existing local profile is returned as-is');
    const href = resolvePostAuthHref({ sessionUserId: UID, profile: pulled, skipped: false });
    assert(href === '/', 'local profile present -> deal list');
  }

  summary('profilepull.test');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
