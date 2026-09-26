// Clear to Close — the store. Single source of truth for the data layer.
//
// Everything is persisted through a KV backend. Each store instance keeps an
// in-memory snapshot so that critical sections (notably redeemInvite) run
// synchronously without an await between check and mutation — with JS's
// single-threaded execution that makes concurrent redeems resolve to exactly
// one winner.

import { BUY_STEPS, SELL_STEPS, type StepTemplate } from './steps';
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
} from './types';

export interface KV {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}

export interface Store {
  getProfile(): Promise<RealtorProfile | null>;
  saveProfile(p: RealtorProfile): Promise<void>;
  listEscrows(): Promise<Escrow[]>;
  getEscrow(id: string): Promise<Escrow | null>;
  createEscrow(input: CreateEscrowInput): Promise<Escrow>;
  toggleStep(escrowId: string, role: ClientRole, stepId: string): Promise<Escrow>;
  addCustomStep(escrowId: string, role: ClientRole, title: string): Promise<Escrow>;
  reorderSteps(escrowId: string, role: ClientRole, orderedIds: string[]): Promise<Escrow>;
  updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow>;
  closeEscrow(escrowId: string): Promise<Escrow>;
  createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite>;
  revokeInvite(inviteId: string): Promise<void>;
  listInvites(escrowId: string): Promise<Invite[]>;
  redeemInvite(code: string, name: string): Promise<RedeemResult>;
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
    data.escrows = e ? (JSON.parse(e) as Escrow[]) : [];
    data.invites = i ? (JSON.parse(i) as Invite[]) : [];
    data.links = l ? (JSON.parse(l) as ClientLink[]) : [];
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
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysToClose = Math.ceil(
      (parseLocalMidnight(e.closeDate).getTime() - todayMidnight.getTime()) / 86400000,
    );
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
      await persist();
      return replaceEscrow(e);
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
      await persist();
      return replaceEscrow(e);
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
      await persist();
      return replaceEscrow(e);
    },

    async updateTargetDate(escrowId: string, closeDate: string): Promise<Escrow> {
      await ensureLoaded();
      assertDate(closeDate, 'closeDate');
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      e.closeDate = closeDate;
      await persist();
      return replaceEscrow(e);
    },

    async closeEscrow(escrowId: string): Promise<Escrow> {
      await ensureLoaded();
      const e = cloneEscrow(findEscrowOrThrow(escrowId));
      e.status = 'closed';
      await persist();
      return replaceEscrow(e);
    },

    async createInvite(escrowId: string, role: ClientRole, partyName: string): Promise<Invite> {
      await ensureLoaded();
      findEscrowOrThrow(escrowId);
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
      inv.revokedAt = new Date().toISOString();
      await persist();
      // Existing client_links stay valid — revoke only blocks future redemption.
    },

    async listInvites(escrowId: string): Promise<Invite[]> {
      await ensureLoaded();
      return data.invites.filter((i) => i.escrowId === escrowId).map((i) => ({ ...i }));
    },

    async redeemInvite(code: string, name: string): Promise<RedeemResult> {
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
      };
      data.links.push(link);
      await persist();
      // Role comes from the invite, never from caller input.
      return { ok: true, escrowId: inv.escrowId, role: inv.role, partyName: inv.partyName, linkId: link.id };
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
