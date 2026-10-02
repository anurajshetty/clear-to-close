// Clear to Close — auth + device/session state.
//
// Realtor identity: Supabase Auth email/password. Client identity: a
// device-bound client link (name + code redeem), no account.
//
// Session persistence (Anuraj, Sept 26, 2026 — this REVERSES the Sept 25
// "web = sign-in screen on every return" decision):
//   - native iOS: the Supabase session persists in AsyncStorage — returning
//     realtors go straight into the app, no re-sign-in.
//   - web: the Supabase session persists in localStorage — a refresh keeps
//     the realtor signed in, on the same screen. The session ends ONLY on
//     Log out, or when the browser session ends (in incognito, closing the
//     incognito window wipes localStorage automatically).
//
// The service is created with injectable deps (client factory, KV,
// platform) so the auth edge-case matrix is unit-testable with a scripted
// supabase mock. The default export wires the real deps.

import type { KV } from './store';
import type { ClientRole, DeviceClientLink } from './types';
import { getDefaultKV } from './kv';
import { getSupabaseClient } from './supabase';

export type PlatformKind = 'web' | 'native';

export function detectPlatform(): PlatformKind {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined'
    ? 'web'
    : 'native';
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ------------------------------------------------------------------ errors --

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = String((err as { message?: string } | null)?.message ?? '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('econn')
  );
}

export type SignUpErrorCode =
  | 'duplicate_email'
  | 'weak_password'
  | 'rate_limited'
  | 'network'
  | 'unconfigured'
  | 'email_confirmation_required'
  | 'unknown';

/** Map a Supabase signUp failure onto the app's sign-up error codes. */
export function mapSignUpError(err: unknown): SignUpErrorCode {
  if (isNetworkError(err)) return 'network';
  const e = (err ?? {}) as { message?: string; status?: number; code?: string };
  const msg = String(e.message ?? '');
  if (/already registered|already exists|duplicate/i.test(msg)) return 'duplicate_email';
  // HTTP 429 from GoTrue ("over_email_send_rate_limit"): the project's email
  // quota is exhausted. The account was NOT created — retryable after a wait.
  if (e.status === 429 || e.code === 'over_email_send_rate_limit' || /rate.?limit/i.test(msg))
    return 'rate_limited';
  if (/password/i.test(msg)) return 'weak_password';
  return 'unknown';
}

export type SignInErrorCode =
  | 'invalid_credentials'
  | 'network'
  | 'unconfigured'
  | 'unknown';

/** True when a sign-in failure is Supabase's "Email not confirmed" shape. */
export function isEmailNotConfirmedError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? '');
  return /email not confirmed/i.test(msg);
}

/** Map a Supabase signIn failure onto the app's login error codes. */
export function mapSignInError(err: unknown): SignInErrorCode {
  if (isNetworkError(err)) return 'network';
  const msg = String((err as { message?: string } | null)?.message ?? '');
  if (/invalid login credentials|invalid/i.test(msg)) return 'invalid_credentials';
  return 'unknown';
}

// ------------------------------------------------------------------- types --

// Minimal structural type for the supabase client surface this module uses.
// The real client is `any` (see src/lib/supabase.ts); tests inject a mock.
export interface AuthClientLike {
  auth: {
    signUp(args: {
      email: string;
      password: string;
      options?: { data?: Record<string, string> };
    }): Promise<{ data: { user?: { id?: string } | null; session?: unknown } ; error?: { message?: string; status?: number; code?: string } | null }>;
    signInWithPassword(args: {
      email: string;
      password: string;
    }): Promise<{ data: { user?: { id?: string } | null; session?: unknown }; error?: { message?: string } | null }>;
    resetPasswordForEmail(
      email: string,
    ): Promise<{ data?: unknown; error?: { message?: string } | null }>;
    resend(args: {
      type: 'signup';
      email: string;
    }): Promise<{ data?: unknown; error?: { message?: string; status?: number; code?: string } | null }>;
    setSession?(args: {
      access_token: string;
      refresh_token: string;
    }): Promise<{
      data: { session?: { user?: { id?: string } } | null };
      error?: { message?: string } | null;
    }>;
    signOut(options?: {
      scope?: 'local' | 'global' | 'others';
    }): Promise<{ error?: { message?: string } | null }>;
    getSession(): Promise<{
      data: { session?: { user?: { id?: string; email?: string } } | null };
    }>;
    updateUser(args: {
      password: string;
    }): Promise<{ data?: unknown; error?: { message?: string } | null }>;
    onAuthStateChange(
      cb: (event: string, session: { user?: { id?: string } } | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
  };
}

export interface AuthServiceDeps {
  getClient: () => AuthClientLike | null;
  kv: KV;
  platform: PlatformKind;
}

export type RoleChoice = 'realtor' | 'client';

export type SignUpResult =
  | { ok: true; userId: string | null; existingAccount?: boolean }
  | { ok: false; code: SignUpErrorCode };

export type SignInResult =
  | { ok: true; userId: string | null }
  | { ok: false; code: SignInErrorCode };

export type ResetResult = { ok: true } | { ok: false; code: 'network' | 'unconfigured' };

export type ResendResult =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'network' | 'unconfigured' | 'unknown' };

export type ChangePasswordErrorCode =
  | 'wrong_current'
  | 'weak_password'
  | 'network'
  | 'unconfigured'
  | 'revoke_failed'
  | 'unknown';

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; code: ChangePasswordErrorCode };

