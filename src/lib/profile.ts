// Clear to Close — realtor branding line (Sept 2026).
//
// The branded subline shown under the realtor's name on client surfaces,
// per the approved branding mockups: "Maya Sharma / Compass Realty ·
// DRE #01998877". The name is already the headline on every surface that
// uses this helper, so only the brokerage / DRE portion is produced here.
// Returns null when there is nothing to show — never a dangling separator.
import type { RealtorProfile } from './types';

export function realtorSubline(
  p: Pick<RealtorProfile, 'realty_group' | 'dreLicense'>,
): string | null {
  const realty = p.realty_group.trim();
  const dre = p.dreLicense.trim();
  if (realty && dre) return `${realty} · DRE #${dre}`;
  if (realty) return realty;
  if (dre) return `DRE #${dre}`;
  return null;
}

/**
 * Display photo for client surfaces (Sept 2026): prefer the synced Supabase
 * Storage URL (`photoRemoteUrl`, set on profile save); the device-local
 * managed file (`photoUri`) is the fallback for offline / pre-sync
 * profiles. REGRESSION: the client home top card read `photoUri` only and
 * raced the local profile fetch, so the synced photo showed on the redeem
 * welcome/celebration screens but not on the top card.
 */
export function displayPhotoUri(
  p: Pick<RealtorProfile, 'photoUri' | 'photoRemoteUrl'> | null,
): string | null {
  return p?.photoRemoteUrl ?? p?.photoUri ?? null;
}

/**
 * Display banner for client surfaces (Sept 2026): same remote-first
 * contract as displayPhotoUri. Returns null when neither source is set.
 */
export function displayBannerUri(
  p: Pick<RealtorProfile, 'banner_image' | 'bannerRemoteUrl'> | null,
): string | null {
  const u = (p?.bannerRemoteUrl ?? p?.banner_image ?? '').trim();
  return u || null;
}
