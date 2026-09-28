// recovery.test.ts — password-reset recovery landing flow (Sept 2026).
// Web only: the reset email opens in the browser; the user sets the new
// password there and signs into the iPhone app with it.
//
//  - parseRecoveryLink: recovery fragment -> tokens; expired/error link ->
//    recovery-error; plain URL -> none.
//  - validatePasswordReset: 8+ rule + confirm match, no current password.
//  - consumeRecoverySession: tokens -> live session; expired link ->
//    'expired' (fresh-link path); network/unconfigured map sanely.
//  - setPasswordFromRecovery: updateUser with the new password; lapsed
//    session -> 'session_expired'; weak -> 'weak_password'.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import type { KV } from '../src/lib/store';
import {
  createAuthService,
  parseRecoveryLink,
  validatePasswordReset,
  type AuthClientLike,
} from '../src/lib/auth';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

type UpdateUserFn = (password: string) => Promise<{ error?: { message?: string } | null }>;
type SetSessionFn = (args: {
  access_token: string;
  refresh_token: string;
}) => Promise<{
  data: { session?: { user?: { id?: string } } | null };
  error?: { message?: string } | null;
}>;

function mockClient(o: {
  reset?: (email: string) => Promise<{ error?: { message?: string } | null }>;
  setSession?: SetSessionFn;
  updateUser?: UpdateUserFn;
}): AuthClientLike {
  return {
    auth: {
      signUp: async () => ({ data: {}, error: { message: 'not scripted' } }),
      signInWithPassword: async () => ({ data: {}, error: { message: 'not scripted' } }),
      resetPasswordForEmail: o.reset ?? (async () => ({ error: null })),
      signOut: async () => ({ error: null }),
      getSession: async () => ({ data: { session: null } }),
      updateUser: async (args: { password: string }) =>
        o.updateUser ? o.updateUser(args.password) : { error: { message: 'not scripted' } },
      setSession: o.setSession
        ? async (args: { access_token: string; refresh_token: string }) => o.setSession!(args)
        : async () => ({ data: { session: null }, error: { message: 'not scripted' } }),
      onAuthStateChange: (_cb: (event: string, session: { user?: { id?: string } } | null) => void) => ({
        data: { subscription: { unsubscribe() {} } },
      }),
    },
  };
}

function serviceFor(client: AuthClientLike | null, kv?: KV, platform: 'web' | 'native' = 'native') {
  return createAuthService({ getClient: () => client, kv: kv ?? memoryKV(), platform });
}

