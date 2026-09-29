// Clear to Close — send-client-push Edge Function.
//
// DB trigger (0008/0021/0022) -> pg_net POSTs here with an
// X-Trigger-Secret header -> this function resolves the realtor's first
// name + the escrow's live push tokens and sends via the Expo Push API.
//
// Send paths:
//   * step/key-date trigger events: immediate send, quiet-hours aware.
//   * flush_step_pushes (pg_cron, every minute): coalesce each escrow's
//     buffered check-offs (~2 min window), drain the delayed queue.
//   * quiet_checkin_sweep (pg_cron, hourly): five-day quiet check-ins.
//
// Guards on EVERY path (approved rules, Anuraj Sept 28 2026):
//   * revoked links / revoked invites never get pushes,
//   * closed/cancelled escrows never get pushes,
//   * 21:00-08:00 client-local -> queued for 08:00, never buzzed,
//   * multi-escrow devices get the property address in the body,
//   * delivery failure is logged (push_delivery_log) and never fails the
//     realtor's write (all sends are async to the write that caused them).
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
  buildCoalescedBody,
  buildPushBody,
  buildQuietCheckinBody,
  daysUntilClose,
  deadTokensFromReceipts,
  isQuietHour,
  nextMorning8am,
  parseTriggerPayload,
  resolveZone,
  toExpoMessages,
  withAddress,
  COALESCE_WINDOW_MS,
  type ExpoMessage,
  type PushEvent,
} from './push.ts';

// PUSH_INLINE_MARKER — the generator replaces the './push.ts' import above
// with the contents of push.ts. Do not remove this comment.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface SupaClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args?: any): any;
}

interface LiveToken {
  expo_push_token: string;
  role: string;
  timezone: string | null;
  escrowIds: string[];
}

interface EscrowInfo {
  id: string;
  address: string;
  status: string;
  realtorFirst: string;
}

async function getEscrowInfo(supa: SupaClient, escrowId: string): Promise<EscrowInfo | null> {
  const { data: escrow } = await supa
    .from('escrows')
    .select('id, address, status, user_id')
    .eq('id', escrowId)
    .maybeSingle();
  if (!escrow) return null;
  const { data: profile } = await supa
    .from('realtor_profiles')
    .select('name')
    .eq('user_id', (escrow as { user_id: string }).user_id)
    .maybeSingle();
  const name = ((profile as { name?: string } | null)?.name ?? '').trim();
  return {
    id: (escrow as { id: string }).id,
    address: ((escrow as { address?: string }).address ?? '').trim(),
    status: (escrow as { status?: string }).status ?? '',
    realtorFirst: name.split(/\s+/)[0] || 'Your realtor',
  };
}

/**
 * Live tokens for one escrow: link live, invite live, escrow open.
 * Revoked links, revoked invites, and closed/cancelled escrows yield zero
 * tokens here — they never get pushes.
 */
async function getLiveTokens(supa: SupaClient, escrow: EscrowInfo): Promise<LiveToken[]> {
  if (escrow.status !== 'open') return [];
  const { data: tokenRows } = await supa
    .from('push_tokens')
    .select('expo_push_token, device_id, timezone, client_links!inner(role, revoked_at, invites!inner(revoked_at))')
    .eq('escrow_id', escrow.id);
  const rows = ((tokenRows ?? []) as Array<{
    expo_push_token: string;
    device_id: string;
    timezone: string | null;
    client_links: { role: string; revoked_at: string | null; invites: { revoked_at: string | null } };
  }>).filter((r) => !r.client_links.revoked_at && !r.client_links.invites.revoked_at);
  if (rows.length === 0) return [];
  // Multi-escrow: how many escrows does each device hold tokens for?
  const deviceIds = [...new Set(rows.map((r) => r.device_id))];
  const { data: escrowRows } = await supa
    .from('push_tokens')
    .select('device_id, escrow_id')
    .in('device_id', deviceIds);
  const byDevice = new Map<string, string[]>();
  for (const r of ((escrowRows ?? []) as Array<{ device_id: string; escrow_id: string }>)) {
    const list = byDevice.get(r.device_id) ?? [];
    if (!list.includes(r.escrow_id)) list.push(r.escrow_id);
    byDevice.set(r.device_id, list);
  }
  return rows.map((r) => ({
    expo_push_token: r.expo_push_token,
    role: r.client_links.role,
    timezone: r.timezone,
    escrowIds: byDevice.get(r.device_id) ?? [escrow.id],
  }));
}

