// Clear to Close — the store. Single source of truth for the data layer.
//
// Everything is persisted through a KV backend. Each store instance keeps an
// in-memory snapshot so that critical sections (notably redeemInvite) run
// synchronously without an await between check and mutation — with JS's
// single-threaded execution that makes concurrent redeems resolve to exactly
// one winner.

import { BUY_STEPS, SELL_STEPS, type StepTemplate } from './steps';
import { daysToClose as dayCount } from './dates';
import { applyDerivedStatus, todayLocalISO } from './lifecycle';
import type {
  ApplyChecklistResult,
  ChecklistDraftStep,
  ClientLink,
  ClientRole,
  ClientView,
  CreateEscrowInput,
  Escrow,
  Invite,
  InviteRealtor,
  RealtorProfile,
  RedeemResult,
  ResolveInviteError,
  StepT,
  TcView,
  UpdateEscrowInput,
} from './types';

export interface KV {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}

/** A client device link killed by an explicit escrow close (for cloud
 * convergence via the convergeLinkRevokes outbox op). */
export interface RevokedClientLink {
  id: string;
  revokedAt: string;
}

/** An invite killed by an explicit escrow close/cancel (for cloud
 * convergence via the pushRevoke outbox op). */
export interface RevokedInvite {
  id: string;
  revokedAt: string;
}

/** closeEscrow result: the closed escrow plus the client links and invites
 * revoked at close time. */
export interface CloseEscrowResult {
  escrow: Escrow;
  revokedLinks: RevokedClientLink[];
  revokedInvites: RevokedInvite[];
}

/** cancelEscrow result: the cancelled escrow plus the invites revoked at
 * cancel time (every active invite dies with the escrow). */
export interface CancelEscrowResult {
  escrow: Escrow;
  revokedInvites: RevokedInvite[];
}

/**
 * The local collections as one deep-cloned unit (Sept 2026, synchronous
 * server-first writes). A preview computes a mutation against a cloned
 * snapshot — the live in-memory data and the persisted keys are untouched
 * until the server confirms the write, at which point commitPreview swaps
 * the snapshot in and persists it.
 */
export interface LocalSnapshot {
  profile: RealtorProfile | null;
  escrows: Escrow[];
  invites: Invite[];
  links: ClientLink[];
}

/** A computed-but-unapplied local mutation: the result plus the snapshot
 * carrying it. Pass to commitPreview to apply after server confirmation. */
export interface Preview<T> {
  result: T;
  snapshot: LocalSnapshot;
}

export interface Store {
  getProfile(): Promise<RealtorProfile | null>;
  /**
   * Pull the realtor's profile from the cloud into the local store when the
   * local copy is missing (e.g. login on a new device/browser whose local
   * KV was never seeded). Returns the local profile when present, otherwise
   * the pulled cloud profile — null when none exists anywhere. Only a
   * completed profile (non-empty name) counts. Never throws.
   */
  pullProfileFromCloud(): Promise<RealtorProfile | null>;
  /**
   * Realtor foreground refresh (Sept 2026 stale-profile fix): converge the
   * local profile snapshot from the server row. A locally-dirty profile
   * awaiting push is never clobbered; a missing server row never wipes the
   * local snapshot. Never throws.
   */
  refreshProfile(): Promise<void>;
  /**
   * Pull the realtor's cloud escrows (with steps) into the local store
   * (e.g. login on a new device/browser whose local KV was never seeded).
   * Rows with queued local edits keep the local copy so the pull cannot
   * clobber unsynced changes; a failed pull keeps the local list untouched.
   * Returns the merged local list. Never throws.
   */
  pullEscrowsFromCloud(): Promise<Escrow[]>;
  /** Insert or replace a whole escrow by id (used by the cloud pull-merge). */
  replaceEscrow(e: Escrow): Promise<void>;
  /** Cloud-linked realtor profile for a client view, or null (local path). */
  getLinkedProfile(escrowId: string): Promise<RealtorProfile | null>;
  /**
   * The realtor profile a client device should display for an escrow:
   * the linked realtor profile when this device came through an invite
   * (a client device has no local profile of its own), falling back to
   * the device's own local profile (the realtor's own device).
   */
  getClientProfile(escrowId: string | null): Promise<RealtorProfile | null>;
  saveProfile(p: RealtorProfile): Promise<void>;
  /**
   * Sync-failure surface (Anuraj, Sept 2026): pending failure records for
   * writes that did not reach the server, oldest first. Never throws.
   */
  getSyncErrors(): Promise<import('./syncErrors').SyncError[]>;
  /** Subscribe to failure-record changes. Returns an unsubscribe function. */
  onSyncErrors(fn: () => void): () => void;
  /** Retry every pending write now. Records clear as their writes land. */
  retrySync(): Promise<void>;
  /** Dismiss a final (non-retryable) failure record. Never throws. */
  dismissSyncError(key: string): Promise<void>;
  listEscrows(): Promise<Escrow[]>;
  getEscrow(id: string): Promise<Escrow | null>;
  createEscrow(input: CreateEscrowInput): Promise<Escrow>;
  /**
   * Edit an escrow's fields (deal-list edit round, Sept 2026). Validates
   * like creation; status and steps are preserved (editing a closed or
   * cancelled escrow keeps it closed/cancelled).
   */
  updateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Escrow>;
  /**
   * Reactivate a closed or cancelled escrow (Activate escrow, Sept 2026).
   * Saves the field edits exactly like updateEscrow AND reopens it: status
   * back to 'open' and the per-side close dates cleared (the deal list
   * reads closed from those dates, so flipping status alone would not move
   * the card back to Active). Steps, invites, and client links carry over
   * unchanged — reactivation resumes where it left off. Throws on an
   * already-open escrow (use updateEscrow for that).
   */
  activateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Escrow>;
  /**
   * Move an escrow to the Cancelled section. Closed escrows cannot be
   * cancelled (their cards show the pencil only).
   */
  cancelEscrow(escrowId: string): Promise<CancelEscrowResult>;
  toggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Escrow>;
  addCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Escrow>;
  reorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Escrow>;
  /**
   * Bulk checklist apply for edit mode (Sept 28, 2026): the draft is the
   * full new step list for one side — adds, removes, and reorders land in
   * one confirmed synchronous server write. Throws a plain-language error
   * and leaves local state unchanged on any failure.
   */
  applyChecklistEdits(
    escrowId: string,
    role: ClientRole,
    steps: ChecklistDraftStep[],
  ): Promise<Escrow>;
  updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow>;
  /**
   * Close one side of an escrow (per-side lifecycle). Dual-agency sides
   * close independently; the escrow-level status flips to 'closed' only
   * when every side is closed.
   *
   * An explicit close kills client access (Anuraj, Sept 2026): every live
   * client device link for the closed side is revoked, and the TC links die
   * too once the whole escrow is closed — the same treatment as a revoked
   * invite, so the client lands on the dead-link screen ("this code no
   * longer works"). A side that stays active keeps its clients' access
   * (dual agency). Returns the closed escrow plus the killed links, for
   * cloud convergence.
   */
  closeEscrow(escrowId: string, role: ClientRole): Promise<CloseEscrowResult>;
  createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite>;
  revokeInvite(inviteId: string): Promise<{ revokedLinks: RevokedClientLink[] }>;
  /** Replace an invite's code (cloud collision regeneration). */
  updateInviteCode(inviteId: string, code: string): Promise<Invite>;
  getInvite(inviteId: string): Promise<Invite | null>;
  /** Find an invite by its 6-char code (case/space-insensitive). */
  getInviteByCode(code: string): Promise<Invite | null>;
  /** Merge server-side invite states (redeemed/revoked) into local copies. */
  mergeInviteStates(rows: { id: string; revoked_at: string | null; redeemed_at: string | null }[]): Promise<void>;
  /**
   * Hydrate server-side invites into the local store. Invites missing
   * locally are inserted; for existing ones the server's revoked/redeemed
   * timestamps win (server is the authority). Used on login/boot to pick
   * up invites created on another device.
   */
  mergeInvites(invites: Invite[]): Promise<void>;
  listInvites(escrowId: string): Promise<Invite[]>;
  redeemInvite(code: string, name: string, deviceId?: string): Promise<RedeemResult>;
  /**
   * Resolve an invite code to the inviting realtor's public branding for the
   * branded invite welcome (Sept 2026). Mirrors redeem_invite validation;
   * never redeems. Local path resolves against the local invite + profile.
   */
  resolveInviteRealtor(
    code: string,
  ): Promise<{ ok: true; realtor: InviteRealtor } | { ok: false; error: ResolveInviteError }>;
  /**
   * Regenerate an invite code (share-sheet "Regenerate code").
   * Atomically: old invite revoked + old device link killed + fresh
   * globally-unique single-use code issued for the same escrow/role/party.
   * Returns the replaced code, the new invite, and the killed device link
   * (for cloud convergence), if one existed.
   */
  regenerateInvite(
    inviteId: string,
    codeOverride?: string,
    newId?: string,
  ): Promise<{
    oldCode: string;
    invite: Invite;
    revokedLink: { id: string; revokedAt: string } | null;
  }>;
  /** The live (unrevoked) client link bound to an invite, or null. */
  getLinkForInvite(inviteId: string): Promise<ClientLink | null>;
  /**
   * Validate a stored device client link before rendering the escrow.
   * False when the link — or its invite — was revoked/regenerated away.
   * Fail-open: a link this store has never seen resolves valid, so an
   * offline client keeps rendering its cached view instead of a dead end.
   */
  validateClientLink(linkId: string): Promise<{ valid: boolean }>;
  getBuyerView(escrowId: string): Promise<ClientView>;
  getSellerView(escrowId: string): Promise<ClientView>;
  /**
   * Transaction coordinator view (Sept 2026): both checklists on a
   * both-side escrow; the active side's on a single-side escrow.
   */
  getTcView(escrowId: string): Promise<TcView>;
  /**
   * Client refresh/foreground (Sept 2026): refetch this escrow's cloud view
   * so the linked realtor profile (name/photo) converges on refresh and
   * foreground return. Fails open to the cached snapshot; never throws.
   */
  refreshClientView(escrowId: string): Promise<void>;
  /**
   * Logout wipe (Sept 2026): drop every account-scoped artifact — the
   * in-memory snapshot and the persisted profile/escrows/invites/links —
   * so a different realtor using this device next never sees the previous
   * account's data. Device-scoped keys (role, device id, client link) are
   * owned by auth.ts and are NOT touched here.
   */
  clear(): Promise<void>;
  /**
   * Full logout wipe for the synced store (Sept 2026): clear() plus the
   * cloud caches, the unsynced outbox, and the managed photo/banner files.
   */
  clearLocalAccountData(): Promise<void>;