async function main(): Promise<void> {
  // ------------------------------------------- parseRecoveryLink ----------
  {
    const web = 'https://anurajshetty.github.io/clear-to-close/#access_token=AT1&refresh_token=RT1&expires_in=3600&token_type=bearer&type=recovery';
    const r1 = parseRecoveryLink(web);
    assert(r1.kind === 'recovery', 'parse: web recovery fragment detected');
    if (r1.kind === 'recovery') {
      assert(r1.accessToken === 'AT1', 'parse: access token extracted');
      assert(r1.refreshToken === 'RT1', 'parse: refresh token extracted');
    }

    const err =
      'https://anurajshetty.github.io/clear-to-close/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
    const r3 = parseRecoveryLink(err);
    assert(r3.kind === 'recovery-error', 'parse: expired link -> recovery-error');
    if (r3.kind === 'recovery-error') {
      assert(r3.errorDescription.length > 0, 'parse: error description carried');
    }

    assert(parseRecoveryLink('https://anurajshetty.github.io/clear-to-close/').kind === 'none', 'parse: plain URL -> none');
    assert(parseRecoveryLink('not a url at all').kind === 'none', 'parse: garbage -> none');
    // Tokens without type=recovery are not a recovery link.
    assert(
      parseRecoveryLink('https://x.com/#access_token=AT&refresh_token=RT').kind === 'none',
      'parse: tokens without type=recovery -> none',
    );
  }

  // -------------------------------------- validatePasswordReset -----------
  {
    assert(validatePasswordReset('longenough', 'longenough').canSubmit, 'reset validation: valid pair can submit');
    assert(!validatePasswordReset('short', 'short').canSubmit, 'reset validation: short new blocks');
    assert(!validatePasswordReset('longenough', 'different!').canSubmit, 'reset validation: mismatch blocks');
    assert(!validatePasswordReset('', '').canSubmit, 'reset validation: empty blocks');
    const v = validatePasswordReset('short', 'different!');
    assert(!v.newLongEnough && !v.confirmMatches, 'reset validation: flags short vs mismatch separately');
  }

  // ------------------------------------ consumeRecoverySession ------------
  {
    let seen: { access_token: string; refresh_token: string } | null = null;
    const svc = serviceFor(
      mockClient({
        setSession: async (args) => {
          seen = args;
          return { data: { session: { user: { id: 'uid-1' } } }, error: null };
        },
      }),
    );
    const ok = await svc.consumeRecoverySession('AT1', 'RT1');
    assert(ok.ok, 'consume: tokens -> ok');
    assert(
      seen !== null &&
        (seen as { access_token: string }).access_token === 'AT1' &&
        (seen as { refresh_token: string }).refresh_token === 'RT1',
      'consume: tokens handed to setSession',
    );
  }
  {
    // Expired/used link -> 'expired' so the screen offers a fresh link.
    const svc = serviceFor(
      mockClient({
        setSession: async () => ({ data: { session: null }, error: { message: 'invalid_grant: Token expired' } }),
      }),
    );
    const res = await svc.consumeRecoverySession('AT', 'RT');
    assert(!res.ok && (res as { code: string }).code === 'expired', 'consume: expired token -> expired');
  }
  {
    // Network failure -> retryable 'network'.
    const svc = serviceFor(
      mockClient({
        setSession: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const res = await svc.consumeRecoverySession('AT', 'RT');
    assert(!res.ok && (res as { code: string }).code === 'network', 'consume: network throw -> network');
  }
  {
    // No session returned at all -> treat as expired (nothing to set).
    const svc = serviceFor(
      mockClient({
        setSession: async () => ({ data: { session: null }, error: null }),
      }),
    );
    const res = await svc.consumeRecoverySession('AT', 'RT');
    assert(!res.ok && (res as { code: string }).code === 'expired', 'consume: null session -> expired');
  }
  {
    const svc = serviceFor(null);
    const res = await svc.consumeRecoverySession('AT', 'RT');
    assert(!res.ok && (res as { code: string }).code === 'unconfigured', 'consume: no client -> unconfigured');
  }

  // ----------------------------------- setPasswordFromRecovery ------------
  {
    let updated: string | null = null;
    const svc = serviceFor(
      mockClient({
        updateUser: async (pw) => {
          updated = pw;
          return { error: null };
        },
      }),
    );
    const res = await svc.setPasswordFromRecovery('brand-new-password');
    assert(res.ok, 'recovery set: success returns ok');
    assert(updated === 'brand-new-password', 'recovery set: updateUser receives the new password');
  }
  {
    // Lapsed recovery session -> 'session_expired' so the screen routes to
    // the fresh-link path.
    const svc = serviceFor(
      mockClient({
        updateUser: async () => ({ error: { message: 'JWT expired' } }),
      }),
    );
    const res = await svc.setPasswordFromRecovery('brand-new-password');
    assert(!res.ok && (res as { code: string }).code === 'session_expired', 'recovery set: lapsed session -> session_expired');
  }
  {
    const svc = serviceFor(
      mockClient({
        updateUser: async () => ({ error: { message: 'Password should be at least 8 characters' } }),
      }),
    );
    const res = await svc.setPasswordFromRecovery('short');
    assert(!res.ok && (res as { code: string }).code === 'weak_password', 'recovery set: server-side weak -> weak_password');
  }
  {
    const svc = serviceFor(
      mockClient({
        updateUser: async () => {
          throw new TypeError('network request failed');
        },
      }),
    );
    const res = await svc.setPasswordFromRecovery('brand-new-password');
    assert(!res.ok && (res as { code: string }).code === 'network', 'recovery set: network throw -> network');
  }
  {
    const svc = serviceFor(null);
    const res = await svc.setPasswordFromRecovery('brand-new-password');
    assert(!res.ok && (res as { code: string }).code === 'unconfigured', 'recovery set: no client -> unconfigured');
  }
}

main()
  .then(() => summary('recovery'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
