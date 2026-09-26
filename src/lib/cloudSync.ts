// Clear to Close — cloud sync layer (Supabase).
//
// Local AsyncStorage stays the offline source of truth for the UI. When the
// Supabase env vars are present AND the boot ping succeeds under a realtor
// session, realtor mutations are pushed to the cloud (fire-and-forget, with a
// persisted outbox for retries) and linked client views are read through the
// get_client_view RPC. When the ping fails (offline, no realtor session, RLS
// blocking), the app keeps working exactly as the local-only v1 — sync stays
// dormant.
//
// Identity: the realtor signs in with email/password (onboarding); sync
// activates under that identity from the start. Every row is stamped with
// the live session's auth.uid(). Anonymous auth is DISABLED and never
// called. Client (buyer/seller) access needs no session: redeem_invite,
// regenerate_invite, and get_client_view are SECURITY DEFINER RPCs granted
// to anon.
//
// The supabase client is typed as `any` (see src/lib/supabase.ts): it is
// require()d lazily so this module imports cleanly in Node test runs, and
// unit tests inject a mock client.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Cloud = any;

import type {
  ClientRole,
  ClientView,
  Escrow,
  Invite,
  RealtorProfile,
  RedeemResult,
  StepT,
} from './types';
import type { KV } from './store';
import { isSupabaseConfigured } from './supabase';
import { getAuthClient } from './auth';
import { daysToClose } from './dates';
import { applyDerivedStatus } from './lifecycle';

const K_OUTBOX = 'ctc:outbox';
const MAX_PUSH_ATTEMPTS = 10;
const MAX_CODE_REGEN_ATTEMPTS = 5;

// Invite code alphabet: no 0/O/1/I/L to avoid visual confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export interface PingResult {
  ran: boolean;
  ok: boolean;
  userId?: string;
  error?: string;
}

export interface CloudViewResult {
  ok: boolean;
  view?: ClientView;
  profile?: RealtorProfile | null;
  error?: string;
}

interface OutboxOp {
  op: 'pushEscrow' | 'pushProfile' | 'pushInvite' | 'pushRevoke' | 'revokeClientLink';
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
  revokedAt?: string;
  attempts: number;
}

/** Exported for the pull-merge: rows with a queued push keep the local copy. */
export type { OutboxOp };

// ------------------------------------------------------------------ mappers --

export function toEscrowRow(userId: string, e: Escrow): Record<string, unknown> {
  return {
    id: e.id,
    user_id: userId,
    address: e.address,
    city: e.city,
    side: e.side,
    buyer_name: e.buyerName,
    seller_name: e.sellerName,
    open_date: e.openDate,
    close_date: e.closeDate,
    status: e.status,
    // Per-side close dates (migration 0007). Null until the side closes.
    buyer_closed_at: e.buyerClosedAt,
    seller_closed_at: e.sellerClosedAt,
    created_at: e.createdAt,
  };
}

export function toStepRows(escrowId: string, role: ClientRole, steps: StepT[]): Record<string, unknown>[] {
  // created_at is omitted: the DB default (now()) fills it on insert, and
  // upserts must not overwrite it with null.
  return steps.map((s) => ({
    id: s.id,
    escrow_id: escrowId,
    role,
    title: s.title,
    subtitle: s.subtitle,
    done: s.done,
    custom: s.custom,
    position: s.order,
    completed_at: s.completedAt,
  }));
}

export function toProfileRow(userId: string, p: RealtorProfile | null): Record<string, unknown> {
  return {
    user_id: userId,
    name: p?.name ?? null,
    photo_url: p?.photoUri ?? null,
    about: p?.about ?? null,
    years_experience: p?.yearsExperience ?? null,
    deals_closed: p?.dealsClosed ?? null,
    areas_served: p?.areasServed ?? null,
    phone: p?.phone ?? null,
    dre_license: p?.dreLicense ?? null,
  };
}

