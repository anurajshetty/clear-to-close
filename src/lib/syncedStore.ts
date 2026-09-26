// Clear to Close — synced store.
//
// Wraps the local KV store with the Store interface. Realtor mutations apply
// locally first (offline-first), then push to Supabase in the background;
// failures land in the persisted outbox and are retried on init.
//
// Reads prefer the cloud only when it is proven healthy:
//   - redeemInvite: redeem_invite RPC when Supabase is configured (public
//     gate — no realtor session needed), otherwise the local v1 path.
//   - getBuyerView/getSellerView: get_client_view RPC when this device holds
//     a cloud link for the escrow (public gate — works on client devices
//     with no session), with a cached-view and local fallback.
//   - validateClientLink: get_client_view authority under the public gate.
// Realtor-owned pushes still require the email/password session (cloudOk()).
// When the ping fails (offline / no realtor session / RLS blocking) the app
// behaves exactly as the local-only v1 — sync stays dormant.

import { createStore, type KV, type Store } from './store';
import type {
  ClientRole,
  ClientView,
  Escrow,
  Invite,
  RealtorProfile,
  RedeemResult,
} from './types';
import {
  cloudClient,
  cloudConfigured,
  drainOutbox,
  enqueueOutbox,
  ensureCloudUser,
  fetchCloudView,
  pingCloud,
  pullInvitesNow,
  pushEscrowNow,
  pushInviteNow,
  pushProfileNow,
  pushRevokeNow,
  redeemViaCloud,
  regenerateInviteNow,
  type Cloud,
  type PingResult,
} from './cloudSync';

const K_CLOUD_LINKS = 'ctc:cloudlinks';
const K_CLOUD_VIEW_PREFIX = 'ctc:cloudview:';

interface CloudLinkRef {
  linkId: string;
  role: ClientRole;
}

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

