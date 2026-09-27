// Clear to Close — send-client-push Edge Function.
//
// DB trigger (0008_push_tokens.sql) -> pg_net POSTs here with an
// X-Trigger-Secret header -> this function resolves the realtor's first
// name + the escrow's live push tokens and sends via the Expo Push API.
//
// Secrets (Dashboard -> Edge Functions -> send-client-push -> Secrets):
//   PUSH_TRIGGER_SECRET — must match the Vault value minted by the migration
//                         (printed once as RAISE NOTICE on dashboard run).
//   EXPO_ACCESS_TOKEN   — created at expo.dev -> Access Tokens.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided by the platform.
//
// SINGLE-FILE-SOURCE: this file + ./push.ts are the canonical sources.
// tools/make_send_client_push_single.py inlines push.ts into this file and
// writes the dashboard-paste single file to
// ~/workspace/your_files/send-client-push-single.ts. Never hand-edit the
// generated file; fix the sources and regenerate.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import {
  buildPushBody,
  deadTokensFromReceipts,
  parseTriggerPayload,
  toExpoMessages,
} from './push.ts';

// PUSH_INLINE_MARKER — the generator replaces the './push.ts' import above
// with the contents of push.ts. Do not remove this comment.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface SupaClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

async function handle(req: Request, env: Record<string, string | undefined>): Promise<Response> {
  const secret = env['PUSH_TRIGGER_SECRET'];
  if (!secret || req.headers.get('X-Trigger-Secret') !== secret) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const payload = parseTriggerPayload(raw);
  if (!payload) return json({ ok: false, error: 'bad_payload' }, 400);

  const supa = createClient(
    env['SUPABASE_URL'] ?? '',
    env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  ) as unknown as SupaClient;

  // Realtor first name (for the copy) via the escrow's owner.
  const { data: escrow } = await supa
    .from('escrows')
    .select('user_id')
    .eq('id', payload.escrow_id)
    .maybeSingle();
  const { data: profile } = escrow
    ? await supa.from('realtor_profiles').select('name').eq('user_id', escrow.user_id).maybeSingle()
    : { data: null };

  const body = buildPushBody(
    payload.event,
    (profile as { name?: string } | null)?.name ?? null,
    payload.step_title,
    payload.new_close_date,
  );
  if (!body) {
    // Honest copy impossible (missing title/date) — drop, don't misfire.
    return json({ ok: true, dropped: true });
  }

  // Live tokens only: revoked links (and revoked invites) never get pushes.
  const { data: tokenRows } = await supa
    .from('push_tokens')
    .select('expo_push_token, client_links!inner(role, revoked_at, invites!inner(revoked_at))')
    .eq('escrow_id', payload.escrow_id);
  const tokens = ((tokenRows ?? []) as Array<{
    expo_push_token: string;
    client_links: { role: string; revoked_at: string | null; invites: { revoked_at: string | null } };
  }>)
    .filter((r) => !r.client_links.revoked_at && !r.client_links.invites.revoked_at)
    .map((r) => ({ expo_push_token: r.expo_push_token, role: r.client_links.role }));

  if (tokens.length === 0) return json({ ok: true, sent: 0 });

  const messages = toExpoMessages(tokens, body, payload.escrow_id);
  const expoRes = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env['EXPO_ACCESS_TOKEN'] ?? ''}`,
    },
    body: JSON.stringify(messages),
  });
  if (!expoRes.ok) {
    return json({ ok: false, error: 'expo_push_failed', status: expoRes.status }, 502);
  }
  const expoJson = (await expoRes.json()) as {
    data?: Array<{ status: 'ok' | 'error'; details?: { error?: string }; id?: string }>;
  };
  // Expo returns receipts in request order; map them back to messages.
  const receipts: Record<string, { status: 'ok' | 'error'; details?: { error?: string } }> = {};
  (expoJson.data ?? []).forEach((r, i) => {
    if (messages[i]) receipts[messages[i].to] = r;
  });
  const dead = deadTokensFromReceipts(messages, receipts);
  for (const token of dead) {
    await supa.from('push_tokens').delete().eq('expo_push_token', token);
  }

  return json({ ok: true, sent: messages.length, dead_removed: dead.length });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Deno.serve is only invoked on the platform; node test runs import the
// pure helpers above without executing this block.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  serve((req: Request) => handle(req, Deno.env.toObject() as Record<string, string | undefined>));
}

// Exported for unit tests (node): the handler takes env explicitly so tests
// never need Deno.
export { handle };