/** Map a realtor_profiles row back onto a RealtorProfile.
 *
 * A device-local `blob:` photo URL can never survive a reload or reach
 * another device, so it is treated as absent here — every consumer then
 * falls back to its no-photo rendering instead of a broken image. */
export function fromProfileRow(row: Record<string, unknown>): RealtorProfile {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const photoUrl = typeof row.photo_url === 'string' ? (row.photo_url as string) : null;
  return {
    name: s(row.name),
    photoUri: photoUrl !== null && photoUrl.startsWith('blob:') ? null : photoUrl,
    about: s(row.about),
    yearsExperience: s(row.years_experience),
    dealsClosed: s(row.deals_closed),
    areasServed: s(row.areas_served),
    phone: s(row.phone),
    dreLicense: s(row.dre_license),
  };
}

/**
 * Pull the realtor's own profile row from Supabase. Returns null when there
 * is no row (brand-new account), when the row has no saved fields at all
 * (never completed — e.g. a phantom row left by the old ping probe's write
 * round-trip), or on any failure. A row with ANY saved field counts as an
 * existing profile even when its name is NULL/empty — the name alone must
 * never discard the realtor's saved data. Never throws.
 */
export async function pullProfileNow(
  client: Cloud,
  userId: string,
): Promise<RealtorProfile | null> {
  try {
    if (!client) return null;
    const { data, error } = await client
      .from('realtor_profiles')
      .select('name, photo_url, about, years_experience, deals_closed, areas_served, phone, dre_license')
      .eq('user_id', userId)
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const row = data[0] as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string';
    const hasAnyField =
      (isStr(row.name) && row.name.trim().length > 0) ||
      isStr(row.photo_url) ||
      isStr(row.about) ||
      isStr(row.years_experience) ||
      isStr(row.deals_closed) ||
      isStr(row.areas_served) ||
      isStr(row.phone) ||
      isStr(row.dre_license);
    if (!hasAnyField) return null;
    return fromProfileRow(row);
  } catch {
    return null;
  }
}

/** Map one escrows row to the local Escrow shape (steps attached separately). */
export function fromEscrowRow(row: Record<string, unknown>): Escrow {
  const side = String(row.side ?? 'buy');
  const dateOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  const buyerClosedAt = dateOrNull(row.buyer_closed_at);
  const sellerClosedAt = dateOrNull(row.seller_closed_at);
  const e: Escrow = {
    id: String(row.id ?? ''),
    address: String(row.address ?? ''),
    city: String(row.city ?? ''),
    side: side === 'sell' || side === 'both' ? side : 'buy',
    buyerName: (row.buyer_name as string) ?? null,
    sellerName: (row.seller_name as string) ?? null,
    openDate: String(row.open_date ?? ''),
    closeDate: String(row.close_date ?? ''),
    buyerSteps: [],
    sellerSteps: [],
    status: 'open',
    buyerClosedAt,
    sellerClosedAt,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
  // Prefer the derived per-side status; a legacy 'closed' row from before
  // the per-side-close migration keeps its status (the UI renders it
  // without a date).
  applyDerivedStatus(e);
  if (e.status === 'open' && row.status === 'closed') e.status = 'closed';
  // A cancelled row stays cancelled — per-side derivation must never
  // resurrect it into Active/Closed (deal-list edit/cancel round, Sept 2026).
  if (row.status === 'cancelled') e.status = 'cancelled';
  return e;
}

/** Map one steps row to the local StepT shape. */
export function fromStepRow(row: Record<string, unknown>): StepT {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    subtitle: String(row.subtitle ?? ''),
    done: row.done === true,
    custom: row.custom === true,
    order: Number(row.position ?? 0),
    completedAt: (row.completed_at as string) ?? null,
  };
}

/**
 * Pull the signed-in realtor's escrows (with both roles' steps, in position
 * order) from Supabase. RLS scopes the read to auth.uid()'s rows; the
 * user_id filter below is a second, app-layer guard so a misconfigured
 * policy can never leak another realtor's deals into this device.
 *
 * Returns the escrow list (possibly empty — a legitimate empty deal list),
 * or null when the pull failed (no session / transport error) so the caller
 * keeps the local list untouched.
 */