export interface PasswordChangeValidation {
  allFilled: boolean;
  newLongEnough: boolean;
  confirmMatches: boolean;
  canSubmit: boolean;
}

export interface PasswordResetValidation {
  newLongEnough: boolean;
  confirmMatches: boolean;
  canSubmit: boolean;
}

/**
 * Client-side validation for the "set new password" recovery screen. Same
 * 8+ rule and confirm-match as change-password, minus the current-password
 * field — the recovery link IS the authentication.
 */
export function validatePasswordReset(
  next: string,
  confirm: string,
): PasswordResetValidation {
  const newLongEnough = next.length >= 8;
  const confirmMatches = confirm === next;
  return {
    newLongEnough,
    confirmMatches,
    canSubmit: next.length > 0 && newLongEnough && confirmMatches,
  };
}

/**
 * Parse a web launch URL for a Supabase recovery payload.
 *
 * Supabase puts recovery params in the URL FRAGMENT
 * (`#access_token=…&refresh_token=…&type=recovery`) and error params when
 * the link is expired/invalid (`#error=…&error_description=…`). The client
 * runs with detectSessionInUrl: false, so the app parses the fragment
 * itself and hands the tokens to consumeRecoverySession.
 *
 * Fragment-only (L9, Oct 2026): query params are deliberately never read.
 * A token in `?query=` would land in server/proxy logs; the fragment never
 * leaves the device.
 */
export type RecoveryLink =
  | { kind: 'recovery'; accessToken: string; refreshToken: string }
  | { kind: 'recovery-error'; errorDescription: string }
  | { kind: 'none' };

export function parseRecoveryLink(rawUrl: string): RecoveryLink {
  let hash = '';
  try {
    // Works for http(s) URLs, scheme URLs (clear-to-close://…), and bare
    // fragments. Bare "#…" strings fail the URL constructor on their own.
    const u = rawUrl.startsWith('#')
      ? new URL(`x://x/${rawUrl}`)
      : new URL(rawUrl, 'x://x');
    hash = u.hash;
  } catch {
    return { kind: 'none' };
  }
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  const fp = new URLSearchParams(frag);
  // L9: fragment-only. The query string is intentionally ignored even when
  // it carries token-shaped params (see docstring above).
  const get = (k: string) => fp.get(k);
  if (get('error') || get('error_code')) {
    return {
      kind: 'recovery-error',
      errorDescription: get('error_description') ?? get('error') ?? '',
    };
  }
  const type = get('type');
  const accessToken = get('access_token');
  const refreshToken = get('refresh_token');
  if (type === 'recovery' && accessToken && refreshToken) {
    return { kind: 'recovery', accessToken, refreshToken };
  }
  return { kind: 'none' };
}

export type RecoveryConsumeResult =
  | { ok: true }
  | { ok: false; code: 'expired' | 'network' | 'unconfigured' | 'unknown' };

export type RecoverySetPasswordErrorCode =
  | 'session_expired'
  | 'weak_password'
  | 'network'
  | 'unconfigured'
  | 'revoke_failed'
  | 'unknown';

export type RecoverySetPasswordResult =
  | { ok: true }
  | { ok: false; code: RecoverySetPasswordErrorCode };

