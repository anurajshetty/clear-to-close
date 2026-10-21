// Clear to Close — send-client-push Edge Function.
//
// DB trigger (0008/0021/0022) -> pg_net POSTs here with an
// X-Trigger-Secret header -> this function resolves the realtor's first
// name + the escrow's live push tokens and sends via the Expo Push API.
//
// Send paths:
//   * step/key-date trigger events: immediate send, quiet-hours aware.
//   * flush_step_pushes (pg_cron, every minute): coalesce each escrow's
//     buffered check-offs (~2 min window), drain the delayed queue,
//     drain the P1 event outbox (0040) and the Team Access kinds (0044:
//     team invites, invite acceptances, member step activity — every
//     recipient/validity decision is made at drain time from the live
//     grant row, R4; no-account invitees get the invite email instead,
//     capped at 20 per owner per rolling 24h, R5).
//   * quiet_checkin_sweep (pg_cron, hourly): five-day quiet check-ins.
//   * date_reminder_sweep (pg_cron, hourly): P2 date reminders (0041) —
//     candidates per recipient timezone, claimed once per (date, token)
//     in push_reminder_log before delivery; quiet-hours-queued rows
//     re-validate at drain so stale "tomorrow" copy never lands.
//
// Guards on EVERY path (approved rules, Anuraj Sept 28 2026):
//   * revoked links / revoked invites never get pushes,
//   * closed/cancelled escrows never get pushes — ONE deliberate
//     exception (P1, 0040): the closed/cancelled announcement itself is
//     delivered to the tokens snapshotted at the transition moment,
//   * 21:00-08:00 client-local -> queued for 08:00, never buzzed,
//   * multi-escrow devices get the property address in the body,
//   * delivery failure is logged (push_delivery_log) and never fails the
//     realtor's write (all sends are async to the write that caused them).
//
// Secrets (Dashboard -> Edge Functions -> send-client-push -> Secrets):
//   PUSH_TRIGGER_SECRET — must match the Vault value minted by the migration
//                         (printed once as RAISE NOTICE on dashboard run).
//   EXPO_ACCESS_TOKEN   — created at expo.dev -> Access Tokens.
//   RESEND_API_KEY      — Resend API key for the Team Access invite
//                         email (no-account invitees only). The From
//                         address is push_config key 'invite_from_email'.
//                         Missing either one: the email is skipped
//                         silently, the invite itself is unaffected.
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
  buildEventBody,
  buildMemberActivityBody,
  buildPushBody,
  buildQuietCheckinBody,
  buildReminderBody,
  buildTeamInviteEmail,
  collapseBurstEvents,
  daysUntilClose,
  deadTokensFromReceipts,
  groupMemberActivityRows,
  isQuietHour,
  nextMorning8am,
  parseTriggerPayload,
  planTeamInviteAccepted,
  planTeamInviteReceived,
  teamQuietQueue,
  resolveZone,
  rolesForPushEvent,
  splitStepPushesByAudience,
  toExpoMessages,
  withAddress,
  COALESCE_WINDOW_MS,
  type BufferedStepPush,
  type ClientLinkRole,
  type ExpoMessage,
  type MemberActivityFact,
  type PushEvent,
  type ReminderEvent,
  type TeamGrantSnapshot,
  type TeamInviteEmail,
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
  /** Snapshot rows (closed/cancelled) carry their multi-escrow flag
   *  directly; live rows derive it from escrowIds. */
  multi?: boolean;
}