function timeoutMs(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

export function createSyncedStore(
  kv: KV,
  deps?: {
    /** Override the Supabase client factory (unit tests inject a mock). */
    cloudClient?: () => Cloud | null;
    /** Override the redeem RPC timeout (unit tests use a short timeout). */
    redeemTimeoutMs?: number;
  },
): { store: Store; initCloudSync: () => Promise<PingResult> } {
  const local = createStore(kv);

  let ping: PingResult | null = null;
  let userId: string | null = null;
  const profileCache = new Map<string, RealtorProfile | null>();

  const cloudOk = (): boolean => ping?.ok === true && !!userId;
  // An explicit override returning null means "no client" (used by tests to
  // force the local path); only fall back to the real factory when no
  // override was provided at all.
  const client = () => (deps?.cloudClient ? deps.cloudClient() : cloudClient());
  const redeemTimeoutMs = deps?.redeemTimeoutMs ?? 8000;

  // Public client RPCs (redeem_invite, get_client_view) need no realtor
  // session — the configured anon client is enough. This gate is independent
  // of cloudOk() (realtor sync health), so a client device with no session
  // can still redeem an invite and validate its device link.
  const publicOk = (): boolean => cloudConfigured() && !!client();

  /** Fire-and-forget cloud push; failures (or a not-yet-healthy cloud) go
   *  to the outbox for retry, so the system self-heals when connectivity or
   *  the project configuration is fixed later. */
  function bgPush(
    run: (c: NonNullable<ReturnType<typeof cloudClient>>, uid: string) => Promise<void>,
    op: { op: 'pushEscrow' | 'pushProfile' | 'pushInvite' | 'pushRevoke'; escrowId?: string; inviteId?: string } | null,
  ): void {
    if (!cloudConfigured()) return; // truly local build: nothing to queue
    if (cloudOk()) {
      const c = client();
      const uid = userId;
      if (!c || !uid) return;
      void (async () => {
        try {
          await run(c, uid);
        } catch {
          if (op) await enqueueOutbox(kv, { ...op, attempts: 0 });
        }
      })();
      return;
    }
    // Ping pending or failed: queue the op; the init drain (or a later
    // successful ping) retries it.
    if (op) void enqueueOutbox(kv, { ...op, attempts: 0 });
  }

  async function cloudLinks(): Promise<Record<string, CloudLinkRef>> {
    return (await readJson<Record<string, CloudLinkRef>>(kv, K_CLOUD_LINKS)) ?? {};
  }

  async function cloudLinkFor(escrowId: string): Promise<CloudLinkRef | null> {
    const links = await cloudLinks();
    return links[escrowId] ?? null;
  }

  async function saveCloudLink(escrowId: string, ref: CloudLinkRef): Promise<void> {
    const links = await cloudLinks();
    links[escrowId] = ref;
    await writeJson(kv, K_CLOUD_LINKS, links);
  }

  async function initCloudSync(): Promise<PingResult> {
    const c = client();
    const result = await pingCloud(c);
    ping = result;
    try {
      (globalThis as Record<string, unknown>).__ctcCloudPing = result;
    } catch {
      // Non-browser/test environments may not allow the hook.
    }
    if (result.ok && result.userId) {
      userId = result.userId;
      try {
        await drainOutbox(c, userId, kv, {
          getEscrow: (id) => local.getEscrow(id),
          getProfile: () => local.getProfile(),
          getInvite: (id) => local.getInvite(id),
          updateInviteCode: (id, code) => local.updateInviteCode(id, code),
        });
      } catch {
        // Outbox drain is best-effort; ops stay queued for next time.
      }
      // Lightweight reconcile: upserts are idempotent, so pushing everything
      // converges any state that missed the outbox (e.g. a launch where the
      // cloud config was broken and fixed later). Best-effort, background.
      void (async () => {
        try {
          if (!c || !userId) return;
          const profile = await local.getProfile();
          if (profile) await pushProfileNow(c, userId, profile);
          for (const escrow of await local.listEscrows()) {
            await pushEscrowNow(c, userId, escrow);
            for (const inv of await local.listInvites(escrow.id)) {
              await pushInviteNow(c, inv);
            }
          }
        } catch {
          // Next launch retries.
        }
      })();
    }
    return result;
  }

  // Re-resolve the session user if the ping hasn't run yet but a push is
  // attempted (e.g. init hasn't completed). Returns null when dormant.
  async function lazyUser(): Promise<string | null> {
    if (userId) return userId;
    if (ping && !ping.ok) return null;
    const c = client();
    if (!c) return null;
    const uid = await ensureCloudUser(c);
    if (uid && ping?.ok) userId = uid;
    return ping?.ok === true ? uid : null;
  }

  const store: Store = {
    getProfile: () => local.getProfile(),

    async getLinkedProfile(escrowId: string): Promise<RealtorProfile | null> {
      if (profileCache.has(escrowId)) return profileCache.get(escrowId) ?? null;
      const cached = await readJson<{ profile: RealtorProfile | null }>(kv, K_CLOUD_VIEW_PREFIX + escrowId);
      const p = cached?.profile ?? null;
      profileCache.set(escrowId, p);
      return p;
    },

    /**
     * Client-facing realtor profile: the linked profile when this device
     * came through an invite (a client device has no local profile of its
     * own), falling back to the device's own local profile.
     */
    async getClientProfile(escrowId: string | null): Promise<RealtorProfile | null> {
      if (escrowId) {
        const linked = await store.getLinkedProfile(escrowId);
        if (linked) return linked;
      }
      return local.getProfile();
    },

    saveProfile: async (p: RealtorProfile): Promise<void> => {
      await local.saveProfile(p);
      bgPush((c, uid) => pushProfileNow(c, uid, p), { op: 'pushProfile' });
    },

    listEscrows: () => local.listEscrows(),
    getEscrow: (id: string) => local.getEscrow(id),

    createEscrow: async (input): Promise<Escrow> => {
      const e = await local.createEscrow(input);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId: e.id });
      return e;
    },

    toggleStep: async (escrowId, role, stepId): Promise<Escrow> => {
      const e = await local.toggleStep(escrowId, role, stepId);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    addCustomStep: async (escrowId, role, title): Promise<Escrow> => {
      const e = await local.addCustomStep(escrowId, role, title);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    reorderSteps: async (escrowId, role, orderedIds): Promise<Escrow> => {
      const e = await local.reorderSteps(escrowId, role, orderedIds);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    updateTargetDate: async (escrowId, closeDate): Promise<Escrow> => {
      const e = await local.updateTargetDate(escrowId, closeDate);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    closeEscrow: async (escrowId): Promise<Escrow> => {
      const e = await local.closeEscrow(escrowId);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    createInvite: async (escrowId, role, partyName): Promise<Invite> => {
      const invite = await local.createInvite(escrowId, role, partyName);
      bgPush(
        async (c) => {
          const uid = await lazyUser();
          if (!uid) throw new Error('cloud dormant');
          const before = invite.code;
          await pushInviteNow(c, invite);
          if (invite.code !== before) {
            await local.updateInviteCode(invite.id, invite.code);
          }
        },
        { op: 'pushInvite', inviteId: invite.id },
      );
      return invite;
    },

    revokeInvite: async (inviteId: string): Promise<void> => {
      await local.revokeInvite(inviteId);
      const inv = await local.getInvite(inviteId);
      const revokedAt = inv?.revokedAt ?? new Date().toISOString();
      bgPush((c) => pushRevokeNow(c, inviteId, revokedAt), { op: 'pushRevoke', inviteId });
    },

    updateInviteCode: (inviteId: string, code: string) => local.updateInviteCode(inviteId, code),
    getInvite: (inviteId: string) => local.getInvite(inviteId),
    mergeInviteStates: (rows) => local.mergeInviteStates(rows),

    listInvites: async (escrowId: string): Promise<Invite[]> => {
      if (cloudOk()) {
        const c = client();
        if (c) {
          try {
            const rows = await Promise.race([pullInvitesNow(c, escrowId), timeoutMs(4000)]);
            await local.mergeInviteStates(rows as { id: string; revoked_at: string | null; redeemed_at: string | null }[]);
          } catch {
            // Best-effort: local state is still returned below.
          }
        }
      }
      return local.listInvites(escrowId);
    },

    redeemInvite: async (code: string, name: string, deviceId?: string): Promise<RedeemResult> => {
      if (publicOk()) {
        const c = client();
        if (c) {
          try {
            // Attach a no-op catch so a late RPC rejection after our timeout
            // never becomes an unhandled rejection.
            const rpcP = redeemViaCloud(c, code.trim().toUpperCase(), name, deviceId ?? null).then(
              (res) => res,
            );
            rpcP.catch(() => {});
            const res = (await Promise.race([rpcP, timeoutMs(redeemTimeoutMs)])) as
              | (RedeemResult & { linkId?: string })
              | undefined;
            // Timeout or RPC failure: the code may be perfectly good — report
            // a retryable network error, never 'invalid'.
            if (!res) return { ok: false, error: 'network' };
            if (res.ok && res.linkId) {
              await saveCloudLink(res.escrowId, { linkId: res.linkId, role: res.role });
            }
            return res;
          } catch {
            return { ok: false, error: 'network' };
          }
        }
      }
      return local.redeemInvite(code, name, deviceId);
    },

    /**
     * Regenerate an invite code ("Regenerate code" in the share sheet).
     * Cloud path: the regenerate_invite RPC does it atomically; the result
     * is mirrored locally. Local/dormant path: local regenerate + outbox
     * convergence (pushRevoke old invite, pushInvite new invite,
     * revokeClientLink old device link).
     */
    regenerateInvite: async (
      inviteId: string,
      codeOverride?: string,
    ): Promise<{
      oldCode: string;
      invite: Invite;
      revokedLink: { id: string; revokedAt: string } | null;
    }> => {
      if (cloudOk() && !codeOverride) {
        const c = client();
        const uid = userId;
        if (c && uid) {
          try {
            const { newCode, newInviteId } = await regenerateInviteNow(c, inviteId);
            // Mirror locally with the RPC's invite id so local and cloud
            // rows share one id (no local/cloud id divergence).
            return await local.regenerateInvite(inviteId, newCode, newInviteId);
          } catch {
            // Fall through to the local + outbox path below.
          }
        }
      }
      const res = await local.regenerateInvite(inviteId, codeOverride);
      if (cloudConfigured()) {
        // Converge the cloud: revoke the old invite, push the new one, and
        // kill the old device link (drain retries each until it lands).
        await enqueueOutbox(kv, { op: 'pushRevoke', inviteId, attempts: 0 });
        await enqueueOutbox(kv, { op: 'pushInvite', inviteId: res.invite.id, attempts: 0 });
        if (res.revokedLink) {
          await enqueueOutbox(kv, {
            op: 'revokeClientLink',
            linkId: res.revokedLink.id,
            revokedAt: res.revokedLink.revokedAt,
            attempts: 0,
          });
        }
      }
      return res;
    },

    getLinkForInvite: (inviteId: string) => local.getLinkForInvite(inviteId),

    /**
     * Validate a stored device client link before rendering the escrow.
     * Uses the PUBLIC cloud gate (no realtor session needed): get_client_view
     * is the authority — a revoked/superseded link returns valid:false and
     * the client lands on the dead-link screen. Non-revocation failures
     * (network/timeout) fail open so an offline client keeps rendering its
     * cached view.
     */
    validateClientLink: async (linkId: string): Promise<{ valid: boolean }> => {
      if (publicOk()) {
        const c = client();
        if (c) {
          try {
            const res = await Promise.race([fetchCloudView(c, linkId), timeoutMs(8000)]);
            if (res.ok) return { valid: true };
            return /revoked/i.test(res.error ?? '') ? { valid: false } : { valid: true };
          } catch {
            return { valid: true };
          }
        }
      }
      return local.validateClientLink(linkId);
    },

    getBuyerView: (escrowId: string) => viewForRole(escrowId, 'buyer'),
    getSellerView: (escrowId: string) => viewForRole(escrowId, 'seller'),
  };

  async function viewForRole(escrowId: string, role: ClientRole): Promise<ClientView> {
    const link = await cloudLinkFor(escrowId);
    // Public gate: a client device has no realtor session, but the cloud
    // view is still fetchable with the anon client.
    if (link && link.role === role && publicOk()) {
      const c = client();
      if (c) {
        try {
          // Attach a no-op catch so a late RPC rejection after our timeout
          // never becomes an unhandled rejection.
          const rpcP = fetchCloudView(c, link.linkId).then((res) => {
            if (res.ok && res.view) return { view: res.view, profile: res.profile ?? null };
            throw new Error('invalid client view');
          });
          rpcP.catch(() => {});
          const { view, profile } = await Promise.race([rpcP, timeoutMs(8000)]);
          profileCache.set(escrowId, profile);
          await writeJson(kv, K_CLOUD_VIEW_PREFIX + escrowId, { view, profile });
          return view;
        } catch {
          // fall through to cached/local below
        }
      }
    }
    // Cached cloud view (offline) or the local v1 path.
    const cached = await readJson<{ view: ClientView; profile: RealtorProfile | null }>(
      kv,
      K_CLOUD_VIEW_PREFIX + escrowId,
    );
    if (cached?.view && cached.view.role === role) {
      profileCache.set(escrowId, cached.profile);
      return cached.view;
    }
    return role === 'buyer' ? local.getBuyerView(escrowId) : local.getSellerView(escrowId);
  }

  return { store, initCloudSync };
}