export async function pullEscrowsNow(client: Cloud): Promise<Escrow[] | null> {
  try {
    if (!client) return null;
    const uid = await ensureCloudUser(client);
    if (!uid) return null;
    const { data: escrowData, error: escrowError } = await client.from('escrows').select('*');
    if (escrowError) return null;
    const rows = ((escrowData ?? []) as Record<string, unknown>[]).filter(
      (r) => String(r.user_id ?? '') === uid,
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => String(r.id));
    const { data: stepData, error: stepError } = await client
      .from('steps')
      .select('*')
      .in('escrow_id', ids);
    if (stepError) return null;
    const stepsByEscrow = new Map<string, { buyer: StepT[]; seller: StepT[] }>();
    for (const s of (stepData ?? []) as Record<string, unknown>[]) {
      const eid = String(s.escrow_id ?? '');
      if (!ids.includes(eid)) continue;
      let g = stepsByEscrow.get(eid);
      if (!g) {
        g = { buyer: [], seller: [] };
        stepsByEscrow.set(eid, g);
      }
      (String(s.role ?? '') === 'seller' ? g.seller : g.buyer).push(fromStepRow(s));
    }
    return rows.map((r) => {
      const e = fromEscrowRow(r);
      const g = stepsByEscrow.get(e.id);
      e.buyerSteps = (g?.buyer ?? []).sort((a, b) => a.order - b.order);
      e.sellerSteps = (g?.seller ?? []).sort((a, b) => a.order - b.order);
      return e;
    });
  } catch {
    return null;
  }
}

export function toInviteRow(invite: Invite): Record<string, unknown> {
  return {
    id: invite.id,
    code: invite.code,
    escrow_id: invite.escrowId,
    role: invite.role,
    party_name: invite.partyName,
    created_at: invite.createdAt,
    revoked_at: invite.revokedAt,
    redeemed_at: invite.redeemedAt,
  };
}

export function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === '23505'
  );
}

type RpcRedeemOk = {
  ok: true;
  escrowId: string;
  role: ClientRole;
  partyName: string;
  linkId: string;
};

/** Map the redeem_invite RPC payload onto the app's RedeemResult contract. */
export function mapRedeemRpc(data: unknown): RedeemResult & { linkId?: string } {
  const d = data as Record<string, unknown>;
  if (d && d.ok === true) {
    return {
      ok: true,
      escrowId: String(d.escrow_id),
      role: d.role as ClientRole,
      partyName: String(d.party_name),
      linkId: String(d.link_id),
    } as RpcRedeemOk;
  }
  const err = (d?.error as string) ?? 'invalid';
  const valid = ['invalid', 'name_mismatch', 'revoked', 'already_used', 'network', 'device_has_link'] as const;
  return { ok: false, error: valid.includes(err as (typeof valid)[number]) ? (err as (typeof valid)[number]) : 'invalid' };
}

function mapRpcStep(s: Record<string, unknown>): StepT {
  return {
    id: String(s.id),
    title: String(s.title ?? ''),
    subtitle: String(s.subtitle ?? ''),
    done: s.done === true,
    custom: s.custom === true,
    order: Number(s.position ?? 0),
    completedAt: s.completed_at ? String(s.completed_at) : null,
  };
}

