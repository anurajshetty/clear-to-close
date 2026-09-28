// media_upload.test.ts — realtor photo/banner upload to Supabase Storage
// (Sept 2026, Anuraj-approved): profile saves upload the managed photo/banner
// to the public `realtor-media` bucket so client devices can see them.
//
// Regression coverage (each fails without the change, passes with it):
//   1. storagePathFor: <userId>/photo.jpg and <userId>/banner.jpg — the
//      legacy fixed paths (kept as the delete fallback for pre-change files).
//   2. uploadProfileMedia success: uploads bytes with contentType image/jpeg
//      to a UNIQUE per-upload path (<uid>/photo-<id>.jpg, never over the
//      live file), then returns that path's public URL (unique URLs replace
//      the old ?v= cache-buster; client stale-photo fix, Sept 2026).
//   7. versionedPublicUrl appends the numeric ?v= param (legacy helper,
//      kept for the pre-change rows that still carry versioned URLs); a
//      second upload yields a different unique path/URL, busting the
//      client's cache. Device-local fallbacks (displayPhotoUri/
//      displayBannerUri with no remote URL) never carry the param.
//   8. storagePathFromUrl parses the bucket object path back out of a
//      stored public URL (unique-path and legacy fixed-path forms).
import { assert, summary } from './assert';
import {
  base64ToBytes,
  publicUrlFor,
  readImageBytes,
  stagedUploadPath,
  storagePathFor,
  storagePathFromUrl,
  uploadProfileMedia,
  versionedPublicUrl,
} from '../src/lib/mediaUpload';
import { displayBannerUri, displayPhotoUri } from '../src/lib/profile';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

interface UploadCall {
  bucket: string;
  path: string;
  options: Record<string, unknown>;
  byteLength: number | undefined;
}

function mockClient(opts: { uploadError?: unknown; publicUrl?: string | null } = {}) {
  const calls: UploadCall[] = [];
  const client = {
    calls,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: unknown, options: Record<string, unknown>) => {
          calls.push({
            bucket,
            path,
            options,
            byteLength: (body as { length?: number } | null)?.length,
          });
          if (opts.uploadError !== undefined) return { error: opts.uploadError };
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: {
            publicUrl:
              opts.publicUrl === undefined
                ? `https://cdn.test/${bucket}/${path}`
                : opts.publicUrl,
          },
        }),
      }),
    },
  };
  return client;
}

// data: URI for bytes [1, 2, 3, 4] — tiny but real JPEG-ish payload.
const DATA_URI = 'data:image/jpeg;base64,AQIDBA==';