/**
 * Client-side validation for the change-password sheet (approved spec §2.8).
 * The 8+ rule and confirm-match are client-side; the current password is
 * validated by the server (changePassword re-authenticates).
 */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): PasswordChangeValidation {
  const allFilled = current.length > 0 && next.length > 0 && confirm.length > 0;
  const newLongEnough = next.length >= 8;
  const confirmMatches = confirm === next;
  return {
    allFilled,
    newLongEnough,
    confirmMatches,
    canSubmit: allFilled && newLongEnough && confirmMatches,
  };
}

// ------------------------------------------------------------------ service --

const K_DEVICE_ID = 'ctc:deviceid';
const K_ROLE = 'ctc:role';
const K_CLIENT_LINK = 'ctc:clientlink';
/**
 * Multi-escrow link array (Sept 28, 2026, Anuraj-approved): one device
 * holds one LIVE link per escrow. The pre-multi-escrow single link
 * (K_CLIENT_LINK above) is migrated into this array on first read.
 */
const K_CLIENT_LINKS = 'ctc:clientlinks';
const K_PROFILE_SKIPPED = 'ctc:profileskipped';
const K_PENDING_NAME = 'ctc:pendingname';
const K_EXISTING_ACCOUNT_NOTICE = 'ctc:existingaccountnotice';
const K_HAS_ACCOUNT = 'ctc:hasaccount';

