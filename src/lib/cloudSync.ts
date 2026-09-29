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
import { deleteMediaAtPath, storagePathFor, storagePathFromUrl, uploadProfileMedia, type MediaKind } from './mediaUpload';
import { backfillTemplateKey } from './steps';

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
  op:
    | 'pushEscrow'
    | 'pushProfile'
    | 'pushInvite'
    | 'pushRevoke'
    | 'revokeClientLink'
    | 'convergeLinkRevokes';
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
  revokedAt?: string;
  attempts: number;
  /**
   * Set once automatic attempts hit MAX_PUSH_ATTEMPTS (Sept 2026
   * sync-failure surface): the op stays queued so a MANUAL Retry still
   * has something to retry, but automatic drains stop hammering it. Under
   * the synchronous-write model nothing re-arms an op — a retry either
   * lands it (it drains) or leaves it manual-only until the user
   * dismisses it.
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
    // Key dates (migration 0019): realtor-entered on the "Update escrow"
    // sheet; null until set. Missing-column fallback below (see
    // pushEscrowNow) keeps the push landing on pre-0019 databases.
    inspection_deadline: e.inspectionDeadline,
    appraisal_deadline: e.appraisalDeadline,
    loan_approval_date: e.loanApprovalDate,
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
    // Step explainer (migration 0019): the realtor's one-line custom-step
    // note. The key ships only when a note exists — a pre-0019 database
    // then upserts explainer-less steps fine, while a step carrying a note
    // fails the push loudly (confirmed-write contract: the realtor's note
    // is never silently dropped; the write errors until 0019 is applied).
    ...(s.explainer ? { explainer: s.explainer } : null),
    // Template key (migration 0020): the permanent default-step identity
    // the explainer lookup trusts. Ships only when set — custom steps and
    // very old rows omit it, and a pre-0020 database then upserts those
    // steps fine, while a default step carrying a key fails the push
    // loudly (confirmed-write contract: the key is never silently dropped;
    // the write errors until 0020 is applied).
    ...(s.templateKey ? { template_key: s.templateKey } : null),
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
  // Key dates (migration 0019): local 'YYYY-MM-DD' or null. Absent on
  // pre-0019 rows; null until the realtor sets one.
  const keyDate = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  e.inspectionDeadline = keyDate(row.inspection_deadline);
  e.appraisalDeadline = keyDate(row.appraisal_deadline);
  e.loanApprovalDate = keyDate(row.loan_approval_date);
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
  const custom = row.custom === true;
  const role = row.role === 'seller' ? 'seller' : 'buyer';
  const rawKey = typeof row.template_key === 'string' && row.template_key ? row.template_key : null;
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    subtitle: String(row.subtitle ?? ''),
    done: row.done === true,
    custom,
    order: Number(row.position ?? 0),
    completedAt: (row.completed_at as string) ?? null,
    explainer: (row.explainer as string) ?? null,
    // Template key (migration 0020). Rows written before keys existed
    // backfill it by title match here, same as the local upgrade path —
    // titles are intact on pre-rename-UI databases. Custom steps never
    // receive a key.
    templateKey: rawKey ?? backfillTemplateKey(role, { custom, title: String(row.title ?? '') }),
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

/**
 * The invites_no_closed_escrow trigger's rejection (Sept 2026): raised when
 * an insert would mint an invite on a closed or cancelled escrow. Like the
 * cap rejection, this is authoritative and final — retrying would never
 * succeed. Race: an invite created while the escrow was open whose push
 * lands after a close/cancel must roll back locally and surface loudly,
 * never retry forever.
 */
export function isClosedEscrowRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = String((error as { message?: unknown }).message ?? '');
  return /cannot create invites for a (closed|cancelled) escrow/i.test(msg);
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
  // Multi-escrow (Sept 28, 2026): the different-escrow device_has_link
  // rejection is gone — redeem_invite returns the existing link for a
  // same-device/same-escrow redeem instead of erroring, and the
  // (device_id, escrow_id) index makes a second escrow's redeem succeed.
  const valid = ['invalid', 'name_mismatch', 'revoked', 'already_used', 'network'] as const;
  return { ok: false, error: valid.includes(err as (typeof valid)[number]) ? (err as (typeof valid)[number]) : 'invalid' };
}

