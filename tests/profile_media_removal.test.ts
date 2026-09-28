// profile_media_removal.test.ts — REGRESSION: profile/banner image removal
// (Sept 28, 2026, Anuraj).
//
// The edit-profile form's photo and banner get a small X badge (visible
// only when an image is set): tapping the image still opens the
// picker/cropper (change flow, untouched); tapping X clears the image from
// the draft. No confirmation — Save is the commit point. On Save with a
// cleared image the pipeline deletes the local managed file, deletes
// <userId>/photo.jpg (or banner.jpg) from the `realtor-media` Storage
// bucket (new delete path), and nulls photo_url/banner_image on the
// profile row so clients fall back to initials (photo) and the teal
// gradient (banner). A Storage failure is loud (throws → sync-error
// surface), never silently unconfirmed.
//
// Regression coverage (each fails without the change, passes with it):
//   1. X clears the draft (structural: badge exists, visible only when an
//      image is set, onPress nulls the draft field, 44pt target + hitSlop).
//   2. Removal detection: mediaKindsRemoved(prev, next) reports photo /
//      banner / both / neither.
//   3. deleteProfileMedia hits the right bucket+path, throws on failure
//      (loud), tolerates a missing file (idempotent).
//   4. toProfileRow writes explicit nulls for removed kinds (and still
//      omits the keys when there was simply never an upload).
//   5. removeProfileMediaNow: local file deleted, Storage file deleted,
//      upload fingerprint cleared, remote URLs nulled and persisted.
//   6. pushProfileWithMedia converges a removal end to end: Storage delete
//      + row upsert with photo_url null.
//   7. Change-after-clear: with the fingerprint cleared, picking the same
//      image again re-uploads (the new image wins).
//   8. Offline/failure: a Storage delete failure rejects — the removal is
//      surfaced, never swallowed.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  mediaKindsRemoved,
  pushProfileWithMedia,
  readPendingMediaRemovals,
  removeProfileMediaNow,
  toProfileRow,
  writePendingMediaRemovals,
} from '../src/lib/cloudSync';
import { deleteProfileMedia, storagePathFor } from '../src/lib/mediaUpload';
import type { RealtorProfile } from '../src/lib/types';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number; env: Record<string, string> };
const fs = require('fs');
const path = require('path');

function readFromRoot(rel: string): string {
  const roots: string[] = [];
  if (process.env.CTC_REPO_ROOT) roots.push(process.env.CTC_REPO_ROOT);
  roots.push(process.cwd(), __dirname);
  for (const start of roots) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return '';
}

const src = (rel: string): string => {
  const s = readFromRoot(rel);
  assert(s !== '', `located ${rel}`);
  return s;
};

// --- fakes ---------------------------------------------------------------

interface StorageCall {
  bucket: string;
  op: 'remove' | 'upload';
  paths: string[];
}

function mockClient(opts: { removeError?: unknown; upsertRows?: Record<string, unknown>[] } = {}) {
  const storageCalls: StorageCall[] = [];
  const upserted: Record<string, unknown>[][] = [];
  const client = {
    storageCalls,
    upserted,
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          storageCalls.push({ bucket, op: 'remove', paths });
          if (opts.removeError !== undefined) return { error: opts.removeError };
          return { error: null };
        },
        upload: async (p: string, body: unknown, options: Record<string, unknown>) => {
          storageCalls.push({ bucket, op: 'upload', paths: [p] });
          return { error: null };
        },
        getPublicUrl: (p: string) => ({
          data: { publicUrl: `https://cdn.test/realtor-media/${p}` },
        }),
      }),
    },
    from: (_table: string) => ({
      upsert: (rows: Record<string, unknown>[], _opts: unknown) => ({
        select: async (_col: string) => {
          upserted.push(rows);
          if (opts.upsertRows !== undefined) return { data: opts.upsertRows, error: null };
          return { data: rows.map((r) => ({ id: r.user_id })), error: null };
        },
      }),
    }),
  };
  return client;
}

function baseProfile(over: Partial<RealtorProfile> = {}): RealtorProfile {
  return {
    name: 'Maya Chen',
    photoUri: null,
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    about: '',
    yearsExperience: '',
    email: '',
    areasServed: '',
    phone: '',
    dreLicense: '',
    realty_group: '',
    banner_image: null,
    reviews: [],
    rating: null,
    ...over,
  };
}

// --- tests ---------------------------------------------------------------

