// Clear to Close — external review links (Oct 2026, Anuraj).
//
// The realtor saves optional Google / realtor.com review links on the
// profile-update screen. After the escrow closes (canLeaveReview gate), the
// client home shows a compact card with the logo buttons; tapping a logo
// opens the link in the external browser.
import { canLeaveReview } from './clientView';
import type { ClientView, RealtorProfile } from './types';

/**
 * True when a review-link field is acceptable: empty/whitespace-only (the
 * field is optional) or a parseable URL with the http: or https: protocol.
 */
export function isValidReviewLink(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when the links have at least one non-empty link. */
export function hasReviewLinks(
  profile: Pick<RealtorProfile, 'googleReviewLink' | 'realtorComReviewLink'> | null,
): boolean {
  if (!profile) return false;
  return profile.googleReviewLink.trim().length > 0 || profile.realtorComReviewLink.trim().length > 0;
}

/**
 * The review-links card shows on the client home only when the escrow is
 * reviewable (100% complete, not cancelled — same gate as the triumph
 * section) AND the realtor set at least one review link.
 */
export function shouldShowReviewLinksCard(
  view: Pick<ClientView, 'done' | 'total' | 'status'>,
  profile: Pick<RealtorProfile, 'googleReviewLink' | 'realtorComReviewLink'> | null,
): boolean {
  return canLeaveReview(view) && hasReviewLinks(profile);
}

/** The (logo, url) pairs to render — one per set link, Google first. */
export function reviewLinkTargets(
  profile: Pick<RealtorProfile, 'googleReviewLink' | 'realtorComReviewLink'>,
): Array<{ key: 'google' | 'realtorCom'; url: string }> {
  const targets: Array<{ key: 'google' | 'realtorCom'; url: string }> = [];
  if (profile.googleReviewLink.trim().length > 0) {
    targets.push({ key: 'google', url: profile.googleReviewLink.trim() });
  }
  if (profile.realtorComReviewLink.trim().length > 0) {
    targets.push({ key: 'realtorCom', url: profile.realtorComReviewLink.trim() });
  }
  return targets;
}
