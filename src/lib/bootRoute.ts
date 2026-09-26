// Clear to Close — launch routing (approved onboarding/auth, spec §4).
//
// Pure, unit-testable: given the stored onboarding role, the persisted
// session user (native only; web never restores a session), and the stored
// device client link, decide where the app should open.

import type { DeviceClientLink, RealtorProfile } from './types';

export interface BootInput {
  /** Role chosen on the role picker ('realtor' | 'client'), or null. */
  role: 'realtor' | 'client' | null;
  /** Persisted Supabase session user id, or null. Web is always null. */
  sessionUserId: string | null;
  /** Device client link from a previous client redeem, or null. */
  clientLink: DeviceClientLink | null;
  /** True once a realtor account has been created on this device. */
  hasAccount: boolean;
  isWeb: boolean;
}

/**
 * Resolve the launch destination href.
 * Client-link validity (regenerated/revoked) is checked AFTER this returns
 * the client href — callers must run validateClientLink and send dead links
 * to '/link-dead' before rendering the escrow.
 */
export function resolveBootHref(input: BootInput): string {
  if (input.clientLink) {
    const l = input.clientLink;
    return `/client/${l.role}/${l.escrowId}`;
  }
  if (input.sessionUserId) {
    return '/';
  }
  if (input.role === 'realtor') {
    // Web never restores a session: the realtor signs in every visit.
    // Native with a lapsed session: an existing account goes to login,
    // a never-completed sign-up goes back to sign-up.
    if (input.isWeb) return '/login';
    return input.hasAccount ? '/login' : '/signup';
  }
  if (input.role === 'client') {
    return '/redeem';
  }
  return '/role';
}

export interface PostAuthInput {
  /** Live Supabase session user id after sign-up/login. */
  sessionUserId: string | null;
  /** The realtor's local profile, if completed. */
  profile: RealtorProfile | null;
  /** True when profile creation was explicitly skipped during onboarding. */
  skipped: boolean;
}

/**
 * Where a realtor lands right after sign-up/login succeeds (and on fresh
 * boot with a live session): the deal list, unless this is a mid-onboarding
 * account — a live session with no profile at all and no explicit skip
 * resumes at profile creation (step 2) instead of silently dropping it.
 *
 * Profile existence, not name completeness, drives this decision: a profile
 * row with a NULL/empty name but other saved fields is still an existing
 * profile (its fields hydrate the form and the client view) and goes to the
 * deal list. Only a genuinely new account — no profile row, or a row with
 * no saved fields at all (pullProfileNow maps both to null) — enters
 * profile creation.
 */
export function resolvePostAuthHref(input: PostAuthInput): string {
  if (input.sessionUserId && !input.profile && !input.skipped) {
    return '/profile-create';
  }
  return '/';
}

/**
 * The deal-list "Complete your profile" nudge appears only when profile
 * creation was explicitly skipped during sign-up — never merely because no
 * local profile row exists yet (approved mockup ㉔).
 */
export function shouldShowProfileNudge(input: { skipped: boolean }): boolean {
  return input.skipped;
}
