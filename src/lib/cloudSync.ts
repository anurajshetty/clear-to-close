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
  InviteRealtor,
  RealtorAction,
  RealtorProfile,
  RedeemResult,
  ResolveInviteError,
  Review,
  StepT,
  TcView,
} from './types';
import type { KV } from './store';
import { isSupabaseConfigured } from './supabase';
import { getAuthClient } from './auth';
import { daysToClose } from './dates';
import { applyDerivedStatus } from './lifecycle';
import { deleteProfileMedia, uploadProfileMedia, type MediaKind } from './mediaUpload';

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
  /** Transaction coordinator payload: both checklists (Sept 2026). */
  tcView?: TcView;
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
  /**
   * Set once automatic attempts hit MAX_PUSH_ATTEMPTS (Sept 2026
   * sync-failure surface): the op stays queued so a MANUAL Retry still
   * has something to retry, but automatic drains stop hammering it. A
   * fresh user edit re-arms it via enqueueOutbox.
   */
  manualOnly?: boolean;
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
    // "LATEST FROM" card (migration 0009): the most recent realtor
    // check/uncheck as JSONB. Null until the first toggle.
    last_action: e.lastAction ?? null,
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

export function toProfileRow(
  userId: string,
  p: RealtorProfile | null,
  removed: MediaKind[] = [],
): Record<string, unknown> {
  // Photo/banner sync (Sept 2026, Anuraj-approved): photo_url / banner_image
  // now carry the PUBLIC Supabase Storage URLs, uploaded on profile save
  // (see mediaUpload.ts), so client devices can see them. Previously these
  // columns carried device-local file:// URIs, which were meaningless on any
  // other device.
  //
  // When no upload has succeeded yet the keys are OMITTED (not nulled): the
  // upsert then keeps whatever the server already has, so an offline name
  // edit can never wipe a previously uploaded photo. The local managed files
  // (photoUri / banner_image) stay the offline source and display fallback.
  //
  // Removal (Sept 28, 2026, Anuraj) is the exception: a kind in `removed`
  // is written as an EXPLICIT null so clients fall back to initials (photo)
  // and the teal gradient (banner) instead of the stale Storage URL.
  const row: Record<string, unknown> = {
    user_id: userId,
    name: p?.name ?? null,
    about: p?.about ?? null,
    years_experience: p?.yearsExperience ?? null,
    email: p?.email ?? null,
    areas_served: p?.areasServed ?? null,
    phone: p?.phone ?? null,
    dre_license: p?.dreLicense ?? null,
    realty_group: p?.realty_group ?? null,
  };
  if (p === null) {
    // Legacy null-profile push: explicit nulls, as before.
    row.photo_url = null;
    row.banner_image = null;
    return row;
  }
  if (p.photoRemoteUrl != null) row.photo_url = p.photoRemoteUrl;
  else if (removed.includes('photo')) row.photo_url = null;
  if (p.bannerRemoteUrl != null) row.banner_image = p.bannerRemoteUrl;
  else if (removed.includes('banner')) row.banner_image = null;
  // NOTE: reviews / rating are deliberately NOT in this payload. They are
  // written by clients through the upsert_review / delete_review RPCs; the
  // realtor's full-row upsert must never clobber them with a stale local
  // copy. Columns absent from the payload keep their server values.
  return row;
}

/**
 * Average of review stars, null when there are no reviews (Sept 2026).
 * Exported for tests and for any surface that builds a profile object
 * without going through fromProfileRow.
 */
export function computeRating(reviews: { stars: number }[] | null | undefined): number | null {
  if (!reviews || reviews.length === 0) return null;
  const sum = reviews.reduce((n, r) => n + (typeof r.stars === 'number' ? r.stars : 0), 0);
  return sum / reviews.length;
}

/** Parse the reviews JSONB column into Review[] (tolerates text or null). */
function parseReviews(v: unknown): Review[] {
  let arr: unknown = v;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      clientName: typeof r.clientName === 'string' ? r.clientName : '',
      stars:
        typeof r.stars === 'number' && r.stars >= 1 && r.stars <= 5
          ? Math.round(r.stars)
          : 5,
      text: typeof r.text === 'string' ? r.text : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    }))
    .filter((r) => r.id.length > 0);
}

/** Map a realtor_profiles row back onto a RealtorProfile.
 *
 * A device-local `blob:` photo URL can never survive a reload or reach
 * another device, so it is treated as absent here — every consumer then
 * falls back to its no-photo rendering instead of a broken image. */
export function fromProfileRow(row: Record<string, unknown>): RealtorProfile {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const photoUrl = typeof row.photo_url === 'string' ? (row.photo_url as string) : null;
  const bannerUrl = typeof row.banner_image === 'string' ? (row.banner_image as string) : null;
  const reviews = parseReviews(row.reviews);
  const rating =
    typeof row.rating === 'number' && Number.isFinite(row.rating)
      ? row.rating
      : computeRating(reviews);
  // Remote Storage URLs (Sept 2026): an http(s) photo_url / banner_image is
  // the public bucket URL — record it as the remote source. Anything else
  // (legacy device-local file:// rows, blob:) is not a reachable remote.
  const isRemote = (u: string | null): u is string =>
    u !== null && (u.startsWith('http://') || u.startsWith('https://'));
  return {
    name: s(row.name),
    photoUri: photoUrl !== null && photoUrl.startsWith('blob:') ? null : photoUrl,
    photoRemoteUrl: isRemote(photoUrl) ? photoUrl : null,
    bannerRemoteUrl: isRemote(bannerUrl) ? bannerUrl : null,
    banner_image: bannerUrl !== null && bannerUrl.startsWith('blob:') ? null : bannerUrl,
    about: s(row.about),
    yearsExperience: s(row.years_experience),
    email: s(row.email),
    areasServed: s(row.areas_served),
    phone: s(row.phone),
    dreLicense: s(row.dre_license),
    realty_group: s(row.realty_group),
    reviews,
    rating,
  };
}

