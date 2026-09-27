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
