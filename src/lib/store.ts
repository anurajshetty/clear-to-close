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
  ClientLink,
  ClientRole,
  ClientView,
  CreateEscrowInput,
  Escrow,
  Invite,
  RealtorProfile,
  RedeemResult,
  StepT,
  UpdateEscrowInput,
} from './types';

export interface KV {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
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
   * Move an escrow to the Cancelled section. Closed escrows cannot be
   * cancelled (their cards show the pencil only).
   */
  cancelEscrow(escrowId: string): Promise<Escrow>;
  toggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Escrow>;
  addCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Escrow>;
  reorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Escrow>;
  updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow>;
  /** "Edit dates" sheet: both dates editable; target close must be ≥ opened. */
  updateDates(escrowId: string, openDate: string, closeDate: string): Promise<Escrow>;
  /**
   * Close one side of an escrow (per-side lifecycle). Dual-agency sides
   * close independently; the escrow-level status flips to 'closed' only
   * when every side is closed.
   */
  closeEscrow(escrowId: string, role: ClientRole): Promise<Escrow>;
  createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite>;
  revokeInvite(inviteId: string): Promise<void>;
  /** Replace an invite's code (cloud collision regeneration). */
  updateInviteCode(inviteId: string, code: string): Promise<Invite>;
  getInvite(inviteId: string): Promise<Invite | null>;
  /** Merge server-side invite states (redeemed/revoked) into local copies. */
  mergeInviteStates(rows: { id: string; revoked_at: string | null; redeemed_at: string | null }[]): Promise<void>;
  listInvites(escrowId: string): Promise<Invite[]>;
  redeemInvite(code: string, name: string, deviceId?: string): Promise<RedeemResult>;
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

function uid(): string {
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

  function findEscrowOrThrow(escrowId: string): Escrow {
    const e = data.escrows.find((x) => x.id === escrowId);
    if (!e) throw new Error(`Escrow not found: ${escrowId}`);
    return e;
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

  function replaceEscrow(next: Escrow): Escrow {
    const i = data.escrows.findIndex((x) => x.id === next.id);
    if (i < 0) throw new Error(`Escrow not found: ${next.id}`);
    data.escrows[i] = next;
    return next;
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
    };
  }

  const store: Store = {
    async getProfile(): Promise<RealtorProfile | null> {
      await ensureLoaded();
      return data.profile;
    },

    async pullProfileFromCloud(): Promise<RealtorProfile | null> {
      // Local-only build: no cloud to pull from.
      await ensureLoaded();
      return data.profile;
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
      data.profile = { ...p };
      await persist();
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
      const address = input.address.trim();
      const city = input.city.trim();
      if (!address) throw new Error('createEscrow: address is required');
      if (!city) throw new Error('createEscrow: city is required');
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
      data.escrows.push(escrow);
      await persist();
      return escrow;
    },

    async toggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      const step = roleSteps(e, role).find((s) => s.id === stepId);
      if (!step) throw new Error(`Step not found: ${stepId}`);
      step.done = !step.done;
      step.completedAt = step.done ? new Date().toISOString() : null;
      if (!step.done) {
        // Unchecking any step in a closed side moves that side back to
        // Active (approved escrow lifecycle, Sept 2026). Only that side
        // reopens — the other side of a dual-agency escrow is untouched.
        if (role === 'buyer') e.buyerClosedAt = null;
        else e.sellerClosedAt = null;
      }
      applyDerivedStatus(e);
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    async addCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
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
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    async reorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      const steps = roleSteps(e, role);
      const current = new Set(steps.map((s) => s.id));
      if (orderedIds.length !== current.size || !orderedIds.every((id) => current.has(id))) {
        throw new Error('reorderSteps: orderedIds must contain exactly the current step ids');
      }
      const byId = new Map(steps.map((s) => [s.id, s]));
      const next = orderedIds.map((id, index) => ({ ...byId.get(id)!, order: index }));
      if (role === 'buyer') e.buyerSteps = next; else e.sellerSteps = next;
      const replaced = replaceEscrow(e);
      await persist();
      return replaced;
    },

    async updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow> {
      await ensureLoaded();
      assertDate(closeDate, 'closeDate');
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      if (parseLocalMidnight(closeDate) < parseLocalMidnight(e.openDate)) {
        throw new Error('updateTargetDate: closeDate cannot be before openDate');
      }
      e.closeDate = closeDate;
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    /**
     * "Edit dates" sheet (approved escrow lifecycle, Sept 2026): both dates
     * are editable in place; the target close must be on or after the opened
     * date. The time tracker recomputes from these dates.
     */
    async updateDates(escrowId: string, openDate: string, closeDate: string): Promise<Escrow> {
      await ensureLoaded();
      assertDate(openDate, 'openDate');
      assertDate(closeDate, 'closeDate');
      if (parseLocalMidnight(closeDate) < parseLocalMidnight(openDate)) {
        throw new Error('updateDates: closeDate cannot be before openDate');
      }
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      e.openDate = openDate;
      e.closeDate = closeDate;
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    /**
     * Close one side of an escrow (approved escrow lifecycle, Sept 2026).
     * Dual-agency sides close independently — closing the buyer side leaves
     * the seller side active and vice versa. The escrow-level `status` flips
     * to 'closed' only when every side is closed. Requires every step on the
     * side to be checked off (the UI only offers the button then).
     */
    async closeEscrow(escrowId: string, role: ClientRole): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      const steps = roleSteps(e, role);
      if (steps.length === 0 || steps.some((s) => !s.done)) {
        throw new Error('closeEscrow: every step on the side must be complete');
      }
      const today = todayLocalISO();
      if (role === 'buyer') e.buyerClosedAt = today;
      else e.sellerClosedAt = today;
      applyDerivedStatus(e);
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    async updateEscrow(escrowId: string, input: UpdateEscrowInput): Promise<Escrow> {
      await ensureLoaded();
      const address = input.address.trim();
      const city = input.city.trim();
      if (!address) throw new Error('updateEscrow: address is required');
      if (!city) throw new Error('updateEscrow: city is required');
      assertDate(input.openDate, 'openDate');
      assertDate(input.closeDate, 'closeDate');
      if (parseLocalMidnight(input.closeDate) < parseLocalMidnight(input.openDate)) {
        throw new Error('updateEscrow: closeDate cannot be before openDate');
      }
      const trimName = (n?: string) => {
        const t = (n ?? '').trim();
        return t ? t : null;
      };
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      e.address = address;
      e.city = city;
      e.side = input.side;
      e.buyerName = trimName(input.buyerName);
      e.sellerName = trimName(input.sellerName);
      e.openDate = input.openDate;
      e.closeDate = input.closeDate;
      // Status and steps are never touched by an update: editing a closed
      // or cancelled escrow keeps it closed/cancelled with its steps intact.
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    async cancelEscrow(escrowId: string): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      if (e.status === 'closed') {
        throw new Error('cancelEscrow: a closed escrow cannot be cancelled');
      }
      e.status = 'cancelled';
      const next = replaceEscrow(e);
      await persist();
      return next;
    },

    async createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite> {
      await ensureLoaded();
      findEscrowOrThrow(escrowId);
      // Two-per-side cap: revoking frees a slot, so only live invites count.
      const activeForSide = data.invites.filter(
        (i) => i.escrowId === escrowId && i.role === role && !i.revokedAt,
      ).length;
      if (activeForSide >= MAX_CLIENTS_PER_SIDE) {
        throw new Error('createInvite: two clients per side max — revoke one to invite someone new');
      }
      const existing = new Set(data.invites.map((i) => i.code));
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
      data.invites.push(invite);
      await persist();
      return invite;
    },

    async revokeInvite(inviteId: string): Promise<void> {
      await ensureLoaded();
      const inv = data.invites.find((i) => i.id === inviteId);
      if (!inv) throw new Error(`Invite not found: ${inviteId}`);
      const now = new Date().toISOString();
      inv.revokedAt = now;
      const next = { ...inv };
      data.invites[data.invites.indexOf(inv)] = next;
      // The client link dies with the invite: a revoked client can never get
      // back in on the old link (their access is killed, not just future
      // redemption). validateClientLink reads link.revokedAt.
      for (const link of data.links) {
        if (link.inviteId === inviteId && !link.revokedAt) {
          link.revokedAt = now;
        }
      }
      await persist();
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
      const inv = data.invites.find((i) => i.id === inviteId);
      if (!inv) throw new Error(`regenerateInvite: invite not found: ${inviteId}`);
      if (inv.revokedAt) throw new Error('regenerateInvite: invite already revoked');
      const oldCode = inv.code;
      // Fresh, globally unique single-use code for the same escrow/role/party.
      const taken = new Set(data.invites.map((i) => i.code));
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
      const link = data.links.find((l) => l.inviteId === inviteId && !l.revokedAt);
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
      data.invites.push(next);
      await persist();
      return { oldCode, invite: { ...next }, revokedLink };
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
  };

  return store;
}