function mapRpcStep(s: Record<string, unknown>, role: ClientRole): StepT {
  const custom = s.custom === true;
  const rawKey = typeof s.template_key === 'string' && s.template_key ? s.template_key : null;
  return {
    id: String(s.id),
    title: String(s.title ?? ''),
    subtitle: String(s.subtitle ?? ''),
    done: s.done === true,
    custom,
    order: Number(s.position ?? 0),
    completedAt: s.completed_at ? String(s.completed_at) : null,
    // Custom-step explainer (migration 0019): rides the step JSON via
    // to_jsonb(s) in get_client_view. Absent on older rows.
    explainer: typeof s.explainer === 'string' && s.explainer ? s.explainer : null,
    // Template key (migration 0020): rides the same JSON. Pre-key rows
    // backfill by title match — the same safe match as the local upgrade
    // path; custom steps never receive a key.
    templateKey: rawKey ?? backfillTemplateKey(role, { custom, title: String(s.title ?? '') }),
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
  const steps = rawSteps.map((s) => mapRpcStep(s, role)).sort((a, b) => a.order - b.order);
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
    // Key dates (migration 0019): get_client_view serializes the escrow
    // row via to_jsonb(e), so the new columns ride along automatically.
    // Absent on pre-0019 payloads; the card then shows its empty state.
    inspectionDeadline:
      typeof e.inspection_deadline === 'string' ? e.inspection_deadline : null,
    appraisalDeadline:
      typeof e.appraisal_deadline === 'string' ? e.appraisal_deadline : null,
    loanApprovalDate:
      typeof e.loan_approval_date === 'string' ? e.loan_approval_date : null,
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
    // Server updated_at (escrows.updated_at) — drives the multi-escrow list
    // ordering (Sept 28, 2026): most-recently-updated first within each
    // status group. Absent on older payloads; those sort as oldest.
    updatedAt: typeof e.updated_at === 'string' ? e.updated_at : undefined,
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
    // Same for migration 0019 (key dates + step explainers): a pre-0019
    // database keeps the write working, the new fields just stay local
    // until the migration lands.
    const legacy = { ...row };
    delete legacy.buyer_closed_at;
    delete legacy.seller_closed_at;
    delete legacy.last_action;
    delete legacy.inspection_deadline;
    delete legacy.appraisal_deadline;
    delete legacy.loan_approval_date;
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
 * Delete step rows a checklist edit removed (bulk apply, Sept 28, 2026).
 * Runs inside the same confirmed write as the step upserts, after them.
 * Idempotent: a row already gone server-side is converged, not an error
 * (a step added and removed within one draft never reached the server —
 * such ids never appear here, but absence is never treated as failure).
 * Transport/RLS errors still throw and fail the write loudly.
 */
export async function deleteStepRowsNow(client: Cloud, stepIds: string[]): Promise<void> {
  if (stepIds.length === 0) return;
  const { error } = await client.from('steps').delete().in('id', stepIds).select('id');
  if (error) throw error;
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

export async function clearPendingMediaRemovals(kv: KV, kinds?: MediaKind[]): Promise<void> {
  const cur = (await readJson<MediaRemovedFlags>(kv, K_MEDIA_REMOVED)) ?? {};
  let changed = false;
  const list: MediaKind[] = kinds ?? (Object.keys(cur) as MediaKind[]);
  for (const k of list) {
    if (cur[k]) {
      delete cur[k];
      changed = true;
    }
  }
  if (changed) await writeJson(kv, K_MEDIA_REMOVED, cur);
}

/**
 * Profile photo/banner convergence (Sept 28, 2026; synchronous
 * server-first writes, Anuraj): these helpers run INSIDE a confirmed
 * write, before the local snapshot commits. They mutate ONLY the preview
 * draft passed in (never persist locally) and throw on any failure, so a
 * failed save leaves local state — including the device-local managed
 * files and the displayed photo/banner — unchanged.
 *
 * Ordering is the safety property (Sept 28, 2026 redesign):
 * - removeProfileMediaNow (phase 1, local-only): captures the old remote
 *   URLs and nulls the draft's URLs. No server side effects.
 * - ensureProfileMedia: uploads changed managed media to UNIQUE per-upload
 *   paths (fingerprint-guarded, so a name-only edit never re-uploads).
 *   Never overwrites a live file: a later row failure orphans an
 *   unreferenced object instead of changing what clients see. An upload
 *   failure THROWS — the save is never reported as saved with a stale URL.
 * - The profile row upserts NEXT, carrying the nulled URLs and the new
 *   unique-path URLs.
 * - deleteRemovedMediaFiles (phase 2): only AFTER the row confirmed, the
 *   removed files are deleted from Storage (by the path parsed from their
 *   old URLs, falling back to the legacy fixed path). A delete failure
 *   throws — the server row is already nulled so clients are correct, and
 *   the next pull heals the local snapshot.
 *
 * Device-local managed-file deletion is NOT done here: the synced store
 * deletes the files only after the server confirmed, so a failed save
 * never strands a retry without its upload source.
 */
export async function removeProfileMediaNow(
  client: Cloud,
  userId: string,
  kv: KV,
  kinds: MediaKind[],
  p: RealtorProfile,
): Promise<{ profile: RealtorProfile; oldUrls: { photo: string | null; banner: string | null } }> {
  void client;
  void userId;
  void kv;
  // Phase 1 is local-only on purpose: the row must null the URLs BEFORE
  // any Storage file is deleted, so a row failure can never delete a file
  // the confirmed row still references. Mutate the preview draft in place
  // so the commit persists the nulled URLs alongside everything else.
  // Never persist locally from here.
  const oldUrls = { photo: p.photoRemoteUrl, banner: p.bannerRemoteUrl };
  if (kinds.includes('photo')) p.photoRemoteUrl = null;
  if (kinds.includes('banner')) p.bannerRemoteUrl = null;
  return { profile: p, oldUrls };
}

/**
 * Phase 2 of a media removal: delete the removed kinds' Storage files,
 * called ONLY after the profile row confirmed with the URLs nulled.
 * Deletes by the path parsed from each kind's old URL (unique per-upload
 * paths), falling back to the legacy fixed path for pre-change files.
 * Also clears the upload fingerprints for the removed kinds. Loud: a
 * failure throws — the server row is already nulled (clients are correct)
 * and the next pull heals the local snapshot, while the failure surfaces
 * instead of reporting a silent success.
 */
export async function deleteRemovedMediaFiles(
  client: Cloud,
  userId: string,
  kv: KV,
  kinds: MediaKind[],
  oldUrls: { photo: string | null; banner: string | null },
): Promise<void> {
  for (const kind of kinds) {
    const path = storagePathFromUrl(oldUrls[kind]) ?? storagePathFor(userId, kind);
    await deleteMediaAtPath(client, path);
  }
  const uploaded = (await readJson<{ photo?: string; banner?: string }>(kv, K_MEDIA_UPLOADED)) ?? {};
  for (const k of kinds) delete uploaded[k];
  await writeJson(kv, K_MEDIA_UPLOADED, uploaded);
}

// ------------------------------------------------- profile media convergence --

/**
 * Fingerprints of the managed photo/banner at the last successful upload
 * (KV `ctc:media-uploaded`). Uploads go to unique per-upload paths, so a
 * changed file always needs a fresh upload — the fingerprint captures the
 * content to skip re-uploading unchanged files: web managed files are
 * data: URIs (the URI embeds the bytes), native managed files are
 * fingerprinted by size+mtime via expo-file-system (dynamically imported
 * so plain node never loads it).
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
 * Converge one profile's media to the cloud (Sept 2026 stale-client-photo
 * fix, now synchronous): uploads each managed kind whose content changed
 * since the last successful upload (fingerprint-guarded, so a name-only
 * edit never re-uploads or mints a new URL) and sets the draft's remote
 * URLs in place. Uploads go to unique per-upload paths — never over a
 * live file — so a later row failure orphans an unreferenced object
 * instead of changing what clients see. Throws on upload failure — the
 * caller is a confirmed write, so the failure leaves local state
 * unchanged instead of stranding the old photo_url on the server. Never
 * persists locally.
 *
 * The upload fingerprints are RETURNED, not persisted here: the caller
 * persists them only after the profile row confirms. A row failure after
 * a successful upload must not mark an unconfirmed URL as uploaded — the
 * retry would then skip the upload and push the stale URL back onto the
 * row.
 */
export async function ensureProfileMedia(
  client: Cloud,
  userId: string,
  kv: KV,
  p: RealtorProfile,
): Promise<{ profile: RealtorProfile; fingerprints: { photo?: string; banner?: string } | null }> {
  const uploaded =
    (await readJson<{ photo?: string; banner?: string }>(kv, K_MEDIA_UPLOADED)) ?? {};
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
      if (!url) throw new Error(`ensureProfileMedia: ${s.kind} upload failed`);
      if (s.kind === 'photo') p.photoRemoteUrl = url;
      else p.bannerRemoteUrl = url;
    }
    uploaded[s.kind] = fp;
    dirty = true;
  }
  return { profile: p, fingerprints: dirty ? uploaded : null };
}

/**
 * Converge one profile to the cloud: null removed URLs (local-only),
 * upload changed managed media to unique paths, upsert the profile row,
 * then delete the removed Storage files — all inside the caller's
 * confirmed write. The row upsert runs BEFORE any Storage delete, so a
 * row failure can never delete a file the confirmed row still references.
 * Use this on EVERY path that pushes the profile — never pushProfileNow
 * alone.
 */
export async function pushProfileWithMedia(
  client: Cloud,
  userId: string,
  kv: KV,
  p: RealtorProfile,
  removed: MediaKind[] = [],
): Promise<void> {
  // Removals converge from the explicit removed list computed against the
  // stored profile before the write (mediaKindsRemoved). Phase 1 only
  // nulls the draft's URLs — the row below carries the nulls.
  let oldUrls = { photo: null as string | null, banner: null as string | null };
  if (removed.length > 0) {
    ({ oldUrls } = await removeProfileMediaNow(client, userId, kv, removed, p));
  }
  const { fingerprints } = await ensureProfileMedia(client, userId, kv, p);
  await pushProfileNow(client, userId, p, removed);
  // Only after the row confirmed: delete the removed files, then mark the
  // fingerprints uploaded. A row failure leaves the files referenced and
  // the fingerprints unmarked, so the retry re-uploads and carries the
  // fresh URL onto the row instead of skipping to a stale one.
  if (removed.length > 0) {
    await deleteRemovedMediaFiles(client, userId, kv, removed, oldUrls);
  }
  if (fingerprints) await writeJson(kv, K_MEDIA_UPLOADED, fingerprints);
}

/**
 * Server-authoritative link convergence for one invite revocation (Sept
 * 28, 2026): kill every live server-side device link for the invite.
 * The redeem_invite RPC creates client_links rows server-side, which the
 * realtor's device never holds locally — so the killed links are
 * discovered with a live server query and stamped revoked_at inline,
 * inside the caller's confirmed write. A failure throws, leaving local
 * state unchanged.
 */
export async function convergeInviteLinkRevokesNow(
  client: Cloud,
  inviteId: string,
  revokedAt: string,
): Promise<void> {
  const ids = await fetchLiveServerLinkIds(client, inviteId);
  for (const id of ids) {
    const { data, error } = await client
      .from('client_links')
      .update({ revoked_at: revokedAt })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    // A silent no-op (RLS owner policy rejected the write) must surface as
    // a failure, never as a silent success: a link read as "killed" that
    // still works would let a revoked client back in.
    const affected = Array.isArray(data) ? data.length : 0;
    if (affected < 1) throw new SyncNotAppliedError('client_links', 1, affected);
  }
}

/** Timeout error for confirmed writes: the server never confirmed. */
export class WriteTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`Timed out waiting for the server (${label})`);
    this.name = 'WriteTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Await a server write with a hard timeout. On expiry the promise rejects
 * with WriteTimeoutError — the caller's confirmed write then fails without
 * touching local state. A late rejection after the timeout never becomes
 * an unhandled rejection.
 */
