// Clear to Close — delete-account Edge Function (Nov 2026, Stream 4).
//
// In-app account deletion (App Store Guideline 5.1.1(v) preempt;
// auditor PASS WITH CONDITIONS). The app calls this with the caller's
// session token and ONE body field: the password, re-entered on the
// confirmation screen. There is nothing else the body can say.
//
// Identity (auditor, binding): the caller is derived ONLY from the
// JWT — the token is validated against the auth server and the user
// record it names is the deletion target. Identity-shaped fields on
// the request body are never read, so a body cannot name another
// victim; the password is re-verified against the JWT user's OWN
// email only, never against an address the request supplies (that
// would be a password-guessing oracle for other people's accounts).
//
// Step order (auditor, binding; every step idempotent/retry-safe):
//   1. Global session revocation for the user. Failure aborts
//      before anything is destroyed.
//   2. Storage: the caller's whole prefix in the realtor-media
//      bucket is removed and verified empty by listing. Failure
//      ABORTS with the account intact (orphaned public photos are
//      the worst residue, so storage goes before data).
//   3. Data: the service-role-only definer RPC (migration 0052)
//      deletes every owned row in one transaction. Failure means
//      nothing was deleted (the transaction rolls back).
//   4. The auth user is deleted LAST, via the admin API.
// If step 4 fails after step 3 committed, the account is a husk:
// data gone, sign-in still present. The function reports that as a
// distinct outcome ('husk') and the app lands the user on a
// complete-deletion / log-out offer instead of a broken home; a
// retry of this function finishes the job (steps 1-3 are no-ops).
//
// Secrets: SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY — all provided by the platform.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

const BUCKET = 'realtor-media';
const STORAGE_PAGE = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The request body contract: exactly one meaningful field, the
 * password. Anything else a client sends is ignored by construction
 * (never destructured, never consulted).
 */
export function parseDeleteRequestBody(
  raw: unknown,
): { password: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { password?: unknown };
  if (typeof body.password !== 'string' || body.password.length === 0) {
    return null;
  }
  return { password: body.password };
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

async function handle(
  req: Request,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const url = env['SUPABASE_URL'] ?? '';
  const anonKey = env['SUPABASE_ANON_KEY'] ?? '';
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  if (!url || !anonKey || !serviceKey) {
    return json({ ok: false, error: 'unconfigured' }, 500);
  }

  const token = bearerToken(req);
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401);

  // Identity ONLY from the JWT: the auth server validates the token
  // and names the user. Nothing in the body can influence this.
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user || !user.id || !user.email) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const parsed = parseDeleteRequestBody(raw);
  if (!parsed) return json({ ok: false, error: 'bad_request' }, 400);

  // Password re-verification against the JWT user's OWN email only.
  // A throwaway client: the check-in leaves no session behind.
  const checker = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: pwError } = await checker.auth.signInWithPassword({
    email: user.email,
    password: parsed.password,
  });
  if (pwError) return json({ ok: false, error: 'wrong_password' }, 401);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Step 1: global session revocation. Abort before destruction on
  // failure; a retry re-runs it harmlessly.
  const { error: revokeError } = await admin.auth.admin.signOut(user.id, 'global');
  if (revokeError) {
    console.warn('delete-account: revocation failed', user.id, revokeError.message);
    return json({ ok: false, error: 'revoke_failed' }, 502);
  }

  // Step 2: storage. Remove the caller's whole prefix, then verify
  // by listing that nothing remains. Abort with the account intact
  // on any storage failure.
  try {
    for (;;) {
      const { data: page, error: listError } = await admin.storage
        .from(BUCKET)
        .list(user.id, { limit: STORAGE_PAGE, offset: 0 });
      if (listError) throw listError;
      if (!page || page.length === 0) break;
      const paths = page.map((o) => `${user.id}/${o.name}`);
      const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
      if (removeError) throw removeError;
      if (page.length < STORAGE_PAGE) break;
    }
    const { data: remaining, error: verifyError } = await admin.storage
      .from(BUCKET)
      .list(user.id, { limit: 1, offset: 0 });
    if (verifyError) throw verifyError;
    if (remaining && remaining.length > 0) {
      throw new Error('storage prefix not empty after removal');
    }
  } catch (err) {
    console.warn('delete-account: storage removal failed', user.id, err);
    return json({ ok: false, error: 'storage_failed' }, 502);
  }

  // Step 3: the data transaction (migration 0052). The JWT email is
  // passed so still-pending team invites addressed to it are purged;
  // it comes from the verified token, never from the request body.
  const { data: rpcData, error: rpcError } = await admin.rpc('delete_account_data', {
    p_uid: user.id,
    p_email: user.email,
  });
  if (rpcError || !rpcData || (rpcData as { ok?: boolean }).ok !== true) {
    console.warn('delete-account: data RPC failed', user.id, rpcError?.message ?? rpcData);
    return json({ ok: false, error: 'data_failed' }, 502);
  }

  // Step 4: the auth user, LAST. Failure here (with the data already
  // committed) is the husk outcome, reported distinctly.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    console.warn('delete-account: auth delete failed after data commit', user.id, deleteError.message);
    return json({ ok: true, outcome: 'husk' });
  }

  return json({ ok: true, outcome: 'deleted' });
}

// Deno.serve is only invoked on the platform; node test runs import
// the pure helpers above without executing this block.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  serve((req: Request) => handle(req, Deno.env.toObject() as Record<string, string | undefined>));
}

// Exported for unit tests (node): the handler takes env explicitly so
// tests never need Deno.
export { handle };