  // ------------------------------------------------------- confirmed writes --
  /**
   * Synchronous server-first writes (Anuraj, Sept 28, 2026): every
   * user-initiated write computes its candidate state against a CLONED
   * snapshot (preview*), pushes to the server, and only then applies the
   * snapshot locally (commitPreview). A preview never touches the live
   * data or the persisted keys, so a failed or timed-out write leaves
   * local state byte-identical. The plain (non-preview) mutations keep
   * their apply-immediately semantics for the dormant local-only build.
   */
  previewSaveProfile(p: RealtorProfile): Promise<Preview<void>>;
  previewCreateEscrow(input: CreateEscrowInput): Promise<Preview<Escrow>>;
  previewToggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Preview<Escrow>>;
  previewAddCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Preview<Escrow>>;
  previewReorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Preview<Escrow>>;
  /**
   * Bulk checklist apply for edit mode (Sept 28, 2026): replace one side's
   * step list with the draft (adds, removes, reorders, done-state edits in
   * one shot). Returns the escrow plus the ids of steps the edit removed
   * (computed against the snapshot's confirmed state) so the server effect
   * can delete exactly those rows.
   */
  previewApplyChecklist(
    escrowId: string,
    role: ClientRole,
    steps: ChecklistDraftStep[],
  ): Promise<Preview<ApplyChecklistResult>>;
  previewUpdateTargetDate(escrowId: string, closeDate: string): Promise<Preview<Escrow>>;
  previewUpdateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Preview<Escrow>>;
  previewActivateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Preview<Escrow>>;
  previewCancelEscrow(escrowId: string): Promise<Preview<CancelEscrowResult>>;
  previewCloseEscrow(escrowId: string, role: ClientRole): Promise<Preview<CloseEscrowResult>>;
  previewCreateInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Preview<Invite>>;
  previewRevokeInvite(inviteId: string): Promise<Preview<{ revokedLinks: RevokedClientLink[] }>>;
  previewRegenerateInvite(
    inviteId: string,
    codeOverride?: string,
    newId?: string,
  ): Promise<
    Preview<{
      oldCode: string;
      invite: Invite;
      revokedLink: { id: string; revokedAt: string } | null;
    }>
  >;
  /**
   * Apply a confirmed preview: swap the snapshot's collections into the
   * live data, persist, and return the preview's result. Call ONLY after
   * the server has confirmed the write.
   */
  commitPreview<T>(p: Preview<T>): Promise<T>;
}

const K_PROFILE = 'ctc:profile';
const K_ESCROWS = 'ctc:escrows';
const K_INVITES = 'ctc:invites';
const K_LINKS = 'ctc:links';

// Invite code alphabet: no 0/O/1/I/L to avoid visual confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 100;

/**
 * Two active clients per escrow+role max (invite-client flow, Sept 2026).
 * Counts non-revoked invites; revoking frees a slot.
 */
export const MAX_CLIENTS_PER_SIDE = 2;

/**
 * Exactly one active transaction coordinator per escrow (TC invite type,
 * Sept 2026). The TC is separate from the buyer/seller sides.
 * Counts non-revoked invites; revoking frees the slot.
 */
export const MAX_TC_PER_ESCROW = 1;