export async function withWriteTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WriteTimeoutError(label, ms)), ms);
    });
    // Attach a no-op catch so a late rejection after the timeout never
    // becomes an unhandled rejection.
    promise.catch(() => {});
    return await Promise.race([promise, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    // data {ok:false}, mapped below. Multi-escrow (Sept 28, 2026): the old
    // 0002 one-live-link-per-device index (23505) is replaced by the
    // (device_id, escrow_id) index whose conflicts are resolved INSIDE the
    // redeem_invite RPC (the race loser is handed the winner's link) — a
    // 23505 escaping the RPC is unexpected and must never read as a code
    // verdict, so it falls into the generic retryable 'network'.
    if (error) return { ok: false, error: 'network' };
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

/**
 * Server-authoritative live link IDs for an invite (Sept 28, 2026).
 * client_links rows are created server-side by the redeem_invite RPC —
 * the realtor's device never holds them in its local store (local
 * data.links is written only by the offline redeem fallback) — so every
 * link-killing path MUST query the server instead of trusting local
 * data.links. A local-state-only convergence is a no-op in production:
 * tests that seed local data.links pass for the wrong reason.
 */
export async function fetchLiveServerLinkIds(client: Cloud, inviteId: string): Promise<string[]> {
  const { data, error } = await client
    .from('client_links')
    .select('id')
    .eq('invite_id', inviteId)
    .is('revoked_at', null);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const ids: string[] = [];
  for (const r of rows) {
    const id = String((r as Record<string, unknown>).id ?? '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
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

// ------------------------------------------------- retired outbox --
// RETIRED user-action outbox (Anuraj, Sept 28, 2026): user actions never
// enqueue push ops anymore — every write is a synchronous server-first
// confirmed write (see confirmedWrite in syncedStore.ts). The machinery
// below exists ONLY to drain legacy ops that the retired background-push
// model left queued on upgraded installs: one final drain runs on boot
// (guarded by the ctc:outbox-retired marker in syncedStore), and the user
// can manually Retry surfaced failures. Nothing below may be called by a
// user-action path. enqueueOutbox/dequeueOutboxOp were deleted with the
// retirement — there is no way to add or remove single ops anymore.

/**
 * Outbox serialization (Sept 28, 2026): every remaining outbox
 * read-modify-write runs on a per-KV promise chain, so the final drain's
 * read-process-write cycle can never interleave a stale read between
 * another reader's read and write. The chain survives rejections: a failed
 * op must not stall every later outbox reader forever. The drain holds the
 * chain for its whole read-process-write cycle.
 */
const outboxChains = new WeakMap<KV, Promise<void>>();

function withOutboxChain<T>(kv: KV, fn: () => Promise<T>): Promise<T> {
  const prev = outboxChains.get(kv) ?? Promise.resolve();
  const run = prev.then(fn);
  outboxChains.set(
    kv,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
async function readOutbox(kv: KV): Promise<OutboxOp[]> {
  try {
    const raw = await kv.getItem(K_OUTBOX);
    const ops = raw ? (JSON.parse(raw) as OutboxOp[]) : [];
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

/** Legacy queued push ops (exported so pulls can skip rows a pending legacy op owns). */
export async function readOutboxOps(kv: KV): Promise<OutboxOp[]> {
  // Serialized with the drain and the logout-wipe: a pull reading the
  // skip-set mid-drain must see a consistent snapshot, never a half-drained
  // list.
  return withOutboxChain(kv, () => readOutbox(kv));
}

/**
 * Drop every queued push op (logout wipe, Sept 2026): unsynced ops carry
 * the previous account's auth.uid() and must never drain under a different
 * realtor's session.
 */
export async function clearOutbox(kv: KV): Promise<void> {
  return withOutboxChain(kv, async () => {
    try {
      await kv.removeItem(K_OUTBOX);
    } catch {
      // best-effort
    }
  });
}

async function writeOutbox(kv: KV, ops: OutboxOp[]): Promise<void> {
  try {
    await kv.setItem(K_OUTBOX, JSON.stringify(ops));
  } catch {
    // Best-effort: the drain records the failure on the sync-failure
    // surface either way.
  }
}

/** Coalescing key for one queued push op (legacy ops only, see above). */
export function outboxOpKey(o: {
  op: string;
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
}): string {
  return `${o.op}:${o.escrowId ?? ''}:${o.inviteId ?? ''}:${o.linkId ?? ''}`;
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
     * callers and tests keep working. May be async: the drain awaits it,
     * so concurrent failure records cannot clobber each other in the
     * persisted map (read-modify-write race, caught Sept 28 2026 when a
     * revoke drain lost the pushRevoke record next to a converge failure).
     */
    onOpError?(op: OutboxOp, error: unknown): void | Promise<void>;
    /**
     * True when the drain was triggered by an explicit user Retry (Sept
     * 2026 sync-failure surface). Manual drains also attempt manual-only
     * ops; automatic drains (boot, background) skip them.
     */
    manual?: boolean;
  },
): Promise<{ drained: number; pending: number }> {
  // Serialized with every other outbox reader/writer (see withOutboxChain):
  // the drain's read-process-write cycle is atomic relative to concurrent
  // clearOutbox and readOutboxOps calls, so no op can vanish between the
  // read and the final write.
  return withOutboxChain(kv, () => drainOutboxLocked(client, userId, kv, load));
}

async function drainOutboxLocked(
  client: Cloud,
  userId: string,
  kv: KV,
  load: {
    getEscrow(id: string): Promise<Escrow | null>;
    getProfile(): Promise<RealtorProfile | null>;
    getInvite?(inviteId: string): Promise<Invite | null>;
    updateInviteCode?(inviteId: string, code: string): Promise<unknown>;
    saveProfile?(p: RealtorProfile): Promise<void>;
    onOpError?(op: OutboxOp, error: unknown): void | Promise<void>;
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
          await pushProfileWithMedia(client, userId, kv, p, []);
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
      } else if (op.op === 'convergeLinkRevokes' && op.inviteId && op.revokedAt) {
        // Server-authoritative link convergence (Sept 28, 2026): the
        // redeem_invite RPC creates client_links rows server-side, which
        // the realtor's device never holds locally — so the killed links
        // are discovered with a live server query HERE, at drain time,
        // where a failure stays queued and retries. A one-shot query at
        // action time would strand the zombie with no recovery path (the
        // Sept 28 side-effect pass caught exactly that hole).
        const ids = await fetchLiveServerLinkIds(client, op.inviteId);
        for (const id of ids) {
          await pushLinkRevokeNow(client, id, op.revokedAt);
        }
      }
      drained++;
    } catch (e) {
      await load.onOpError?.(op, e);
      if (e instanceof SyncNotAppliedError) {
        // Ownership mismatch (the target row belongs to a different user
        // than this session): retrying under THIS identity can never
        // succeed, but dropping the op would lose the user's edits — the
        // boot pull would then clobber them with the stale server copy.
        // Keep it queued without counting toward the drop: it converges on
        // the next drain under the owning identity.
        remaining.push(op);
      } else if (op.op === 'pushInvite' && (isCapViolation(e) || isClosedEscrowRejection(e))) {
        // Authoritative cap / closed-escrow rejection at drain time (the
        // invite was queued while offline and another device filled the cap
        // meanwhile, or the escrow was closed/cancelled before the push
        // landed): retrying would never succeed, so the op is dropped. The
        // final failure record (from onOpError above) stays until the user
        // dismisses it.
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
