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
import { uploadProfileMedia } from './mediaUpload';
import type {
  ClientRole,
  ClientView,
  Escrow,
  Invite,
  InviteRealtor,
  RealtorProfile,
  RedeemResult,
  ResolveInviteError,
  TcView,
} from './types';
import {
  cloudClient,
  cloudConfigured,
  drainOutbox,
  enqueueOutbox,
  ensureCloudUser,
  fetchCloudView,
  isCapViolation,
  pingCloud,
  pullEscrowsNow,
  pullFullInvitesNow,
  pullInvitesNow,
  pullProfileNow,
  pushEscrowNow,
  pushInviteNow,
  pushProfileNow,
  pushRevokeNow,
  readOutboxOps,
  redeemViaCloud,
  regenerateInviteNow,
  resolveInviteRealtor as resolveInviteRealtorViaCloud,
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
  // Throttle for background re-inits kicked off when ops are queued while
  // the cloud isn't healthy: at most one re-init per minute, so a burst of
  // offline mutations doesn't hammer the ping endpoint.
  let lastBgReinit = 0;
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
    // Ping pending or failed: queue the op, then kick off a background
    // re-init (throttled) so the outbox drains as soon as the cloud is
    // reachable again — without waiting for the next app reload. This
    // covers the "boot ping failed transiently, user stays in the app and
    // creates an invite" case.
    if (op) void enqueueOutbox(kv, { ...op, attempts: 0 });
    const now = Date.now();
    if (now - lastBgReinit > 60_000) {
      lastBgReinit = now;
      void initCloudSync().catch(() => {});
    }
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
      // Deal-list hydration: a realtor logging in on a device/browser whose
      // local KV was never seeded must see the escrows that already exist
      // under their account. Runs after the outbox drain and before the
      // background push-reconcile, so the push converges on merged state.
      try {
        await pullEscrowsFromCloud();
      } catch {
        // Pull failure keeps the local list as-is.
      }
      // Invite hydration: invites created on another device (or whose local
      // copy was lost) live on the server but never appear locally, because
      // listInvites only merges states for invites already present. Pull
      // the full rows and insert the missing ones, so the client list
      // survives a logout/login round-trip.
      try {
        if (c) {
          for (const escrow of await local.listEscrows()) {
            const rows = await pullFullInvitesNow(c, escrow.id);
            if (rows.length) await local.mergeInvites(rows);
          }
        }
      } catch {
        // Pull failure keeps the local list as-is.
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

  /**
   * Cloud escrow hydration. Pulls the signed-in realtor's escrows (with
   * steps) and merges them into the local store:
   *   - rows missing locally are inserted;
   *   - rows present locally are replaced by the cloud copy UNLESS this
   *     device has queued (unsynced) edits for the row — the local copy
   *     wins then, so a pull can never clobber offline changes;
   *   - local-only rows are never deleted (a partial cloud read must not
   *     wipe the deal list);
   *   - a failed pull returns the local list untouched.
   * Never throws.
   */
  async function pullEscrowsFromCloud(): Promise<Escrow[]> {
    try {
      const existing = await local.listEscrows();
      if (!cloudConfigured()) return existing;
      const c = client();
      if (!c) return existing;
      const cloud = await pullEscrowsNow(c);
      if (cloud === null) return existing;
      const ops = await readOutboxOps(kv);
      for (const e of cloud) {
        const dirty = ops.some((o) => o.op === 'pushEscrow' && o.escrowId === e.id);
        if (!dirty) await local.replaceEscrow(e);
      }
      return local.listEscrows();
    } catch {
      try {
        return await local.listEscrows();
      } catch {
        return [];
      }
    }
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

    /**
     * Post-login profile reconcile. The routing decision in login.tsx and the
     * boot router must not trust the local KV alone: a realtor logging in on
     * a device/browser whose local store was never seeded (new device,
     * cleared storage) would otherwise land on profile creation even though
     * their profile exists in the cloud. When the local copy is missing we
     * pull the cloud row once, persist it locally, and return it.
     *
     * A locally saved profile is returned as-is regardless of its name: an
     * existing profile with an empty name still counts as an existing
     * profile and must not be re-fetched or discarded.
     */
    pullProfileFromCloud: async (): Promise<RealtorProfile | null> => {
      try {
        const existing = await local.getProfile();
        if (existing) return existing;
        if (!cloudConfigured()) return existing;
        const c = client();
        if (!c) return existing;
        const uid = await ensureCloudUser(c);
        if (!uid) return existing;
        const pulled = await pullProfileNow(c, uid);
        if (pulled) {
          await local.saveProfile(pulled);
          return pulled;
        }
        return existing;
      } catch {
        try {
          return await local.getProfile();
        } catch {
          return null;
        }
      }
    },

    pullEscrowsFromCloud,

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
      bgPush(
        async (c, uid) => {
          // Photo/banner Storage upload (Sept 2026, Anuraj-approved): the
          // managed photo/banner upload to the public realtor-media bucket
          // so client devices can see them. Best-effort — any failure keeps
          // the profile local-only, exactly the old behavior. The local
          // managed files remain the offline source and display fallback.
          let withRemote = p;
          try {
            const [photoUrl, bannerUrl] = await Promise.all([
              uploadProfileMedia(c, uid, 'photo', p.photoUri),
              uploadProfileMedia(c, uid, 'banner', p.banner_image),
            ]);
            if (photoUrl !== null || bannerUrl !== null) {
              withRemote = {
                ...p,
                photoRemoteUrl: photoUrl ?? p.photoRemoteUrl ?? null,
                bannerRemoteUrl: bannerUrl ?? p.bannerRemoteUrl ?? null,
              };
              await local.saveProfile(withRemote);
            }
          } catch {
            // Keep the local-only profile; the outbox retry covers the push.
          }
          await pushProfileNow(c, uid, withRemote);
        },
        { op: 'pushProfile' },
      );
    },

    listEscrows: () => local.listEscrows(),
    getEscrow: (id: string) => local.getEscrow(id),
    replaceEscrow: (e: Escrow) => local.replaceEscrow(e),

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

    updateEscrow: async (escrowId, input): Promise<Escrow> => {
      const e = await local.updateEscrow(escrowId, input);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    cancelEscrow: async (escrowId): Promise<Escrow> => {
      const e = await local.cancelEscrow(escrowId);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    // Per-side close (escrow lifecycle, Sept 2026): closing is per side —
    // dual-agency escrows close the buyer and seller sides independently.
    closeEscrow: async (escrowId, role): Promise<Escrow> => {
      const e = await local.closeEscrow(escrowId, role);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    createInvite: async (escrowId, role, partyName): Promise<Invite> => {
      // Stale-cache path (Sept 2026): the local invite cache can lag behind
      // the server (initCloudSync hydrates on a best-effort pull), so the
      // local cap check could see fewer than two active invites and
      // optimistically create a third. Refresh the full server rows first
      // when the cloud is reachable — the local cap check below then enforces
      // the real cap at creation time.
      if (cloudOk()) {
        const c = client();
        if (c) {
          try {
            const rows = await Promise.race([pullFullInvitesNow(c, escrowId), timeoutMs(4000)]);
            await local.mergeInvites(rows);
          } catch {
            // Offline/slow: fall through to the local cap check — offline
            // creation keeps working, and the authoritative cap still applies.
          }
        }
      }
      const invite = await local.createInvite(escrowId, role, partyName);
      bgPush(
        async (c) => {
          const uid = await lazyUser();
          if (!uid) throw new Error('cloud dormant');
          const before = invite.code;
          try {
            await pushInviteNow(c, invite);
          } catch (e) {
            if (isCapViolation(e)) {
              // Lost creation race with another device: the server rejected
              // the insert as over-cap. Roll back the optimistic local row so
              // no phantom over-cap invite survives in the UI, and do NOT
              // enqueue the push — the cap rejection is authoritative and
              // retrying it would never succeed.
              await local.revokeInvite(invite.id);
              console.warn(`[syncedStore] server cap rejected invite ${invite.id}; rolled back locally`);
              return;
            }
            throw e;
          }
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
    getInviteByCode: (code: string) => local.getInviteByCode(code),
    mergeInviteStates: (rows) => local.mergeInviteStates(rows),
    mergeInvites: (invites) => local.mergeInvites(invites),

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
            if (res.ok || res.error !== 'invalid') return res;
            // Server doesn't know the code, but we might hold a local-only
            // invite whose push failed. Push it and retry the redeem once.
            const localInvite = await local.getInviteByCode(code);
            if (localInvite && !localInvite.revokedAt && !localInvite.redeemedAt) {
              try {
                const uid = await lazyUser();
                if (uid) {
                  const before = localInvite.code;
                  await pushInviteNow(c, localInvite);
                  if (localInvite.code !== before) {
                    await local.updateInviteCode(localInvite.id, localInvite.code);
                  }
                  const retry = await redeemViaCloud(
                    c,
                    localInvite.code,
                    name,
                    deviceId ?? null,
                  );
                  if (retry.ok && retry.linkId) {
                    await saveCloudLink(retry.escrowId, { linkId: retry.linkId, role: retry.role });
                  }
                  if (retry.ok || retry.error !== 'invalid') return retry;
                }
              } catch {
                // Push failed; fall through to the local redeem below.
              }
            }
            return local.redeemInvite(code, name, deviceId);
          } catch {
            return { ok: false, error: 'network' };
          }
        }
      }
      return local.redeemInvite(code, name, deviceId);
    },

    resolveInviteRealtor: async (
      code: string,
    ): Promise<{ ok: true; realtor: InviteRealtor } | { ok: false; error: ResolveInviteError }> => {
      if (publicOk()) {
        const c = client();
        if (c) {
          try {
            const rpcP = resolveInviteRealtorViaCloud(c, code).then((res) => res);
            rpcP.catch(() => {});
            const res = (await Promise.race([rpcP, timeoutMs(8000)])) as
              | ({ ok: true; realtor: InviteRealtor } | { ok: false; error: ResolveInviteError })
              | undefined;
            // Timeout or RPC failure: report a retryable network error, never
            // a code verdict — the code may be perfectly good.
            if (!res) return { ok: false, error: 'network' };
            if (res.ok || res.error !== 'invalid') return res;
            // The server doesn't know this code, but we might hold a
            // local-only invite whose push failed or hasn't run yet. Push it
            // now and retry once, so a freshly created code never reads as
            // invalid on the creating device.
            const localInvite = await local.getInviteByCode(code);
            if (localInvite && !localInvite.revokedAt && !localInvite.redeemedAt) {
              try {
                const uid = await lazyUser();
                if (uid) {
                  const before = localInvite.code;
                  await pushInviteNow(c, localInvite);
                  if (localInvite.code !== before) {
                    await local.updateInviteCode(localInvite.id, localInvite.code);
                  }
                  const retry = await resolveInviteRealtorViaCloud(c, localInvite.code);
                  if (retry.ok) return retry;
                }
              } catch {
                // Push failed; fall through to the local resolve below.
              }
            }
            return local.resolveInviteRealtor(code);
          } catch {
            return { ok: false, error: 'network' };
          }
        }
      }
      return local.resolveInviteRealtor(code);
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
            // Fail CLOSED on an explicit server rejection — the link is dead
            // ('revoked', or 'invalid' when no live link row exists). Fail open
            // only on transport failures, so a flaky network never strands a
            // client on the dead-link screen. Exact match: free-form transport
            // messages must never be misread as a server rejection.
            const err = (res.error ?? '').trim().toLowerCase();
            return err === 'revoked' || err === 'invalid' ? { valid: false } : { valid: true };
          } catch {
            return { valid: true };
          }
        }
      }
      return local.validateClientLink(linkId);
    },

    getBuyerView: (escrowId: string) => viewForRole(escrowId, 'buyer'),
    getSellerView: (escrowId: string) => viewForRole(escrowId, 'seller'),
    getTcView: (escrowId: string) => viewForTc(escrowId),
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

  /**
   * Transaction coordinator view (Sept 2026). Mirrors viewForRole: the
   * cloud TC payload (both checklists) when this device holds a live TC
   * link, else the cached view, else the local store. Anuraj's decision:
   * both checklists on a both-side escrow; the active side's on a
   * single-side escrow.
   */
  async function viewForTc(escrowId: string): Promise<TcView> {
    const link = await cloudLinkFor(escrowId);
    // Public gate: a client device has no realtor session, but the cloud
    // view is still fetchable with the anon client.
    if (link && link.role === 'tc' && publicOk()) {
      const c = client();
      if (c) {
        try {
          // Attach a no-op catch so a late RPC rejection after our timeout
          // never becomes an unhandled rejection.
          const rpcP = fetchCloudView(c, link.linkId).then((res) => {
            if (res.ok && res.tcView) return { tcView: res.tcView, profile: res.profile ?? null };
            throw new Error('invalid tc view');
          });
          rpcP.catch(() => {});
          const { tcView, profile } = await Promise.race([rpcP, timeoutMs(8000)]);
          profileCache.set(escrowId, profile);
          await writeJson(kv, K_CLOUD_VIEW_PREFIX + escrowId, { tcView, profile });
          return tcView;
        } catch {
          // fall through to cached/local below
        }
      }
    }
    // Cached cloud view (offline) or the local v1 path.
    const cached = await readJson<{ tcView: TcView; profile: RealtorProfile | null }>(
      kv,
      K_CLOUD_VIEW_PREFIX + escrowId,
    );
    if (cached?.tcView) {
      profileCache.set(escrowId, cached.profile);
      return cached.tcView;
    }
    return local.getTcView(escrowId);
  }

  return { store, initCloudSync };
}