interface EscrowInfo {
  id: string;
  address: string;
  status: string;
  realtorFirst: string;
  userId: string;
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
    userId: (escrow as { user_id: string }).user_id,
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

/**
 * One user's own devices (0038 user-bound token rows), for pushes
 * addressed to a realtor-side account rather than a client link. A
 * user with several devices gets the push on each; tap data carries
 * role 'realtor' so the app routes to the realtor side.
 */
async function getUserPushTokens(
  supa: SupaClient,
  userId: string,
  escrowId: string,
): Promise<LiveToken[]> {
  const { data: tokenRows } = await supa
    .from('push_tokens')
    .select('expo_push_token, device_id, timezone')
    .eq('user_id', userId);
  const seen = new Set<string>();
  const rows = ((tokenRows ?? []) as Array<{
    expo_push_token: string;
    device_id: string;
    timezone: string | null;
  }>).filter((r) => {
    if (seen.has(r.expo_push_token)) return false;
    seen.add(r.expo_push_token);
    return true;
  });
  if (rows.length === 0) return [];
  const deviceIds = [...new Set(rows.map((r) => r.device_id))];
  const { data: escrowRows } = await supa
    .from('push_tokens')
    .select('device_id, escrow_id')
    .in('device_id', deviceIds);
  const byDevice = new Map<string, string[]>();
  for (const r of ((escrowRows ?? []) as Array<{ device_id: string; escrow_id: string | null }>)) {
    if (!r.escrow_id) continue;
    const list = byDevice.get(r.device_id) ?? [];
    if (!list.includes(r.escrow_id)) list.push(r.escrow_id);
    byDevice.set(r.device_id, list);
  }
  return rows.map((r) => {
    const ids = byDevice.get(r.device_id) ?? [];
    if (!ids.includes(escrowId)) ids.push(escrowId);
    return {
      expo_push_token: r.expo_push_token,
      role: 'realtor',
      timezone: r.timezone,
      escrowIds: ids,
    };
  });
}

/**
 * The escrow owner's own devices (P0.1 user-bound token rows). A realtor
 * with several devices gets the push on each; tap data carries
 * role 'realtor' so the app routes to the realtor escrow screen.
 */
async function getRealtorTokens(supa: SupaClient, escrow: EscrowInfo): Promise<LiveToken[]> {
  return getUserPushTokens(supa, escrow.userId, escrow.id);
}

/** Full profile name, or null when the profile/name is missing. */
async function getProfileName(supa: SupaClient, userId: string): Promise<string | null> {
  const { data } = await supa
    .from('realtor_profiles')
    .select('name')
    .eq('user_id', userId)
    .maybeSingle();
  const name = ((data as { name?: string } | null)?.name ?? '').trim();
  return name || null;
}

// ------------------------------------------------------- Team Access (0044) --

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** Built-in app link when app_config has no usable client_app_link. */
const FALLBACK_CLIENT_APP_LINK = 'https://anurajshetty.github.io/clear-to-close/redeem';

/** The live grant row a team outbox fact refers to (R4 decision input). */
async function getTeamGrant(
  supa: SupaClient,
  grantId: string,
): Promise<TeamGrantSnapshot | null> {
  const { data } = await supa
    .from('escrow_team_grants')
    .select('id, escrow_id, invited_email, user_id, role, status, invited_by')
    .eq('id', grantId)
    .maybeSingle();
  return (data as TeamGrantSnapshot | null) ?? null;
}

async function getPushConfigValue(supa: SupaClient, key: string): Promise<string | null> {
  const { data } = await supa
    .from('push_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  const v = ((data as { value?: string } | null)?.value ?? '').trim();
  return v || null;
}

async function getClientAppLink(supa: SupaClient): Promise<string> {
  const { data } = await supa
    .from('app_config')
    .select('value')
    .eq('key', 'client_app_link')
    .maybeSingle();
  const v = ((data as { value?: string } | null)?.value ?? '').trim();
  return v.startsWith('https://') ? v : FALLBACK_CLIENT_APP_LINK;
}

/** Invite emails this owner has sent in the trailing 24h (cap input). */
async function countRecentInviteEmails(supa: SupaClient, ownerId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supa
    .from('team_invite_email_log')
    .select('id')
    .eq('owner_id', ownerId)
    .gte('sent_at', since);
  return ((data ?? []) as unknown[]).length;
}

/**
 * Send a team push to a realtor-side user's devices, honoring the
 * per-token quiet hours like deliver() does: tokens in quiet hours
 * get a push_queue row (kind 'event', team kind in data) for 08:00
 * recipient-local; the rest send immediately. Unlike deliver() (the
 * client path), team bodies are complete as built — the
 * accepted/activity copy already names the street — so no address
 * suffix is applied. Tap data carries the contract keys
 * { kind, escrow_id } alongside the legacy { escrowId, role } pair.
 * Returns the number of messages sent immediately.
 */
async function sendTeamPush(
  supa: SupaClient,
  env: Record<string, string | undefined>,
  tokens: LiveToken[],
  body: string,
  kind: 'team_invite_received' | 'team_invite_accepted' | 'member_step_activity',
  escrowId: string,
): Promise<number> {
  const now = new Date();
  const messages: ExpoMessage[] = [];
  for (const t of tokens) {
    const data = { escrowId, escrow_id: escrowId, role: 'realtor', kind };
    const quiet = teamQuietQueue(now, t.timezone);
    if (quiet.queued && quiet.sendAfter) {
      await supa.from('push_queue').insert({
        expo_push_token: t.expo_push_token,
        title: 'Clear to Close',
        body,
        data,
        kind: 'event',
        escrow_id: escrowId,
        send_after: quiet.sendAfter,
      });
    } else {
      messages.push({
        to: t.expo_push_token,
        sound: 'default',
        title: 'Clear to Close',
        body,
        data,
      });
    }
  }
  if (messages.length === 0) return 0;
  const { sent } = await sendExpoMessages(supa, messages, env, kind, escrowId);
  return sent;
}

/** One invite email via Resend. True only when Resend accepted it. */
async function sendTeamInviteEmailMessage(
  env: Record<string, string | undefined>,
  from: string,
  to: string,
  email: TeamInviteEmail,
): Promise<boolean> {
  const apiKey = env['RESEND_API_KEY'] ?? '';
  if (!apiKey || !from) return false;
  try {
    const res = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * team_invite_received: the invitee hears about a pending invite. The
 * plan (from the grant's LIVE state) drives both channels: the invite
 * email goes on EVERY invite (Oct 21, 2026 rule), and an account
 * invitee ALSO gets the push. A grant cancelled before the drain
 * sends neither. Returns pushes sent.
 */
async function handleTeamInviteReceived(
  supa: SupaClient,
  env: Record<string, string | undefined>,
  escrow: EscrowInfo,
  row: EventPushRow,
): Promise<number> {
  try {
    const grantId = row.payload['grant_id'];
    if (typeof grantId !== 'string' || !grantId) return 0;
    const grant = await getTeamGrant(supa, grantId);
    if (!grant || grant.status !== 'pending') return 0;
    const from = await getPushConfigValue(supa, 'invite_from_email');
    const emailConfigured = !!(env['RESEND_API_KEY'] && from);
    // The cap counts every invite email the owner sent in 24h, on
    // both branches (Oct 21 rule) — always counted now.
    const sentLast24h = await countRecentInviteEmails(supa, grant.invited_by);
    const ownerName = await getProfileName(supa, escrow.userId);
    const plan = planTeamInviteReceived(grant, {
      ownerName,
      inviteEmailsSentLast24h: sentLast24h,
      emailConfigured,
    });
    if (plan.action !== 'send') return 0;
    let sent = 0;
    if (plan.pushBody) {
      // Account invitee: the push half. No live tokens is fine — the
      // email half below still goes out (never an early return).
      const tokens = await getUserPushTokens(supa, grant.user_id as string, escrow.id);
      if (tokens.length > 0) {
        sent = await sendTeamPush(supa, env, tokens, plan.pushBody, 'team_invite_received', escrow.id);
      }
    }
    if (plan.emailSkip) {
      // Cap reached or sending unconfigured: the email half is
      // suppressed silently; the invite itself is unaffected.
      // eslint-disable-next-line no-console
      console.log(
        `[send-client-push] team invite email skipped (${plan.emailSkip}) grant=${grant.id}`,
      );
      return sent;
    }
    if (!plan.email || !from) return sent;
    const appLink = await getClientAppLink(supa);
    const email = buildTeamInviteEmail({
      ownerName,
      role: grant.role,
      address: escrow.address,
      appLink,
    });
    const ok = await sendTeamInviteEmailMessage(env, from, grant.invited_email, email);
    if (!ok) {
      await logDeliveryFailure(
        supa,
        'team_invite_received',
        escrow.id,
        `invite email send failed grant=${grant.id}`,
      );
      return sent;
    }
    await supa
      .from('team_invite_email_log')
      .insert({ grant_id: grant.id, owner_id: grant.invited_by });
    return sent;
  } catch (err) {
    await logDeliveryFailure(
      supa,
      'team_invite_received',
      escrow.id,
      `team invite handling threw: ${String(err)}`,
    );
    return 0;
  }
}

/**
 * team_invite_accepted: the escrow owner hears that the invitee
 * accepted — only while the grant still stands accepted at drain time.
 */
async function handleTeamInviteAccepted(
  supa: SupaClient,
  env: Record<string, string | undefined>,
  escrow: EscrowInfo,
  row: EventPushRow,
): Promise<number> {
  try {
    const grantId = row.payload['grant_id'];
    if (typeof grantId !== 'string' || !grantId) return 0;
    const grant = await getTeamGrant(supa, grantId);
    const memberName = grant?.user_id ? await getProfileName(supa, grant.user_id) : null;
    const plan = planTeamInviteAccepted(grant, { memberName, street: escrow.address });
    if (plan.action !== 'push') return 0;
    const tokens = await getRealtorTokens(supa, escrow);
    if (tokens.length === 0) return 0;
    return await sendTeamPush(supa, env, tokens, plan.body, 'team_invite_accepted', escrow.id);
  } catch (err) {
    await logDeliveryFailure(
      supa,
      'team_invite_accepted',
      escrow.id,
      `team accepted handling threw: ${String(err)}`,
    );
    return 0;
  }
}

/**
 * member_step_activity: ONE summary push per escrow per drain pass to
 * the escrow owner; every grouped row is consumed by the caller loop.
 */
async function handleMemberActivityGroup(
  supa: SupaClient,
  env: Record<string, string | undefined>,
  escrow: EscrowInfo,
  group: EventPushRow[],
): Promise<number> {
  try {
    const facts: MemberActivityFact[] = group.map((r) => ({
      actor_id: (r.payload['actor_id'] as string | null) ?? null,
      action: (r.payload['action'] as string | null) ?? null,
      title: (r.payload['title'] as string | null) ?? null,
    }));
    const actorId = facts.find((f) => f.actor_id)?.actor_id ?? null;
    const actorName = actorId ? await getProfileName(supa, actorId) : null;
    const body = buildMemberActivityBody(facts, actorName, escrow.address);
    if (!body) return 0;
    const tokens = await getRealtorTokens(supa, escrow);
    if (tokens.length === 0) return 0;
    return await sendTeamPush(supa, env, tokens, body, 'member_step_activity', escrow.id);
  } catch (err) {
    await logDeliveryFailure(
      supa,
      'member_step_activity',
      escrow.id,
      `member activity handling threw: ${String(err)}`,
    );
    return 0;
  }
}

interface EventPushRow {
  id: string;
  escrow_id: string;
  event: PushEvent;
  payload: Record<string, unknown>;
  snapshot_tokens: Array<{
    token: string;
    role: string;
    timezone: string | null;
    escrow_count: number;
  }> | null;
}

/**
 * P1 event outbox drain (0040): join/review events go to the escrow's
 * realtor, custom-step events to the step's side + TC, and
 * closed/cancelled events to the tokens SNAPSHOTTED at transition time
 * (the one deliberate exception to send-time liveness — see 0040).
 * Team Access kinds (0044) ride the same drain: team_invite_received /
 * team_invite_accepted / member_step_activity, each decided from live
 * state at drain time (R4). Every row is consumed exactly once;
 * delivery failures land in push_delivery_log via deliver(), like
 * every other path.
 */
async function handleEventPushes(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<{ processed: number; sent: number; queued: number }> {
  const { data: rows } = await supa
    .from('pending_event_pushes')
    .select('id, escrow_id, event, payload, snapshot_tokens')
    .order('created_at', { ascending: true })
    .limit(100);
  const fetched = (rows ?? []) as EventPushRow[];
  // Intake bursts collapse to one delivery per (escrow, event); the
  // collapsed rows are still consumed below.
  const list = collapseBurstEvents(fetched);
  // Team Access: member step activity coalesces per escrow into ONE
  // summary push per drain pass (all grouped rows still consumed).
  const memberGroups = groupMemberActivityRows(
    list.filter((r) => r.event === 'member_step_activity'),
  );
  const memberHandled = new Set<string>();
  let processed = 0;
  let sent = 0;
  let queued = 0;
  for (const row of list) {
    const escrow = await getEscrowInfo(supa, row.escrow_id);
    if (escrow) {
      if (row.event === 'client_joined' || row.event === 'review_submitted') {
        const body = buildEventBody(row.event, {
          clientName:
            (row.payload['party_name'] as string | null) ??
            (row.payload['client_name'] as string | null) ??
            null,
          clientRole: (row.payload['role'] as string | null) ?? null,
          stars: (row.payload['stars'] as number | null) ?? null,
        });
        const tokens = await getRealtorTokens(supa, escrow);
        if (body && tokens.length > 0) {
          const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'event');
          sent += d.sent;
          queued += d.queued;
        }
      } else if (row.event === 'custom_step_added') {
        if (escrow.status === 'open') {
          const roles = rolesForPushEvent(
            'custom_step_added',
            (row.payload['step_role'] as string | null) ?? null,
          );
          const tokens = (await getLiveTokens(supa, escrow)).filter((t) =>
            roles.includes(t.role as ClientLinkRole),
          );
          const body = buildPushBody('custom_step_added', escrow.realtorFirst, null, null);
          if (body && tokens.length > 0) {
            const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'event');
            sent += d.sent;
            queued += d.queued;
          }
        }
      } else if (
        row.event === 'buyer_intake_submitted' ||
        row.event === 'seller_intake_submitted'
      ) {
        // Option A: the TC (only) hears that an intake was saved.
        if (escrow.status === 'open') {
          const roles = rolesForPushEvent(row.event);
          const tokens = (await getLiveTokens(supa, escrow)).filter((t) =>
            roles.includes(t.role as ClientLinkRole),
          );
          const body = buildEventBody(row.event, {});
          if (body && tokens.length > 0) {
            const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'event');
            sent += d.sent;
            queued += d.queued;
          }
        }
      } else if (row.event === 'halfway_milestone') {
        // P3: every client device (buyer + seller + TC) celebrates the
        // halfway crossing; counts are the crossing-time snapshot.
        if (escrow.status === 'open') {
          const tokens = await getLiveTokens(supa, escrow);
          const body = buildEventBody('halfway_milestone', {
            doneCount: (row.payload['done'] as number | null) ?? null,
            totalCount: (row.payload['total'] as number | null) ?? null,
          });
          if (body && tokens.length > 0) {
            const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'event');
            sent += d.sent;
            queued += d.queued;
          }
        }
      } else if (row.event === 'team_invite_received') {
        // Team Access (0044): decided from the live grant row (R4).
        sent += await handleTeamInviteReceived(supa, env, escrow, row);
      } else if (row.event === 'team_invite_accepted') {
        sent += await handleTeamInviteAccepted(supa, env, escrow, row);
      } else if (row.event === 'member_step_activity') {
        // First row of the escrow's group delivers the summary; the
        // rest of the group is consumed below without re-sending.
        if (!memberHandled.has(row.escrow_id)) {
          memberHandled.add(row.escrow_id);
          sent += await handleMemberActivityGroup(
            supa,
            env,
            escrow,
            memberGroups.get(row.escrow_id) ?? [row],
          );
        }
      } else if (row.event === 'escrow_closed' || row.event === 'escrow_cancelled') {
        const body = buildEventBody(row.event, {
          realtorName: (row.payload['realtor_first'] as string | null) ?? null,
        });
        const tokens: LiveToken[] = (row.snapshot_tokens ?? []).map((s) => ({
          expo_push_token: s.token,
          role: s.role,
          timezone: s.timezone,
          escrowIds: [escrow.id],
          multi: (s.escrow_count ?? 1) > 1,
        }));
        if (body && tokens.length > 0) {
          const d = await deliver(supa, env, escrow, tokens, body, { escrowId: escrow.id }, 'event');
          sent += d.sent;
          queued += d.queued;
        }
      }
    }
    await supa.from('pending_event_pushes').delete().eq('id', row.id);
    processed++;
  }
  // Consume the burst-collapsed duplicates (already counted as one
  // delivery above) so they never re-fire on the next drain.
  const deliveredIds = new Set(list.map((r) => r.id));
  for (const row of fetched) {
    if (!deliveredIds.has(row.id)) {
      await supa.from('pending_event_pushes').delete().eq('id', row.id);
      processed++;
    }
  }
  return { processed, sent, queued };
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
  kind: 'step' | 'keydate' | 'checkin' | 'event' | 'reminder',
): Promise<{ sent: number; queued: number; deadRemoved: number }> {
  const now = new Date();
  const immediate: ExpoMessage[] = [];
  let queued = 0;
  for (const t of tokens) {
    const zone = resolveZone(t.timezone);
    const addressed = withAddress(body, escrow.address, t.multi ?? t.escrowIds.length > 1);
    if (isQuietHour(now, zone)) {
      // Queue for 08:00 client-local; never buzz at night. Reminder rows
      // also carry the recipient zone so the drain can re-validate the
      // threshold in local time (stale "tomorrow" copy must never land).
      await supa.from('push_queue').insert({
        expo_push_token: t.expo_push_token,
        title: 'Clear to Close',
        body: addressed,
        data: { ...data, role: t.role, ...(kind === 'reminder' ? { tz: t.timezone } : {}) },
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
    if (row.kind === 'reminder' && row.escrow_id) {
      // Still true at delivery time? The escrow must still be open, the
      // date must be UNCHANGED since queueing (a moved date re-arms via
      // the sweep's claim key; the stale queued copy must not land), and
      // the threshold must still be exact in the recipient's timezone.
      const rem = (row.data?.['reminder'] ?? {}) as {
        event?: string;
        threshold?: number;
        dateISO?: string;
      };
      const tz = (row.data?.['tz'] as string | null) ?? null;
      const { data: esc } = await supa
        .from('escrows')
        .select('status, close_date, inspection_deadline, appraisal_deadline, loan_approval_date')
        .eq('id', row.escrow_id)
        .maybeSingle();
      const escRow = (esc ?? {}) as {
        status?: string;
        close_date?: string | null;
        inspection_deadline?: string | null;
        appraisal_deadline?: string | null;
        loan_approval_date?: string | null;
      };
      let current: string | null = null;
      if (rem.event === 'closing_reminder') current = escRow.close_date ?? null;
      else if (rem.event === 'inspection_reminder') current = escRow.inspection_deadline ?? null;
      else if (rem.event === 'appraisal_reminder') current = escRow.appraisal_deadline ?? null;
      else if (rem.event === 'loan_reminder') current = escRow.loan_approval_date ?? null;
      else if (rem.event === 'possession_reminder') {
        const { data: bi } = await supa
          .from('buyer_intakes')
          .select('data')
          .eq('escrow_id', row.escrow_id)
          .maybeSingle();
        const p = ((bi as { data?: Record<string, unknown> } | null)?.data?.['possession'] ??
          null) as string | null;
        current = typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : null;
      }
      valid =
        escRow.status === 'open' &&
        !!rem.dateISO &&
        current === rem.dateISO &&
        typeof rem.threshold === 'number' &&
        daysUntilClose(rem.dateISO, new Date(), tz) === rem.threshold;
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

/** Per-minute tick: coalesce buffered check-offs, then drain the queue. */
async function handleFlush(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const drained = await drainQueue(supa, env);
  const cutoff = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
  const { data: rows } = await supa
    .from('pending_step_pushes')
    .select('escrow_id, event, step_title, step_role, created_at')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(500);
  const list = (rows ?? []) as Array<{
    escrow_id: string;
    event: string;
    step_title: string;
    step_role: string | null;
    created_at: string;
  }>;
  const groups = new Map<string, BufferedStepPush[]>();
  for (const r of list) {
    const g = groups.get(r.escrow_id) ?? [];
    g.push({
      event: r.event as PushEvent,
      step_title: r.step_title,
      step_role: r.step_role,
    });
    groups.set(r.escrow_id, g);
  }
  let flushed = 0;
  let sent = 0;
  let queued = 0;
  for (const [groupEscrowId, groupRows] of groups) {
    const escrow = await getEscrowInfo(supa, groupEscrowId);
    if (!escrow) {
      await supa.from('pending_step_pushes').delete().eq('escrow_id', groupEscrowId);
      continue;
    }
    const tokens = await getLiveTokens(supa, escrow);
    if (tokens.length === 0) {
      // Nobody to notify (revoked/closed): drop the buffer, don't accumulate.
      await supa.from('pending_step_pushes').delete().eq('escrow_id', groupEscrowId);
      flushed++;
      continue;
    }
    // P0.3 side-aware targeting: one delivery per audience (the step's
    // side + TC), and each audience's body counts only its own rows —
    // a buyer check-off and a seller check-off in the same window no
    // longer coalesce into one blast to every device.
    let retain = false;
    for (const audience of splitStepPushesByAudience(groupRows)) {
      const audienceTokens = tokens.filter((t) =>
        audience.roles.includes(t.role as ClientLinkRole),
      );
      if (audienceTokens.length === 0) continue;
      const body =
        audience.rows.length === 1
          ? buildPushBody(
              audience.rows[0].event,
              escrow.realtorFirst,
              audience.rows[0].step_title,
              null,
              null,
            )
          : buildCoalescedBody(audience.rows.length);
      if (!body) {
        // Honest copy impossible for an audience that has devices: keep
        // the buffer for the next tick rather than drop the check-off.
        retain = true;
        continue;
      }
      const d = await deliver(supa, env, escrow, audienceTokens, body, { escrowId: escrow.id }, 'step');
      sent += d.sent;
      queued += d.queued;
    }
    if (!retain) {
      await supa.from('pending_step_pushes').delete().eq('escrow_id', groupEscrowId);
      flushed++;
    }
  }
  const events = await handleEventPushes(supa, env);
  return json({ ok: true, flushed, sent, queued, queue: drained, events });
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

/**
 * P2 date-reminder sweep (0041): due_date_reminders() returns one row
 * per recipient token whose LOCAL date hits a threshold. Each row is
 * claimed in push_reminder_log BEFORE delivery (the claim key includes
 * the date, so a moved date re-arms; and the token, so each timezone
 * claims on its own day). Concurrent runs are safe: the unique claim
 * index lets exactly one insert win.
 */
interface ReminderCandidate {
  escrow_id: string;
  address: string;
  event: ReminderEvent;
  threshold: number;
  date_value: string;
  expo_push_token: string;
  timezone: string | null;
  recipient_role: string;
}

async function handleDateSweep(
  supa: SupaClient,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const { data, error } = await supa.rpc('due_date_reminders');
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`[send-client-push] due_date_reminders failed: ${error.message ?? error}`);
    return json({ ok: false, error: 'reminders_failed' }, 500);
  }
  const candidates = (data ?? []) as ReminderCandidate[];

  // Claim first, deliver second (check-in precedent).
  const claimed: ReminderCandidate[] = [];
  for (const c of candidates) {
    const { error: claimErr } = await supa.from('push_reminder_log').insert({
      escrow_id: c.escrow_id,
      event: c.event,
      threshold: c.threshold,
      date_value: c.date_value,
      expo_push_token: c.expo_push_token,
    });
    if (!claimErr) claimed.push(c);
    // A 23505 (unique violation) means a concurrent or earlier run
    // already claimed this exact reminder for this token: skip quietly.
  }

  // Group deliveries by (escrow, event, threshold, audience): client
  // devices share one body; the realtor's street copy is separate.
  const groups = new Map<string, { first: ReminderCandidate; rows: ReminderCandidate[] }>();
  for (const c of claimed) {
    const audience = c.recipient_role === 'realtor' ? 'realtor' : 'client';
    const key = `${c.escrow_id}|${c.event}|${c.threshold}|${audience}`;
    const g = groups.get(key) ?? { first: c, rows: [] };
    g.rows.push(c);
    groups.set(key, g);
  }

  let sent = 0;
  let queued = 0;
  let escrows = 0;
  const seenEscrows = new Set<string>();
  for (const g of groups.values()) {
    const { first } = g;
    const escrow = await getEscrowInfo(supa, first.escrow_id);
    if (!escrow) continue;
    const body = buildReminderBody(
      first.event,
      first.recipient_role === 'realtor' ? 'realtor' : 'client',
      { threshold: first.threshold, dateISO: first.date_value, street: first.address },
    );
    if (!body) continue;
    const tokens: LiveToken[] = [];
    for (const c of g.rows) {
      // Multi-escrow address suffix: the same per-device computation
      // the check-in sweep uses (link-bound escrows for this token).
      const { data: devRows } = await supa
        .from('push_tokens')
        .select('escrow_id')
        .eq('expo_push_token', c.expo_push_token);
      const ids = new Set<string>();
      for (const r of (devRows ?? []) as Array<{ escrow_id: string | null }>) {
        if (r.escrow_id) ids.add(r.escrow_id);
      }
      ids.add(first.escrow_id);
      tokens.push({
        expo_push_token: c.expo_push_token,
        role: c.recipient_role,
        timezone: c.timezone,
        escrowIds: [...ids],
      });
    }
    const d = await deliver(
      supa,
      env,
      escrow,
      tokens,
      body,
      {
        escrowId: first.escrow_id,
        reminder: { event: first.event, threshold: first.threshold, dateISO: first.date_value },
      },
      'reminder',
    );
    sent += d.sent;
    queued += d.queued;
    if (!seenEscrows.has(first.escrow_id)) {
      seenEscrows.add(first.escrow_id);
      escrows++;
    }
  }
  return json({ ok: true, candidates: candidates.length, claimed: claimed.length, escrows, sent, queued });
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
  if (payload.event === 'date_reminder_sweep') return handleDateSweep(supa, env);

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

  // P0.3 side-aware targeting: key-date events reach only their roles
  // (closing -> all parties; contingency deadlines -> buyer side + TC).
  const targetRoles = rolesForPushEvent(payload.event);
  const targeted = tokens.filter((t) =>
    targetRoles.includes(t.role as ClientLinkRole),
  );
  if (targeted.length === 0) return json({ ok: true, sent: 0 });

  const d = await deliver(supa, env, escrow, targeted, body, { escrowId }, 'keydate');
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
