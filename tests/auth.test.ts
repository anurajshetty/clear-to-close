// auth.test.ts — the auth + device-link edge-case matrix (approved spec §4).
// Every case gets a test, same bar as the invite/sync matrix:
//  - sign-up: duplicate email, weak/malformed password, retry-safe network
//    failure (no phantom state)
//  - login: wrong password / unregistered email -> clear inline code, no throw
//  - password reset: anti-enumeration — identical ok for known/unknown email
//  - sessions: web never restores (fresh client starts sessionless);
//    native restores; logout clears everything and never throws
//  - client redeem: invalid / already-used / revoked / name mismatch
//  - device linking: one device id per link; atomic regeneration kills the
//    old code + old link while issuing the new one; old device lands on an
//    explicit dead-link state; new device redeems into current escrow state
//  - checklist state lives on the escrow, never on the device link
//  - boot routing: first launch, mid-onboarding relaunch, native lapsed
//    session -> login, web returning realtor -> login every visit
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import type { KV } from '../src/lib/store';
import { createStore } from '../src/lib/store';
import {
  createAuthService,
  setExpectSignOut,
  takeExpectSignOut,
  validatePasswordChange,
  type AuthClientLike,
} from '../src/lib/auth';
import { resolveBootHref, resolvePostAuthHref, shouldShowProfileNudge } from '../src/lib/bootRoute';
import type { DeviceClientLink } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

// ------------------------------------------------------------------ mocks --

type SignUpFn = (args: {
  email: string;
  password: string;
  options?: { data?: Record<string, string> };
}) => Promise<{
  data: { user?: { id?: string } | null; session?: unknown };
  error?: { message?: string; status?: number; code?: string } | null;
}>;

type SignInFn = (args: {
  email: string;
  password: string;
}) => Promise<{
  data: { user?: { id?: string } | null; session?: unknown };
  error?: { message?: string } | null;
}>;

function mockClient(o: {
  signUp?: SignUpFn;
  signIn?: SignInFn;
  reset?: (email: string) => Promise<{ error?: { message?: string } | null }>;
  session?: { user?: { id?: string; email?: string } } | null;
  updateUser?: (password: string) => Promise<{ error?: { message?: string } | null }>;
  signOutThrows?: boolean;
  onSignOut?: () => void;
}): AuthClientLike {
  return {
    auth: {
      signUp: o.signUp ?? (async () => ({ data: {}, error: { message: 'not scripted' } })),
      signInWithPassword: o.signIn ?? (async () => ({ data: {}, error: { message: 'not scripted' } })),
      resetPasswordForEmail: o.reset ?? (async () => ({ error: null })),
      signOut: async () => {
        if (o.onSignOut) o.onSignOut();
        if (o.signOutThrows) throw new Error('signout boom');
        return { error: null };
      },
      getSession: async () => ({ data: { session: o.session ?? null } }),
      updateUser: async (args: { password: string }) =>
        o.updateUser ? o.updateUser(args.password) : { error: { message: 'not scripted' } },
      onAuthStateChange: (_cb: (event: string, session: { user?: { id?: string } } | null) => void) => ({
        data: { subscription: { unsubscribe() {} } },
      }),
    },
  };
}

function serviceFor(client: AuthClientLike | null, kv?: KV, platform: 'web' | 'native' = 'native') {
  return createAuthService({ getClient: () => client, kv: kv ?? memoryKV(), platform });
}

const UID = '11111111-1111-4111-8111-111111111111';

