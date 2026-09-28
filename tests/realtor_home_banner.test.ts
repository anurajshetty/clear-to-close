// realtor_home_banner.test.ts — REGRESSION: the realtor home screen's
// banner section (approved sample v3, Anuraj, Sept 2026).
//
// The change (surgical): a full-bleed banner section sits at the very top
// of the realtor home screen, above the existing header — the realtor's
// synced banner, cover-cropped (118px strip, same geometry as the client
// top card), with the brand-teal gradient fallback when no banner is
// uploaded. The photo sits on the banner's right side (88px, right 18,
// 3px white ring) and opens the profile page exactly as the old header
// avatar did; the small avatar is gone from the header row so there is
// only one photo. Everything below (kicker, title, count line, + New
// escrow, sections, deal cards) is untouched.
//
// The strip is the shared BannerStrip component (src/components/
// BannerStrip.tsx, built once and reused by the client top card and the
// realtor home screen): the realtor header is a pixel-exact preview of
// what clients see and the two can never drift.
//
// The banner sits BELOW the safe-area gap from the header-top-gap release
// (that fix's regression test in tests/header_top_gap.test.ts must still
// pass): the gap view (insets.top + 14) comes before the banner.
import { assert, summary } from './assert';

declare const require: any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('app', 'index.tsx');
  const starts: string[] = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir: string = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const up: string = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('repo root not found');
}

const ROOT = findRepoRoot();
assert(ROOT !== '', 'could not locate the repo root (app/index.tsx)');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const home = read('app/index.tsx');
const strip = read('src/components/BannerStrip.tsx');

// The home screen renders the shared banner strip.
assert(
  home.includes("from '../src/components/BannerStrip'"),
  'home imports BannerStrip from the shared component',
);
assert(home.includes('<BannerStrip'), 'home renders the shared BannerStrip');

// The banner sits BELOW the safe-area gap: the gap view (insets.top + 14)
// comes before the BannerStrip in the render order.
const gapAt = home.indexOf('insets.top + 14');
const stripAt = home.indexOf('<BannerStrip');
assert(gapAt !== -1, 'home keeps the insets.top + 14 safe-area gap');
assert(stripAt !== -1, 'home renders BannerStrip');
assert(gapAt < stripAt, 'safe-area gap renders above the banner (banner never crowds the status bar)');

// Full-bleed: the banner wrap breaks out of the content's 18px padding.
assert(home.includes('bannerWrap'), 'home has a bannerWrap style');
assert(home.includes('marginHorizontal: -18'), 'banner breaks out of the content padding edge to edge');

// Sample geometry (Anuraj's approved v3): 118px strip, 88px photo at
// right 18, 3px white ring — the large-class topCard tokens.
assert(home.includes('TOPCARD_TOKENS.large.banner'), 'strip height comes from the large topCard tokens');
assert(home.includes('TOPCARD_TOKENS.large.photo'), 'photo size comes from the large topCard tokens');
assert(home.includes('TOPCARD_TOKENS.large.photoRight'), 'photo right offset comes from the large topCard tokens');
assert(home.includes('TOPCARD_TOKENS.large.photoBorder'), 'photo ring width comes from the large topCard tokens');

// Synced media: the same banner + photo URIs the client card uses.
assert(home.includes('displayBannerUri(profile)'), 'banner URI is the realtor\'s synced banner');
assert(home.includes('displayPhotoUri(profile)'), 'photo URI is the realtor\'s synced photo');

// Tapping the photo opens the profile page exactly as the old header
// avatar did — no behavior change.
assert(
  home.includes("onPhotoPress={() => router.push('/profile-update')}"),
  'banner photo routes to /profile-update on tap',
);

// The small avatar is gone from the header row — the photo now lives on
// the banner, so there is only one photo.
assert(!home.includes('avatarBtn'), 'header avatar button removed');
assert(!home.includes('styles.avatar'), 'header avatar styles removed');

// Everything below the banner is untouched: the kicker, the "Escrows"
// title, and the count line render exactly as before.
assert(home.includes('Hi ${firstName}'), '"Hi {name}" kicker unchanged');
assert(home.includes('>Escrows</Text>'), '"Escrows" title unchanged');
assert(home.includes('styles.count'), 'count line unchanged');
assert(home.includes('"+ New escrow"'), '"+ New escrow" button unchanged');

// The shared strip: banner cover-cropped, teal gradient fallback when no
// banner, white-ringed photo on the right, vertically centered.
assert(strip.includes('resizeMode="cover"'), 'shared strip: banner is cover-cropped');
assert(strip.includes('TealGradientFallback'), 'shared strip: brand-teal gradient fallback defined');
assert(strip.includes('borderColor: \'#FFFFFF\''), 'shared strip: photo has a white ring');
assert(strip.includes("top: '50%'"), 'shared strip: photo vertically centered on the strip');

summary('realtor_home_banner');
