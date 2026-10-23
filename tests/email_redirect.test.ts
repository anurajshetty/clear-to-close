// email_redirect.test.ts — REGRESSION (Oct 20, 2026): email links landed
// on the bare domain root and hit GitHub's 404.
//
// Production repro: signup worked and the confirmation email verified
// the address server-side, but the redirect landed on
// https://anurajshetty.github.io/ — the /clear-to-close path dropped —
// where no site exists. The dashboard was NOT the cause (Site URL and
// Redirect URLs verified correct); the app passed NO redirect on any
// email flow, and Supabase's default resolution drops the Site URL's
// path. Same flaw hit password reset, where the app must open.
//
// The fix pins: AUTH_EMAIL_REDIRECT_URL is the app's public web address,
// and all three flows (signUp, resendConfirmation, sendPasswordReset)
// pass it explicitly — on every platform, since the link always opens
// in a browser.
//
// Oct 23, 2026 split: signUp + resendConfirmation now pass
// AUTH_CONFIRM_REDIRECT_URL (…/email-confirmed) so the confirmation
// link lands on the text-only outcome page; sendPasswordReset keeps
// the root URL. parseConfirmationLink cases live below.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  AUTH_CONFIRM_REDIRECT_URL,
  AUTH_EMAIL_REDIRECT_URL,
  createAuthService,
  parseConfirmationLink,
  type AuthClientLike,
} from '../src/lib/auth';
import { APP_PUBLIC_URL } from '../src/lib/shareCopy';

declare const process: { exitCode?: number };

const EXPECTED = 'https://anurajshetty.github.io/clear-to-close';

interface Captured {
  signUpArgs?: { email: string; password: string; options?: { emailRedirectTo?: string } };
  resendArgs?: { type: 'signup'; email: string; options?: { emailRedirectTo?: string } };
  resetEmail?: string;
  resetOptions?: { redirectTo?: string };
}

function capturingClient(cap: Captured): AuthClientLike {
  const notScripted = async () => ({ data: {}, error: { message: 'not scripted' } });
  return {
    auth: {
      signUp: async (args) => {
        cap.signUpArgs = args as Captured['signUpArgs'];
        // Session present: skips the immediate sign-in fallback path.
        return { data: { user: { id: 'u1' }, session: { access_token: 't' } }, error: null };
      },
      signInWithPassword: notScripted as never,
      resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => {
        cap.resetEmail = email;
        cap.resetOptions = options;
        return { error: null };
      },
      resend: async (args) => {
        cap.resendArgs = args as Captured['resendArgs'];
        return { error: null };
      },
      signOut: async () => ({ error: null }),
      getSession: async () => ({ data: { session: null } }),
      updateUser: notScripted as never,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  } as AuthClientLike;
}

async function main(): Promise<void> {
  assert(
    AUTH_EMAIL_REDIRECT_URL === EXPECTED,
    'the auth email redirect is the app public web address, path included',
  );
  assert(
    AUTH_EMAIL_REDIRECT_URL === APP_PUBLIC_URL,
    'the redirect derives from the single APP_PUBLIC_URL definition (no second copy of the origin)',
  );
  // Oct 23, 2026: confirmation links land on their own text-only page so
  // the outcome can be stated; reset keeps the root.
  const EXPECTED_CONFIRM = `${EXPECTED}/email-confirmed`;
  assert(
    AUTH_CONFIRM_REDIRECT_URL === EXPECTED_CONFIRM,
    'the confirmation redirect is the app address + /email-confirmed',
  );

  // --- signUp -----------------------------------------------------------------
  const cap1: Captured = {};
  const svc1 = createAuthService({ getClient: () => capturingClient(cap1), kv: memoryKV(), platform: 'web' });
  const up = await svc1.signUp('Maya Sharma', 'maya@example.com', 'password123');
  assert(up.ok, 'signUp succeeds against the capturing mock');
  assert(
    cap1.signUpArgs?.options?.emailRedirectTo === EXPECTED_CONFIRM,
    'signUp passes options.emailRedirectTo = the confirmation landing page',
  );

  // --- resend confirmation ------------------------------------------------------
  const cap2: Captured = {};
  const svc2 = createAuthService({ getClient: () => capturingClient(cap2), kv: memoryKV(), platform: 'web' });
  const re = await svc2.resendConfirmation('maya@example.com');
  assert(re.ok, 'resendConfirmation succeeds against the capturing mock');
  assert(cap2.resendArgs?.type === 'signup', 'resend stays type signup');
  assert(
    cap2.resendArgs?.options?.emailRedirectTo === EXPECTED_CONFIRM,
    'resend passes options.emailRedirectTo = the confirmation landing page',
  );

  // --- password reset -------------------------------------------------------------
  const cap3: Captured = {};
  const svc3 = createAuthService({ getClient: () => capturingClient(cap3), kv: memoryKV(), platform: 'native' });
  const rs = await svc3.sendPasswordReset('maya@example.com');
  assert(rs.ok, 'sendPasswordReset succeeds against the capturing mock');
  assert(
    cap3.resetOptions?.redirectTo === EXPECTED,
    'resetPasswordForEmail passes redirectTo = the app address (native included: the link opens in a browser)',
  );

  // --- confirmation outcome parsing (Oct 23, 2026) --------------------------------
  {
    const base = 'https://anurajshetty.github.io/clear-to-close/email-confirmed';
    assert(
      parseConfirmationLink(`${base}#access_token=tok&refresh_token=r&type=signup`).kind === 'confirmed',
      'a verified signup fragment reads confirmed',
    );
    assert(
      parseConfirmationLink(`${base}#error=access_denied&error_code=otp_expired&error_description=expired`).kind === 'expired',
      'an otp_expired error fragment reads expired',
    );
    assert(
      parseConfirmationLink(`${base}#error_code=otp_expired`).kind === 'expired',
      'an error_code-only fragment reads expired',
    );
    assert(
      parseConfirmationLink(base).kind === 'none',
      'a bare landing URL has no outcome (the page shows the expired state)',
    );
    assert(
      parseConfirmationLink(`${base}#access_token=tok&type=recovery`).kind === 'none',
      'a recovery fragment is not a confirmation outcome',
    );
    assert(
      parseConfirmationLink(`${base}?error=access_denied#access_token=tok&type=signup`).kind === 'confirmed',
      'query params are never read (fragment-only, L9): a query error cannot flip a confirmed fragment',
    );
    assert(
      parseConfirmationLink(`${base}?access_token=tok&type=signup`).kind === 'none',
      'tokens in the query string are ignored (fragment-only, L9)',
    );
  }

  summary('email_redirect');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