export function uid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${value}"`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error(`${label} is not a valid calendar date: "${value}"`);
  }
}

function parseLocalMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function roleSteps(e: Escrow, role: ClientRole): StepT[] {
  return role === 'buyer' ? e.buyerSteps : e.sellerSteps;
}

function buildSteps(templates: StepTemplate[]): StepT[] {
  return templates.map((tpl, i) => ({
    id: uid(),
    title: tpl.t,
    subtitle: tpl.s,
    done: false,
    custom: false,
    order: i,
    completedAt: null,
  }));
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function createStore(kv: KV): Store {
  // In-memory snapshot. Loaded lazily on first use; every mutation applies
  // synchronously to the snapshot first, then persists.
  const data: {
    loaded: boolean;
    profile: RealtorProfile | null;
    escrows: Escrow[];
    invites: Invite[];
    links: ClientLink[];
  } = { loaded: false, profile: null, escrows: [], invites: [], links: [] };

  async function ensureLoaded(): Promise<void> {
    if (data.loaded) return;
    const [p, e, i, l] = await Promise.all([
      kv.getItem(K_PROFILE),
      kv.getItem(K_ESCROWS),
      kv.getItem(K_INVITES),
      kv.getItem(K_LINKS),
    ]);
    data.profile = p ? (JSON.parse(p) as RealtorProfile) : null;
    if (data.profile) {
      // Backfill for links saved before the DRE/license field existed.
      if (typeof (data.profile as { dreLicense?: unknown }).dreLicense !== 'string') {
        data.profile.dreLicense = '';
      }
      // Backfill for profiles saved before the realty-group field existed
      // (Sept 2026): starts empty, fillable from account settings.
      if (typeof (data.profile as { realty_group?: unknown }).realty_group !== 'string') {
        data.profile.realty_group = '';
      }
      // Backfill for profiles saved before the banner image existed
      // (Sept 2026): null means no banner (the top card renders its
      // gradient fallback).
      if (typeof (data.profile as { banner_image?: unknown }).banner_image !== 'string') {
        data.profile.banner_image = null;
      }
      // Backfill for profiles saved before the remote Storage URLs existed
      // (Sept 2026): null means no successful upload yet — the local managed
      // files remain the source until the first upload lands.
      if (typeof (data.profile as { photoRemoteUrl?: unknown }).photoRemoteUrl !== 'string') {
        data.profile.photoRemoteUrl = null;
      }
      if (typeof (data.profile as { bannerRemoteUrl?: unknown }).bannerRemoteUrl !== 'string') {
        data.profile.bannerRemoteUrl = null;
      }
      // Backfill for profiles saved before the email field existed
      // (Sept 2026): free text, editable in profile settings.
      if (typeof (data.profile as { email?: unknown }).email !== 'string') {
        data.profile.email = '';
      }
      // Avg days to close was removed from the profile (Anuraj, Sept 2026):
      // drop the stale key so it can never resurface on a display.
      delete (data.profile as { avgDaysToClose?: unknown }).avgDaysToClose;
      // Backfill for profiles saved before reviews existed (Sept 2026).
      if (!Array.isArray((data.profile as { reviews?: unknown }).reviews)) {
        data.profile.reviews = [];
      }
      if (
        typeof (data.profile as { rating?: unknown }).rating !== 'number' &&
        (data.profile as { rating?: unknown }).rating !== null
      ) {
        data.profile.rating = null;
      }
      // Deals-closed was removed from the profile (Anuraj, Sept 2026): drop
      // the stale key so it can never resurface on a display.
      delete (data.profile as { dealsClosed?: unknown }).dealsClosed;
    }
    data.escrows = e ? (JSON.parse(e) as Escrow[]) : [];
    // Backfill for escrows saved before the per-side close dates existed
    // (escrow lifecycle, Sept 2026). A legacy 'closed' status is preserved
    // as-is — isEscrowClosed treats it as closed.
    for (const esc of data.escrows) {
      if (typeof esc.buyerClosedAt !== 'string') esc.buyerClosedAt = null;
      if (typeof esc.sellerClosedAt !== 'string') esc.sellerClosedAt = null;
    }
    data.invites = i ? (JSON.parse(i) as Invite[]) : [];
    // Backfill for links saved before 0002 device linking.
    data.links = (l ? (JSON.parse(l) as ClientLink[]) : []).map((link) => ({
      ...link,
      deviceId: link.deviceId ?? null,
      revokedAt: link.revokedAt ?? null,
    }));
    data.loaded = true;
  }

  async function persist(): Promise<void> {
    await Promise.all([
      kv.setItem(K_PROFILE, JSON.stringify(data.profile)),
      kv.setItem(K_ESCROWS, JSON.stringify(data.escrows)),
      kv.setItem(K_INVITES, JSON.stringify(data.invites)),
      kv.setItem(K_LINKS, JSON.stringify(data.links)),
    ]);
  }

  /**
   * The mutable collections a write computes against. `data` itself
   * extends this shape; previews operate on a deep clone so the live
   * data and the persisted keys stay untouched until commitPreview.
   */
  type Holder = LocalSnapshot;

  function cloneSnapshot(): LocalSnapshot {
    return JSON.parse(
      JSON.stringify({
        profile: data.profile,
        escrows: data.escrows,
        invites: data.invites,
        links: data.links,
      }),
    ) as LocalSnapshot;
  }

  function findEscrowIn(h: Holder, escrowId: string): Escrow {
    const e = h.escrows.find((x) => x.id === escrowId);
    if (!e) throw new Error(`Escrow not found: ${escrowId}`);
    return e;
  }

  function findEscrowOrThrow(escrowId: string): Escrow {
    return findEscrowIn(data, escrowId);
  }

  // Mutations must return NEW object references: screens hold the previous
  // escrow in React state, and setEscrow(sameRef) bails out of re-rendering.
  function cloneEscrow(e: Escrow): Escrow {
    return {
      ...e,
      buyerSteps: e.buyerSteps.map((s) => ({ ...s })),
      sellerSteps: e.sellerSteps.map((s) => ({ ...s })),
    };
  }

  function replaceEscrowIn(h: Holder, next: Escrow): Escrow {
    const i = h.escrows.findIndex((x) => x.id === next.id);
    if (i < 0) throw new Error(`Escrow not found: ${next.id}`);
    h.escrows[i] = next;
    return next;
  }

  function replaceEscrow(next: Escrow): Escrow {
    return replaceEscrowIn(data, next);
  }

  function sortedByOrder(steps: StepT[]): StepT[] {
    return [...steps].sort((a, b) => a.order - b.order);
  }

  function buildClientView(e: Escrow, role: ClientRole): ClientView {
    const steps = sortedByOrder(roleSteps(e, role));
    const done = steps.filter((s) => s.done).length;
    const upNext = steps.find((s) => !s.done) ?? null;
    const daysToClose = dayCount(e.closeDate);
    return {
      escrowId: e.id,
      role,
      address: e.address,
      city: e.city,
      daysToClose,
      done,
      total: steps.length,
      steps,
      upNext,
      // Local-only path: no cloud reviews, so no own review.
      myReviewId: null,
      openDate: e.openDate,
      closeDate: e.closeDate,
      lastAction: e.lastAction ?? null,
      openedAt: e.createdAt,
      // Escrow lifecycle status (Sept 2026, Anuraj's rule): feeds the review
      // gate — a client can leave a review only at 100% on a non-cancelled
      // escrow.
      status: e.status,
    };
  }

  /**
   * Revoke every ACTIVE invite for an escrow (optionally limited to
   * roles), using the exact revokeInvite semantics: the code is
   * invalidated AND the device link tied to the invite is killed at the
   * same moment, so affected devices land on the dead-code state, never
   * a blank screen. Already-revoked invites are untouched (already dead).
   * Single persist is left to the caller.
   */
  function revokeActiveInvites(h: Holder, escrowId: string, roles?: ClientRole[]): RevokedInvite[] {
    const now = new Date().toISOString();
    const revoked: RevokedInvite[] = [];
    for (const inv of h.invites) {
      if (inv.escrowId !== escrowId || inv.revokedAt) continue;
      if (roles && !roles.includes(inv.role)) continue;
      const next = { ...inv, revokedAt: now };
      h.invites[h.invites.indexOf(inv)] = next;
      for (const link of h.links) {
        if (link.inviteId === inv.id && !link.revokedAt) {
          link.revokedAt = now;
        }
      }
      revoked.push({ id: inv.id, revokedAt: now });
    }
    return revoked;
  }

  /** Compute a profile save against the holder (no load, no persist). */
  function computeSaveProfile(h: Holder, p: RealtorProfile): void {
    h.profile = { ...p };
  }

  /**
   * Run a compute against a cloned snapshot and return it as a Preview.
   * The live data and the persisted keys are untouched.
   */
  async function previewFor<T>(compute: (h: Holder) => T): Promise<Preview<T>> {
    await ensureLoaded();
    const snapshot = cloneSnapshot();
    const result = compute(snapshot);
    return { result, snapshot };
  }

  /** Compute an escrow creation against the holder (no load, no persist). */
  function computeCreateEscrow(h: Holder, input: CreateEscrowInput): Escrow {
    const address = input.address.trim();
    // City is no longer collected (Sept 28, 2026): new escrows store ''.
    const city = (input.city ?? '').trim();
    if (!address) throw new Error('createEscrow: address is required');
    assertDate(input.openDate, 'openDate');
    assertDate(input.closeDate, 'closeDate');
    if (parseLocalMidnight(input.closeDate) < parseLocalMidnight(input.openDate)) {
      throw new Error('createEscrow: closeDate cannot be before openDate');
    }
    const trimName = (n?: string) => {
      const t = (n ?? '').trim();
      return t ? t : null;
    };
    const escrow: Escrow = {
      id: uid(),
      address,
      city,
      side: input.side,
      buyerName: trimName(input.buyerName),
      sellerName: trimName(input.sellerName),
      openDate: input.openDate,
      closeDate: input.closeDate,
      buyerSteps: buildSteps(BUY_STEPS),
      sellerSteps: buildSteps(SELL_STEPS),
      status: 'open',
      buyerClosedAt: null,
      sellerClosedAt: null,
      createdAt: new Date().toISOString(),
    };
    h.escrows.push(escrow);
    return escrow;
  }

  /** Compute a step toggle against the holder (no load, no persist). */
  function computeToggleStep(h: Holder, escrowId: string, role: ClientRole, stepId: string): Escrow {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    const step = roleSteps(e, role).find((s) => s.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);
    step.done = !step.done;
    const nowISO = new Date().toISOString();
    step.completedAt = step.done ? nowISO : null;
    // The client home's "LATEST FROM" card shows the single most recent
    // realtor action — forward AND backward moves. An uncheck leaves no
    // completedAt behind, so the action is stamped explicitly here.
    e.lastAction = {
      kind: step.done ? 'checked' : 'reopened',
      stepTitle: step.title,
      at: nowISO,
    };
    if (!step.done) {
      // Unchecking any step in a closed side moves that side back to
      // Active (approved escrow lifecycle, Sept 2026). Only that side
      // reopens — the other side of a dual-agency escrow is untouched.
      if (role === 'buyer') e.buyerClosedAt = null;
      else e.sellerClosedAt = null;
    }
    applyDerivedStatus(e);
    return replaceEscrowIn(h, e);
  }

  /** Compute a custom-step add against the holder (no load, no persist). */
  function computeAddCustomStep(h: Holder, escrowId: string, role: ClientRole, title: string): Escrow {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    const steps = roleSteps(e, role);
    const maxOrder = steps.reduce((m, s) => Math.max(m, s.order), -1);
    steps.push({
      id: uid(),
      title: title.trim(),
      subtitle: '',
      done: false,
      custom: true,
      order: maxOrder + 1,
      completedAt: null,
    });
    return replaceEscrowIn(h, e);
  }

  /** Compute a step reorder against the holder (no load, no persist). */
  function computeReorderSteps(
    h: Holder,
    escrowId: string,
    role: ClientRole,
    orderedIds: string[],
  ): Escrow {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    const steps = roleSteps(e, role);
    const current = new Set(steps.map((s) => s.id));
    if (orderedIds.length !== current.size || !orderedIds.every((id) => current.has(id))) {
      throw new Error('reorderSteps: orderedIds must contain exactly the current step ids');
    }
    const byId = new Map(steps.map((s) => [s.id, s]));
    const next = orderedIds.map((id, index) => ({ ...byId.get(id)!, order: index }));
    if (role === 'buyer') e.buyerSteps = next; else e.sellerSteps = next;
    return replaceEscrowIn(h, e);
  }

  /** Compute a bulk checklist apply against the holder (no load, no persist). */
  function computeApplyChecklist(
    h: Holder,
    escrowId: string,
    role: ClientRole,
    drafts: ChecklistDraftStep[],
  ): ApplyChecklistResult {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    const before = roleSteps(e, role);
    const beforeIds = new Set(before.map((s) => s.id));
    const prevById = new Map(before.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const nowISO = new Date().toISOString();
    const next: StepT[] = drafts.map((d, index) => {
      const title = d.title.trim();
      if (!title) throw new Error('applyChecklistEdits: step titles cannot be empty');
      let id = (d.id ?? '').trim();
      if (!id) id = uid();
      if (seen.has(id)) throw new Error('applyChecklistEdits: duplicate step id in draft');
      seen.add(id);
      const prev = prevById.get(id);
      return {
        id,
        title,
        subtitle: (d.subtitle ?? prev?.subtitle ?? '').trim(),
        done: d.done,
        custom: d.custom,
        order: index,
        completedAt: d.done ? (d.completedAt ?? prev?.completedAt ?? nowISO) : null,
      };
    });
    if (role === 'buyer') e.buyerSteps = next;
    else e.sellerSteps = next;
    const afterIds = new Set(next.map((s) => s.id));
    const removedStepIds = [...beforeIds].filter((id) => !afterIds.has(id));
    // Closed-side semantics (approved checklist edit mode, Sept 28, 2026):
    // removing a checked step from a closed, still-complete side keeps it
    // closed; the edit reopens the side only when an unchecked step
    // remains. Matches toggleStep's uncheck-reopens rule for the add case.
    const wasClosed = role === 'buyer' ? e.buyerClosedAt != null : e.sellerClosedAt != null;
    if (wasClosed && next.some((s) => !s.done)) {
      if (role === 'buyer') e.buyerClosedAt = null;
      else e.sellerClosedAt = null;
    }
    applyDerivedStatus(e);
    replaceEscrowIn(h, e);
    return { escrow: e, removedStepIds };
  }

  /** Compute a target-date update against the holder (no load, no persist). */
  function computeUpdateTargetDate(h: Holder, escrowId: string, closeDate: string): Escrow {    assertDate(closeDate, 'closeDate');
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    if (parseLocalMidnight(closeDate) < parseLocalMidnight(e.openDate)) {
      throw new Error('updateTargetDate: closeDate cannot be before openDate');
    }
    e.closeDate = closeDate;
    return replaceEscrowIn(h, e);
  }

  /** Compute a side close against the holder (no load, no persist). */
  function computeCloseEscrow(h: Holder, escrowId: string, role: ClientRole): CloseEscrowResult {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    const steps = roleSteps(e, role);
    if (steps.length === 0 || steps.some((s) => !s.done)) {
      throw new Error('closeEscrow: every step on the side must be complete');
    }
    const today = todayLocalISO();
    if (role === 'buyer') e.buyerClosedAt = today;
    else e.sellerClosedAt = today;
    applyDerivedStatus(e);
    // Anuraj (Sept 2026): an explicit close kills client access, same as a
    // revoked invite. The closed side's live client links die now; the TC
    // links die once the whole escrow is closed (every side closed). A
    // side that stays active keeps its clients' access (dual agency).
    // validateClientLink reads link.revokedAt, so the killed clients land
    // on the dead-link screen.
    const now = new Date().toISOString();
    const rolesToKill: ClientRole[] = [role];
    if (e.status === 'closed') rolesToKill.push('tc');
    const revokedLinks: RevokedClientLink[] = [];
    for (const link of h.links) {
      if (link.escrowId === escrowId && !link.revokedAt && rolesToKill.includes(link.role)) {
        link.revokedAt = now;
        revokedLinks.push({ id: link.id, revokedAt: now });
      }
    }
    // Invite codes die with the close (Anuraj, Sept 28, 2026): the closed
    // side's active invites are revoked with the same rolesToKill scope —
    // a per-side close kills only that side's invites (the other side and
    // the TC stay live), while a whole-escrow close kills buyer, seller,
    // and TC. Same revoke semantics as revokeInvite: code invalidated +
    // device link killed at the same moment.
    const revokedInvites = revokeActiveInvites(h, escrowId, rolesToKill);
    const next = replaceEscrowIn(h, e);
    return { escrow: next, revokedLinks, revokedInvites };
  }

  /** Compute an escrow field edit against the holder (no load, no persist). */
  function computeUpdateEscrow(h: Holder, escrowId: string, input: UpdateEscrowInput): Escrow {
    const address = input.address.trim();
    if (!address) throw new Error('updateEscrow: address is required');
    assertDate(input.openDate, 'openDate');
    assertDate(input.closeDate, 'closeDate');
    if (parseLocalMidnight(input.closeDate) < parseLocalMidnight(input.openDate)) {
      throw new Error('updateEscrow: closeDate cannot be before openDate');
    }
    const trimName = (n?: string) => {
      const t = (n ?? '').trim();
      return t ? t : null;
    };
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    e.address = address;
    // City is no longer edited (Sept 28, 2026): a supplied value still
    // applies, otherwise the stored city is preserved.
    if (input.city !== undefined) e.city = input.city.trim();
    e.side = input.side;
    e.buyerName = trimName(input.buyerName);
    e.sellerName = trimName(input.sellerName);
    e.openDate = input.openDate;
    e.closeDate = input.closeDate;
    // Status and steps are never touched by an update: editing a closed
    // or cancelled escrow keeps it closed/cancelled with its steps intact.
    return replaceEscrowIn(h, e);
  }

  /** Compute an escrow reactivation against the holder (no load, no persist). */
  function computeActivateEscrow(h: Holder, escrowId: string, input: UpdateEscrowInput): Escrow {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    if (e.status === 'open') {
      throw new Error('activateEscrow: escrow is already open');
    }
    const address = input.address.trim();
    if (!address) throw new Error('activateEscrow: address is required');
    assertDate(input.openDate, 'openDate');
    assertDate(input.closeDate, 'closeDate');
    if (parseLocalMidnight(input.closeDate) < parseLocalMidnight(input.openDate)) {
      throw new Error('activateEscrow: closeDate cannot be before openDate');
    }
    const trimName = (n?: string) => {
      const t = (n ?? '').trim();
      return t ? t : null;
    };
    e.address = address;
    // City is no longer edited (Sept 28, 2026): a supplied value still
    // applies, otherwise the stored city is preserved.
    if (input.city !== undefined) e.city = input.city.trim();
    e.side = input.side;
    e.buyerName = trimName(input.buyerName);
    e.sellerName = trimName(input.sellerName);
    e.openDate = input.openDate;
    e.closeDate = input.closeDate;
    // Reopen: status back to 'open' and the per-side close dates cleared.
    // The deal list reads closed from those dates (isClosedRow), so
    // flipping status alone would leave the card in Closed. Steps,
    // invites, and client links are untouched — reactivation resumes
    // where it left off.
    e.status = 'open';
    e.buyerClosedAt = null;
    e.sellerClosedAt = null;
    return replaceEscrowIn(h, e);
  }

  /** Compute an escrow cancel against the holder (no load, no persist). */
  function computeCancelEscrow(h: Holder, escrowId: string): CancelEscrowResult {
    const e = cloneEscrow(findEscrowIn(h, escrowId));
    if (e.status === 'closed') {
      throw new Error('cancelEscrow: a closed escrow cannot be cancelled');
    }
    e.status = 'cancelled';
    // Invite codes die with the escrow (Anuraj, Sept 28, 2026): every
    // active invite — buyer, seller, and TC — is revoked. Same revoke
    // semantics as revokeInvite: code invalidated + device link killed at
    // the same moment, so affected devices land on the dead-code state,
    // never a blank screen. Already-revoked invites are untouched.
    const revokedInvites = revokeActiveInvites(h, escrowId);
    const next = replaceEscrowIn(h, e);
    return { escrow: next, revokedInvites };
  }

  /** Compute an invite creation against the holder (no load, no persist). */
  function computeCreateInvite(
    h: Holder,
    escrowId: string,
    role: ClientRole,
    partyName: string,
  ): Invite {
    const escrow = findEscrowIn(h, escrowId);
    // No new invites on a dead escrow (Anuraj, Sept 28, 2026): a closed
    // or cancelled escrow must not offer invite creation for any role.
    // The server enforces the same rule with a trigger (migration 0018);
    // this is the app-level gate. Per-side-closed sides (status still
    // 'open') are not blocked — this rule is status-based by design.
    // The gate lives in the compute path so the preview (and therefore
    // every confirmed write) rejects before any server attempt.
    if (escrow.status === 'closed' || escrow.status === 'cancelled') {
      throw new Error(
        `createInvite: cannot create invites for a ${escrow.status} escrow`,
      );
    }
    // Per-role cap: two per buyer/seller side, exactly one transaction
    // coordinator per escrow. Revoking frees a slot, so only live invites
    // count. (The DB trigger enforces the same caps authoritatively.)
    const cap = role === 'tc' ? MAX_TC_PER_ESCROW : MAX_CLIENTS_PER_SIDE;
    const activeForRole = h.invites.filter(
      (i) => i.escrowId === escrowId && i.role === role && !i.revokedAt,
    ).length;
    if (activeForRole >= cap) {
      // Plain-language: preview errors surface unchanged through
      // confirmedWrite (sync-writes, Sept 28, 2026), so this IS the
      // user-facing copy. Unified with the push-time cap rejection copy
      // (plainWriteError / syncErrorCopy inviteCap) for both roles.
      throw new Error(
        'This escrow already has 2 active invite codes. Revoke an unused code first, then create a new one.',
      );
    }
    const existing = new Set(h.invites.map((i) => i.code));
    let code = '';
    let attempts = 0;
    for (; attempts < MAX_CODE_ATTEMPTS; attempts++) {
      const candidate = randomCode();
      if (!existing.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new Error('createInvite: could not generate a unique code after 100 attempts');
    }
    const invite: Invite = {
      id: uid(),
      code,
      escrowId,
      role,
      partyName: partyName.trim(),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      redeemedAt: null,
    };
    h.invites.push(invite);
    return invite;
  }

  /** Compute an invite revocation against the holder (no load, no persist). */
  function computeRevokeInvite(h: Holder, inviteId: string): { revokedLinks: RevokedClientLink[] } {
    const inv = h.invites.find((i) => i.id === inviteId);
    if (!inv) throw new Error(`Invite not found: ${inviteId}`);
    const now = new Date().toISOString();
    inv.revokedAt = now;
    const next = { ...inv };
    h.invites[h.invites.indexOf(inv)] = next;
    // The client link dies with the invite: a revoked client can never get
    // back in on the old link (their access is killed, not just future
    // redemption). validateClientLink reads link.revokedAt. The killed
    // links are returned for cloud convergence — without this, a single
    // invite revoke leaves a zombie live device link on the server that
    // blocks the device from joining any other escrow (Sept 28, 2026).
    const revokedLinks: RevokedClientLink[] = [];
    for (const link of h.links) {
      if (link.inviteId === inviteId && !link.revokedAt) {
        link.revokedAt = now;
        revokedLinks.push({ id: link.id, revokedAt: now });
      }
    }
    return { revokedLinks };
  }

  /** Compute an invite regeneration against the holder (no load, no persist). */
  function computeRegenerateInvite(
    h: Holder,
    inviteId: string,
    codeOverride?: string,
    newId?: string,
  ): {
    oldCode: string;
    invite: Invite;
    revokedLink: { id: string; revokedAt: string } | null;
  } {
    const inv = h.invites.find((i) => i.id === inviteId);
    if (!inv) throw new Error(`regenerateInvite: invite not found: ${inviteId}`);
    if (inv.revokedAt) throw new Error('regenerateInvite: invite already revoked');
    const oldCode = inv.code;
    // Fresh, globally unique single-use code for the same escrow/role/party.
    const taken = new Set(h.invites.map((i) => i.code));
    let code = (codeOverride ?? '').trim().toUpperCase();
    if (code) {
      if (taken.has(code)) throw new Error('regenerateInvite: code collision');
    } else {
      do {
        code = randomCode();
      } while (taken.has(code));
    }
    const now = new Date().toISOString();
    // Atomic within the in-memory critical section: kill the old code and
    // its device link at the same moment the replacement is issued.
    inv.revokedAt = now;
    const link = h.links.find((l) => l.inviteId === inviteId && !l.revokedAt);
    let revokedLink: { id: string; revokedAt: string } | null = null;
    if (link) {
      link.revokedAt = now;
      revokedLink = { id: link.id, revokedAt: now };
    }
    const next: Invite = {
      // The cloud mirror passes the RPC's new_invite_id so local and
      // cloud rows share one id; the local-only path mints its own.
      id: newId ?? uid(),
      code,
      escrowId: inv.escrowId,
      role: inv.role,
      partyName: inv.partyName,
      createdAt: now,
      revokedAt: null,
      redeemedAt: null,
    };
    h.invites.push(next);
    return { oldCode, invite: { ...next }, revokedLink };
  }

  const store: Store = {
    async getProfile(): Promise<RealtorProfile | null> {
      await ensureLoaded();
      return data.profile;
    },

    // Sync-failure surface (Anuraj, Sept 2026): the local-only store never
    // talks to a server, so there are never failure records here.
    async getSyncErrors(): Promise<import('./syncErrors').SyncError[]> {
      return [];
    },
    onSyncErrors(): () => void {
      return () => {};
    },
    async retrySync(): Promise<void> {},
    async dismissSyncError(): Promise<void> {},

    async pullProfileFromCloud(): Promise<RealtorProfile | null> {
      // Local-only build: no cloud to pull from.
      await ensureLoaded();
      return data.profile;
    },

    async refreshProfile(): Promise<void> {
      // Local-only build: nothing to converge from.
    },

    async pullEscrowsFromCloud(): Promise<Escrow[]> {
      // Local-only build: no cloud to pull from.
      await ensureLoaded();
      return data.escrows.map((e) => ({ ...e }));
    },

    async replaceEscrow(e: Escrow): Promise<void> {
      await ensureLoaded();
      const i = data.escrows.findIndex((x) => x.id === e.id);
      if (i >= 0) data.escrows[i] = { ...e };
      else data.escrows.push({ ...e });
      await persist();
    },

    async getLinkedProfile(): Promise<RealtorProfile | null> {
      // Local store has no cloud links; the synced wrapper overrides this.
      return null;
    },

    async getClientProfile(escrowId: string | null): Promise<RealtorProfile | null> {
      // Linked-first: a client device reached this screen through an invite
      // and has no local realtor profile of its own. Falls back to the
      // device's own profile on the realtor's device.
      if (escrowId) {
        const linked = await store.getLinkedProfile(escrowId);
        if (linked) return linked;
      }
      await ensureLoaded();
      return data.profile;
    },

    async saveProfile(p: RealtorProfile): Promise<void> {
      await ensureLoaded();
      computeSaveProfile(data, p);
      await persist();
    },

    async previewSaveProfile(p: RealtorProfile): Promise<Preview<void>> {
      return previewFor((h) => computeSaveProfile(h, p));
    },

    async listEscrows(): Promise<Escrow[]> {
      await ensureLoaded();
      return data.escrows.map((e) => ({ ...e }));
    },

    async getEscrow(id: string): Promise<Escrow | null> {
      await ensureLoaded();
      const e = data.escrows.find((x) => x.id === id);
      return e ?? null;
    },

    async createEscrow(input: CreateEscrowInput): Promise<Escrow> {
      await ensureLoaded();
      const escrow = computeCreateEscrow(data, input);
      await persist();
      return escrow;
    },

    async previewCreateEscrow(input: CreateEscrowInput): Promise<Preview<Escrow>> {
      return previewFor((h) => computeCreateEscrow(h, input));
    },

    async toggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Escrow> {
      await ensureLoaded();
      const next = computeToggleStep(data, escrowId, role, stepId);
      await persist();
      return next;
    },

    async previewToggleStep(
      escrowId: string,
      role: ClientRole,
      stepId: string,
    ): Promise<Preview<Escrow>> {
      return previewFor((h) => computeToggleStep(h, escrowId, role, stepId));
    },

    async addCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Escrow> {
      await ensureLoaded();
      const next = computeAddCustomStep(data, escrowId, role, title);
      await persist();
      return next;
    },

    async previewAddCustomStep(
      escrowId: string,
      role: ClientRole,
      title: string,
    ): Promise<Preview<Escrow>> {
      return previewFor((h) => computeAddCustomStep(h, escrowId, role, title));
    },

    async reorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Escrow> {
      await ensureLoaded();
      const next = computeReorderSteps(data, escrowId, role, orderedIds);
      await persist();
      return next;
    },

    async applyChecklistEdits(
      escrowId: string,
      role: ClientRole,
      steps: ChecklistDraftStep[],
    ): Promise<Escrow> {
      await ensureLoaded();
      const { escrow } = computeApplyChecklist(data, escrowId, role, steps);
      await persist();
      return escrow;
    },

    async previewReorderSteps(
      escrowId: string,
      role: ClientRole,
      orderedIds: string[],
    ): Promise<Preview<Escrow>> {
      return previewFor((h) => computeReorderSteps(h, escrowId, role, orderedIds));
    },

    /**
     * Bulk checklist apply (edit mode, Sept 28, 2026): the draft is the
     * full new step list for one role. New steps (no id) get one minted;
     * order is the array order. Closed-side semantics per the approved
     * spec: removing a checked step from a closed, still-complete side
     * keeps it closed; adding (or leaving) an unchecked step reopens that
     * side. lastAction is untouched — structural edits send no push and
     * the LATEST FROM card keeps the last check/uncheck.
     */
    async previewApplyChecklist(
      escrowId: string,
      role: ClientRole,
      steps: ChecklistDraftStep[],
    ): Promise<Preview<ApplyChecklistResult>> {
      return previewFor((h) => computeApplyChecklist(h, escrowId, role, steps));
    },

    async updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow> {
      await ensureLoaded();
      const next = computeUpdateTargetDate(data, escrowId, closeDate);
      await persist();
      return next;
    },

    async previewUpdateTargetDate(escrowId: string, closeDate: string): Promise<Preview<Escrow>> {
      return previewFor((h) => computeUpdateTargetDate(h, escrowId, closeDate));
    },

    /**
     * Close one side of an escrow (approved escrow lifecycle, Sept 2026).
     * Dual-agency sides close independently — closing the buyer side leaves
     * the seller side active and vice versa. The escrow-level `status` flips
     * to 'closed' only when every side is closed. Requires every step on the
     * side to be checked off (the UI only offers the button then).
     */
    async closeEscrow(escrowId: string, role: ClientRole): Promise<CloseEscrowResult> {
      await ensureLoaded();
      const result = computeCloseEscrow(data, escrowId, role);
      await persist();
      return result;
    },

    async previewCloseEscrow(escrowId: string, role: ClientRole): Promise<Preview<CloseEscrowResult>> {
      return previewFor((h) => computeCloseEscrow(h, escrowId, role));
    },

    async updateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Escrow> {
      await ensureLoaded();
      const next = computeUpdateEscrow(data, escrowId, input);
      await persist();
      return next;
    },

    async previewUpdateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Preview<Escrow>> {
      return previewFor((h) => computeUpdateEscrow(h, escrowId, input));
    },

    async activateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Escrow> {
      await ensureLoaded();
      const next = computeActivateEscrow(data, escrowId, input);
      await persist();
      return next;
    },

    async previewActivateEscrow(
      escrowId: string,
      input: UpdateEscrowInput,
    ): Promise<Preview<Escrow>> {
      return previewFor((h) => computeActivateEscrow(h, escrowId, input));
    },

    async cancelEscrow(escrowId: string): Promise<CancelEscrowResult> {
      await ensureLoaded();
      const result = computeCancelEscrow(data, escrowId);
      await persist();
      return result;
    },

    async previewCancelEscrow(escrowId: string): Promise<Preview<CancelEscrowResult>> {
      return previewFor((h) => computeCancelEscrow(h, escrowId));
    },

    async createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite> {
      await ensureLoaded();
      const invite = computeCreateInvite(data, escrowId, role, partyName);
      await persist();
      return invite;
    },

    async previewCreateInvite(
      escrowId: string,
      role: ClientRole,
      partyName: string,
    ): Promise<Preview<Invite>> {
      return previewFor((h) => computeCreateInvite(h, escrowId, role, partyName));
    },

    async revokeInvite(inviteId: string): Promise<{ revokedLinks: RevokedClientLink[] }> {
      await ensureLoaded();
      const result = computeRevokeInvite(data, inviteId);
      await persist();
      return result;
    },

    async previewRevokeInvite(inviteId: string): Promise<Preview<{ revokedLinks: RevokedClientLink[] }>> {
      return previewFor((h) => computeRevokeInvite(h, inviteId));
    },

    async updateInviteCode(inviteId: string, code: string): Promise<Invite> {
      await ensureLoaded();
      const inv = data.invites.find((i) => i.id === inviteId);
      if (!inv) throw new Error(`Invite not found: ${inviteId}`);
      const next = { ...inv, code };
      data.invites[data.invites.indexOf(inv)] = next;
      await persist();
      return next;
    },

    async getInvite(inviteId: string): Promise<Invite | null> {
      await ensureLoaded();
      return data.invites.find((i) => i.id === inviteId) ?? null;
    },

    async getInviteByCode(code: string): Promise<Invite | null> {
      await ensureLoaded();
      const normalized = code.trim().toUpperCase();
      return data.invites.find((i) => i.code === normalized) ?? null;
    },

    async mergeInviteStates(
      rows: { id: string; revoked_at: string | null; redeemed_at: string | null }[],
    ): Promise<void> {
      await ensureLoaded();
      let changed = false;
      for (const row of rows) {
        const inv = data.invites.find((i) => i.id === row.id);
        if (!inv) continue;
        // Server is the authority on redeemed/revoked timestamps.
        if (row.revoked_at && !inv.revokedAt) {
          inv.revokedAt = row.revoked_at;
          changed = true;
        }
        if (row.redeemed_at && !inv.redeemedAt) {
          inv.redeemedAt = row.redeemed_at;
          changed = true;
        }
      }
      if (changed) await persist();
    },

    async mergeInvites(invites: Invite[]): Promise<void> {
      await ensureLoaded();
      let changed = false;
      for (const inv of invites) {
        const existing = data.invites.find((i) => i.id === inv.id);
        if (!existing) {
          // Server-only invite (created on another device): insert it.
          data.invites.push({ ...inv });
          changed = true;
        } else {
          // Server is the authority on redeemed/revoked timestamps.
          if (inv.revokedAt && !existing.revokedAt) {
            existing.revokedAt = inv.revokedAt;
            changed = true;
          }
          if (inv.redeemedAt && !existing.redeemedAt) {
            existing.redeemedAt = inv.redeemedAt;
            changed = true;
          }
        }
      }
      if (changed) await persist();
    },

    async listInvites(escrowId: string): Promise<Invite[]> {
      await ensureLoaded();
      return data.invites.filter((i) => i.escrowId === escrowId).map((i) => ({ ...i }));
    },

    async redeemInvite(code: string, name: string, deviceId?: string): Promise<RedeemResult> {
      await ensureLoaded();
      // From here to the mutation there is no await: the check-then-set is a
      // single synchronous critical section, so concurrent Promise.all
      // redeems resolve to exactly one winner.
      const normalized = code.trim().toUpperCase();
      const inv = data.invites.find((i) => i.code === normalized);
      if (!inv) return { ok: false, error: 'invalid' };
      if (inv.revokedAt) return { ok: false, error: 'revoked' };
      if (inv.redeemedAt) return { ok: false, error: 'already_used' };
      if (inv.partyName.trim().toLowerCase() !== name.trim().toLowerCase()) {
        return { ok: false, error: 'name_mismatch' };
      }
      inv.redeemedAt = new Date().toISOString();
      const link: ClientLink = {
        id: uid(),
        escrowId: inv.escrowId,
        inviteId: inv.id,
        role: inv.role,
        partyName: inv.partyName,
        createdAt: new Date().toISOString(),
        // 0002 device linking: a successful redeem binds one device id.
        deviceId: deviceId ?? null,
        revokedAt: null,
      };
      data.links.push(link);
      await persist();
      // Role comes from the invite, never from caller input.
      return { ok: true, escrowId: inv.escrowId, role: inv.role, partyName: inv.partyName, linkId: link.id };
    },

    async resolveInviteRealtor(
      code: string,
    ): Promise<{ ok: true; realtor: InviteRealtor } | { ok: false; error: ResolveInviteError }> {
      await ensureLoaded();
      const normalized = code.trim().toUpperCase();
      const inv = data.invites.find((i) => i.code === normalized);
      if (!inv) return { ok: false, error: 'invalid' };
      if (inv.revokedAt) return { ok: false, error: 'revoked' };
      if (inv.redeemedAt) return { ok: false, error: 'already_used' };
      const p = data.profile;
      if (!p) return { ok: false, error: 'unknown' };
      return {
        ok: true,
        realtor: {
          name: p.name,
          // Remote bucket URL first, local managed file as fallback (Sept
          // 2026): the local resolve path serves the offline case, where the
          // local file is the only thing guaranteed to render.
          photoUrl: p.photoRemoteUrl ?? p.photoUri,
          realtyGroup: p.realty_group,
          dreLicense: p.dreLicense,
          realtorId: '',
          role: inv.role,
        },
      };
    },

    async regenerateInvite(
      inviteId: string,
      codeOverride?: string,
      newId?: string,
    ): Promise<{
      oldCode: string;
      invite: Invite;
      revokedLink: { id: string; revokedAt: string } | null;
    }> {
      await ensureLoaded();
      const result = computeRegenerateInvite(data, inviteId, codeOverride, newId);
      await persist();
      return result;
    },

    async previewRegenerateInvite(
      inviteId: string,
      codeOverride?: string,
      newId?: string,
    ): Promise<
      Preview<{
        oldCode: string;
        invite: Invite;
        revokedLink: { id: string; revokedAt: string } | null;
      }>
    > {
      return previewFor((h) => computeRegenerateInvite(h, inviteId, codeOverride, newId));
    },

    async getLinkForInvite(inviteId: string): Promise<ClientLink | null> {
      await ensureLoaded();
      return data.links.find((l) => l.inviteId === inviteId && !l.revokedAt) ?? null;
    },

    async validateClientLink(linkId: string): Promise<{ valid: boolean }> {
      await ensureLoaded();
      const link = data.links.find((l) => l.id === linkId);
      // Fail-open: this store has never seen the link (e.g. the redeem went
      // through the cloud on a client device) — it cannot be proven dead.
      if (!link) return { valid: true };
      if (link.revokedAt) return { valid: false };
      const inv = data.invites.find((i) => i.id === link.inviteId);
      if (!inv || inv.revokedAt) return { valid: false };
      return { valid: true };
    },

    async getBuyerView(escrowId: string): Promise<ClientView> {
      await ensureLoaded();
      return buildClientView(findEscrowOrThrow(escrowId), 'buyer');
    },

    async getSellerView(escrowId: string): Promise<ClientView> {
      await ensureLoaded();
      return buildClientView(findEscrowOrThrow(escrowId), 'seller');
    },

    async getTcView(escrowId: string): Promise<TcView> {
      await ensureLoaded();
      const e = findEscrowOrThrow(escrowId);
      // Anuraj's decision (Sept 2026): both checklists on a both-side
      // escrow; the active side's on a single-side escrow. Inactive sides
      // are null — never silently one side when both exist.
      return {
        escrowId: e.id,
        address: e.address,
        city: e.city,
        daysToClose: dayCount(e.closeDate),
        buyer: e.side === 'sell' ? null : buildClientView(e, 'buyer'),
        seller: e.side === 'buy' ? null : buildClientView(e, 'seller'),
      };
    },

    // Local-only store: no cloud view to refetch — the local profile is
    // already the source of truth here.
    async refreshClientView(_escrowId: string): Promise<void> {},

    async clear(): Promise<void> {
      data.loaded = false;
      data.profile = null;
      data.escrows = [];
      data.invites = [];
      data.links = [];
      await Promise.all([
        kv.removeItem(K_PROFILE),
        kv.removeItem(K_ESCROWS),
        kv.removeItem(K_INVITES),
        kv.removeItem(K_LINKS),
      ]);
    },

    /** The local store holds no cloud caches: the full wipe is clear(). */
    clearLocalAccountData: () => store.clear(),

    async commitPreview<T>(p: Preview<T>): Promise<T> {
      await ensureLoaded();
      data.profile = p.snapshot.profile;
      data.escrows = p.snapshot.escrows;
      data.invites = p.snapshot.invites;
      data.links = p.snapshot.links;
      await persist();
      return p.result;
    },
  };

  return store;
}
