// realtygroup.test.ts — "Realty group" field + banner image on the realtor
// profile (Sept 2026).
//
// Regression coverage: both optional fields must round-trip through every
// profile path, and the branded subline must never render a dangling
// separator. Each case fails without the change and passes with it.
//   1. toProfileRow maps realty_group -> realty_group and banner_image ->
//      banner_image (cloud upsert); device-local data:/blob: captures never
//      sync for either image (same rule as the photo).
//   2. fromProfileRow maps both back; '' / null for legacy rows.
//   3. mapClientViewRpc maps both from the get_client_view payload (this is
//      how a client device receives the realtor's profile).
//   4. Local store backfills '' (realty) / null (banner) for profiles saved
//      before the fields existed.
//   5. realtorSubline: "Realty · DRE #n" / realty only / DRE only / null —
//      never a dangling "·" or "DRE #" with an empty part.
// Field names are contractual (another agent reads realty_group and
// banner_image by name).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { fromProfileRow, mapClientViewRpc, toProfileRow } from '../src/lib/cloudSync';
import { realtorSubline } from '../src/lib/profile';
import type { RealtorProfile } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

function fullProfile(): RealtorProfile {
  return {
    name: 'Maya Sharma',
    realty_group: 'Compass Realty',
    photoUri: null,
    photoRemoteUrl: null,
    bannerRemoteUrl: null,
    banner_image: 'file:///Documents/profile-banner.jpg',
    about: 'About Maya',
    yearsExperience: '9',
    avgDaysToClose: '21',
    areasServed: 'Santa Clarita',
    phone: '555-0100',
    dreLicense: '01998877',
    reviews: [],
    rating: null,
  };
}

