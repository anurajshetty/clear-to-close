// photo_stale_client_chain.test.ts — end-to-end regression for the Sept 2026
// stale-client-photo bug: the realtor updates their profile photo, but the
// CLIENT page still shows the old one even after refresh.
//
// Chain under test (mock Supabase backend, no network):
//   realtor saveProfile -> Storage upload (unique-path URL) ->
//   realtor_profiles upsert -> get_client_view -> client render URI
//   (displayPhotoUri).
//
// The break (old model): the media upload only ran inside saveProfile's live
// bgPush. Any save that converged through the outbox (offline / ping failed
// / the live run threw) or through the boot-time background reconcile pushed
// the profile row WITHOUT uploading the new image — the server kept the old
// photo_url forever while the realtor's device showed the new photo from
// its local managed file. The client then showed the old photo even after
// refresh, with no error anywhere.
//
// Under the synchronous model (Sept 28, 2026): the upload is part of the
// confirmed write — it throws instead of silently producing an unconfirmed
// result, and nothing is ever queued for a later background push.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import {
  fetchCloudView,
  readOutboxOps,
} from '../src/lib/cloudSync';
import { displayPhotoUri } from '../src/lib/profile';
import type { RealtorProfile } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-123';
const OLD_PHOTO_URL =
  'https://cdn.example/storage/v1/object/public/realtor-media/user-123/photo.jpg?v=111';

// Two distinct 1px images as data: URIs (the web managed-photo shape).
const PHOTO_A =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PHOTO_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAWjR9awAAAABJRU5ErkJggg==';

interface Backend {
  netUp: boolean;
  photoUrl: string;
  uploads: string[];
  uploadedBytes: Record<string, number>;
}

function makeBackend(): Backend {
  return { netUp: true, photoUrl: OLD_PHOTO_URL, uploads: [], uploadedBytes: {} };
}

function publicUrlFor(path: string): string {
  return `https://cdn.example/storage/v1/object/public/realtor-media/${path}`;
}

// Minimal Supabase-shaped mock. `netUp=false` makes every network op fail,
// which is how the boot ping and the Storage upload observe "offline".
function mockCloud(be: Backend) {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: UID } } }, error: null }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array) => {
          if (!be.netUp) return { error: new Error('offline') };
          be.uploads.push(`${bucket}/${path}`);
          be.uploadedBytes[path] = bytes.length;
          return { error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: publicUrlFor(path) } }),
      }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => {
            if (!be.netUp) return Promise.reject(new Error('offline'));
            return Promise.resolve({ data: [], error: null });
          },
        }),
      }),
      upsert: (rows: Record<string, unknown>[]) => {
        let result: { data?: unknown; error?: unknown };
        if (!be.netUp) {
          result = { error: new Error('offline') };
        } else {
          for (const r of rows) {
            if (typeof r.photo_url === 'string') be.photoUrl = r.photo_url;
          }
          result = { data: rows.map((r) => ({ id: r.id })), error: null };
        }
        return { select: () => Promise.resolve(result) };
      },
    }),
    rpc: async (name: string) => {
      if (name !== 'get_client_view') return { data: null, error: new Error('unknown rpc') };
      if (!be.netUp) return { data: null, error: new Error('offline') };
      return {
        error: null,
        data: {
          ok: true,
          escrow: {
            id: 'esc-1',
            address: '1 Main St',
            city: 'Valencia',
            open_date: '2026-09-01',
            close_date: '2026-10-15',
          },
          profile: {
            name: 'Rita Realtor',
            photo_url: be.photoUrl,
            banner_image: null,
            about: '',
            years_experience: '',
            email: '',
            areas_served: '',
            phone: '',
            dre_license: '',
            realty_group: '',
            googleReviewLink: '',
            realtorComReviewLink: '',
          },
          role: 'buyer',
          buyer_steps: [],
        },
      };
    },
  };
}

function profileFixture(): RealtorProfile {
  return {
    name: 'Rita Realtor',
    photoUri: null,
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    banner_image: null,
    about: '',
    yearsExperience: '',
    email: '',
    areasServed: '',
    phone: '',
    dreLicense: '',
    realty_group: '',
    googleReviewLink: '',
    realtorComReviewLink: '',
    reviews: [],
    rating: null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      console.error(`FAIL - timed out waiting for: ${what}`);
      return false;
    }
    await sleep(25);
  }
  return true;
}

