// Clear to Close — auth + device/session state.
//
// Realtor identity: Supabase Auth email/password. Client identity: a
// device-bound client link (name + code redeem), no account.
//
// Session persistence is platform-differentiated (approved spec §4):
//   - native iOS: the supabase session persists (AsyncStorage) — returning
//     realtors go straight into the deal list, no re-sign-in.
//   - web: in-memory session only — returning realtors see the email +
//     password sign-in screen on every visit, no auto-login.
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
    signOut(): Promise<{ error?: { message?: string } | null }>;
    getSession(): Promise<{
      data: { session?: { user?: { id?: string } } | null };
    }>;
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
  | { ok: true; userId: string | null }
  | { ok: false; code: SignUpErrorCode };

export type SignInResult =
  | { ok: true; userId: string | null }
  | { ok: false; code: SignInErrorCode };

export type ResetResult = { ok: true } | { ok: false; code: 'network' | 'unconfigured' };

// ------------------------------------------------------------------ service --

const K_DEVICE_ID = 'ctc:deviceid';
const K_ROLE = 'ctc:role';
const K_CLIENT_LINK = 'ctc:clientlink';
const K_PROFILE_SKIPPED = 'ctc:profileskipped';
const K_PENDING_NAME = 'ctc:pendingname';
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

    // -- client link (device access key) -------------------------------------
    async getClientLink(): Promise<DeviceClientLink | null> {
      return readJson<DeviceClientLink>(K_CLIENT_LINK);
    },
    async setClientLink(link: DeviceClientLink): Promise<void> {
      await writeJson(K_CLIENT_LINK, link);
    },
    async clearClientLink(): Promise<void> {
      try {
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
            return { ok: true, userId: again.data.user?.id ?? null };
          }
        } catch (e) {
          // A network failure here is a connectivity problem, not a
          // confirmation requirement — label it so the UI offers a retry.
          if (isNetworkError(e)) return { ok: false, code: 'network' };
          // fall through to the confirmation error
        }
        return { ok: false, code: 'email_confirmation_required' };
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
        return { ok: true, userId: data?.user?.id ?? null };
      } catch (e) {
        return { ok: false, code: mapSignInError(e) };
      }
    },

    /**
     * Password reset. Anti-enumeration: any non-network outcome (including
     * "unknown email") resolves ok — the UI always shows the same
     * confirmation copy. Only a network failure surfaces a retry error.
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

    /** Sign out: clears the session, the remembered role, and the has-account flag. Never throws. */
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
        await kv.removeItem(K_ROLE);
        await kv.removeItem(K_HAS_ACCOUNT);
        // A different realtor may use this device next: never leak the
        // previous account's onboarding state into their session.
        await kv.removeItem(K_PROFILE_SKIPPED);
        await kv.removeItem(K_PENDING_NAME);
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
