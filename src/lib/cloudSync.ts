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

export function toProfileRow(userId: string, p: RealtorProfile | null): Record<string, unknown> {
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
  if (p.bannerRemoteUrl != null) row.banner_image = p.bannerRemoteUrl;
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

export async function pushProfileNow(client: Cloud, userId: string, profile: RealtorProfile): Promise<void> {
  const row = toProfileRow(userId, profile);
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

/**
 * Upsert an invite on its primary key. On a code collision (DB unique
 * constraint 23505 on the code column) the code is regenerated and the
 * upsert retried — the invite's code is updated in place so the caller can
 * persist the final value.
 *
 * The upsert (not insert) matters: the boot reconcile and the outbox drain
 * re-push every local invite, including ones already synced. With a plain
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
    const { error } = await client
      .from('invites')
      .upsert(toInviteRow(invite), { onConflict: 'id' });
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