async function main(): Promise<void> {
  // --------------------------------------- change password (Sept 26) --------
  {
    // Client-side validation: all three filled + 8+ + confirm matches.
    assert(validatePasswordChange('a', 'longenough', 'longenough').canSubmit, 'changepw validation: valid triple can submit');
    assert(!validatePasswordChange('', 'longenough', 'longenough').canSubmit, 'changepw validation: empty current blocks');
    assert(!validatePasswordChange('a', 'short', 'short').canSubmit, 'changepw validation: short new blocks');
    assert(!validatePasswordChange('a', 'longenough', 'different!').canSubmit, 'changepw validation: mismatch blocks');
    const v = validatePasswordChange('a', 'short', 'short');
    assert(!v.newLongEnough && v.confirmMatches, 'changepw validation: flags short vs mismatch separately');

    // Success: re-auth with the current password, then updateUser with the new.
    {
      let updated: string | null = null;
      const svc = serviceFor(
        mockClient({
          session: { user: { id: UID, email: 'rita@example.com' } },
          signIn: async (args) => {
            assert(args.email === 'rita@example.com', 'changepw: re-auth uses the session email');
            assert(args.password === 'old-secret', 'changepw: re-auth sends the current password');
            return { data: { user: { id: UID } }, error: null };
          },
          updateUser: async (pw) => {
            updated = pw;
            return { error: null };
          },
        }),
      );
      const res = await svc.changePassword('old-secret', 'brand-new-password');
      assert(res.ok, 'changepw: success returns ok');
      assert(updated === 'brand-new-password', 'changepw: updateUser receives the new password');
    }

    // Wrong current password: re-auth rejects -> wrong_current, updateUser never called.
    {
      let updated = false;
      const svc = serviceFor(
        mockClient({
          session: { user: { id: UID, email: 'rita@example.com' } },
          signIn: async () => ({ data: {}, error: { message: 'Invalid login credentials' } }),
          updateUser: async () => {
            updated = true;
            return { error: null };
          },
        }),
      );
      const res = await svc.changePassword('wrong-secret', 'brand-new-password');
      assert(!res.ok && (res as { code: string }).code === 'wrong_current', 'changepw: wrong current -> wrong_current');
      assert(!updated, 'changepw: updateUser not called when re-auth fails');
    }

    // Network failure on re-auth -> network (retryable, never wrong_current).
    {
      const svc = serviceFor(
        mockClient({
          session: { user: { id: UID, email: 'rita@example.com' } },
          signIn: async () => {
            throw new TypeError('fetch failed');
          },
        }),
      );
      const res = await svc.changePassword('old-secret', 'brand-new-password');
      assert(!res.ok && (res as { code: string }).code === 'network', 'changepw: network on re-auth -> network');
    }

    // Weak new password rejected by the server -> weak_password.
    {
      const svc = serviceFor(
        mockClient({
          session: { user: { id: UID, email: 'rita@example.com' } },
          signIn: async () => ({ data: { user: { id: UID } }, error: null }),
          updateUser: async () => ({ error: { message: 'Password should be at least 8 characters' } }),
        }),
      );
      const res = await svc.changePassword('old-secret', 'brand-new-password');
      assert(!res.ok && (res as { code: string }).code === 'weak_password', 'changepw: server weak-password -> weak_password');
    }

    // No session email (signed out mid-flow) -> unknown, never throws.
    {
      const svc = serviceFor(mockClient({ session: null }));
      const res = await svc.changePassword('old-secret', 'brand-new-password');
      assert(!res.ok, 'changepw: no session never throws');
    }

    // Unconfigured (no client) -> unconfigured.
    {
      const svc = serviceFor(null);
      const res = await svc.changePassword('old-secret', 'brand-new-password');
      assert(!res.ok && (res as { code: string }).code === 'unconfigured', 'changepw: unconfigured -> unconfigured');
    }
  }

  // ------------------------------------------------- sign-up edge cases ---
  {
    const kv = memoryKV();
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: { message: 'User already registered' } }),
      }),
      kv,
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'duplicate_email', 'duplicate email -> duplicate_email (login path, never a dead end)');
    assert((await kv.getItem('ctc:role')) === null, 'failed sign-up writes no role');
    assert((await svc.getHasAccount()) === false, 'failed sign-up sets no has-account flag');
  }
  {
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: { message: 'Password should be at least 8 characters' } }),
      }),
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'short');
    assert(!r.ok && r.code === 'weak_password', 'weak password -> weak_password');
  }
  {
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: { message: 'Password is too weak' } }),
      }),
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'password');
    assert(!r.ok && r.code === 'weak_password', 'malformed password message -> weak_password');
  }
  {
    // Live bug (Sept 25, 2026): GoTrue's email rate limit (HTTP 429,
    // error_code over_email_send_rate_limit) was mapped to 'unknown' and the
    // UI showed a generic "Something went wrong". It must surface a specific,
    // retry-safe code — the account is NOT created, so the user just waits.
    const kv = memoryKV();
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({
          data: {},
          error: {
            message: 'email rate limit exceeded',
            status: 429,
            code: 'over_email_send_rate_limit',
          },
        }),
      }),
      kv,
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'rate_limited', '429 over_email_send_rate_limit -> rate_limited (not unknown)');
    assert((await kv.getItem('ctc:role')) === null && (await svc.getHasAccount()) === false,
      'rate-limited sign-up writes no local state (safe to retry)');
  }
  {
    // Message-only variant (older API versions omit status/code fields).
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: { message: 'email rate limit exceeded' } }),
      }),
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'rate_limited', 'bare "rate limit" message -> rate_limited');
  }
  {
    // Network failure is retry-safe: first attempt fails clean, the retry
    // succeeds, and no phantom local state exists in between.
    const kv = memoryKV();
    let attempt = 0;
    const svc = serviceFor(
      mockClient({
        signUp: async () => {
          attempt++;
          if (attempt === 1) throw new TypeError('fetch failed');
          return { data: { user: { id: UID }, session: {} }, error: null };
        },
      }),
      kv,
    );
    const r1 = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r1.ok && r1.code === 'network', 'sign-up network failure -> network (retryable)');
    assert((await kv.getItem('ctc:role')) === null && (await svc.getHasAccount()) === false,
      'network failure leaves no phantom account state');
    const r2 = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(r2.ok === true, 'sign-up retry after network failure succeeds');
  }
  {
    // No-session fallback: when the project requires email confirmation the
    // sign-up returns no session and the fallback sign-in decides the code.
    // A NETWORK failure inside that fallback must surface 'network' (retry),
    // never the misleading 'email_confirmation_required'.
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: null }),
        signIn: async () => { throw new TypeError('fetch failed'); },
      }),
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'network', 'sign-up no-session fallback network failure -> network');
  }
  {
    const svc = serviceFor(
      mockClient({
        signUp: async () => ({ data: {}, error: null }),
        signIn: async () => ({ data: {}, error: { message: 'Email not confirmed' } }),
      }),
    );
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'email_confirmation_required',
      'sign-up no-session fallback auth failure -> email_confirmation_required');
  }
  {
    const svc = serviceFor(null);
    const r = await svc.signUp('Rita', 'rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'unconfigured', 'sign-up without a client -> unconfigured');
  }

  // ---------------------------------------------------- login edge cases ---
  {
    const svc = serviceFor(
      mockClient({
        signIn: async () => ({ data: {}, error: { message: 'Invalid login credentials' } }),
      }),
    );
    const r = await svc.signIn('rita@x.com', 'wrongpassword');
    assert(!r.ok && r.code === 'invalid_credentials', 'wrong password -> invalid_credentials, stays on login');
  }
  {
    // Supabase does not distinguish unregistered emails on sign-in; the app
    // surfaces the same clear inline error.
    const svc = serviceFor(
      mockClient({
        signIn: async () => ({ data: {}, error: { message: 'Invalid login credentials' } }),
      }),
    );
    const r = await svc.signIn('nobody@x.com', 'whatever123');
    assert(!r.ok && r.code === 'invalid_credentials', 'unregistered email -> invalid_credentials');
  }
  {
    const svc = serviceFor(
      mockClient({
        signIn: async () => { throw new TypeError('Failed to fetch'); },
      }),
    );
    const r = await svc.signIn('rita@x.com', 'longenoughpassword');
    assert(!r.ok && r.code === 'network', 'login network failure -> network (retryable)');
  }
  {
    const svc = serviceFor(
      mockClient({
        signIn: async () => ({ data: { user: { id: UID }, session: {} }, error: null }),
      }),
    );
    const r = await svc.signIn('rita@x.com', 'longenoughpassword');
    assert(r.ok === true && r.userId === UID, 'login happy path resolves the user id');
  }

  // ------------------------------------------- password reset (anti-enum) ---
  {
    const seen: string[] = [];
    const svc = serviceFor(
      mockClient({
        reset: async (email: string) => {
          seen.push(email);
          return { error: { message: 'User not found' } };
        },
      }),
    );
    const r = await svc.sendPasswordReset('unknown@x.com');
    assert(r.ok === true && seen[0] === 'unknown@x.com', 'reset for unknown email -> identical ok (anti-enumeration)');
  }
  {
    const svc = serviceFor(mockClient({ reset: async () => ({ error: null }) }));
    const r = await svc.sendPasswordReset('rita@x.com');
    assert(r.ok === true, 'reset for known email -> ok');
  }
  {
    const svc = serviceFor(
      mockClient({
        reset: async () => { throw new TypeError('network timeout'); },
      }),
    );
    const r = await svc.sendPasswordReset('rita@x.com');
    assert(!r.ok && r.code === 'network', 'reset network failure -> retryable network error');
  }

  // ------------------------------------------------- sessions + logout ----
  {
    // Web never restores: no persisted session means null.
    const svc = serviceFor(mockClient({ session: null }), memoryKV(), 'web');
    assert((await svc.getSessionUserId()) === null, 'web: no session restored on launch');
  }
  {
    // Native restores the persisted session.
    const svc = serviceFor(mockClient({ session: { user: { id: UID } } }), memoryKV(), 'native');
    assert((await svc.getSessionUserId()) === UID, 'native: persisted session restored');
  }
  {
    // Logout clears the session, the remembered role, and the has-account
    // flag — and never throws, even when the remote sign-out fails.
    const kv = memoryKV();
    let remoteSignOut = 0;
    const svc = serviceFor(
      mockClient({ session: { user: { id: UID } }, signOutThrows: true, onSignOut: () => { remoteSignOut++; } }),
      kv,
    );
    await kv.setItem('ctc:role', 'realtor');
    await svc.setHasAccount(true);
    await svc.signOut();
    assert(remoteSignOut === 1, 'logout attempts the remote sign-out');
    assert((await kv.getItem('ctc:role')) === null, 'logout clears the remembered role');
    assert((await svc.getHasAccount()) === false, 'logout clears the has-account flag');
  }
  {
    // A different realtor may use this device next: logout also clears the
    // onboarding state so the next account never inherits a stale skip flag
    // or a wrong-account pending name.
    const kv = memoryKV();
    const svc = serviceFor(mockClient({}), kv);
    await svc.setProfileSkipped(true);
    await svc.setPendingProfileName('Previous Realtor');
    await svc.signOut();
    assert((await kv.getItem('ctc:profileskipped')) === null, 'logout clears the profile-skipped flag');
    assert((await kv.getItem('ctc:pendingname')) === null, 'logout clears the pending profile name');
  }

  // ------------------------------------------------------- device state ----
  {
    const svc = serviceFor(mockClient({}));
    const d1 = await svc.getDeviceId();
    const d2 = await svc.getDeviceId();
    assert(typeof d1 === 'string' && d1.length > 0 && d1 === d2, 'device id is stable per device');
  }
  {
    const svc = serviceFor(mockClient({}));
    const link: DeviceClientLink = {
      linkId: 'lid-1', escrowId: 'eid-1', role: 'buyer', partyName: 'Priya Nair', deviceId: 'dev-1',
    };
    await svc.setClientLink(link);
    const back = await svc.getClientLink();
    assert(back !== null && back.linkId === 'lid-1' && back.partyName === 'Priya Nair', 'client link persists (the device access key)');
    await svc.clearClientLink();
    assert((await svc.getClientLink()) === null, 'client link clears');
  }
  {
    const svc = serviceFor(mockClient({}));
    await svc.setPendingProfileName('Rita Realtor');
    assert((await svc.takePendingProfileName()) === 'Rita Realtor', 'pending profile name hands off once');
    assert((await svc.takePendingProfileName()) === null, 'pending profile name is consumed one-shot');
  }
  {
    const svc = serviceFor(mockClient({}));
    assert((await svc.getProfileSkipped()) === false, 'profile-skipped defaults false');
    await svc.setProfileSkipped(true);
    assert((await svc.getProfileSkipped()) === true, 'profile-skipped persists');
  }

  // ------------------------------------------------------- boot routing ----
  {
    assert(resolveBootHref({ role: null, sessionUserId: null, clientLink: null, hasAccount: false, isWeb: false }) === '/role',
      'first launch -> role picker');
    assert(resolveBootHref({ role: 'realtor', sessionUserId: null, clientLink: null, hasAccount: false, isWeb: false }) === '/signup',
      'native: realtor picked, never signed up -> sign-up');
    assert(resolveBootHref({ role: 'realtor', sessionUserId: null, clientLink: null, hasAccount: true, isWeb: false }) === '/login',
      'native: lapsed session with an existing account -> login (not sign-up)');
    assert(resolveBootHref({ role: 'realtor', sessionUserId: null, clientLink: null, hasAccount: true, isWeb: true }) === '/login',
      'web: returning realtor signs in every visit');
    assert(resolveBootHref({ role: 'realtor', sessionUserId: UID, clientLink: null, hasAccount: true, isWeb: false }) === '/',
      'native: live session -> deal list (mid-onboarding resume handled by the layout)');
    assert(resolveBootHref({ role: 'client', sessionUserId: null, clientLink: null, hasAccount: false, isWeb: false }) === '/redeem',
      'client picked -> redeem');
    const buyerLink: DeviceClientLink = { linkId: 'l', escrowId: 'eid-9', role: 'buyer', partyName: 'P', deviceId: 'd' };
    assert(resolveBootHref({ role: 'client', sessionUserId: null, clientLink: buyerLink, hasAccount: false, isWeb: false }) === '/client/buyer/eid-9',
      'stored buyer link -> buyer escrow');
    const sellerLink: DeviceClientLink = { linkId: 'l', escrowId: 'eid-9', role: 'seller', partyName: 'P', deviceId: 'd' };
    assert(resolveBootHref({ role: 'client', sessionUserId: null, clientLink: sellerLink, hasAccount: false, isWeb: true }) === '/client/seller/eid-9',
      'stored seller link -> seller escrow (web too)');
  }

  // --------------------------------------- post-auth + profile nudge --------
  {
    // Mid-onboarding resume: a live session with no profile and no explicit
    // skip resumes at profile creation (step 2) — login and the root layout
    // share this helper so the funnel can't be silently skipped.
    assert(resolvePostAuthHref({ sessionUserId: UID, profile: null, skipped: false }) === '/profile-create',
      'post-auth: live session, no profile, not skipped -> profile-create');
    assert(resolvePostAuthHref({ sessionUserId: UID, profile: { name: 'R' } as never, skipped: false }) === '/',
      'post-auth: live session with profile -> deal list');
    assert(resolvePostAuthHref({ sessionUserId: UID, profile: null, skipped: true }) === '/',
      'post-auth: live session, profile skipped -> deal list');
    assert(resolvePostAuthHref({ sessionUserId: null, profile: null, skipped: false }) === '/',
      'post-auth: no session -> deal list (no resume without a session)');
    // The deal-list "Complete your profile" nudge appears ONLY when profile
    // creation was explicitly skipped (approved mockup 24) — never merely
    // because no local profile row exists yet.
    assert(shouldShowProfileNudge({ skipped: true }) === true,
      'profile nudge shows when profile creation was skipped');
    assert(shouldShowProfileNudge({ skipped: false }) === false,
      'profile nudge hidden when never skipped');
    // Sign-out expectation flag: deliberate logout vs mid-session expiry.
    assert(takeExpectSignOut() === false, 'expect-sign-out flag starts unset');
    setExpectSignOut(true);
    assert(takeExpectSignOut() === true, 'expect-sign-out flag reads true once');
    assert(takeExpectSignOut() === false, 'expect-sign-out flag auto-resets after read');
  }

  // --------------------------------------------- client redeem + devices ---
  {
    const store = createStore(memoryKV());
    const escrow = await store.createEscrow({
      address: '4187 Oakmont Dr',
      city: 'Valencia, CA 91355',
      side: 'buy',
      buyerName: 'Priya Nair',
      openDate: '2026-09-20',
      closeDate: '2026-11-20',
    });

    // invalid / already-used / revoked / name mismatch
    const bad = await store.redeemInvite('ZZZZZZ', 'Nobody', 'dev-1');
    assert(!bad.ok && bad.error === 'invalid', 'redeem: unknown code -> invalid');

    const inv = await store.createInvite(escrow.id, 'buyer', 'Priya Nair');
    const ok1 = await store.redeemInvite(inv.code, 'Priya Nair', 'dev-1');
    assert(ok1.ok === true, 'redeem: happy path ok');
    if (!ok1.ok) throw new Error('fixture redeem failed');

    const again = await store.redeemInvite(inv.code, 'Priya Nair', 'dev-1');
    assert(!again.ok && again.error === 'already_used', 'redeem: second use -> already_used');
    // Literal reinstall/new-device case: the same consumed code attempted
    // from a DIFFERENT device id is still already_used.
    const againOtherDevice = await store.redeemInvite(inv.code, 'Priya Nair', 'dev-2');
    assert(!againOtherDevice.ok && againOtherDevice.error === 'already_used',
      'redeem: consumed code from a different device id -> already_used');

    const inv2 = await store.createInvite(escrow.id, 'buyer', 'Sam Buyer');
    await store.revokeInvite(inv2.id);
    const rev = await store.redeemInvite(inv2.code, 'Sam Buyer', 'dev-1');
    assert(!rev.ok && rev.error === 'revoked', 'redeem: revoked code -> revoked');

    const inv3 = await store.createInvite(escrow.id, 'buyer', 'Alex Buyer');
    const mm = await store.redeemInvite(inv3.code, 'Wrong Name', 'dev-1');
    assert(!mm.ok && mm.error === 'name_mismatch', 'redeem: name mismatch -> name_mismatch');
    const mmOk = await store.redeemInvite(inv3.code, '  aLeX bUyEr ', 'dev-9');
    assert(mmOk.ok === true, 'redeem: name match is case/space-insensitive');

    // One device id per client link.
    const link1 = await store.getLinkForInvite(inv.id);
    assert(link1 !== null && link1.deviceId === 'dev-1', 'one device id bound per client link');
    assert(link1 !== null && link1.revokedAt === null, 'fresh link is not revoked');
    const v1 = await store.validateClientLink(ok1.linkId);
    assert(v1.valid === true, 'live link validates');

    // Checklist state lives on the escrow, never on the device link.
    const esc = await store.getEscrow(escrow.id);
    const stepId = esc!.buyerSteps[0].id;
    await store.toggleStep(escrow.id, 'buyer', stepId);
    const linkAfterToggle = await store.getLinkForInvite(inv.id);
    assert(linkAfterToggle !== null && !('steps' in linkAfterToggle), 'device link carries no checklist state');

    // Atomic regeneration: the old code AND the old device link die at the
    // same moment the fresh code is issued for the same escrow/role/party.
    // Cloud mirror: the caller can pin the replacement invite's id to the
    // server-issued id so local and cloud rows never diverge (separate
    // invite, so the main regen flow below is unaffected).
    const pinInv = await store.createInvite(escrow.id, 'seller', 'Sam Seller');
    const regenPinned = await store.regenerateInvite(pinInv.id, undefined, 'server-invite-id-1');
    assert(regenPinned.invite.id === 'server-invite-id-1', 'regen honors a caller-supplied replacement id');
    const regen = await store.regenerateInvite(inv.id);
    assert(regen.oldCode === inv.code, 'regen returns the replaced code');
    assert(regen.invite.code !== inv.code && regen.invite.code.length === 6, 'regen issues a fresh 6-char code');
    assert(regen.invite.escrowId === escrow.id && regen.invite.role === 'buyer' && regen.invite.partyName === 'Priya Nair',
      'regen keeps escrow/role/party');
    assert(regen.revokedLink !== null && regen.revokedLink.id === ok1.linkId, 'regen kills the old device link');
    const oldLinkGone = await store.getLinkForInvite(inv.id);
    assert(oldLinkGone === null, 'no live link remains on the old invite');

    // The OLD device lands on an explicit dead-link state — never a blank screen.
    const vOld = await store.validateClientLink(ok1.linkId);
    assert(vOld.valid === false, 'old device link no longer validates after regen');

    // The old code is dead for everyone.
    const oldCodeRedeem = await store.redeemInvite(inv.code, 'Priya Nair', 'dev-2');
    assert(!oldCodeRedeem.ok && oldCodeRedeem.error === 'revoked', 'old code -> revoked after regen');

    // The NEW device redeems the fresh code and instantly sees the escrow's
    // current checklist state (the step toggled above).
    const ok2 = await store.redeemInvite(regen.invite.code, 'Priya Nair', 'dev-2');
    assert(ok2.ok === true, 'new device redeems the fresh code');
    if (!ok2.ok) throw new Error('new-device redeem failed');
    assert(ok2.role === 'buyer' && ok2.escrowId === escrow.id, 'new link binds the same escrow + role');
    const link2 = await store.getLinkForInvite(regen.invite.id);
    assert(link2 !== null && link2.deviceId === 'dev-2', 'new link binds the new device id');
    const view = await store.getBuyerView(escrow.id);
    const toggled = view.steps.find((s) => s.id === stepId);
    assert(toggled !== undefined && toggled.done === true, 'new device sees current escrow checklist state');
    const v2 = await store.validateClientLink(ok2.linkId);
    assert(v2.valid === true, 'new device link validates');
  }

  // --------------------------------------- supabase platform storage (7/8) --
  await supabasePlatformTests();

  summary('auth');
}

