// Clear to Close — client-realtime-token Edge Function.
//
// Mints short-lived realtime JWTs for client devices (buyer/seller/TC).
// Clients have no login; they authenticate by device link. This function
// validates (link_id, device_id) server-side and signs a 15-minute JWT
// with the project's JWT secret (SUPABASE_JWT_SECRET, provided by the
// platform). The client passes the token to realtime.setAuth(); the
// 0030 RLS policies admit exactly that token's escrow while its device
// link is live.
//
// Request:  POST { link_id: string, device_id: string }
// Response: { ok: true, token, expires_at } | { ok: false, error }
//
// SINGLE-FILE-SOURCE: this file is the canonical source.
// tools/make_client_realtime_token_single.py copies it verbatim to
// ~/workspace/your_files/client-realtime-token-single.ts for the
// dashboard-paste deploy. Never hand-edit the generated file.
//
// Dashboard -> Edge Functions -> client-realtime-token -> Secrets: none
// required beyond the platform-provided SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET. The anon key in the
// request's Authorization header is NOT trusted for identity — the
// (link_id, device_id) pair is validated against client_links.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes; the client refreshes early.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa is available in the Edge Function runtime.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const parts = [
    base64UrlEncode(enc.encode(JSON.stringify(header))),
    base64UrlEncode(enc.encode(JSON.stringify(payload))),
  ].join('.');
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(parts));
  return parts + '.' + base64UrlEncode(new Uint8Array(sig));
}

interface LinkRow {
  id: string;
  escrow_id: string;
  role: string;
  device_id: string | null;
  revoked_at: string | null;
  invites: { revoked_at: string | null } | null;
}

async function handle(
  req: Request,
  env: Record<string, string | undefined>,
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  const url = env['SUPABASE_URL'] ?? '';
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  const jwtSecret = env['SUPABASE_JWT_SECRET'] ?? '';
  if (!url || !serviceKey || !jwtSecret) {
    return json({ ok: false, error: 'misconfigured' }, 500);
  }

  let body: { link_id?: unknown; device_id?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const linkId =
    typeof body.link_id === 'string' ? body.link_id.trim() : '';
  const deviceId =
    typeof body.device_id === 'string' ? body.device_id.trim() : '';
  if (!linkId || !deviceId) {
    return json({ ok: false, error: 'missing_params' }, 400);
  }

  // Validate the device link with the service role (bypasses RLS): the
  // link must exist, be unrevoked, sit on an unrevoked invite, and be
  // bound to this device (when the link carries a device binding).
  let link: LinkRow | null = null;
  try {
    const res = await fetch(
      url +
        '/rest/v1/client_links?select=id,escrow_id,role,device_id,revoked_at,invites(revoked_at)&id=eq.' +
        encodeURIComponent(linkId) +
        '&limit=1',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          Accept: 'application/json',
        },
      },
    );
    if (!res.ok) return json({ ok: false, error: 'lookup_failed' }, 500);
    const rows = (await res.json()) as LinkRow[];
    link = rows.length > 0 ? rows[0] : null;
  } catch {
    return json({ ok: false, error: 'lookup_failed' }, 500);
  }

  if (!link) return json({ ok: false, error: 'invalid' }, 401);
  if (link.revoked_at) return json({ ok: false, error: 'revoked' }, 401);
  if (link.invites && link.invites.revoked_at) {
    return json({ ok: false, error: 'revoked' }, 401);
  }
  // Device binding: a link bound to a device only mints tokens for that
  // device. Unbound (legacy) links accept the presenting device.
  if (link.device_id && link.device_id !== deviceId) {
    return json({ ok: false, error: 'device_mismatch' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      role: 'anon',
      device_link_id: link.id,
      escrow_id: link.escrow_id,
      link_role: link.role,
      iss: 'ctc-client-realtime-token',
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    jwtSecret,
  );
  return json({
    ok: true,
    token,
    expires_at: now + TOKEN_TTL_SECONDS,
  });
}

// Deno.serve is declared by the Edge Function runtime types; the local
// tsc guard below keeps the repo's node typecheck from choking.
declare const Deno: {
  env: { get(k: string): string | undefined };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serve(h: (req: Request) => Promise<Response> | Response): any;
};

serve((req: Request) =>
  handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_JWT_SECRET: Deno.env.get('SUPABASE_JWT_SECRET'),
  }),
);
