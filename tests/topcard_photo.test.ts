// topcard_photo.test.ts — REGRESSION: synced realtor photo on the client
// home top card (Anuraj, Sept 2026).
//
// The synced photo (Supabase Storage URL in photoRemoteUrl) showed on the
// redeem welcome/celebration screens but the client home top card rendered
// empty photo circles. Two causes, both covered here:
//
//  1. The top card read `photoUri` only. The display selector must prefer
//     the synced remote URL and fall back to the device-local file when no
//     remote URL exists (offline / pre-sync profiles).
//  2. The buyer/seller/tc screens raced two independent profile fetches —
//     the fast local getProfile() (null on client devices) could resolve
//     after getLinkedProfile() and wipe the linked profile. The screens now
//     use the single linked-first getClientProfile() call (the same pattern
//     the celebration screen uses); that contract is asserted against the
//     synced store below.
//
// The React component itself is not unit-rendered (RN components are not
// importable in the node suite); the pure selector is covered here.
import { assert, summary } from './assert';
import { displayBannerUri, displayPhotoUri } from '../src/lib/profile';

const REMOTE = 'https://xyz.supabase.co/storage/v1/object/public/realtor-media/uid/photo.jpg';
const LOCAL = 'file:///data/user/0/app/photo.jpg';
const REMOTE_BANNER = 'https://xyz.supabase.co/storage/v1/object/public/realtor-media/uid/banner.jpg';
const LOCAL_BANNER = 'file:///data/user/0/app/banner.jpg';

const base = {
  photoUri: null as string | null,
  photoRemoteUrl: null as string | null,
  banner_image: null as string | null,
  bannerRemoteUrl: null as string | null,
};

// Photo: remote wins when both exist (the synced photo is the source of
// truth on client devices).
assert(
  displayPhotoUri({ ...base, photoUri: LOCAL, photoRemoteUrl: REMOTE }) === REMOTE,
  'photo prefers the synced remote URL when both exist',
);
// Photo: falls back to the local file when no remote URL (offline/pre-sync).
assert(
  displayPhotoUri({ ...base, photoUri: LOCAL, photoRemoteUrl: null }) === LOCAL,
  'photo falls back to the local file when remote is absent',
);
// Photo: remote alone (client device after a fresh cloud pull).
assert(
  displayPhotoUri({ ...base, photoUri: null, photoRemoteUrl: REMOTE }) === REMOTE,
  'photo works with remote URL only',
);
// Photo: null profile and no-photo profile render initials, never crash.
assert(displayPhotoUri(null) === null, 'photo null profile -> null');
assert(
  displayPhotoUri({ ...base }) === null,
  'photo with neither source -> null',
);

// Banner: same remote-first contract.
assert(
  displayBannerUri({ ...base, banner_image: LOCAL_BANNER, bannerRemoteUrl: REMOTE_BANNER }) ===
    REMOTE_BANNER,
  'banner prefers the synced remote URL when both exist',
);
assert(
  displayBannerUri({ ...base, banner_image: LOCAL_BANNER, bannerRemoteUrl: null }) ===
    LOCAL_BANNER,
  'banner falls back to the local file when remote is absent',
);
assert(displayBannerUri(null) === null, 'banner null profile -> null');
assert(displayBannerUri({ ...base }) === null, 'banner with neither source -> null');
// Banner: whitespace-only values count as absent.
assert(
  displayBannerUri({ ...base, banner_image: '   ', bannerRemoteUrl: null }) === null,
  'banner blank local value -> null',
);

summary('topcard_photo');