async function supabasePlatformTests(): Promise<void> {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'fake-key';

  let spec: string | null = null;
  try {
    spec = require.resolve('@supabase/supabase-js');
  } catch {
    spec = null;
  }
  if (!spec) {
    console.log('ok   - (supabase-js not resolvable: platform storage tests skipped)');
    return;
  }
  const supabasePath: string = require.resolve('../src/lib/supabase.js');

  // Stub createClient to capture the auth options per platform kind.
  const captured: { url: string; opts: any }[] = [];
  require.cache[spec] = {
    exports: {
      createClient: (url: string, _key: string, opts: any) => {
        captured.push({ url, opts });
        return { __stubClient: true };
      },
    },
  };
  delete require.cache[supabasePath];
  const stubbed = require(supabasePath);
  stubbed.getSupabaseClient('web');
  stubbed.getSupabaseClient('native');
  assert(captured.length === 2, 'both platform clients are created through createClient');
  const webOpts = captured[0].opts;
  const nativeOpts = captured[1].opts;
  assert(webOpts.auth.persistSession === false, 'web: persistSession false — no session restore');
  assert(webOpts.auth.autoRefreshToken === false, 'web: autoRefreshToken false');
  assert(webOpts.auth.detectSessionInUrl === false, 'web: detectSessionInUrl false');
  assert(nativeOpts.auth.persistSession === true, 'native: persistSession true — session restored');
  assert(nativeOpts.auth.autoRefreshToken === true, 'native: autoRefreshToken true');
  assert(webOpts.auth.storage !== nativeOpts.auth.storage, 'web and native get isolated storage instances');
  // The web storage is memory-backed: it round-trips within the instance.
  await webOpts.auth.storage.setItem('k', 'v');
  assert((await webOpts.auth.storage.getItem('k')) === 'v', 'web storage round-trips in memory');

  // A brand-new web client (fresh page load) starts with no session — the
  // real client, not the stub.
  delete require.cache[spec];
  delete require.cache[supabasePath];
  const real = require(supabasePath);
  const webClient = real.getSupabaseClient('web');
  assert(webClient !== null, 'configured web client is created');
  const { data } = await webClient.auth.getSession();
  assert(data.session === null || data.session === undefined, 'fresh web client has no session (never restored)');

  // Unconfigured -> null client.
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  delete require.cache[supabasePath];
  const bare = require(supabasePath);
  assert(bare.getSupabaseClient('web') === null, 'unconfigured -> null client');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