async function main(): Promise<void> {
  // 1. cloud upsert mapping — Storage URLs sync; local-only files never sync.
  const REMOTE_BANNER = 'https://xyz.supabase.co/storage/v1/object/public/realtor-media/uid-1/banner.jpg';
  const REMOTE_PHOTO = 'https://xyz.supabase.co/storage/v1/object/public/realtor-media/uid-1/photo.jpg';
  const row = toProfileRow('uid-1', { ...fullProfile(), bannerRemoteUrl: REMOTE_BANNER, photoRemoteUrl: REMOTE_PHOTO });
  assert(row.realty_group === 'Compass Realty', 'toProfileRow maps realty_group -> realty_group');
  assert(
    row.banner_image === REMOTE_BANNER,
    'toProfileRow maps banner_image -> remote Storage URL',
  );
  assert(row.photo_url === REMOTE_PHOTO, 'toProfileRow maps photo_url -> remote Storage URL');
  assert(toProfileRow('uid-1', null).realty_group === null, 'null profile maps realty_group to null');
  assert(toProfileRow('uid-1', null).banner_image === null, 'null profile maps banner_image to null');
  assert(toProfileRow('uid-1', null).photo_url === null, 'null profile maps photo_url to null');
  // No successful upload yet (local file://, web data:, blob:, or null): the
  // keys are OMITTED so the upsert keeps the server value — an offline edit
  // must never wipe a previously uploaded image.
  const localOnly = toProfileRow('uid-1', fullProfile());
  assert(!('banner_image' in localOnly), 'local-only banner omits banner_image (server value kept)');
  assert(!('photo_url' in localOnly), 'local-only photo omits photo_url (server value kept)');
  const webOnly = toProfileRow('uid-1', { ...fullProfile(), banner_image: 'data:image/jpeg;base64,AAA' });
  assert(!('banner_image' in webOnly), 'data: banner never syncs (key omitted)');
  const blobOnly = toProfileRow('uid-1', { ...fullProfile(), banner_image: 'blob:https://x/1' });
  assert(!('banner_image' in blobOnly), 'blob: banner never syncs (key omitted)');

  // 2. cloud pull mapping (legacy rows predate the columns)
  const pulled = fromProfileRow({ ...row, realty_group: 'Compass Realty' });
  assert(pulled.realty_group === 'Compass Realty', 'fromProfileRow maps realty_group -> realty_group');
  assert(
    pulled.bannerRemoteUrl === REMOTE_BANNER,
    'fromProfileRow maps an http(s) banner_image -> bannerRemoteUrl',
  );
  assert(
    pulled.photoRemoteUrl === REMOTE_PHOTO,
    'fromProfileRow maps an http(s) photo_url -> photoRemoteUrl',
  );
  const legacy = fromProfileRow({ name: 'Old' });
  assert(legacy.realty_group === '', 'legacy row without realty_group -> empty string');
  assert(legacy.banner_image === null, 'legacy row without banner_image -> null');
  assert(legacy.photoRemoteUrl === null, 'legacy row without photo_url -> null photoRemoteUrl');
  assert(legacy.bannerRemoteUrl === null, 'legacy row without banner_image -> null bannerRemoteUrl');
  assert(
    fromProfileRow({ banner_image: 'blob:https://x/1' }).banner_image === null,
    'blob: banner treated as absent',
  );
  const legacyFile = fromProfileRow({ photo_url: 'file:///Documents/profile-photo.jpg' });
  assert(
    legacyFile.photoRemoteUrl === null,
    'legacy file:// photo_url is not a remote URL',
  );

  // 3. get_client_view RPC mapping
  const rpc = mapClientViewRpc({
    ok: true,
    escrow: { id: 'e1', address: '1 Main', city: 'SCV', close_date: '2026-11-24' },
    buyer_steps: [],
    profile: {
      name: 'Maya Sharma',
      photo_url: null,
      about: '',
      years_experience: '',
      deals_closed: '',
      areas_served: '',
      phone: '',
      dre_license: '01998877',
      realty_group: 'Compass Realty',
      banner_image: 'file:///Documents/profile-banner.jpg',
    },
  });
  assert(
    rpc.ok === true && !!rpc.profile && rpc.profile.realty_group === 'Compass Realty',
    'get_client_view profile maps realty_group',
  );
  assert(
    rpc.ok === true && !!rpc.profile && rpc.profile.banner_image === 'file:///Documents/profile-banner.jpg',
    'get_client_view profile maps banner_image',
  );
  assert(
    rpc.ok === true && !!rpc.profile && !('dealsClosed' in rpc.profile),
    'deals_closed never surfaces on the client profile',
  );

  // 4. local backfill for profiles saved before the fields existed
  const kv = memoryKV();
  const legacyLocal = {
    name: 'Maya Sharma',
    photoUri: null,
    about: '',
    yearsExperience: '',
    dealsClosed: '',
    areasServed: '',
    phone: '',
    dreLicense: '01998877',
  };
  await kv.setItem('ctc:profile', JSON.stringify(legacyLocal));
  const store = createStore(kv);
  const p = await store.getProfile();
  assert(p !== null && p.realty_group === '', 'local legacy profile backfills realty_group to empty');
  assert(p !== null && p.banner_image === null, 'local legacy profile backfills banner_image to null');
  assert(p !== null && p.photoRemoteUrl === null, 'local legacy profile backfills photoRemoteUrl to null');
  assert(p !== null && p.bannerRemoteUrl === null, 'local legacy profile backfills bannerRemoteUrl to null');
  assert(p !== null && p.avgDaysToClose === '', 'local legacy profile backfills avgDaysToClose to empty');
  assert(
    p !== null && Array.isArray(p.reviews) && p.reviews.length === 0,
    'local legacy profile backfills reviews to []',
  );
  assert(p !== null && p.rating === null, 'local legacy profile backfills rating to null');
  assert(p !== null && !('dealsClosed' in p), 'local legacy profile drops the dealsClosed key');

  // 5. branded subline — no dangling separators
  const both = realtorSubline({ realty_group: 'Compass Realty', dreLicense: '01998877' });
  assert(both === 'Compass Realty · DRE #01998877', 'subline: realty + DRE');
  assert(
    realtorSubline({ realty_group: 'Compass Realty', dreLicense: '' }) === 'Compass Realty',
    'subline: realty only, no dangling separator',
  );
  assert(
    realtorSubline({ realty_group: '', dreLicense: '01998877' }) === 'DRE #01998877',
    'subline: DRE only, no dangling separator',
  );
  assert(
    realtorSubline({ realty_group: '  ', dreLicense: '  ' }) === null,
    'subline: nothing entered -> null (no line at all)',
  );

  // 6. No realtor-profile city field (removed Sept 2026): the profile must
  //    not carry a city key, and the separate areasServed concept stays.
  assert(!('city' in fullProfile()), 'RealtorProfile carries no city key');
  assert(!('city' in fromProfileRow({ city: 'SCV' })), 'cloud row city is not picked up');
  assert(fullProfile().areasServed === 'Santa Clarita', 'areasServed remains intact');

  summary('realtygroup');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