/** What the client page renders for the realtor photo after a refresh. */
async function clientPhotoUri(be: Backend): Promise<string | null> {
  const res = await fetchCloudView(mockCloud(be) as never, 'link-1');
  if (!res.ok || !res.profile) return null;
  return displayPhotoUri(res.profile);
}

async function main(): Promise<void> {
  // ------------------------------------------- 1. happy path (online save) ---
  {
    const be = makeBackend();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(be) as never,
    });
    const ping = await initCloudSync();
    assert(ping.ok === true, '1: boot ping ok (happy path)');
    await store.saveProfile({ ...profileFixture(), photoUri: PHOTO_A });
    const updated = await waitFor(
      () =>
        be.photoUrl !== OLD_PHOTO_URL &&
        /^https:\/\/cdn\.example\/storage\/v1\/object\/public\/realtor-media\/user-123\/photo-[0-9a-z]+\.jpg$/.test(
          be.photoUrl,
        ),
      '1: server photo_url updated with a fresh unique-path URL',
    );
    assert(updated, '1: server photo_url updated with a fresh unique-path URL');
    assert(
      be.uploads.length === 1 &&
        /^realtor-media\/user-123\/photo-[0-9a-z]+\.jpg$/.test(be.uploads[0]),
      '1: the new photo bytes were uploaded to a unique path in the realtor-media bucket',
    );
    const uri = await clientPhotoUri(be);
    assert(uri === be.photoUrl && uri !== OLD_PHOTO_URL, '1: client renders the new photo after refresh');
  }

  // ------ 2. save while offline: fail-fast, nothing queued, nothing uploaded
  {
    const be = makeBackend();
    be.netUp = false;
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(be) as never,
    });
    const ping1 = await initCloudSync();
    assert(ping1.ok === false, '2: boot ping fails while offline');
    // The realtor updates the photo with no connectivity: the confirmed
    // write fails fast instead of queueing a background push.
    let msg = '';
    try {
      await store.saveProfile({ ...profileFixture(), photoUri: PHOTO_B });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/not saved/i.test(msg), '2: offline save throws the plain not-saved copy');
    assert(be.uploads.length === 0, '2: nothing uploaded while offline (sanity)');
    const ops = await readOutboxOps(kv);
    assert(ops.length === 0, '2: no outbox op is queued for a user action');
    const kept = await store.getProfile();
    assert(kept === null, '2: the failed save leaves no local profile behind');
    // Network recovers; a fresh save converges the photo end to end.
    be.netUp = true;
    await store.saveProfile({ ...profileFixture(), photoUri: PHOTO_B });
    const updated = await waitFor(
      () => be.photoUrl !== OLD_PHOTO_URL && /\/photo-[0-9a-z]+\.jpg$/.test(be.photoUrl),
      '2: server photo_url carries the new unique-path URL after the retry',
    );
    assert(updated, '2: server photo_url carries the new unique-path URL after the retry');
    const uri = await clientPhotoUri(be);
    assert(
      uri !== null && uri === be.photoUrl && uri !== OLD_PHOTO_URL,
      '2: client renders the new photo after refresh (no reinstall)',
    );
  }

  // ----------------- 3. no URL churn when the photo did not change -----------
  {
    const be = makeBackend();
    const kv = memoryKV();
    const { store, initCloudSync } = createSyncedStore(kv, {
      cloudClient: () => mockCloud(be) as never,
    });
    await initCloudSync();
    await store.saveProfile({ ...profileFixture(), photoUri: PHOTO_A });
    const first = await waitFor(() => be.uploads.length === 1, '3: first save uploads once');
    assert(first, '3: first save uploads once');
    const firstUrl = be.photoUrl;
    // A name-only edit must not re-upload the unchanged photo or mint a new URL.
    await store.saveProfile({ ...profileFixture(), name: 'Rita Updated', photoUri: PHOTO_A });
    await sleep(600);
    assert(be.uploads.length === 1, '3: unchanged photo is not re-uploaded on a name-only edit');
    assert(be.photoUrl === firstUrl, '3: photo URL is stable when the photo did not change');
  }

  summary('photo_stale_client_chain');
}

main().catch((e) => {
  console.error('FAIL - unexpected throw', e);
  process.exitCode = 1;
});