export function createAuthService(deps: AuthServiceDeps) {
  const { kv, platform } = deps;

  async function readJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await kv.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async function writeJson(key: string, value: unknown): Promise<void> {
    try {
      await kv.setItem(key, JSON.stringify(value));
    } catch {
      // Device-state writes are best-effort.
    }
  }

  /**
   * F3 (Sept 2026): when a realtor session is established (sign-up or
   * login success), any device client link from an earlier client redeem is
   * stale — resolveBootHref checks the client link FIRST, so it would boot
   * the new realtor session straight into the old client view. The
   * device's client access key dies here; a client re-redeems to restore
   * client access. Best-effort; never throws.
   */
  async function clearStaleClientLink(): Promise<void> {
    try {
      await kv.removeItem(K_CLIENT_LINKS);
      await kv.removeItem(K_CLIENT_LINK);
    } catch {
      // best-effort
    }
  }

  function validLink(l: unknown): l is DeviceClientLink {
    const x = l as DeviceClientLink | null;
    return (
      !!x &&
      typeof x.linkId === 'string' && x.linkId.length > 0 &&
      typeof x.escrowId === 'string' && x.escrowId.length > 0 &&
      typeof x.role === 'string' && x.role.length > 0
    );
  }

  async function readLinks(): Promise<DeviceClientLink[]> {
    const raw = await readJson<DeviceClientLink[]>(K_CLIENT_LINKS);
    if (Array.isArray(raw)) return raw.filter(validLink);
    // One-time upgrade: the pre-multi-escrow single link migrates into
    // the array; the old key is removed after.
    const single = await readJson<DeviceClientLink>(K_CLIENT_LINK);
    if (validLink(single)) {
      await writeJson(K_CLIENT_LINKS, [single]);
      try {
        await kv.removeItem(K_CLIENT_LINK);
      } catch {
        // best-effort
      }
      return [single];
    }
    return [];
  }

  /**
   * M6b (Oct 2026): after any successful password update, revoke every
   * other live session — an attacker holding a stolen refresh token must
   * not survive the reset. Runs client-side via the JWT-bearing session
   * (Anuraj, Oct 1 — no edge function). Returns false when the revocation
   * fails so the caller can surface 'revoke_failed' LOUDLY; the password
   * update already succeeded, so the failure must never be swallowed.
   */
  async function revokeOtherSessions(client: AuthClientLike): Promise<boolean> {
    try {
      const { error } = await client.auth.signOut({ scope: 'others' });
      return !error;
    } catch {
      return false;
    }
  }

  return {
    platform,
    isWeb: () => platform === 'web',

    /** Stable per-device id used to bind client links (0002 device linking). */
    async getDeviceId(): Promise<string> {
      try {
        const existing = await kv.getItem(K_DEVICE_ID);
        if (existing) return existing;
      } catch {
        // fall through and mint one
      }
      const id = uuid();
      try {
        await kv.setItem(K_DEVICE_ID, id);
      } catch {
        // best-effort
      }
      return id;
    },

    // -- role ---------------------------------------------------------------
    async getRole(): Promise<RoleChoice | null> {
      try {
        const raw = await kv.getItem(K_ROLE);
        return raw === 'realtor' || raw === 'client' ? raw : null;
      } catch {
        return null;
      }
    },
    async setRole(role: RoleChoice): Promise<void> {
      try {
        await kv.setItem(K_ROLE, role);
      } catch {
        // best-effort
      }
    },
    async clearRole(): Promise<void> {
      try {
        await kv.removeItem(K_ROLE);
      } catch {
        // best-effort
      }
    },

    // -- has-account flag ---------------------------------------------------
    // True once a realtor account has been created on this device (sign-up
    // or login success). Lets boot routing send a returning native realtor
    // whose session lapsed to /login instead of /signup. Cleared on logout.
    async getHasAccount(): Promise<boolean> {
      try {
        return (await kv.getItem(K_HAS_ACCOUNT)) === '1';
      } catch {
        return false;
      }
    },
    async setHasAccount(v: boolean): Promise<void> {
      try {
        if (v) await kv.setItem(K_HAS_ACCOUNT, '1');
        else await kv.removeItem(K_HAS_ACCOUNT);
      } catch {
        // best-effort
      }
    },

    // -- client links (device access keys, multi-escrow) -----------------------
    //
    // One device holds one live link per escrow. Rows are added by redeem
    // (redeem_invite is the server authority), replaced per-escrow on
    // re-redeem, and removed when the link dies (revoked/regenerated).
    /** Every live device link, oldest-redeemed first. */
    async getClientLinks(): Promise<DeviceClientLink[]> {
      return readLinks();
    },

    /** This device's link for one escrow, or null. */
    async getClientLinkForEscrow(escrowId: string): Promise<DeviceClientLink | null> {
      const links = await readLinks();
      return links.find((l) => l.escrowId === escrowId) ?? null;
    },

    /**
     * Add (or replace, per escrow) a device link. One link per escrow on
     * this device — a re-redeem of the same escrow replaces the old row,
     * never duplicates it.
     */
    async addClientLink(link: DeviceClientLink): Promise<void> {
      if (!validLink(link)) return;
      const links = await readLinks();
      const idx = links.findIndex((l) => l.escrowId === link.escrowId);
      if (idx >= 0) links[idx] = link;
      else links.push(link);
      await writeJson(K_CLIENT_LINKS, links);
    },

    /** Remove one link by its link id (dead-link removal). Returns true when a link was removed. */
    async removeClientLink(linkId: string): Promise<boolean> {
      const links = await readLinks();
      const kept = links.filter((l) => l.linkId !== linkId);
      if (kept.length === links.length) return false;
      await writeJson(K_CLIENT_LINKS, kept);
      return true;
    },

    /** Remove every device link (client "Start over"). */
    async clearClientLink(): Promise<void> {
      try {
        await kv.removeItem(K_CLIENT_LINKS);
        await kv.removeItem(K_CLIENT_LINK);
      } catch {
        // best-effort
      }
    },

    // -- onboarding profile-skipped flag --------------------------------------
    async getProfileSkipped(): Promise<boolean> {
      try {
        return (await kv.getItem(K_PROFILE_SKIPPED)) === '1';
      } catch {
        return false;
      }
    },
    async setProfileSkipped(skipped: boolean): Promise<void> {
      try {
        if (skipped) await kv.setItem(K_PROFILE_SKIPPED, '1');
        else await kv.removeItem(K_PROFILE_SKIPPED);
      } catch {
        // best-effort
      }
    },

    /**
     * One-time handoff of the sign-up full name into profile creation
     * (step 2). takePendingProfileName consumes it.
     */
    async setPendingProfileName(name: string): Promise<void> {
      try {
        await kv.setItem(K_PENDING_NAME, name);
      } catch {
        // best-effort
      }
    },
    async takePendingProfileName(): Promise<string | null> {
      try {
        const v = await kv.getItem(K_PENDING_NAME);
        await kv.removeItem(K_PENDING_NAME);
        return v && v.trim() ? v : null;
      } catch {
        return null;
      }
    },

    /**
     * One-time "we've signed you in" notice for the signup fallback path
     * (existing email + correct password). Set by the signup screen when
     * the signUp result carries existingAccount; takeExistingAccountNotice
     * consumes it so profile-create shows the banner exactly once.
     */
    async setExistingAccountNotice(): Promise<void> {
      try {
        await kv.setItem(K_EXISTING_ACCOUNT_NOTICE, '1');
      } catch {
        // best-effort
      }
    },
    async takeExistingAccountNotice(): Promise<boolean> {
      try {
        const v = await kv.getItem(K_EXISTING_ACCOUNT_NOTICE);
        await kv.removeItem(K_EXISTING_ACCOUNT_NOTICE);
        return v === '1';
      } catch {
        return false;
      }
    },

    // -- realtor session ------------------------------------------------------
    async getSessionUserId(): Promise<string | null> {
      const client = deps.getClient();
      if (!client) return null;
      try {
        const { data } = await client.auth.getSession();
        return data?.session?.user?.id ?? null;
      } catch {
        return null;
      }
    },

    onAuthStateChange(
      cb: (event: string, session: { user?: { id?: string } } | null) => void,
    ): (() => void) | null {
      const client = deps.getClient();
      if (!client) return null;
      try {
        const { data } = client.auth.onAuthStateChange(cb);
        return () => {
          try {
            data.subscription.unsubscribe();
          } catch {
            // ignore
          }
        };
      } catch {
        return null;
      }
    },

    /**
     * Create the realtor account (sign-up step 1). Never throws: every
     * failure maps to a SignUpErrorCode. Retry-safe: a network failure
     * leaves no local state behind (no phantom account).
     */
    async signUp(name: string, email: string, password: string): Promise<SignUpResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { name: name.trim() } },
        });
        if (error) return { ok: false, code: mapSignUpError(error) };
        if (data?.session) {
          // F3 (Sept 2026): a device client link from an earlier client
          // redeem would make resolveBootHref open the old client view on
          // next launch — a realtor session kills the device's client key.
          await clearStaleClientLink();
          return { ok: true, userId: data.user?.id ?? null };
        }
        // No session: the project may require email confirmation. Try an
        // immediate sign-in (works when confirmation is disabled); if that
        // fails, surface a clear, non-dead-end error.
        try {
          const again = await client.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (!again.error && again.data?.session) {
            await clearStaleClientLink();
            // Fallback sign-in succeeded: this is an EXISTING account, not
            // a new signup. Flag it so the UI can say so explicitly instead
            // of silently logging the user in.
            return { ok: true, userId: again.data.user?.id ?? null, existingAccount: true };
          }
          // Supabase hides email enumeration on signup: an existing email
          // returns a fake success with no session. If the fallback sign-in
          // then fails with "Invalid login credentials", the account exists
          // and the password was wrong — surface duplicate_email, which the
          // signup screen renders with a login path.
          if (mapSignInError(again.error) === 'invalid_credentials') {
            return { ok: false, code: 'duplicate_email' };
          }
          // Only an explicit "Email not confirmed" earns the inbox nudge.
          // Anything unrecognized fails loud-generic (auditor hardening,
          // Oct 2, 2026) — never "check your inbox" on a guess.
          if (isEmailNotConfirmedError(again.error)) {
            return { ok: false, code: 'email_confirmation_required' };
          }
        } catch (e) {
          // A network failure here is a connectivity problem, not a
          // confirmation requirement — label it so the UI offers a retry.
          if (isNetworkError(e)) return { ok: false, code: 'network' };
          // A thrown invalid-credentials error carries the same signal.
          if (mapSignInError(e) === 'invalid_credentials') {
            return { ok: false, code: 'duplicate_email' };
          }
          if (isEmailNotConfirmedError(e)) {
            return { ok: false, code: 'email_confirmation_required' };
          }
          // fall through to the generic error
        }
        return { ok: false, code: 'unknown' };
      } catch (e) {
        return { ok: false, code: mapSignUpError(e) };
      }
    },

    /** Email + password login. Never throws. */
    async signIn(email: string, password: string): Promise<SignInResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        const { data, error } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) return { ok: false, code: mapSignInError(error) };
        // F3 (Sept 2026): see clearStaleClientLink — a realtor session
        // kills the device's client access key.
        await clearStaleClientLink();
        return { ok: true, userId: data?.user?.id ?? null };
      } catch (e) {
        return { ok: false, code: mapSignInError(e) };
      }
    },

    /**
     * Password reset. Anti-enumeration: any non-network outcome (including
     * "unknown email") resolves ok — the UI always shows the same
     * confirmation copy. Only a network failure surfaces a retry error.
     *
     * Recovery is web-only: the emailed link opens in the browser (the
     * Supabase dashboard Site URL), so no redirectTo is needed.
     */
    async sendPasswordReset(email: string): Promise<ResetResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        const { error } = await client.auth.resetPasswordForEmail(email.trim());
        if (error && isNetworkError(error)) return { ok: false, code: 'network' };
        return { ok: true };
      } catch (e) {
        return isNetworkError(e) ? { ok: false, code: 'network' } : { ok: true };
      }
    },

    /**
     * Resend the signup confirmation email ("Didn't get the email?
     * Resend" on the check-inbox card). Never throws. Rate-limit errors
     * map to 'rate_limited' so the UI shows the "too many attempts" copy
     * instead of inviting re-taps that burn the resend budget.
     */
    async resendConfirmation(email: string): Promise<ResendResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        const { error } = await client.auth.resend({ type: 'signup', email: email.trim() });
        if (!error) return { ok: true };
        if (isNetworkError(error)) return { ok: false, code: 'network' };
        const e = error as { status?: number; code?: string; message?: string };
        if (e.status === 429 || e.code === 'over_email_send_rate_limit' || /rate.?limit/i.test(String(e.message ?? ''))) {
          return { ok: false, code: 'rate_limited' };
        }
        return { ok: false, code: 'unknown' };
      } catch (e) {
        if (isNetworkError(e)) return { ok: false, code: 'network' };
        return { ok: false, code: 'unknown' };
      }
    },

    /**
     * Establish the recovery session parsed out of a recovery link
     * (see parseRecoveryLink). The link's access/refresh tokens become a
     * live Supabase session, which lets the user set a new password
     * without knowing the old one. Never throws.
     *
     * An expired/used link surfaces 'expired' so the screen can offer a
     * fresh link instead of a dead-end error.
     */
    async consumeRecoverySession(
      accessToken: string,
      refreshToken: string,
    ): Promise<RecoveryConsumeResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      if (typeof client.auth.setSession !== 'function')
        return { ok: false, code: 'unknown' };
      try {
        const { data, error } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          if (isNetworkError(error)) return { ok: false, code: 'network' };
          const msg = String(error.message ?? '').toLowerCase();
          if (/expir|invalid|token|revok/i.test(msg))
            return { ok: false, code: 'expired' };
          return { ok: false, code: 'unknown' };
        }
        if (!data?.session) return { ok: false, code: 'expired' };
        return { ok: true };
      } catch (e) {
        return { ok: false, code: isNetworkError(e) ? 'network' : 'unknown' };
      }
    },

    /**
     * Set the new password from inside a recovery session (the recovery
     * link IS the authentication — no current password). Never throws.
     * A lapsed recovery session maps to 'session_expired' so the screen
     * can route to the fresh-link path.
     */
    async setPasswordFromRecovery(
      newPassword: string,
    ): Promise<RecoverySetPasswordResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        const { error } = await client.auth.updateUser({
          password: newPassword,
        });
        if (!error) {
          // M6b: password changed — kill every other session now. LOUD if
          // revocation fails; the password is already changed at this point.
          if (!(await revokeOtherSessions(client)))
            return { ok: false, code: 'revoke_failed' };
          return { ok: true };
        }
        if (isNetworkError(error)) return { ok: false, code: 'network' };
        const msg = String(error.message ?? '').toLowerCase();
        if (/session|jwt|token|expir|invalid/i.test(msg))
          return { ok: false, code: 'session_expired' };
        if (/password/i.test(msg)) return { ok: false, code: 'weak_password' };
        return { ok: false, code: 'unknown' };
      } catch (e) {
        return { ok: false, code: isNetworkError(e) ? 'network' : 'unknown' };
      }
    },

    /**
     * Change the realtor's password (approved spec §2.8). Never throws.
     *
     * GoTrue has no verify-password endpoint, so the current password is
     * validated server-side by re-authenticating with it first: a rejected
     * re-auth maps to 'wrong_current'. Only then is the new password set via
     * the authenticated updateUser flow.
     */
    async changePassword(
      currentPassword: string,
      newPassword: string,
    ): Promise<ChangePasswordResult> {
      const client = deps.getClient();
      if (!client) return { ok: false, code: 'unconfigured' };
      try {
        let email: string | null = null;
        try {
          const { data } = await client.auth.getSession();
          email = data?.session?.user?.email ?? null;
        } catch {
          // fall through to the unknown error below
        }
        if (!email) return { ok: false, code: 'unknown' };
        const { error: signInError } = await client.auth.signInWithPassword({
          email,
          password: currentPassword,
        });
        if (signInError) {
          if (isNetworkError(signInError)) return { ok: false, code: 'network' };
          return { ok: false, code: 'wrong_current' };
        }
        const { error: updateError } = await client.auth.updateUser({
          password: newPassword,
        });
        if (updateError) {
          if (isNetworkError(updateError)) return { ok: false, code: 'network' };
          if (/password/i.test(String(updateError.message ?? '')))
            return { ok: false, code: 'weak_password' };
          return { ok: false, code: 'unknown' };
        }
        // M6b: password changed — kill every other session now. LOUD if
        // revocation fails; the password is already changed at this point.
        if (!(await revokeOtherSessions(client)))
          return { ok: false, code: 'revoke_failed' };
        return { ok: true };
      } catch (e) {
        return { ok: false, code: isNetworkError(e) ? 'network' : 'unknown' };
      }
    },

    /**
     * Sign out: clears the Supabase session and any onboarding leftovers
     * that could leak into another account's flow. Never throws.
     *
     * The remembered device role (ctc:role) and the has-account flag stay:
     * the role picker promises "you only see this once", and the boot
     * router sends a signed-out realtor (role remembered, no session)
     * straight to the login screen — after sign-out clears the persisted
     * session. Clearing the role would instead
     * funnel a logged-out realtor back through the role picker into
     * sign-up, breaking "protected routes redirect to login".
     */
    async signOut(): Promise<void> {
      const client = deps.getClient();
      if (client) {
        try {
          await client.auth.signOut();
        } catch {
          // best-effort; local state is cleared below regardless
        }
      }
      try {
        // A different realtor may use this device next: never leak the
        // previous account's onboarding state into their session.
        await kv.removeItem(K_PROFILE_SKIPPED);
        await kv.removeItem(K_PENDING_NAME);
        // F1 (Sept 2026): the sync outbox belongs to the previous account.
        // drainOutbox stamps the CURRENT session's uid onto each row before
        // upserting, so lingering ops would push A's rows into B's account
        // with RLS (auth.uid() = user_id) passing. Drop them here too —
        // the store's clearLocalAccountData clears the outbox first, and
        // this is the identity-boundary backstop. NEVER drain before
        // clearing: draining under the outgoing identity is exactly the
        // leak. (Literal key: cloudSync's K_OUTBOX; cloudSync imports auth,
        // so auth can't import it back.)
        await kv.removeItem('ctc:outbox');
        // F3 (Sept 2026): resolveBootHref checks the device client link
        // FIRST, ahead of the realtor login — a stale link would boot the
        // signed-out device straight into the old client view.
        await kv.removeItem(K_CLIENT_LINK);
        // H4 (Oct 2026): signOut cleared only the legacy single-link key —
        // the live multi-link array survived a realtor logout, so a stale
        // client link could still boot the next user into a client view.
        await kv.removeItem(K_CLIENT_LINKS);
      } catch {
        // never throw from sign-out cleanup
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClient: any | undefined;

export function getAuthClient(): AuthClientLike | null {
  if (cachedClient !== undefined) return cachedClient as AuthClientLike | null;
  const kind = detectPlatform() === 'web' ? 'web' : 'native';
  cachedClient = getSupabaseClient(kind);
  return cachedClient as AuthClientLike | null;
}

/** The default service wired to the real Supabase client, KV, and platform. */
export const auth: ReturnType<typeof createAuthService> = createAuthService({
  getClient: getAuthClient,
  kv: getDefaultKV(),
  platform: detectPlatform(),
});

// ---------------------------------------------------------------------------
// Sign-out expectation flag: the profile-update screen sets it before its own
// signOut() so the root layout's SIGNED_OUT listener doesn't mistake a
// deliberate logout for mid-session expiry.
let expectSignOut = false;

/** Mark the next SIGNED_OUT event as a deliberate logout. */
export function setExpectSignOut(v: boolean): void {
  expectSignOut = v;
}

/** Consume the sign-out expectation flag (one-shot). */
export function takeExpectSignOut(): boolean {
  const v = expectSignOut;
  expectSignOut = false;
  return v;
}