interface QueuedPush {
  expo_push_token: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

async function logDeliveryFailure(
  supa: SupaClient,
  event: string,
  escrowId: string | null,
  detail: string,
): Promise<void> {
  try {
    // eslint-disable-next-line no-console
    console.error(`[send-client-push] delivery failed (${event}): ${detail}`);
    await supa.from('push_delivery_log').insert({ event, escrow_id: escrowId, detail });
  } catch {
    // logging must never break the send path
  }
}

async function sendExpoMessages(
  supa: SupaClient,
  messages: ExpoMessage[],
  env: Record<string, string | undefined>,
  event: string,
  escrowId: string | null,
): Promise<{ sent: number; deadRemoved: number }> {
  if (messages.length === 0) return { sent: 0, deadRemoved: 0 };
  let expoRes: Response;
  try {
    expoRes = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env['EXPO_ACCESS_TOKEN'] ?? ''}`,
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    await logDeliveryFailure(supa, event, escrowId, `expo fetch threw: ${String(err)}`);
    return { sent: 0, deadRemoved: 0 };
  }
  if (!expoRes.ok) {
    await logDeliveryFailure(supa, event, escrowId, `expo_push_failed status=${expoRes.status}`);
    return { sent: 0, deadRemoved: 0 };
  }
  const expoJson = (await expoRes.json()) as {
    data?: Array<{ status: 'ok' | 'error'; details?: { error?: string }; id?: string }>;
  };
  const receipts: Record<string, { status: 'ok' | 'error'; details?: { error?: string } }> = {};
  (expoJson.data ?? []).forEach((r, i) => {
    if (messages[i]) receipts[messages[i].to] = r;
  });
  const dead = deadTokensFromReceipts(messages, receipts);
  for (const token of dead) {
    await supa.from('push_tokens').delete().eq('expo_push_token', token);
  }
  return { sent: messages.length, deadRemoved: dead.length };
}

/**
 * Deliver one push body to an escrow's live tokens, honoring quiet hours.
 * kind is recorded on queued rows so the drain can re-validate check-ins.
 */
async function deliver(
  supa: SupaClient,
  env: Record<string, string | undefined>,
  escrow: EscrowInfo,
  tokens: LiveToken[],
  body: string,
  data: Record<string, unknown>,
  kind: 'step' | 'keydate' | 'checkin',
): Promise<{ sent: number; queued: number; deadRemoved: number }> {
  const now = new Date();
  const immediate: ExpoMessage[] = [];
  let queued = 0;
  for (const t of tokens) {
    const zone = resolveZone(t.timezone);
    const addressed = withAddress(body, escrow.address, t.escrowIds.length > 1);
    if (isQuietHour(now, zone)) {
      // Queue for 08:00 client-local; never buzz at night.
      await supa.from('push_queue').insert({
        expo_push_token: t.expo_push_token,
        title: 'Clear to Close',
        body: addressed,
        data: { ...data, role: t.role },
        kind,
        escrow_id: escrow.id,
        send_after: nextMorning8am(now, zone).toISOString(),
      });
      queued++;
    } else {
      immediate.push({
        to: t.expo_push_token,
        sound: 'default',
        title: 'Clear to Close',
        body: addressed,
        data: { escrowId: escrow.id, role: t.role },
      });
    }
  }
  const { sent, deadRemoved } = await sendExpoMessages(supa, immediate, env, kind, escrow.id);
  return { sent, queued, deadRemoved };
}

/** Drain due queued pushes. Check-ins re-validate: a check-off that landed
 *  while queued cancels the stale check-in (no duplicate). */
async function drainQueue(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<{ sent: number; dropped: number }> {
  const { data: rows } = await supa
    .from('push_queue')
    .select('id, expo_push_token, title, body, data, kind, escrow_id, queued_at')
    .lte('send_after', new Date().toISOString())
    .order('send_after', { ascending: true })
    .limit(100);
  const list = (rows ?? []) as Array<{
    id: string;
    expo_push_token: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    kind: string;
    escrow_id: string | null;
    queued_at: string;
  }>;
  let sent = 0;
  let dropped = 0;
  for (const row of list) {
    let valid = true;
    if (row.kind === 'checkin' && row.escrow_id) {
      // Still due? Escrow open, open steps remain, and no forward check-off
      // since queueing (the durable server-side activity stamp — a stale
      // completed_at on an unchecked step must not count).
      const { data: esc } = await supa
        .from('escrows')
        .select('status, last_checkoff_activity_at, created_at')
        .eq('id', row.escrow_id)
        .maybeSingle();
      const { data: steps } = await supa
        .from('steps')
        .select('done')
        .eq('escrow_id', row.escrow_id);
      const stepList = (steps ?? []) as Array<{ done: boolean }>;
      const hasOpen = stepList.some((s) => !s.done);
      const escRow = (esc ?? {}) as {
        status?: string;
        last_checkoff_activity_at?: string | null;
        created_at?: string | null;
      };
      const activityAt = escRow.last_checkoff_activity_at ?? escRow.created_at;
      const activitySince =
        !!activityAt && new Date(activityAt).getTime() > new Date(row.queued_at).getTime();
      valid = escRow.status === 'open' && hasOpen && !activitySince;
    }
    await supa.from('push_queue').delete().eq('id', row.id);
    if (!valid) {
      dropped++;
      continue;
    }
    const msg: ExpoMessage = {
      to: row.expo_push_token,
      sound: 'default',
      title: row.title || 'Clear to Close',
      body: row.body,
      data: { escrowId: (row.data?.['escrowId'] as string) ?? '', role: (row.data?.['role'] as string) ?? 'buyer' },
    };
    const r = await sendExpoMessages(supa, [msg], env, `queue:${row.kind}`, row.escrow_id);
    sent += r.sent;
  }
  return { sent, dropped };
}

interface PendingGroup {
  escrow_id: string;
  push_count: number;
  events: string[];
  titles: string[];
  oldest_at: string;
}

/** Per-minute tick: coalesce buffered check-offs, then drain the queue. */
async function handleFlush(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const drained = await drainQueue(supa, env);
  const cutoff = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
  const { data: rows } = await supa
    .from('pending_step_pushes')
    .select('escrow_id, event, step_title, created_at')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(500);
  const list = (rows ?? []) as Array<{
    escrow_id: string;
    event: string;
    step_title: string;
    created_at: string;
  }>;
  const groups = new Map<string, PendingGroup>();
  for (const r of list) {
    const g = groups.get(r.escrow_id) ?? {
      escrow_id: r.escrow_id,
      push_count: 0,
      events: [],
      titles: [],
      oldest_at: r.created_at,
    };
    g.push_count++;
    g.events.push(r.event);
    g.titles.push(r.step_title);
    groups.set(r.escrow_id, g);
  }
  let flushed = 0;
  let sent = 0;
  let queued = 0;
  for (const g of groups.values()) {
    const escrow = await getEscrowInfo(supa, g.escrow_id);
    if (!escrow) {
      await supa.from('pending_step_pushes').delete().eq('escrow_id', g.escrow_id);
      continue;
    }
    const tokens = await getLiveTokens(supa, escrow);
    let body: string | null;
    if (g.push_count === 1) {
      // Single check-off: the exact FINAL copy (Sept 26 2026).
      const ev = g.events[0] as PushEvent;
      body = buildPushBody(ev, escrow.realtorFirst, g.titles[0], null, null);
    } else {
      body = buildCoalescedBody(g.push_count);
    }
    if (body && tokens.length > 0) {
      const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'step');
      sent += d.sent;
      queued += d.queued;
    }
    // Rows are gone once sent or safely queued; on delivery failure they
    // stay and retry next tick (at-least-once beats silent loss).
    if (body && tokens.length > 0) {
      await supa.from('pending_step_pushes').delete().eq('escrow_id', g.escrow_id);
      flushed++;
    } else if (tokens.length === 0) {
      // Nobody to notify (revoked/closed): drop the buffer, don't accumulate.
      await supa.from('pending_step_pushes').delete().eq('escrow_id', g.escrow_id);
      flushed++;
    }
  }
  return json({ ok: true, flushed, sent, queued, queue: drained });
}

interface CheckinCandidate {
  escrow_id: string;
  address: string;
  close_date: string;
  done_count: number;
  total_count: number;
  realtor_first: string | null;
  expo_push_token: string;
  timezone: string | null;
  link_role: string;
}

/** Hourly tick: five-day quiet check-ins, once per quiet stretch. */
async function handleSweep(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const { data: rows, error } = await supa.rpc('due_quiet_checkins');
  if (error) {
    await logDeliveryFailure(supa, 'quiet_checkin_sweep', null, `due_quiet_checkins rpc: ${error.message}`);
    return json({ ok: false, error: 'sweep_query_failed' }, 500);
  }
  const list = (rows ?? []) as CheckinCandidate[];
  const byEscrow = new Map<string, CheckinCandidate[]>();
  for (const r of list) {
    const group = byEscrow.get(r.escrow_id) ?? [];
    group.push(r);
    byEscrow.set(r.escrow_id, group);
  }
  let sent = 0;
  let queued = 0;
  let escrows = 0;
  const now = new Date();
  for (const [escrowId, candidates] of byEscrow) {
    const first = candidates[0];
    const days = daysUntilClose(first.close_date, now, first.timezone);
    const body = buildQuietCheckinBody(first.done_count, first.total_count, days);
    if (!body) continue;
    // Mark sent BEFORE delivering: one check-in per quiet stretch even if
    // some tokens are queued for morning.
    await supa.rpc('mark_quiet_checkin_sent', { p_escrow_id: escrowId });
    escrows++;
    for (const c of candidates) {
      const zone = resolveZone(c.timezone);
      // Multi-escrow address: does this device hold other escrows?
      const { data: devRows } = await supa
        .from('push_tokens')
        .select('escrow_id')
        .eq('expo_push_token', c.expo_push_token);
      const otherEscrows = ((devRows ?? []) as Array<{ escrow_id: string }>).filter(
        (r) => r.escrow_id !== escrowId,
      ).length;
      const finalBody = withAddress(body, c.address, otherEscrows > 0);
      if (isQuietHour(now, zone)) {
        await supa.from('push_queue').insert({
          expo_push_token: c.expo_push_token,
          title: 'Clear to Close',
          body: finalBody,
          data: { escrowId, role: c.link_role },
          kind: 'checkin',
          escrow_id: escrowId,
          send_after: nextMorning8am(now, zone).toISOString(),
        });
        queued++;
      } else {
        const msg: ExpoMessage = {
          to: c.expo_push_token,
          sound: 'default',
          title: 'Clear to Close',
          body: finalBody,
          data: { escrowId, role: c.link_role },
        };
        const r = await sendExpoMessages(supa, [msg], env, 'checkin', escrowId);
        sent += r.sent;
      }
    }
  }
  return json({ ok: true, escrows, sent, queued });
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

  // Internal cron events carry no escrow.
  if (payload.event === 'flush_step_pushes') return handleFlush(supa, env);
  if (payload.event === 'quiet_checkin_sweep') return handleSweep(supa, env);

  const escrowId = payload.escrow_id as string;
  const escrow = await getEscrowInfo(supa, escrowId);
  if (!escrow) return json({ ok: true, sent: 0 });

  const body = buildPushBody(
    payload.event,
    escrow.realtorFirst,
    payload.step_title,
    payload.new_close_date,
    payload.new_date,
  );
  if (!body) {
    // Honest copy impossible (missing title/date) — drop, don't misfire.
    return json({ ok: true, dropped: true });
  }

  // Live tokens only: revoked links, revoked invites, and closed/cancelled
  // escrows never get pushes.
  const tokens = await getLiveTokens(supa, escrow);
  if (tokens.length === 0) return json({ ok: true, sent: 0 });

  const d = await deliver(supa, env, escrow, tokens, body, { escrowId }, 'keydate');
  return json({ ok: true, sent: d.sent, queued: d.queued, dead_removed: d.deadRemoved });
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