async function main(): Promise<void> {
  // 1. path convention
  assert(storagePathFor('uid-1', 'photo') === 'uid-1/photo.jpg', 'photo path is <uid>/photo.jpg');
  assert(storagePathFor('uid-1', 'banner') === 'uid-1/banner.jpg', 'banner path is <uid>/banner.jpg');

  // 2. happy path (web data: URI): unique per-upload path, never the live file
  const okClient = mockClient();
  const url = await uploadProfileMedia(okClient, 'uid-1', 'photo', DATA_URI);
  const photoPathRe = /^uid-1\/photo-[0-9a-z]+\.jpg$/;
  assert(
    url !== null &&
      url.startsWith('https://cdn.test/realtor-media/') &&
      photoPathRe.test(url.slice('https://cdn.test/realtor-media/'.length)),
    'successful upload returns the unique-path public URL (no ?v= needed)',
  );
  assert(okClient.calls.length === 1, 'exactly one storage upload attempted');
  assert(okClient.calls[0].bucket === 'realtor-media', 'uploads go to the realtor-media bucket');
  assert(
    photoPathRe.test(okClient.calls[0].path) && okClient.calls[0].path !== 'uid-1/photo.jpg',
    'upload uses a unique per-upload path, never overwriting the live file',
  );
  assert(okClient.calls[0].options.contentType === 'image/jpeg', 'upload sets image/jpeg content type');
  assert(okClient.calls[0].options.upsert === false, 'upload does not upsert (unique path)');
  assert((okClient.calls[0].byteLength ?? 0) > 0, 'upload sends the image bytes');
  // The returned URL is the uploaded path's public URL.
  assert(
    url === `https://cdn.test/realtor-media/${okClient.calls[0].path}`,
    'returned URL is the uploaded path public URL',
  );

  const bannerClient = mockClient();
  const bannerUrl = await uploadProfileMedia(bannerClient, 'uid-1', 'banner', DATA_URI);
  assert(
    bannerUrl !== null &&
      /^https:\/\/cdn\.test\/realtor-media\/uid-1\/banner-[0-9a-z]+\.jpg$/.test(bannerUrl),
    'banner uploads to a unique <uid>/banner-<id>.jpg path',
  );
  assert(
    okClient.calls[0].path !== bannerClient.calls[0].path,
    'two uploads mint different paths (stale-cache fix via uniqueness)',
  );

  // native path with an injected reader (expo-file-system is app-only)
  const nativeClient = mockClient();
  const nativeUrl = await uploadProfileMedia(
    nativeClient,
    'uid-1',
    'photo',
    'file:///Documents/profile-photo.jpg',
    async () => 'AQIDBA==',
  );
  assert(
    nativeUrl !== null &&
      /^https:\/\/cdn\.test\/realtor-media\/uid-1\/photo-[0-9a-z]+\.jpg$/.test(nativeUrl),
    'native upload reads via the injected base64 reader and returns the unique-path URL',
  );

  // stagedUploadPath shape (unit): unique per call, kind-prefixed.
  const sp1 = stagedUploadPath('uid-1', 'photo');
  const sp2 = stagedUploadPath('uid-1', 'photo');
  assert(
    photoPathRe.test(sp1) && photoPathRe.test(sp2) && sp1 !== sp2,
    'stagedUploadPath mints a distinct unique path per call',
  );
  assert(
    /^uid-1\/banner-[0-9a-z]+\.jpg$/.test(stagedUploadPath('uid-1', 'banner')),
    'stagedUploadPath kind prefix follows the kind',
  );

  // 8. storagePathFromUrl: parse the object path back out of stored URLs.
  assert(
    storagePathFromUrl('https://cdn.test/realtor-media/uid-1/photo-abc123.jpg') ===
      'uid-1/photo-abc123.jpg',
    'storagePathFromUrl parses a unique-path URL',
  );
  assert(
    storagePathFromUrl('https://proj.supabase.co/storage/v1/object/public/realtor-media/uid-1/banner-xyz.jpg') ===
      'uid-1/banner-xyz.jpg',
    'storagePathFromUrl parses a production-shaped URL',
  );
  assert(
    storagePathFromUrl('https://cdn.test/realtor-media/uid-1/photo.jpg?v=111') ===
      'uid-1/photo.jpg',
    'storagePathFromUrl parses a legacy fixed-path URL and strips the ?v= param',
  );
  assert(storagePathFromUrl(null) === null, 'storagePathFromUrl null-safe');
  assert(storagePathFromUrl('https://cdn.test/other-bucket/uid-1/photo.jpg') === null, 'storagePathFromUrl rejects non-bucket URLs');
  assert(storagePathFromUrl('not a url') === null, 'storagePathFromUrl rejects garbage');

  // 3. quiet failure modes — all return null, never throw
  const nullClient = mockClient();
  assert(
    (await uploadProfileMedia(nullClient, 'uid-1', 'photo', null)) === null,
    'null localUri returns null without uploading',
  );
  assert(nullClient.calls.length === 0, 'no upload attempted when there is no local image');

  const errClient = mockClient({ uploadError: { message: 'row-level security' } });
  assert(
    (await uploadProfileMedia(errClient, 'uid-1', 'photo', DATA_URI)) === null,
    'storage upload error returns null (stays local-only)',
  );

  const badReadClient = mockClient();
  assert(
    (await uploadProfileMedia(
      badReadClient,
      'uid-1',
      'photo',
      'file:///Documents/profile-photo.jpg',
      async () => null,
    )) === null,
    'unreadable native file returns null',
  );
  assert(badReadClient.calls.length === 0, 'no upload attempted when bytes are unreadable');

  assert(
    (await uploadProfileMedia(mockClient(), '', 'photo', DATA_URI)) === null,
    'missing userId returns null',
  );

  // 4. base64 decode
  const bytes = base64ToBytes('AQIDBA==');
  assert(
    bytes.length === 4 && bytes[0] === 1 && bytes[1] === 2 && bytes[2] === 3 && bytes[3] === 4,
    'base64ToBytes decodes correctly',
  );

  // 5. web data: URI read
  const webBytes = await readImageBytes(DATA_URI);
  assert(
    webBytes !== null && webBytes.length === 4 && webBytes[0] === 1,
    'readImageBytes resolves a web data: URI to bytes',
  );
  assert(
    (await readImageBytes('data:image/jpeg;base64,!!!')) === null,
    'readImageBytes returns null for a corrupt data: URI',
  );

  // 6. publicUrlFor (stays clean — versioning lives in versionedPublicUrl)
  assert(
    publicUrlFor(mockClient(), 'uid-1', 'photo') ===
      'https://cdn.test/realtor-media/uid-1/photo.jpg',
    'publicUrlFor returns the bucket public URL',
  );
  assert(publicUrlFor(mockClient({ publicUrl: null }), 'uid-1', 'photo') === null, 'publicUrlFor null-safe');

  // 7. cache-bust versioning (legacy helper: new uploads mint unique paths
  //    instead of ?v=, but pre-change rows still carry versioned URLs and
  //    every surface must render the stored URL verbatim).
  const vClient = mockClient();
  const v1 = versionedPublicUrl(vClient, 'uid-1', 'photo', () => 1000);
  assert(
    v1 === 'https://cdn.test/realtor-media/uid-1/photo.jpg?v=1000',
    'versionedPublicUrl appends ?v=<upload timestamp>',
  );
  const v2 = versionedPublicUrl(vClient, 'uid-1', 'photo', () => 2000);
  assert(v1 !== v2, 'a fresh upload yields a different URL — the client cache is busted');
  assert(
    versionedPublicUrl(mockClient({ publicUrl: null }), 'uid-1', 'photo') === null,
    'versionedPublicUrl null-safe',
  );
  // The stored remote URL carries the version param through the display
  // helpers, so every client surface (top-card banner strip + banner photo,
  // in-app realtor profile, celebration photo/footer) renders the fresh URL.
  const profileWithRemote = {
    photoUri: 'file:///Documents/photo.jpg',
    photoRemoteUrl: v1,
    banner_image: 'file:///Documents/banner.jpg',
    bannerRemoteUrl: 'https://cdn.test/realtor-media/uid-1/banner.jpg?v=2000',
  };
  assert(
    displayPhotoUri(profileWithRemote) === v1,
    'client surfaces render the versioned photo URL',
  );
  assert(
    displayBannerUri(profileWithRemote) === 'https://cdn.test/realtor-media/uid-1/banner.jpg?v=2000',
    'client surfaces render the versioned banner URL',
  );
  // Device-local fallback carries no version param.
  assert(
    displayPhotoUri({ photoUri: 'file:///Documents/photo.jpg', photoRemoteUrl: null }) ===
      'file:///Documents/photo.jpg',
    'local fallback photo has no version param',
  );
  assert(
    displayBannerUri({ banner_image: 'file:///Documents/banner.jpg', bannerRemoteUrl: null }) ===
      'file:///Documents/banner.jpg',
    'local fallback banner has no version param',
  );

  summary('media_upload');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
