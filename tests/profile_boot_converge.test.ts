// profile_boot_converge.test.ts — Sept 2026: after a browser refresh, the
// realtor's own profile edit page showed the OLD name/email ("Jimmy" /
// "jimmy@gmail.com") while realtor_profiles already held the NEW values
// ("jimmy ola" / "jimmyola@gmail.com") — e.g. saved from another
// device/browser. Root cause: the boot-time reconcile never pulls the
// profile row — pullProfileFromCloud returns the local snapshot as-is
// whenever one exists, and initCloudSync only ever PUSHES the profile.
// The local snapshot was the eternal source of truth.
//
// Required behavior: on boot (pullProfileFromCloud, which the launch router
// awaits) and on foreground (refreshProfile), the local snapshot converges
// to the live server row — with the usual conflict care: a locally-dirty
// profile awaiting push (queued pushProfile op) must NOT be clobbered, and
// a missing server row must never wipe the local snapshot.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import { enqueueOutbox } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-123';
const STALE_NAME = 'Jimmy';
const STALE_EMAIL = 'jimmy@gmail.com';
const FRESH_NAME = 'jimmy ola';
const FRESH_EMAIL = 'jimmyola@gmail.com';

interface Backend {
  netUp: boolean;
  serverRow: Record<string, unknown> | null;
}

function makeBackend(serverRow: Record<string, unknown> | null): Backend {
  return { netUp: true, serverRow };
}

function serverRow(name: string, email: string): Record<string, unknown> {
  return {
    user_id: UID,
    name,
    email,
    photo_url: null,
    banner_image: null,
    about: '',
    years_experience: '',
    areas_served: '',
    phone: '',
    dre_license: '',
    realty_group: '',
  };
}

function mockCloud(be: Backend) {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: UID } } }, error: null }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          limit: async () => {
            if (!be.netUp) throw new Error('offline');
            return { data: be.serverRow ? [be.serverRow] : [], error: null };
          },
        }),
      }),
    }),
  };
}

function seedLocalProfile(kv: ReturnType<typeof memoryKV>, name: string, email: string): void {
  void kv.setItem('ctc:profile', JSON.stringify({ name, email }));
}

async function main(): Promise<void> {
  // 1. The reported bug: stale local snapshot converges to the server row
  // on the boot pull the launch router awaits.
  {
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME, STALE_EMAIL);
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(makeBackend(serverRow(FRESH_NAME, FRESH_EMAIL))),
    });
    const pulled = await store.pullProfileFromCloud();
    assert(
      pulled !== null && pulled.name === FRESH_NAME,
      `boot pull returns the live server profile (got ${pulled?.name})`,
    );
    const local = await store.getProfile();
    assert(
      local !== null && local.name === FRESH_NAME && local.email === FRESH_EMAIL,
      `boot pull replaces the stale local snapshot (got ${local?.name} / ${local?.email})`,
    );
  }

  // 2. Conflict care: a locally-dirty profile awaiting push is NOT clobbered.
  {
    const kv = memoryKV();
    seedLocalProfile(kv, 'Local Edit', 'local@example.com');
    await enqueueOutbox(kv, { op: 'pushProfile', attempts: 0 });
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(makeBackend(serverRow('Server Old', 'old@example.com'))),
    });
    const pulled = await store.pullProfileFromCloud();
    assert(
      pulled !== null && pulled.name === 'Local Edit',
      `dirty local profile wins the boot pull (got ${pulled?.name})`,
    );
    const local = await store.getProfile();
    assert(
      local !== null && local.name === 'Local Edit',
      'dirty local snapshot is not overwritten',
    );
  }

  // 3. A missing server row never wipes the local snapshot (e.g. a profile
  // created while the cloud was unconfigured and never pushed).
  {
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME, STALE_EMAIL);
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(makeBackend(null)),
    });
    const pulled = await store.pullProfileFromCloud();
    assert(
      pulled !== null && pulled.name === STALE_NAME,
      `missing server row keeps the local snapshot (got ${pulled?.name})`,
    );
  }

  // 4. Foreground: refreshProfile converges a clean snapshot, never throws.
  {
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME, STALE_EMAIL);
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(makeBackend(serverRow(FRESH_NAME, FRESH_EMAIL))),
    });
    let threw = false;
    try {
      await store.refreshProfile();
    } catch {
      threw = true;
    }
    assert(!threw, 'refreshProfile never throws');
    const local = await store.getProfile();
    assert(
      local !== null && local.name === FRESH_NAME,
      `refreshProfile converges the snapshot (got ${local?.name})`,
    );
  }

  // 5. Foreground: refreshProfile leaves a dirty snapshot alone.
  {
    const kv = memoryKV();
    seedLocalProfile(kv, 'Local Edit', 'local@example.com');
    await enqueueOutbox(kv, { op: 'pushProfile', attempts: 0 });
    const { store } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(makeBackend(serverRow('Server Old', 'old@example.com'))),
    });
    await store.refreshProfile();
    const local = await store.getProfile();
    assert(
      local !== null && local.name === 'Local Edit',
      `refreshProfile does not clobber dirty local state (got ${local?.name})`,
    );
  }

  // 6. Offline: the stale snapshot keeps rendering, never throws.
  {
    const be = makeBackend(serverRow(FRESH_NAME, FRESH_EMAIL));
    be.netUp = false;
    const kv = memoryKV();
    seedLocalProfile(kv, STALE_NAME, STALE_EMAIL);
    const { store } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });
    let threw = false;
    try {
      await store.pullProfileFromCloud();
    } catch {
      threw = true;
    }
    assert(!threw, 'offline boot pull never throws');
    const local = await store.getProfile();
    assert(local !== null && local.name === STALE_NAME, 'offline keeps the local snapshot');
  }

  summary('profile_boot_converge');
}

void main();