/** Map the get_client_view RPC payload onto ClientView + RealtorProfile. */
export function mapClientViewRpc(data: unknown): CloudViewResult {
  const d = data as Record<string, unknown>;
  if (!d || d.ok !== true) {
    return { ok: false, error: String(d?.error ?? 'invalid') };
  }
  const e = d.escrow as Record<string, unknown>;
  const role = ((d.buyer_steps ? 'buyer' : 'seller') as ClientRole);
  const rawSteps = ((d.buyer_steps ?? d.seller_steps) as Record<string, unknown>[]) ?? [];
  const steps = rawSteps.map(mapRpcStep).sort((a, b) => a.order - b.order);
  const done = steps.filter((s) => s.done).length;
  const p = d.profile as Record<string, unknown> | null;
  const profile: RealtorProfile | null = p
    ? {
        name: String(p.name ?? ''),
        photoUri: (p.photo_url as string) ?? null,
        about: String(p.about ?? ''),
        yearsExperience: String(p.years_experience ?? ''),
        dealsClosed: String(p.deals_closed ?? ''),
        areasServed: String(p.areas_served ?? ''),
        phone: String(p.phone ?? ''),
        dreLicense: String(p.dre_license ?? ''),
      }
    : null;
  const closeDate = String(e.close_date);
  const view: ClientView = {
    escrowId: String(e.id),
    role,
    address: String(e.address),
    city: String(e.city),
    daysToClose: daysToClose(closeDate),
    done,
    total: steps.length,
    steps,
    upNext: steps.find((s) => !s.done) ?? null,
  };
  return { ok: true, view, profile };
}

// ------------------------------------------------------------------ session --

function pingError(e: unknown): string {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  const m = (e as { message?: string }).message;
  return m ? m.slice(0, 160) : JSON.stringify(e).slice(0, 160);
}

/**
 * Resolve the cloud identity: the persisted session's auth.uid(), or null.
 * Sync runs ONLY under the realtor's email/password session — anonymous
 * auth is disabled and is never called. Never throws.
 */
export async function ensureCloudUser(client: Cloud): Promise<string | null> {
  if (!client) return null;
  try {
    const { data: sessData } = await client.auth.getSession();
    const existing = sessData?.session?.user?.id as string | undefined;
    return existing ?? null;
  } catch {
    return null;
  }
}

/**
 * Boot-time connectivity check: auth + a simple read probe.
 * Never throws; a failure means sync stays dormant (local-only v1 behavior).
 *
 * Read-only by design — it must never write to the profile row. An earlier
 * version upserted `{ user_id, name: null }` as a write round-trip, which
 * wiped the realtor's saved name on every boot and created phantom all-null
 * rows for brand-new accounts. The read probe is sufficient to prove
 * connectivity and RLS access.
 */
export async function pingCloud(client: Cloud): Promise<PingResult> {
  if (!isSupabaseConfigured() || !client) {
    return { ran: true, ok: false, error: 'supabase not configured' };
  }
  const userId = await ensureCloudUser(client);
  if (!userId) {
    return { ran: true, ok: false, error: 'no realtor session — sign in to enable sync' };
  }
  try {
    // Read: own profile rows (RLS owner policy).
    const { error: readError } = await client
      .from('realtor_profiles')
      .select('user_id')
      .eq('user_id', userId)
      .limit(1);
    if (readError) return { ran: true, ok: false, error: `read probe failed: ${pingError(readError)}` };
    return { ran: true, ok: true, userId };
  } catch (e) {
    return { ran: true, ok: false, error: pingError(e) };
  }
}

// --------------------------------------------------------------------- push --

async function upsertAll(client: Cloud, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  const { error } = await client.from(table).upsert(rows, { onConflict });
  if (error) throw error;
}

/** Push one escrow and ALL of its steps (both roles) — idempotent. */
export async function pushEscrowNow(client: Cloud, userId: string, escrow: Escrow): Promise<void> {
  const row = toEscrowRow(userId, escrow);
  try {
    await upsertAll(client, 'escrows', [row], 'id');
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    // Migration 0007 not applied yet on this database: retry without the
    // per-side close columns so the push still lands (close dates stay
    // local-only until the migration is applied).
    const legacy = { ...row };
    delete legacy.buyer_closed_at;
    delete legacy.seller_closed_at;
    await upsertAll(client, 'escrows', [legacy], 'id');
  }
  const steps = [
    ...toStepRows(escrow.id, 'buyer', escrow.buyerSteps),
    ...toStepRows(escrow.id, 'seller', escrow.sellerSteps),
  ];
  if (steps.length > 0) {
    await upsertAll(client, 'steps', steps, 'id');
  }
}

