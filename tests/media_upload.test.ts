// media_upload.test.ts — realtor photo/banner upload to Supabase Storage
// (Sept 2026, Anuraj-approved): profile saves upload the managed photo/banner
// to the public `realtor-media` bucket so client devices can see them.
//
// Regression coverage (each fails without the change, passes with it):
//   1. storagePathFor: <userId>/photo.jpg and <userId>/banner.jpg — the
//      single-overwrite path convention (contractual with migration 0014).
//   2. uploadProfileMedia success: uploads bytes with contentType image/jpeg
//      + upsert, then returns the bucket's public URL.
//   3. uploadProfileMedia failure modes are quiet: null localUri, upload
//      error, and unreadable bytes all return null (profile stays
//      local-only, exactly the old behavior) — never throws.
//   4. base64ToBytes round-trips (native read path decode).
//   5. readImageBytes resolves a web data: URI to bytes.
//   6. publicUrlFor returns the bucket public URL, null when unavailable.
import { assert, summary } from './assert';
import {
  base64ToBytes,
  publicUrlFor,
  readImageBytes,
  storagePathFor,
  uploadProfileMedia,
} from '../src/lib/mediaUpload';

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

  // 2. happy path (web data: URI)
  const okClient = mockClient();
  const url = await uploadProfileMedia(okClient, 'uid-1', 'photo', DATA_URI);
  assert(
    url === 'https://cdn.test/realtor-media/uid-1/photo.jpg',
    'successful upload returns the bucket public URL',
  );
  assert(okClient.calls.length === 1, 'exactly one storage upload attempted');
  assert(okClient.calls[0].bucket === 'realtor-media', 'uploads go to the realtor-media bucket');
  assert(okClient.calls[0].path === 'uid-1/photo.jpg', 'upload uses the single-overwrite path');
  assert(okClient.calls[0].options.contentType === 'image/jpeg', 'upload sets image/jpeg content type');
  assert(okClient.calls[0].options.upsert === true, 'upload upserts (single overwrite file)');
  assert((okClient.calls[0].byteLength ?? 0) > 0, 'upload sends the image bytes');

  const bannerClient = mockClient();
  const bannerUrl = await uploadProfileMedia(bannerClient, 'uid-1', 'banner', DATA_URI);
  assert(
    bannerUrl === 'https://cdn.test/realtor-media/uid-1/banner.jpg',
    'banner uploads to <uid>/banner.jpg',
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
    nativeUrl === 'https://cdn.test/realtor-media/uid-1/photo.jpg',
    'native upload reads via the injected base64 reader',
  );

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

  // 6. publicUrlFor
  assert(
    publicUrlFor(mockClient(), 'uid-1', 'photo') ===
      'https://cdn.test/realtor-media/uid-1/photo.jpg',
    'publicUrlFor returns the bucket public URL',
  );
  assert(publicUrlFor(mockClient({ publicUrl: null }), 'uid-1', 'photo') === null, 'publicUrlFor null-safe');

  summary('media_upload');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