async function main(): Promise<void> {
  // 1. X clears the draft (structural — RN components are not importable).
  const form = src(path.join('src', 'components', 'ProfileForm.tsx'));
  assert(/testID="remove-profile-photo"/.test(form), 'photo X badge exists');
  assert(/testID="remove-banner-image"/.test(form), 'banner X badge exists');
  assert(
    /\{value\.photoUri \? \(\s*<ClearBadge[\s\S]*?testID="remove-profile-photo"/.test(form),
    'photo X is visible only when a photo is set',
  );
  assert(
    /\{value\.banner_image \? \(\s*<ClearBadge[\s\S]*?testID="remove-banner-image"/.test(form),
    'banner X is visible only when a banner is set',
  );
  assert(
    /onPress=\{\(\) => onChange\(\{ photoUri: null \}\)\}/.test(form),
    'photo X clears the draft photo (no confirmation — Save commits)',
  );
  assert(
    /onPress=\{\(\) => onChange\(\{ banner_image: null \}\)\}/.test(form),
    'banner X clears the draft banner (no confirmation — Save commits)',
  );
  assert(
    /clearBadge: \{[\s\S]*?width: 44,[\s\S]*?height: 44,/.test(form),
    'the X badge is its own 44pt tap target',
  );
  assert(/hitSlop=\{8\}/.test(form), 'the X badge has hitSlop so it never mis-fires with the image tap');
  assert(
    /accessibilityLabel="Remove profile photo"/.test(form) &&
      /accessibilityLabel="Remove banner image"/.test(form),
    'the X badges are labelled for accessibility',
  );
  // The image tap itself is untouched: still opens the picker.
  assert(
    /accessibilityLabel=\{value\.photoUri \? 'Change profile photo' : 'Add profile photo'\}[\s\S]*?onPress=\{pickPhoto\}/.test(form),
    'tapping the photo still opens the picker (change flow untouched)',
  );

  // 2. Removal detection.
  const withPhoto = baseProfile({ photoUri: 'file:///p.jpg', photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1' });
  const cleared = baseProfile();
  assert(
    JSON.stringify(mediaKindsRemoved(withPhoto, cleared)) === JSON.stringify(['photo']),
    'photo cleared -> ["photo"]',
  );
  const withBanner = baseProfile({ banner_image: 'file:///b.jpg', bannerRemoteUrl: 'https://cdn/x/banner.jpg?v=1' });
  assert(
    JSON.stringify(mediaKindsRemoved(withBanner, cleared)) === JSON.stringify(['banner']),
    'banner cleared -> ["banner"]',
  );
  const withBoth = baseProfile({
    photoUri: 'file:///p.jpg',
    photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1',
    banner_image: 'file:///b.jpg',
    bannerRemoteUrl: 'https://cdn/x/banner.jpg?v=1',
  });
  assert(
    JSON.stringify(mediaKindsRemoved(withBoth, cleared)) === JSON.stringify(['photo', 'banner']),
    'both cleared -> ["photo","banner"]',
  );
  assert(
    mediaKindsRemoved(withPhoto, withPhoto).length === 0,
    'unchanged image is not a removal',
  );
  assert(
    mediaKindsRemoved(null, cleared).length === 0,
    'no previous profile -> no removal',
  );
  // Remote-URL-as-photoUri (fresh device pull) still counts as "had".
  const remoteOnly = baseProfile({ photoUri: 'https://cdn/x/photo.jpg?v=1', photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1' });
  assert(
    JSON.stringify(mediaKindsRemoved(remoteOnly, cleared)) === JSON.stringify(['photo']),
    'remote-URL photo cleared -> ["photo"]',
  );
  // A new pick after a clear is a replace, not a removal.
  const repicked = baseProfile({ photoUri: 'file:///p2.jpg', photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1' });
  assert(
    mediaKindsRemoved(withPhoto, repicked).length === 0,
    'clear-then-pick before save = replace, not removal',
  );

  // 3. The Storage delete path.
  const delClient = mockClient();
  await deleteProfileMedia(delClient, 'uid-1', 'photo');
  assert(
    delClient.storageCalls.length === 1 &&
      delClient.storageCalls[0].bucket === 'realtor-media' &&
      delClient.storageCalls[0].paths[0] === storagePathFor('uid-1', 'photo'),
    'delete hits the realtor-media bucket at <uid>/photo.jpg',
  );
  await deleteProfileMedia(delClient, 'uid-1', 'banner');
  assert(
    delClient.storageCalls[1].paths[0] === 'uid-1/banner.jpg',
    'delete hits <uid>/banner.jpg for the banner',
  );
  // Loud failure: a Storage error throws (the caller surfaces it).
  const failClient = mockClient({ removeError: { message: 'network down' } });
  let threw = false;
  try {
    await deleteProfileMedia(failClient, 'uid-1', 'photo');
  } catch {
    threw = true;
  }
  assert(threw, 'a Storage delete failure throws — never silently unconfirmed');
  // Idempotent: a missing file is already deleted, not a failure.
  const goneClient = mockClient({ removeError: { message: 'Not found' } });
  threw = false;
  try {
    await deleteProfileMedia(goneClient, 'uid-1', 'photo');
  } catch {
    threw = true;
  }
  assert(!threw, 'a missing Storage file does not throw (removal is idempotent)');

  // 4. toProfileRow: explicit nulls for removed kinds.
  const removedRow = toProfileRow('uid-1', cleared, ['photo']);
  assert(removedRow.photo_url === null, 'removed photo -> explicit photo_url null');
  assert(!('banner_image' in removedRow), 'non-removed banner key still omitted when never uploaded');
  const removedBoth = toProfileRow('uid-1', cleared, ['photo', 'banner']);
  assert(removedBoth.banner_image === null, 'removed banner -> explicit banner_image null');
  const neverHad = toProfileRow('uid-1', cleared, []);
  assert(!('photo_url' in neverHad), 'no removal -> photo_url omitted (server value kept)');

  // 5. removeProfileMediaNow: local + Storage + fingerprint + URL nulls.
  const kv = memoryKV();
  await kv.setItem('ctc:media-uploaded', JSON.stringify({ photo: 'data:9:123', banner: 'data:9:456' }));
  const localDeleted: string[] = [];
  const rClient = mockClient();
  const saved: RealtorProfile[] = [];
  const out = await removeProfileMediaNow(
    rClient,
    'uid-1',
    kv,
    ['photo'],
    async (next) => {
      saved.push(next);
    },
    withPhoto,
    async (kind) => {
      localDeleted.push(kind);
    },
  );
  assert(localDeleted[0] === 'photo', 'the local managed photo file is deleted');
  assert(
    rClient.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/photo.jpg'),
    'the Storage photo file is deleted',
  );
  const fps = JSON.parse((await kv.getItem('ctc:media-uploaded')) ?? '{}');
  assert(!('photo' in fps) && fps.banner === 'data:9:456', 'the photo upload fingerprint is cleared (banner kept)');
  assert(out.photoRemoteUrl === null, 'the returned profile nulls photoRemoteUrl');
  assert(saved.length === 1 && saved[0].photoRemoteUrl === null, 'the nulled profile is persisted');
  assert(out.bannerRemoteUrl === 'https://cdn/x/photo.jpg?v=1' || out.bannerRemoteUrl === withPhoto.bannerRemoteUrl, 'non-removed banner URL untouched');

  // 6. pushProfileWithMedia converges a removal end to end.
  const kv2 = memoryKV();
  const e2e = mockClient();
  const saved2: RealtorProfile[] = [];
  await pushProfileWithMedia(e2e, 'uid-1', kv2, cleared, async (n) => { saved2.push(n); }, ['photo'], async () => {});
  assert(
    e2e.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/photo.jpg'),
    'end to end: the Storage file is deleted',
  );
  assert(e2e.upserted.length === 1, 'end to end: the profile row is upserted');
  assert(e2e.upserted[0][0].photo_url === null, 'end to end: the row nulls photo_url');
  assert(
    (await readPendingMediaRemovals(kv2)).length === 0,
    'end to end: pending removal flags clear after convergence',
  );

  // Pending flags survive for the outbox/boot retry paths.
  const kv3 = memoryKV();
  await writePendingMediaRemovals(kv3, ['banner']);
  const e3 = mockClient();
  await pushProfileWithMedia(e3, 'uid-1', kv3, cleared, async () => {}, [], async () => {});
  assert(
    e3.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/banner.jpg'),
    'a pending removal flag re-runs the Storage delete on retry',
  );
  assert(e3.upserted[0][0].banner_image === null, 'a pending removal flag re-nulls the URL on retry');

  // 7. Change-after-clear: the same image re-picked re-uploads.
  const kv4 = memoryKV();
  const e4 = mockClient();
  const DATA_URI = 'data:image/jpeg;base64,AQIDBA==';
  // Simulate: removal cleared the fingerprint, then the realtor re-picks
  // the identical image before saving.
  await removeProfileMediaNow(e4, 'uid-1', kv4, ['photo'], async () => {}, withPhoto, async () => {});
  const repick = baseProfile({ photoUri: DATA_URI });
  const saved4: RealtorProfile[] = [];
  await pushProfileWithMedia(e4, 'uid-1', kv4, repick, async (n) => { saved4.push(n); }, [], async () => {});
  assert(
    e4.storageCalls.some((c) => c.op === 'upload' && c.paths[0] === 'uid-1/photo.jpg'),
    're-picking after a clear re-uploads the image',
  );
  assert(
    typeof saved4[saved4.length - 1]?.photoRemoteUrl === 'string' &&
      (saved4[saved4.length - 1]?.photoRemoteUrl as string).includes('?v='),
    'the re-upload stamps a fresh versioned URL',
  );

  // 8. Offline/failure is loud: the removal rejects, never swallowed.
  const kv5 = memoryKV();
  const e5 = mockClient({ removeError: { message: 'network down' } });
  let rejected = false;
  try {
    await pushProfileWithMedia(e5, 'uid-1', kv5, cleared, async () => {}, ['photo'], async () => {});
  } catch {
    rejected = true;
  }
  assert(rejected, 'a failed Storage delete rejects — the bgPush records a sync error (loud)');
  assert(e5.upserted.length === 0, 'a failed removal does not upsert a half-removed row');

  summary('profile_media_removal');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