/**
 * Pull the realtor's own profile row from Supabase. Returns null when there
 * is no row (brand-new account), when the row has no saved fields at all
 * (never completed — e.g. a phantom row left by the old ping probe's write
 * round-trip), or on any failure. A row with ANY saved field counts as an
 * existing profile even when its name is NULL/empty — the name alone must
 * never discard the realtor's saved data. Never throws.
 *
 * The realty_group / banner_image columns (migration 0010, Sept 2026) may
 * not exist yet on databases whose dashboard migration hasn't been applied:
 * on an undefined-column error the select retries with the pre-0008 column
 * list so the profile still loads (both fields stay local-only until
 * applied).
 */
export async function pullProfileNow(
  client: Cloud,
  userId: string,
): Promise<RealtorProfile | null> {
  const COLUMNS =
    'name, photo_url, about, years_experience, email, areas_served, phone, dre_license, realty_group, banner_image, rating';
  const COLUMNS_0008 =
    'name, photo_url, about, years_experience, areas_served, phone, dre_license, realty_group, banner_image';
  const LEGACY_COLUMNS =
    'name, photo_url, about, years_experience, areas_served, phone, dre_license';
  const fetchRow = async (columns: string) =>
    client.from('realtor_profiles').select(columns).eq('user_id', userId).limit(1);
  try {
    if (!client) return null;
    let { data, error } = await fetchRow(COLUMNS);
    if (error && isMissingColumnError(error)) {
      // Migration 0016 not applied yet on this database: fall back to the
      // 0008 column list (no email / reviews / rating).
      ({ data, error } = await fetchRow(COLUMNS_0008));
    }
    if (error && isMissingColumnError(error)) {
      // Migration 0008 not applied yet either: fall back to the
      // pre-migration column list.
      ({ data, error } = await fetchRow(LEGACY_COLUMNS));
    }
    if (error || !data || data.length === 0) return null;
    const row = data[0] as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string';
    const hasAnyField =
      (isStr(row.name) && row.name.trim().length > 0) ||
      isStr(row.photo_url) ||
      isStr(row.about) ||
      isStr(row.years_experience) ||
      isStr(row.email) ||
      isStr(row.areas_served) ||
      isStr(row.phone) ||
      isStr(row.dre_license) ||
      isStr(row.realty_group) ||
      isStr(row.banner_image);
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

/** Convert a Supabase invites row to the local Invite shape. */
export function fromInviteRow(row: Record<string, unknown>): Invite {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const nullStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const role = str(row.role);
  return {
    id: str(row.id),
    escrowId: str(row.escrow_id),
    role: role === 'seller' ? 'seller' : role === 'tc' ? 'tc' : 'buyer',
    partyName: str(row.party_name),
    code: str(row.code),
    createdAt: str(row.created_at),
    revokedAt: nullStr(row.revoked_at),
    redeemedAt: nullStr(row.redeemed_at),
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

/**
 * The invites_cap trigger's cap rejection (Sept 2026): raised when an insert
 * would push an escrow past its cap (2 per buyer/seller side, 1 TC). A lost
 * cross-device creation race surfaces here — the local row must be rolled
 * back, not retried forever.
 */
export function isCapViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = String((error as { message?: unknown }).message ?? '');
  return /two clients per side max|one transaction coordinator per escrow max/i.test(msg);
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
  const p = d.profile as Record<string, unknown> | null;
  const profile: RealtorProfile | null = p ? fromProfileRow(p) : null;
  // The id of this link's own review, if it has posted one (Sept 2026) —
  // used by the client home to open the review sheet in edit mode.
  const myReviewId =
    typeof d.my_review_id === 'string' && d.my_review_id.length > 0 ? d.my_review_id : null;
  const closeDate = String(e.close_date);
  if (d.role === 'tc') {
    // TC payload carries BOTH step arrays; the escrow side decides which
    // sections are active. Never silently drop a side here.
    const tcView = mapTcSteps(e, d, closeDate, myReviewId);
    return { ok: true, tcView, profile };
  }
  const role = ((d.buyer_steps ? 'buyer' : 'seller') as ClientRole);
  const rawSteps = ((d.buyer_steps ?? d.seller_steps) as Record<string, unknown>[]) ?? [];
  const view = buildRpcClientView(e, role, rawSteps, closeDate, myReviewId);
  return { ok: true, view, profile };
}

function buildRpcClientView(
  e: Record<string, unknown>,
  role: ClientRole,
  rawSteps: Record<string, unknown>[],
  closeDate: string,
  myReviewId: string | null,
): ClientView {
  const steps = rawSteps.map(mapRpcStep).sort((a, b) => a.order - b.order);
  const done = steps.filter((s) => s.done).length;
  return {
    escrowId: String(e.id),
    role,
    address: String(e.address),
    city: String(e.city),
    daysToClose: daysToClose(closeDate),
    done,
    total: steps.length,
    steps,
    upNext: steps.find((s) => !s.done) ?? null,
    myReviewId,
    openDate: typeof e.open_date === 'string' ? e.open_date : undefined,
    closeDate: typeof e.close_date === 'string' ? e.close_date : undefined,
    // The escrow row's user_id is the realtor behind this escrow — the
    // <realtor-id> in the public profile URL contract.
    realtorId: typeof e.user_id === 'string' ? e.user_id : undefined,
    // "LATEST FROM" card (escrow last_action migration): the most recent
    // realtor check/uncheck, read defensively — absent/unshaped values map
    // to undefined and the card derives from completed_at instead.
    lastAction: parseRealtorAction(e.last_action),
    openedAt: typeof e.created_at === 'string' ? e.created_at : undefined,
    // Escrow lifecycle status (Sept 2026, Anuraj's rule): feeds the review
    // gate — carried explicitly by get_client_view (migration 0015). Absent
    // on older payloads; the gate fails open.
    status:
      e.status === 'open' || e.status === 'closed' || e.status === 'cancelled'
        ? e.status
        : undefined,
  };
}

/**
 * Map the TC branch of the get_client_view payload onto a TcView.
 * side 'both' activates both sections; 'buy'/'sell' activates one.
 */
function mapTcSteps(
  e: Record<string, unknown>,
  d: Record<string, unknown>,
  closeDate: string,
  myReviewId: string | null,
): TcView {
  const side = String(e.side ?? 'both');
  const buyerRaw = (d.buyer_steps ?? []) as Record<string, unknown>[];
  const sellerRaw = (d.seller_steps ?? []) as Record<string, unknown>[];
  return {
    escrowId: String(e.id),
    address: String(e.address),
    city: String(e.city),
    daysToClose: daysToClose(closeDate),
    buyer: side === 'sell' ? null : buildRpcClientView(e, 'buyer', buyerRaw, closeDate, myReviewId),
    seller: side === 'buy' ? null : buildRpcClientView(e, 'seller', sellerRaw, closeDate, myReviewId),
  };
}

// ------------------------------------------------- public profile + reviews --

/**
 * Fetch a realtor's public profile for the /realtor/<id> page (Sept 2026).
 * PUBLIC: works with the anon key, no session required. Returns null when
 * the id is unknown or the database is unreachable / unconfigured.
 */
export async function getPublicProfile(
  client: Cloud,
  realtorId: string,
): Promise<{ profile: RealtorProfile; realtorId: string } | null> {
  try {
    if (!client || !realtorId) return null;
    const { data, error } = await client.rpc('get_public_profile', {
      p_realtor_id: realtorId,
    });
    if (error || !data) return null;
    const d = data as Record<string, unknown>;
    if (d.ok !== true || !d.profile) return null;
    return {
      profile: fromProfileRow(d.profile as Record<string, unknown>),
      realtorId,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an invite code to the inviting realtor's public branding for the
 * branded invite welcome (Sept 2026). PUBLIC: works with the anon key, no
 * login or device link required — the client hasn't redeemed yet.
 * Returns the specific redeem_invite-style error when the code isn't live.
 */
export async function resolveInviteRealtor(
  client: Cloud,
  code: string,
): Promise<{ ok: true; realtor: InviteRealtor } | { ok: false; error: ResolveInviteError }> {
  try {
    if (!client || !code.trim()) return { ok: false, error: 'invalid' };
    const { data, error } = await client.rpc('resolve_invite_realtor', {
      p_code: code.trim().toUpperCase(),
    });
    if (error || !data) return { ok: false, error: 'network' };
    const d = data as Record<string, unknown>;
    if (d.ok !== true) {
      const e = d.error;
      return {
        ok: false,
        error:
          e === 'already_used' || e === 'revoked' || e === 'unknown' ? e : 'invalid',
      };
    }
    const r = d.realtor as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    // Role comes from migration 0013; older DBs omit it — default to 'buyer'
    // (client label) so the form still renders before Anuraj runs the migration.
    const role = d.role === 'tc' ? 'tc' : d.role === 'seller' ? 'seller' : 'buyer';
    return {
      ok: true,
      realtor: {
        name: str(r.name),
        photoUrl: typeof r.photo_url === 'string' ? (r.photo_url as string) : null,
        realtyGroup: str(r.realty_group),
        dreLicense: str(r.dre_license),
        realtorId: str(r.realtor_id),
        role,
      },
    };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  reviews: Review[];
  rating: number | null;
  /** The review's id (for a new review, or the edited one). */
  reviewId?: string;
}

const MAX_REVIEW_TEXT = 280;

/**
 * Save a client's review of their realtor (Sept 2026). When reviewId is
 * omitted a new review is created; when given, the client's own review is
 * edited. Identity comes from the client's link id: the upsert_review RPC
 * only touches reviews authored by that link. Returns the updated review
 * list + rating so the client can refresh its cached profile.
 */
export async function saveReview(
  client: Cloud,
  args: { linkId: string; stars: number; text: string; reviewId?: string },
): Promise<ReviewResult> {
  const empty: ReviewResult = { ok: false, reviews: [], rating: null };
  try {
    if (!client || !args.linkId) return { ...empty, error: 'invalid' };
    const stars = Math.round(args.stars);
    if (stars < 1 || stars > 5) return { ...empty, error: 'stars' };
    const text = args.text.trim().slice(0, MAX_REVIEW_TEXT);
    const { data, error } = await client.rpc('upsert_review', {
      p_link_id: args.linkId,
      p_stars: stars,
      p_text: text,
      p_review_id: args.reviewId ?? null,
    });
    if (error || !data) return { ...empty, error: 'network' };
    const d = data as Record<string, unknown>;
    if (d.ok !== true) return { ...empty, error: String(d.error ?? 'invalid') };
    const reviews = parseReviews(d.reviews);
    return {
      ok: true,
      reviews,
      rating: computeRating(reviews),
      reviewId: typeof d.review_id === 'string' ? d.review_id : undefined,
    };
  } catch {
    return { ...empty, error: 'network' };
  }
}

/**
 * Delete the client's own review (Sept 2026). The delete_review RPC only
 * removes a review authored by the caller's link.
 */
export async function deleteReview(
  client: Cloud,
  args: { linkId: string; reviewId: string },
): Promise<ReviewResult> {
  const empty: ReviewResult = { ok: false, reviews: [], rating: null };
  try {
    if (!client || !args.linkId || !args.reviewId) return { ...empty, error: 'invalid' };
    const { data, error } = await client.rpc('delete_review', {
      p_link_id: args.linkId,
      p_review_id: args.reviewId,
    });
    if (error || !data) return { ...empty, error: 'network' };
    const d = data as Record<string, unknown>;
    if (d.ok !== true) return { ...empty, error: String(d.error ?? 'invalid') };
    const reviews = parseReviews(d.reviews);
    return { ok: true, reviews, rating: computeRating(reviews) };
  } catch {
    return { ...empty, error: 'network' };
  }
}

/**
 * Defensive read of the escrow row's last_action JSONB.
 * Anything unshaped maps to undefined — never a crash, never a wrong card.
 */
function parseRealtorAction(v: unknown): RealtorAction | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'checked' && o.kind !== 'reopened') return undefined;
  if (typeof o.stepTitle !== 'string' || typeof o.at !== 'string') return undefined;
  return { kind: o.kind, stepTitle: o.stepTitle, at: o.at };
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
    return { ran: true, ok: false, error: 'no realtor session; sign in to enable sync' };
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

/**
 * Thrown when a push upsert reports success but affected zero rows.
 *
 * Under the RLS owner-policies (migrations 0001/0015: `auth.uid() = user_id`,
 * child rows via the parent escrow) a write that targets a row owned by a
 * DIFFERENT user than the session's auth.uid() does NOT error — PostgREST
 * returns success with zero affected rows. Treating that as "synced" drops
 * the user's edits on the floor: the server keeps the old data, the next
 * boot's cloud pull clobbers the local edits (the outbox dirty-guard only
 * protects queued ops), and every client keeps rendering stale data after
 * refresh — with no error anywhere. That is exactly the "nothing the
 * realtor updates reaches the client" failure (Sept 2026).
 *
 * A zero-affected upsert-by-id can only mean the row exists but belongs to
 * someone else: the insert path would have succeeded otherwise (its WITH
 * CHECK stamps this session's own uid). The op is therefore kept queued for
 * retry instead of being dropped as converged — it self-heals the next time
 * the owning identity drains the outbox.
 */
export class SyncNotAppliedError extends Error {
  readonly table: string;
  readonly expected: number;
  readonly affected: number;
  constructor(table: string, expected: number, affected: number) {
    super(
      `cloudSync: upsert into ${table} affected ${affected} of ${expected} rows. ` +
        `The write silently did nothing (the target row belongs to a different user than this session). ` +
        `No data was changed on the server; the push stays queued for retry.`,
    );
    this.name = 'SyncNotAppliedError';
    this.table = table;
    this.expected = expected;
    this.affected = affected;
  }
}

async function upsertAll(client: Cloud, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  // .select(onConflict) asks PostgREST for the affected rows (RETURNING):
  // without it a write rejected by an RLS owner-policy looks identical to
  // a successful write (no error, zero rows). See SyncNotAppliedError.
  const { data, error } = await client.from(table).upsert(rows, { onConflict }).select(onConflict);
  if (error) throw error;
  const affected = Array.isArray(data) ? data.length : 0;
  if (affected < rows.length) throw new SyncNotAppliedError(table, rows.length, affected);
}

/** Push one escrow and ALL of its steps (both roles) — idempotent. */
export async function pushEscrowNow(client: Cloud, userId: string, escrow: Escrow): Promise<void> {
  const row = toEscrowRow(userId, escrow);
  try {
    await upsertAll(client, 'escrows', [row], 'id');
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    // Migration 0007/0008 not applied yet on this database: retry without
    // the newer columns so the push still lands (per-side close dates and
    // the last-action stamp stay local-only until the migration is applied).
    const legacy = { ...row };
    delete legacy.buyer_closed_at;
    delete legacy.seller_closed_at;
    delete legacy.last_action;
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
 * True when a PostgREST error means a not-yet-applied migration's columns
 * don't exist yet on this database (per-side close dates, last-action,
 * realty group / banner / reviews columns).
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  if (e.code === '42703') return true; // PostgreSQL undefined_column
  // PostgREST schema-cache miss: the column (e.g. from a not-yet-applied
  // migration) isn't in the schema cache.
  if (e.code === 'PGRST204') return true;
  const msg = e.message ?? '';
  return (
    msg.includes('buyer_closed_at') ||
    msg.includes('seller_closed_at') ||
    msg.includes('last_action') ||
    msg.includes('realty_group') ||
    msg.includes('banner_image') ||
    msg.includes('email') ||
    msg.includes('reviews') ||
    msg.includes('rating')
  );
}

export async function pushProfileNow(
  client: Cloud,
  userId: string,
  profile: RealtorProfile,
  removed: MediaKind[] = [],
): Promise<void> {
  const row = toProfileRow(userId, profile, removed);
  try {
    await upsertAll(client, 'realtor_profiles', [row], 'user_id');
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    // Migration 0016 (email) not applied yet: retry without it
    // so the push still lands.
    const retry = { ...row } as Record<string, unknown>;
    delete retry.email;
    try {
      await upsertAll(client, 'realtor_profiles', [retry], 'user_id');
    } catch (e2) {
      if (!isMissingColumnError(e2)) throw e2;
      // Migration 0008 (realty_group / banner_image) not applied yet either:
      // retry with the pre-migration column set.
      delete retry.realty_group;
      delete retry.banner_image;
      await upsertAll(client, 'realtor_profiles', [retry], 'user_id');
    }
  }
}

// -------------------------------------------- profile media removal --

/**
 * Media-removal detection (Sept 28, 2026, Anuraj: profile/banner image
 * removal). A kind was removed when the previous profile had any image
 * for it (local managed URI or remote Storage URL) and the new one has
 * neither. Pure — unit-tested. The edit-profile form's X button is the
 * only flow that nulls an image the profile previously had.
 */
export function mediaKindsRemoved(
  prev: RealtorProfile | null,
  next: RealtorProfile,
): MediaKind[] {
  const out: MediaKind[] = [];
  const had = (uri: string | null, remote: string | null): boolean =>
    (uri ?? remote) != null;
  if (prev) {
    if (had(prev.photoUri, prev.photoRemoteUrl) && !had(next.photoUri, next.photoRemoteUrl)) {
      out.push('photo');
    }
    if (
      had(prev.banner_image, prev.bannerRemoteUrl) &&
      !had(next.banner_image, next.bannerRemoteUrl)
    ) {
      out.push('banner');
    }
  }
  return out;
}

/**
 * KV flags for media removals that have not converged to the server yet
 * (`ctc:media-removed`). A failed removal keeps its flag, so the outbox
 * drain and the boot reconcile retry the Storage delete + URL null —
 * the server can never silently keep a photo the realtor removed.
 */
const K_MEDIA_REMOVED = 'ctc:media-removed';

type MediaRemovedFlags = { photo?: boolean; banner?: boolean };

export async function readPendingMediaRemovals(kv: KV): Promise<MediaKind[]> {
  const raw = (await readJson<MediaRemovedFlags>(kv, K_MEDIA_REMOVED)) ?? {};
  const out: MediaKind[] = [];
  if (raw.photo) out.push('photo');
  if (raw.banner) out.push('banner');
  return out;
}

export async function writePendingMediaRemovals(kv: KV, kinds: MediaKind[]): Promise<void> {
  const cur = (await readJson<MediaRemovedFlags>(kv, K_MEDIA_REMOVED)) ?? {};
  for (const k of kinds) cur[k] = true;
  await writeJson(kv, K_MEDIA_REMOVED, cur);
}

async function clearPendingMediaRemovals(kv: KV, kinds: MediaKind[]): Promise<void> {
  const cur = (await readJson<MediaRemovedFlags>(kv, K_MEDIA_REMOVED)) ?? {};
  let changed = false;
  for (const k of kinds) {
    if (cur[k]) {
      delete cur[k];
      changed = true;
    }
  }
  if (changed) await writeJson(kv, K_MEDIA_REMOVED, cur);
}

/**
 * Converge media removals to the cloud (Sept 28, 2026, Anuraj:
 * profile/banner image removal): delete each removed kind's Storage file,
 * clear its upload fingerprint (the file is gone, so a later re-pick of
 * the same image must re-upload instead of matching the cache), null the
 * profile's remote URLs, and persist via saveProfile.
 *
 * Loud, not best-effort: a Storage failure throws, so the caller's bgPush
 * records a sync error and keeps the op queued — a removal is never
 * reported silently unconfirmed (confirmed-or-loud). The delete itself is
 * idempotent (missing file = already deleted), which keeps retries safe.
 *
 * `deleteLocal` removes the device-local managed file. It is injectable
 * because photoFile.ts statically imports react-native and cannot load in
 * plain node; the app passes the real deleters, tests inject fakes. Local
 * cleanup stays best-effort: a failed local delete must never block the
 * server-side removal.
 */
export async function removeProfileMediaNow(
  client: Cloud,
  userId: string,
  kv: KV,
  kinds: MediaKind[],
  saveProfile: (next: RealtorProfile) => Promise<void>,
  p: RealtorProfile,
  deleteLocal?: (kind: MediaKind) => Promise<void>,
): Promise<RealtorProfile> {
  for (const kind of kinds) {
    if (deleteLocal) {
      try {
        await deleteLocal(kind);
      } catch {
        // Local cleanup is best-effort; the server removal below is not.
      }
    }
    await deleteProfileMedia(client, userId, kind);
  }
  const uploaded = (await readJson<{ photo?: string; banner?: string }>(kv, K_MEDIA_UPLOADED)) ?? {};
  for (const k of kinds) delete uploaded[k];
  await writeJson(kv, K_MEDIA_UPLOADED, uploaded);
  const out: RealtorProfile = {
    ...p,
    photoRemoteUrl: kinds.includes('photo') ? null : p.photoRemoteUrl,
    bannerRemoteUrl: kinds.includes('banner') ? null : p.bannerRemoteUrl,
  };
  await saveProfile(out);
  return out;
}

// ------------------------------------------------- profile media convergence --

/**
 * Fingerprints of the managed photo/banner at the last successful upload
 * (KV `ctc:media-uploaded`). The managed files are single-overwrite paths,
 * so the URI alone never changes — the fingerprint captures the content:
 * web managed files are data: URIs (the URI embeds the bytes), native
 * managed files are fingerprinted by size+mtime via expo-file-system
 * (dynamically imported so plain node never loads it).
 */
const K_MEDIA_UPLOADED = 'ctc:media-uploaded';

async function readJson<T>(kv: KV, key: string): Promise<T | null> {
  try {
    const raw = await kv.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(kv: KV, key: string, value: unknown): Promise<void> {
  try {
    await kv.setItem(key, JSON.stringify(value));
  } catch {
    // Cache writes are best-effort.
  }
}

async function mediaFingerprint(uri: string | null): Promise<string | null> {
  if (!uri) return null;
  if (uri.startsWith('data:')) {
    let h = 0;
    for (let i = 0; i < uri.length; i++) h = (Math.imul(h, 31) + uri.charCodeAt(i)) | 0;
    return `data:${uri.length}:${h >>> 0}`;
  }
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('blob:')) {
    // Already remote (or a dead blob:): there is nothing local to upload.
    return `remote:${uri}`;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = await import('expo-file-system/legacy');
    const info = await fs.getInfoAsync(uri);
    if (info.exists) {
      const size = (info as { size?: unknown }).size;
      const mtime = (info as { modificationTime?: unknown }).modificationTime;
      return `file:${typeof size === 'number' ? size : 0}:${typeof mtime === 'number' ? mtime : 0}`;
    }
    return 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * Ensure the profile's managed photo/banner are uploaded to Storage,
 * uploading ONLY media whose content changed since the last successful
 * upload (fingerprint guard — a name-only edit must not re-upload or churn
 * the ?v= cache-buster). Fresh ?v=-versioned public URLs are stamped onto
 * the returned profile, which is persisted via saveProfile; the server row
 * push itself is the caller's job (see pushProfileWithMedia).
 *
 * This is the Sept 2026 stale-client-photo convergence fix. The media
 * upload used to run ONLY inside saveProfile's live bgPush: any save that
 * converged through the outbox (offline / ping failed / the live run threw)
 * or through the boot-time background reconcile pushed the profile row
 * WITHOUT uploading the new image — the server kept the old photo_url
 * forever while the realtor's device showed the new photo from its local
 * managed file, so clients kept seeing the old photo even after refresh.
 * Every profile-push path now funnels through here. A failed upload keeps
 * the previous URL and records nothing, so the next convergence retries.
 */
export async function ensureProfileMedia(
  client: Cloud,
  userId: string,
  kv: KV,
  p: RealtorProfile,
  saveProfile: (next: RealtorProfile) => Promise<void>,
): Promise<RealtorProfile> {
  const uploaded =
    (await readJson<{ photo?: string; banner?: string }>(kv, K_MEDIA_UPLOADED)) ?? {};
  let out = p;
  let dirty = false;
  const slots = [
    { kind: 'photo' as const, uri: p.photoUri },
    { kind: 'banner' as const, uri: p.banner_image },
  ];
  for (const s of slots) {
    const fp = await mediaFingerprint(s.uri);
    if (!fp || fp === uploaded[s.kind]) continue;
    if (!fp.startsWith('remote:')) {
      const url = await uploadProfileMedia(client, userId, s.kind, s.uri);
      if (!url) continue; // upload failed: keep the old URL, retry next time
      out =
        s.kind === 'photo' ? { ...out, photoRemoteUrl: url } : { ...out, bannerRemoteUrl: url };
    }
    uploaded[s.kind] = fp;
    dirty = true;
  }
  if (dirty) {
    await saveProfile(out);
    await writeJson(kv, K_MEDIA_UPLOADED, uploaded);
  }
  return out;
}

/**
 * Converge one profile to the cloud: upload changed managed media first
 * (fresh ?v= URLs), then upsert the profile row. Use this on EVERY path
 * that pushes the profile — the live save, the outbox drain, and the
 * boot-time background reconcile — never pushProfileNow alone.
 */
export async function pushProfileWithMedia(
  client: Cloud,
  userId: string,
  kv: KV,
  p: RealtorProfile,
  saveProfile: (next: RealtorProfile) => Promise<void>,
  removed: MediaKind[] = [],
  deleteLocal?: (kind: MediaKind) => Promise<void>,
): Promise<void> {
  // Media removals converge here too, not just on the live save: the
  // pending KV flags survive a failed push, so the outbox drain and the
  // boot reconcile re-run the Storage delete + URL null instead of
  // silently keeping the old photo_url/banner_image on the server.
  const pending = await readPendingMediaRemovals(kv);
  const kinds = Array.from(new Set<MediaKind>([...removed, ...pending]));
  let out = p;
  if (kinds.length > 0) {
    out = await removeProfileMediaNow(client, userId, kv, kinds, saveProfile, p, deleteLocal);
  }
  const withRemote = await ensureProfileMedia(client, userId, kv, out, saveProfile);
  await pushProfileNow(client, userId, withRemote, kinds);
  await clearPendingMediaRemovals(kv, kinds);
}

/**
 * Upsert an invite on its primary key. On a code collision (DB unique
 * constraint 23505 on the code column) the code is regenerated and the
 * upsert retried — the invite's code is updated in place so the caller can
 * persist the final value.
 *
 * The upsert (not insert) matters: the outbox drain re-pushes every queued
 * local invite, including ones already synced. With a plain
 * insert the primary-key conflict was misread as a code collision, burning
 * all regeneration attempts and throwing, even though the row was already
 * there. Upserting on id makes a re-push idempotent; a 23505 from the
 * upsert can only be the code colliding with a different invite's row.
 */
export async function pushInviteNow(
  client: Cloud,
  invite: Invite,
  genCode: () => string = randomCode,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CODE_REGEN_ATTEMPTS; attempt++) {
    const { data, error } = await client
      .from('invites')
      .upsert(toInviteRow(invite), { onConflict: 'id' })
      .select('id');
    if (!error) {
      // Same RLS silent-no-op guard as upsertAll: a code-regenerated retry
      // that "succeeds" with zero affected rows must not read as synced.
      const affected = Array.isArray(data) ? data.length : 0;
      if (affected < 1) throw new SyncNotAppliedError('invites', 1, affected);
      return;
    }
    if (!isUniqueViolation(error)) throw error;
    lastError = error;
    invite.code = genCode();
  }
  throw lastError ?? new Error('pushInviteNow: exhausted code-regeneration attempts');
}

export async function pushRevokeNow(client: Cloud, inviteId: string, revokedAt: string): Promise<void> {
  // RLS silent-no-op guard (Sept 2026): PostgREST can report success with
  // zero affected rows when an owner policy rejects the write, so a plain
  // { error } check would read the revocation as synced. Request the
  // affected row and verify it — a revocation that touched nothing must
  // surface as a failure, never as a silent success.
  const { data, error } = await client
    .from('invites')
    .update({ revoked_at: revokedAt })
    .eq('id', inviteId)
    .select('id');
  if (error) throw error;
  const affected = Array.isArray(data) ? data.length : 0;
  if (affected < 1) throw new SyncNotAppliedError('invites', 1, affected);
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

/**
 * Best-effort pull of FULL invite rows for one escrow. Used on login/boot
 * to hydrate server-side invites that were created on another device (or
 * whose local copy was lost) into the local store.
 */
export async function pullFullInvitesNow(client: Cloud, escrowId: string): Promise<Invite[]> {
  const { data, error } = await client
    .from('invites')
    .select('id,code,escrow_id,role,party_name,created_at,revoked_at,redeemed_at')
    .eq('escrow_id', escrowId);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(fromInviteRow);
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
  // RLS silent-no-op guard (Sept 2026): same as pushRevokeNow — verify the
  // revocation actually touched a row.
  const { data, error } = await client
    .from('client_links')
    .update({ revoked_at: revokedAt })
    .eq('id', linkId)
    .select('id');
  if (error) throw error;
  const affected = Array.isArray(data) ? data.length : 0;
  if (affected < 1) throw new SyncNotAppliedError('client_links', 1, affected);
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

/**
 * Drop every queued push op (logout wipe, Sept 2026): unsynced ops carry
 * the previous account's auth.uid() and must never drain under a different
 * realtor's session.
 */
export async function clearOutbox(kv: KV): Promise<void> {
  try {
    await kv.removeItem(K_OUTBOX);
  } catch {
    // best-effort
  }
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
  const next = ops.filter((o) => outboxOpKey(o) !== outboxOpKey(op));
  next.push({ ...op, attempts: 0 });
  await writeOutbox(kv, next);
}

/** Coalescing key for one queued push op. */
export function outboxOpKey(o: {
  op: string;
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
}): string {
  return `${o.op}:${o.escrowId ?? ''}:${o.inviteId ?? ''}:${o.linkId ?? ''}`;
}

/**
 * Drop one queued push op (server-is-truth, Anuraj Sept 2026): the live
 * save path enqueues its op BEFORE attempting the push, so a crash
 * mid-push leaves the op queued for the boot drain (a pure-pull boot must
 * never wipe an unconfirmed local edit). On success the op is dequeued —
 * the row is clean again.
 */
export async function dequeueOutboxOp(
  kv: KV,
  op: { op: string; escrowId?: string; inviteId?: string; linkId?: string },
): Promise<void> {
  const ops = await readOutbox(kv);
  const key = outboxOpKey(op);
  const next = ops.filter((o) => outboxOpKey(o) !== key);
  if (next.length !== ops.length) await writeOutbox(kv, next);
}

const K_CONFLICT_LOG = 'ctc:conflict-log';
const MAX_CONFLICT_LOG = 50;

export interface ConflictEntry {
  at: string;
  entity: 'profile' | 'escrow' | 'invite';
  id: string;
  resolution: 'server-wins';
  detail: string;
}

/**
 * Auditable conflict resolutions (ARCHITECTURE.md principle 5, Anuraj Sept
 * 2026): every time a pull resolves a genuine two-writer divergence in the
 * server's favor, the resolution is appended to a bounded KV ring buffer
 * for diagnostics. Best-effort; never throws, never blocks sync.
 */
export async function logConflict(kv: KV, entry: Omit<ConflictEntry, 'at'>): Promise<void> {
  try {
    const raw = await kv.getItem(K_CONFLICT_LOG);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list: ConflictEntry[] = Array.isArray(parsed) ? parsed : [];
    list.push({ ...entry, at: new Date().toISOString() });
    while (list.length > MAX_CONFLICT_LOG) list.shift();
    await kv.setItem(K_CONFLICT_LOG, JSON.stringify(list));
  } catch {
    // Diagnostics only — never break sync.
  }
}

/** Read the conflict-resolution audit log (newest last). */
export async function readConflictLog(kv: KV): Promise<ConflictEntry[]> {
  try {
    const raw = await kv.getItem(K_CONFLICT_LOG);
    const parsed: unknown = raw ? (JSON.parse(raw) as ConflictEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Drain the outbox against current local state (retries converge on the
 * latest local values). Ops that keep failing past MAX_PUSH_ATTEMPTS are NOT
 * dropped: they become manual-only (kept for an explicit Retry, skipped by
 * automatic drains). SyncNotAppliedError ops are kept as-is; a cap
 * rejection is authoritative and drops the op (the failure record stays).
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
    /**
     * Persist the profile after the media-convergence step stamps fresh
     * ?v= URLs (Sept 2026 stale-client-photo fix). Optional so older
     * callers keep working; when absent the drain falls back to a plain
     * row push with no media upload.
     */
    saveProfile?(p: RealtorProfile): Promise<void>;
    /**
     * Called with the op and the error each time an op fails during the
     * drain (Sept 2026 sync-failure surface: the realtor must see every
     * failure on screen, never silently queued). Optional so existing
     * callers and tests keep working.
     */
    onOpError?(op: OutboxOp, error: unknown): void;
    /**
     * True when the drain was triggered by an explicit user Retry (Sept
     * 2026 sync-failure surface). Manual drains also attempt manual-only
     * ops; automatic drains (boot, background) skip them.
     */
    manual?: boolean;
  },
): Promise<{ drained: number; pending: number }> {
  let ops = await readOutbox(kv);
  let drained = 0;
  const remaining: OutboxOp[] = [];
  for (const op of ops) {
    // Manual-only ops wait for an explicit Retry; automatic drains leave
    // them untouched (and keep their failure records visible).
    if (op.manualOnly && !load.manual) {
      remaining.push(op);
      continue;
    }
    try {
      if (op.op === 'pushEscrow' && op.escrowId) {
        const e = await load.getEscrow(op.escrowId);
        if (e) await pushEscrowNow(client, userId, e);
      } else if (op.op === 'pushProfile') {
        const p = await load.getProfile();
        if (p) {
          // Media convergence (Sept 2026 stale-client-photo fix): a queued
          // profile push must also upload a changed photo/banner. The old
          // code pushed the row alone, so the server kept the old photo_url
          // forever while the realtor's device showed the new local image.
          if (load.saveProfile) await pushProfileWithMedia(client, userId, kv, p, load.saveProfile);
          else await pushProfileNow(client, userId, p);
        }
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
    } catch (e) {
      load.onOpError?.(op, e);
      if (e instanceof SyncNotAppliedError) {
        // Ownership mismatch (the target row belongs to a different user
        // than this session): retrying under THIS identity can never
        // succeed, but dropping the op would lose the user's edits — the
        // boot pull would then clobber them with the stale server copy.
        // Keep it queued without counting toward the drop: it converges on
        // the next drain under the owning identity.
        remaining.push(op);
      } else if (op.op === 'pushInvite' && isCapViolation(e)) {
        // Authoritative cap rejection at drain time (the invite was queued
        // while offline and another device filled the cap meanwhile):
        // retrying would never succeed, so the op is dropped. The final
        // inviteCap failure record (from onOpError above) stays until the
        // user dismisses it.
      } else {
        op.attempts++;
        if (op.attempts < MAX_PUSH_ATTEMPTS) {
          remaining.push(op);
        } else {
          // Automatic attempts are exhausted: keep the op for an explicit
          // manual Retry instead of dropping it, so the failure record the
          // user sees still has something to retry.
          op.manualOnly = true;
          remaining.push(op);
        }
      }
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