/**
 * True when a PostgREST error means the per-side close-date columns
 * (migration 0007) don't exist yet on this database.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  if (e.code === '42703') return true; // PostgreSQL undefined_column
  const msg = e.message ?? '';
  return msg.includes('buyer_closed_at') || msg.includes('seller_closed_at');
}

export async function pushProfileNow(client: Cloud, userId: string, profile: RealtorProfile): Promise<void> {
  await upsertAll(client, 'realtor_profiles', [toProfileRow(userId, profile)], 'user_id');
}

/**
 * Insert an invite. On a code collision (DB unique constraint 23505) the code
 * is regenerated and the insert retried — the invite's code is updated in
 * place so the caller can persist the final value.
 */
export async function pushInviteNow(
  client: Cloud,
  invite: Invite,
  genCode: () => string = randomCode,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CODE_REGEN_ATTEMPTS; attempt++) {
    const { error } = await client.from('invites').insert(toInviteRow(invite));
    if (!error) return;
    if (!isUniqueViolation(error)) throw error;
    lastError = error;
    invite.code = genCode();
  }
  throw lastError ?? new Error('pushInviteNow: exhausted code-regeneration attempts');
}

export async function pushRevokeNow(client: Cloud, inviteId: string, revokedAt: string): Promise<void> {
  const { error } = await client.from('invites').update({ revoked_at: revokedAt }).eq('id', inviteId);
  if (error) throw error;
}

/** Best-effort pull of invite states (redeemed/revoked) for one escrow. */
export async function pullInvitesNow(
  client: Cloud,
  escrowId: string,
): Promise<{ id: string; revoked_at: string | null; redeemed_at: string | null }[]> {
  const { data, error } = await client
    .from('invites')
    .select('id,revoked_at,redeemed_at')
    .eq('escrow_id', escrowId);
  if (error) throw error;
  return (data ?? []) as { id: string; revoked_at: string | null; redeemed_at: string | null }[];
}

// ------------------------------------------------------------------ redeem --

