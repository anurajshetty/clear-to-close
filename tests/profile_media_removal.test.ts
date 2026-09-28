// profile_media_removal.test.ts — profile/banner image removal under the
// SYNCHRONOUS write model (Anuraj, Sept 28, 2026).
//
// Removal is part of the confirmed profile write: the preview applies the
// nulls locally only AFTER the server confirms (Storage delete + row
// upsert). Failure (Storage error, row rejection, offline, timeout) throws
// and leaves local state byte-identical — the old bgPush "outbox retry"
// behavior is gone.
//
// Regression coverage (each fails without the change, passes with it):
//   1. X badge still clears the draft (structural — RN not importable).
//   2. mediaKindsRemoved detection (unchanged from the old suite).
//   3. deleteProfileMedia: right bucket+path, throws on failure, tolerates
//      a missing file (idempotent).
//   4. toProfileRow: explicit nulls for removed kinds, omits never-uploaded.
//   5. removeProfileMediaNow (phase 1) is DRAFT-ONLY: no persistence, no
//      Storage delete, no fingerprint clear. It captures the old remote URLs
//      and nulls the draft's URLs in place; the row upsert carries the nulls
//      and the Storage delete happens only after the row confirms.
//   5b. deleteRemovedMediaFiles (phase 2): deletes by the path parsed from
//      each kind's old URL (unique per-upload paths), falling back to the
//      legacy fixed path; then clears the fingerprints. Loud on failure.
//   6. pushProfileWithMedia converges a removal end to end with row-first
//      ordering: the profile row upserts BEFORE any Storage delete, so a
//      row failure can never delete a file the confirmed row still
//      references.
//   7. ensureProfileMedia THROWS on upload failure (was silently
//      unconfirmed) — a failed upload never produces a URL.
//   8. Re-pick after clear re-uploads (the fingerprint was cleared in
//      phase 2, so the re-pick cannot point the row at the deleted file).
//   9. Fingerprint persistence: the upload fingerprint is marked only after
//      the profile ROW confirms. If the row upsert fails after a successful
//      upload, the fingerprint is NOT marked, so the next save re-uploads
//      instead of trusting a URL the row may never have stored.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  deleteRemovedMediaFiles,
  ensureProfileMedia,
  mediaKindsRemoved,
  pushProfileWithMedia,
  removeProfileMediaNow,
  toProfileRow,
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

function mockClient(opts: {
  removeError?: unknown;
  uploadError?: unknown;
  rowError?: unknown;
  upsertRows?: Record<string, unknown>[];
} = {}) {
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
        upload: async (p: string, _body: unknown, _options: Record<string, unknown>) => {
          storageCalls.push({ bucket, op: 'upload', paths: [p] });
          if (opts.uploadError !== undefined) return { error: opts.uploadError };
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
          if (opts.rowError !== undefined) return { data: null, error: opts.rowError };
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
    /onPress=\{\(\) => onChange\(\{ photoUri: null \}\)\}/.test(form),
    'photo X clears the draft photo (no confirmation — Save commits)',
  );
  assert(
    /onPress=\{\(\) => onChange\(\{ banner_image: null \}\)\}/.test(form),
    'banner X clears the draft banner (no confirmation — Save commits)',
  );
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
  assert(mediaKindsRemoved(withPhoto, withPhoto).length === 0, 'unchanged image is not a removal');
  assert(mediaKindsRemoved(null, cleared).length === 0, 'no previous profile -> no removal');
  const remoteOnly = baseProfile({ photoUri: 'https://cdn/x/photo.jpg?v=1', photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1' });
  assert(
    JSON.stringify(mediaKindsRemoved(remoteOnly, cleared)) === JSON.stringify(['photo']),
    'remote-URL photo cleared -> ["photo"]',
  );
  const repicked = baseProfile({ photoUri: 'file:///p2.jpg', photoRemoteUrl: 'https://cdn/x/photo.jpg?v=1' });
  assert(mediaKindsRemoved(withPhoto, repicked).length === 0, 'clear-then-pick before save = replace, not removal');

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
  assert(delClient.storageCalls[1].paths[0] === 'uid-1/banner.jpg', 'delete hits <uid>/banner.jpg for the banner');
  const failClient = mockClient({ removeError: { message: 'network down' } });
  let threw = false;
  try {
    await deleteProfileMedia(failClient, 'uid-1', 'photo');
  } catch {
    threw = true;
  }
  assert(threw, 'a Storage delete failure throws — never silently unconfirmed');
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

  // 5. removeProfileMediaNow (phase 1): DRAFT-ONLY mutation — no
  //    persistence, no Storage delete, no fingerprint clear. The Storage
  //    delete waits for row confirmation; local file cleanup happens after
  //    the write commits (owned by the caller).
  const kv = memoryKV();
  await kv.setItem('ctc:media-uploaded', JSON.stringify({ photo: 'data:9:123', banner: 'data:9:456' }));
  const rClient = mockClient();
  const draft = { ...withPhoto };
  const { oldUrls } = await removeProfileMediaNow(rClient, 'uid-1', kv, ['photo'], draft);
  assert(
    rClient.storageCalls.length === 0,
    'phase 1 performs no Storage calls — the delete waits for row confirmation',
  );
  assert(oldUrls.photo === withPhoto.photoRemoteUrl, 'phase 1 captures the old remote URL for the later delete');
  const fps = JSON.parse((await kv.getItem('ctc:media-uploaded')) ?? '{}');
  assert('photo' in fps, 'phase 1 does not clear the upload fingerprint yet');
  assert(draft.photoRemoteUrl === null, 'the draft profile nulls photoRemoteUrl in place');
  assert(draft.bannerRemoteUrl === withPhoto.bannerRemoteUrl, 'non-removed banner URL untouched');

  // 5b. deleteRemovedMediaFiles (phase 2): after the row confirmed.
  await deleteRemovedMediaFiles(rClient, 'uid-1', kv, ['photo'], oldUrls);
  assert(
    rClient.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/photo.jpg'),
    'phase 2 deletes the legacy fixed-path file when the old URL is not bucket-parseable',
  );
  const fps2 = JSON.parse((await kv.getItem('ctc:media-uploaded')) ?? '{}');
  assert(!('photo' in fps2) && fps2.banner === 'data:9:456', 'the photo upload fingerprint is cleared (banner kept)');
  // A unique-path old URL deletes by its parsed path, not the fixed path.
  const rClient2 = mockClient();
  const uniqueDraft = { ...withPhoto, photoRemoteUrl: 'https://cdn.test/realtor-media/uid-1/photo-abc123.jpg' };
  const { oldUrls: oldUrls2 } = await removeProfileMediaNow(rClient2, 'uid-1', kv, ['photo'], uniqueDraft);
  await deleteRemovedMediaFiles(rClient2, 'uid-1', kv, ['photo'], oldUrls2);
  assert(
    rClient2.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/photo-abc123.jpg'),
    'phase 2 deletes the unique-path file parsed from the old URL',
  );
  // Phase 2 is loud: a delete failure throws.
  const rFail = mockClient({ removeError: { message: 'network down' } });
  let phase2Threw = false;
  try {
    await deleteRemovedMediaFiles(rFail, 'uid-1', kv, ['photo'], oldUrls);
  } catch {
    phase2Threw = true;
  }
  assert(phase2Threw, 'phase 2 delete failure throws — never silently unconfirmed');

  // 6. pushProfileWithMedia converges a removal end to end, row-first: the
  //    profile row upserts BEFORE any Storage delete.
  const kv2 = memoryKV();
  const e2e = mockClient();
  const order: string[] = [];
  const upsertPush = e2e.upserted.push.bind(e2e.upserted);
  e2e.upserted.push = (...a: Record<string, unknown>[][]) => {
    order.push('upsert');
    return upsertPush(...a);
  };
  const e2eStorage = e2e.storage.from('realtor-media');
  (e2e as { storage: { from: (b: string) => unknown } }).storage.from = (_bucket: string) => {
    const inner = e2eStorage as {
      remove: (p: string[]) => Promise<{ error: null }>;
      upload: (p: string, b: unknown, o: unknown) => Promise<{ error: null }>;
      getPublicUrl: (p: string) => { data: { publicUrl: string } };
    };
    return {
      remove: async (p: string[]) => {
        order.push('remove');
        return inner.remove(p);
      },
      upload: inner.upload.bind(inner),
      getPublicUrl: inner.getPublicUrl.bind(inner),
    };
  };
  const removalDraft = { ...cleared };
  await pushProfileWithMedia(e2e, 'uid-1', kv2, removalDraft, ['photo']);
  assert(e2e.upserted.length === 1, 'end to end: the profile row is upserted');
  assert(e2e.upserted[0][0].photo_url === null, 'end to end: the row nulls photo_url');
  assert(
    e2e.storageCalls.some((c) => c.op === 'remove' && c.paths[0] === 'uid-1/photo.jpg'),
    'end to end: the Storage file is deleted after the row confirmed',
  );
  assert(
    JSON.stringify(order) === JSON.stringify(['upsert', 'remove']),
    'end to end: the row upserts BEFORE the Storage delete',
  );
  // Row failure: the Storage file must NOT be deleted.
  const kv2b = memoryKV();
  const e2eFail = mockClient({ rowError: { message: 'row rejected' } });
  let e2eThrew = false;
  try {
    await pushProfileWithMedia(e2eFail, 'uid-1', kv2b, { ...cleared }, ['photo']);
  } catch {
    e2eThrew = true;
  }
  assert(e2eThrew, 'end to end: the row failure rejects');
  assert(
    !e2eFail.storageCalls.some((c) => c.op === 'remove'),
    'end to end: a row failure never deletes the still-referenced file',
  );

  // 7. ensureProfileMedia THROWS on upload failure (was silently
  //    unconfirmed): a failed upload never produces a versioned URL, so the
  //    row can't reference a file that isn't there.
  const kv3 = memoryKV();
  const DATA_URI = 'data:image/jpeg;base64,AQIDBA==';
  const pickDraft = baseProfile({ photoUri: DATA_URI });
  const upFail = mockClient({ uploadError: { message: 'storage down' } });
  let upThrew = false;
  try {
    await ensureProfileMedia(upFail, 'uid-1', kv3, pickDraft);
  } catch {
    upThrew = true;
  }
  assert(upThrew, 'an upload failure throws — the write fails loudly');
  assert(pickDraft.photoRemoteUrl === null, 'a failed upload never stamps a versioned URL');

  // 8. Change-after-clear: the same image re-picked re-uploads. Phase 2
  //    cleared the fingerprint, so the re-pick cannot skip the upload and
  //    point the row at the deleted file.
  const kv4 = memoryKV();
  await kv4.setItem('ctc:media-uploaded', JSON.stringify({ photo: 'data:9:123' }));
  const e4 = mockClient();
  const { oldUrls: old4 } = await removeProfileMediaNow(e4, 'uid-1', kv4, ['photo'], { ...withPhoto });
  await deleteRemovedMediaFiles(e4, 'uid-1', kv4, ['photo'], old4);
  const repickDraft = baseProfile({ photoUri: DATA_URI });
  await ensureProfileMedia(e4, 'uid-1', kv4, repickDraft);
  assert(
    e4.storageCalls.some((c) => c.op === 'upload' && /^uid-1\/photo-[0-9a-z]+\.jpg$/.test(c.paths[0])),
    're-picking after a clear re-uploads the image to a fresh unique path',
  );
  assert(
    typeof repickDraft.photoRemoteUrl === 'string' &&
      /^https:\/\/cdn\.test\/realtor-media\/uid-1\/photo-[0-9a-z]+\.jpg$/.test(repickDraft.photoRemoteUrl),
    'the re-upload stamps a fresh unique-path URL',
  );

  // 9. Fingerprint persistence: the upload fingerprint is marked only after
  //    the profile ROW confirms. A row failure after a successful upload
  //    leaves the fingerprint unmarked, so the next save re-uploads instead
  //    of trusting a URL the row may never have stored.
  const kv5 = memoryKV();
  const e5 = mockClient({ rowError: { message: 'row rejected' } });
  const upDraft = baseProfile({ photoUri: DATA_URI });
  const ens = await ensureProfileMedia(e5, 'uid-1', kv5, upDraft);
  assert(typeof upDraft.photoRemoteUrl === 'string', 'the upload succeeded and stamped a URL');
  let rowThrew = false;
  try {
    await pushProfileWithMedia(e5, 'uid-1', kv5, upDraft, []);
    await kv5.setItem('ctc:media-uploaded', JSON.stringify(ens.fingerprints));
  } catch {
    rowThrew = true;
  }
  assert(rowThrew, 'the row failure rejects');
  const fpsAfter = JSON.parse((await kv5.getItem('ctc:media-uploaded')) ?? '{}');
  assert(!('photo' in fpsAfter), 'the failed row does not persist the photo fingerprint');
  // Next save: the fingerprint is still missing, so the upload re-runs.
  const e6 = mockClient();
  const retryDraft = baseProfile({ photoUri: DATA_URI });
  await ensureProfileMedia(e6, 'uid-1', kv5, retryDraft);
  assert(
    e6.storageCalls.some((c) => c.op === 'upload' && /^uid-1\/photo-[0-9a-z]+\.jpg$/.test(c.paths[0])),
    'the retry re-uploads because the fingerprint was never persisted',
  );
  // A row failure orphans the unreferenced uploads — no live file is
  // ever overwritten, because every upload mints a fresh unique path.
  const uploadPaths = e5.storageCalls.filter((c) => c.op === 'upload').map((c) => c.paths[0]);
  assert(
    uploadPaths.length > 0 &&
      uploadPaths.every((p) => /^uid-1\/photo-[0-9a-z]+\.jpg$/.test(p)),
    'every upload went to a fresh unique path — no live file was overwritten',
  );

  summary('profile_media_removal');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