export async function redeemViaCloud(
  client: Cloud,
  code: string,
  name: string,
  deviceId: string | null,
): Promise<RedeemResult & { linkId?: string }> {
  try {
    const { data, error } = await client.rpc('redeem_invite', {
      p_code: code,
      p_name: name,
      p_device_id: deviceId,
    });
    // A transport/RPC-level error (network down, timeout, missing function)
    // is NOT a bad code — surface it as retryable 'network' so the client
    // never sees "invalid code" for a server problem. Bad codes arrive as
    // data {ok:false}, mapped below. One exception: the 0002 one-live-link-
    // per-device index (23505) means this device already holds a different
    // escrow's link — a permanent, connection-independent state, so it gets
    // its own non-retryable error instead of the misleading 'network'.
    if (error) return { ok: false, error: isUniqueViolation(error) ? 'device_has_link' : 'network' };
    return mapRedeemRpc(data);
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * Atomically regenerate an invite code (share-sheet "Regenerate code").
 * The RPC kills the old code + old device link and issues the replacement
 * in one transaction. Throws on failure.
 */
export async function regenerateInviteNow(
  client: Cloud,
  inviteId: string,
): Promise<{ newCode: string; oldCode: string; newInviteId: string }> {
  const { data, error } = await client.rpc('regenerate_invite', { p_invite_id: inviteId });
  if (error) throw error;
  const d = data as Record<string, unknown> | null;
  if (!d || d.ok !== true) {
    throw new Error(String((d as Record<string, unknown> | null)?.error ?? 'regenerate failed'));
  }
  return {
    newCode: String(d.new_code),
    oldCode: String(d.old_code),
    newInviteId: String(d.new_invite_id),
  };
}

/** Push a client-link revocation (part of regenerate convergence). */
export async function pushLinkRevokeNow(
  client: Cloud,
  linkId: string,
  revokedAt: string,
): Promise<void> {
  const { error } = await client
    .from('client_links')
    .update({ revoked_at: revokedAt })
    .eq('id', linkId);
  if (error) throw error;
}

export async function fetchCloudView(client: Cloud, linkId: string): Promise<CloudViewResult> {
  try {
    const { data, error } = await client.rpc('get_client_view', { p_link_id: linkId });
    if (error) return { ok: false, error: pingError(error) };
    return mapClientViewRpc(data);
  } catch (e) {
    return { ok: false, error: pingError(e) };
  }
}

// ------------------------------------------------------------------ outbox --

async function readOutbox(kv: KV): Promise<OutboxOp[]> {
  try {
    const raw = await kv.getItem(K_OUTBOX);
    const ops = raw ? (JSON.parse(raw) as OutboxOp[]) : [];
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

/** Queued push ops (exported so the escrow pull-merge can skip dirty rows). */
export async function readOutboxOps(kv: KV): Promise<OutboxOp[]> {
  return readOutbox(kv);
}

async function writeOutbox(kv: KV, ops: OutboxOp[]): Promise<void> {
  try {
    await kv.setItem(K_OUTBOX, JSON.stringify(ops));
  } catch {
    // Outbox persistence is best-effort; the local write already succeeded.
  }
}

export async function enqueueOutbox(kv: KV, op: OutboxOp): Promise<void> {
  const ops = await readOutbox(kv);
  // Coalesce: one pending op per (op, escrowId, inviteId, linkId).
  const key = (o: OutboxOp) =>
    `${o.op}:${o.escrowId ?? ''}:${o.inviteId ?? ''}:${o.linkId ?? ''}`;
  const next = ops.filter((o) => key(o) !== key(op));
  next.push({ ...op, attempts: 0 });
  await writeOutbox(kv, next);
}

/**
 * Drain the outbox against current local state (retries converge on the
 * latest local values). Drops ops that keep failing past MAX_PUSH_ATTEMPTS.
 */
export async function drainOutbox(
  client: Cloud,
  userId: string,
  kv: KV,
  load: {
    getEscrow(id: string): Promise<Escrow | null>;
    getProfile(): Promise<RealtorProfile | null>;
    getInvite?(inviteId: string): Promise<Invite | null>;
    updateInviteCode?(inviteId: string, code: string): Promise<unknown>;
  },
): Promise<{ drained: number; pending: number }> {
  let ops = await readOutbox(kv);
  let drained = 0;
  const remaining: OutboxOp[] = [];
  for (const op of ops) {
    try {
      if (op.op === 'pushEscrow' && op.escrowId) {
        const e = await load.getEscrow(op.escrowId);
        if (e) await pushEscrowNow(client, userId, e);
      } else if (op.op === 'pushProfile') {
        const p = await load.getProfile();
        if (p) await pushProfileNow(client, userId, p);
      } else if (op.op === 'pushInvite' && op.inviteId && load.getInvite) {
        const inv = await load.getInvite(op.inviteId);
        if (inv) {
          const before = inv.code;
          await pushInviteNow(client, inv);
          if (inv.code !== before && load.updateInviteCode) {
            await load.updateInviteCode(inv.id, inv.code);
          }
        }
      } else if (op.op === 'pushRevoke' && op.inviteId && load.getInvite) {
        const inv = await load.getInvite(op.inviteId);
        if (inv?.revokedAt) await pushRevokeNow(client, inv.id, inv.revokedAt);
      } else if (op.op === 'revokeClientLink' && op.linkId && op.revokedAt) {
        await pushLinkRevokeNow(client, op.linkId, op.revokedAt);
      }
      drained++;
    } catch {
      op.attempts++;
      if (op.attempts < MAX_PUSH_ATTEMPTS) remaining.push(op);
    }
  }
  await writeOutbox(kv, remaining);
  return { drained, pending: remaining.length };
}

// ------------------------------------------------------------------ client --

/** Resolve the lazily-created platform-aware supabase client (null when not configured). */
export function cloudClient(): Cloud | null {
  return getAuthClient();
}

export function cloudConfigured(): boolean {
  return isSupabaseConfigured();
}
