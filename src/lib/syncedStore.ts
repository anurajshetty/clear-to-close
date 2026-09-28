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

import { createStore, type CancelEscrowResult, type CloseEscrowResult, type KV, type Store } from './store';
import type {
  ClientRole,
  ClientView,
  Escrow,
  Invite,
  InviteRealtor,
  RealtorProfile,
  RedeemResult,
  ResolveInviteError,
  StepT,
  TcView,
} from './types';
import {
  cloudClient,
  cloudConfigured,
  clearOutbox,
  dequeueOutboxOp,
  drainOutbox,
  enqueueOutbox,
  ensureCloudUser,
  fetchCloudView,
  isCapViolation,
  logConflict,
  mediaKindsRemoved,
  outboxOpKey,
  pingCloud,
  pullEscrowsNow,
  pullFullInvitesNow,
  pullInvitesNow,
  pullProfileNow,
  pushEscrowNow,
  pushInviteNow,
  pushProfileWithMedia,
  pushRevokeNow,
  readOutboxOps,
  redeemViaCloud,
  regenerateInviteNow,
  resolveInviteRealtor as resolveInviteRealtorViaCloud,
  type Cloud,
  type OutboxOp,
  type PingResult,
  writePendingMediaRemovals,
} from './cloudSync';
import type { MediaKind } from './mediaUpload';
import {
  classifySyncError,
  clearAllSyncErrors,
  clearSyncError,
  opErrorKey,
  readSyncErrors,
  recordSyncError,
  subscribeSyncErrors,
  syncErrorCopy,
  type SyncError,
  type SyncOpKind,
} from './syncErrors';

const K_CLOUD_LINKS = 'ctc:cloudlinks';
const K_CLOUD_VIEW_PREFIX = 'ctc:cloudview:';

/**
 * Delete the realtor's managed photo/banner files (logout wipe, Sept 2026).
 * The filenames/keys are owned by src/lib/photoFile.ts; duplicated here as
 * string literals so this module never statically imports expo-file-system
 * (plain-node tests cannot resolve it). Web files live in localStorage;
 * native files live in the app documents directory.
 */
async function deleteManagedMedia(): Promise<void> {
  try {
    const ls = (globalThis as { localStorage?: { removeItem(k: string): void } | undefined })
      .localStorage;
    if (ls && typeof ls.removeItem === 'function') {
      ls.removeItem('ctc:profile-photo');
      ls.removeItem('ctc:profile-banner');
    }
  } catch {
    // best-effort
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = await import('expo-file-system/legacy');
    const dd: string = fs.documentDirectory ?? '';
    await fs.deleteAsync(`${dd}profile-photo.jpg`, { idempotent: true });
    await fs.deleteAsync(`${dd}profile-banner.jpg`, { idempotent: true });
  } catch {
    // best-effort (node tests land here)
  }
}

/**
 * Delete one device-local managed media file (Sept 28, 2026, Anuraj:
 * profile/banner image removal). photoFile.ts statically imports
 * react-native, so it is dynamically imported here — the same reason
 * deleteManagedMedia above dynamically imports expo-file-system
 * (plain-node tests cannot resolve either).
 */
async function deleteLocalMedia(kind: MediaKind): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pf = await import('./photoFile');
    if (kind === 'photo') await pf.deleteManagedPhoto();
    else await pf.deleteManagedBanner();
  } catch {
    // best-effort (node tests land here)
  }
}

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

  /**
   * Build a persisted failure record for a write that did not reach the
   * server (Sept 2026 sync-failure surface: the realtor must see every
   * failure on screen, never silently queued).
   */
  function syncErrorForOp(
    op: { op: SyncOpKind; escrowId?: string; inviteId?: string; linkId?: string },
    error: unknown,
  ): SyncError {
    const kind = classifySyncError(error);
    return {
      key: opErrorKey(op),
      op: op.op,
      escrowId: op.escrowId,
      inviteId: op.inviteId,
      linkId: op.linkId,
      kind,
      ...syncErrorCopy(op.op, kind),
      at: Date.now(),
    };
  }

  /** Fire-and-forget cloud push; failures (or a not-yet-healthy cloud) go
   *  to the outbox for retry, so the system self-heals when connectivity or
   *  the project configuration is fixed later.
   *
   *  Server-is-truth (Anuraj, Sept 2026): bgPush is the ONLY push entry
   *  point, and it fires only from explicit user actions (Save, check-off,
   *  invite generate/regenerate, close, revoke). There are no background
   *  pushes — boot and foreground return are pure pull. */
  // Throttle for background re-inits kicked off when ops are queued while
  // the cloud isn't healthy: at most one re-init per minute, so a burst of
  // offline mutations doesn't hammer the ping endpoint.
  let lastBgReinit = 0;
  /**
   * Rows with a user action's push currently in flight. Marked
   * SYNCHRONOUSLY when the action fires (before any await), so a pull that
   * is already in flight sees the row as dirty and never overwrites it —
   * the explicit push is the row's only writer, and its confirmation is
   * the last word. Cleared when the push settles; the persisted outbox op
   * covers a crash mid-push (the boot drain retries it — boot itself never
   * pushes).
   */
  const dirtyInflight = new Set<string>();
  /**
   * Dirty-row check: true while an explicit user action's push for this row
   * is in flight (memory flag, set synchronously when the action fires) or
   * queued for retry (persisted outbox). Pulls must never overwrite a dirty
   * row.
   */
  async function isDirty(key: string): Promise<boolean> {
    if (dirtyInflight.has(key)) return true;
    const ops = await readOutboxOps(kv);
    return ops.some((o) => outboxOpKey(o) === key);
  }
  /**
   * Canonical snapshots for conflict detection (ARCHITECTURE.md principle
   * 5): a pull that replaces a clean local snapshot with a DIFFERENT
   * server row is resolving a genuine two-writer divergence, and the
   * resolution is logged. Field subsets are the synced surface — local-only
   * metadata (e.g. lastAction) must not count as a divergence.
   */
  function profileCanon(p: RealtorProfile): string {
    return JSON.stringify([
      p.name,
      p.email,
      p.phone,
      p.about,
      p.yearsExperience,
      p.areasServed,
      p.dreLicense,
      p.realty_group,
      p.photoRemoteUrl,
      p.bannerRemoteUrl,
    ]);
  }
  function escrowCanon(e: Escrow): string {
    const steps = (ss: StepT[]): string =>
      [...ss]
        .sort((a, b) => a.order - b.order)
        .map((s) => [s.id, s.title, s.subtitle, s.done, s.order, s.custom, s.completedAt].join('|'))
        .join(';');
    return JSON.stringify([
      e.address,
      e.city,
      e.side,
      e.buyerName,
      e.sellerName,
      e.openDate,
      e.closeDate,
      e.status,
      steps(e.buyerSteps),
      steps(e.sellerSteps),
    ]);
  }
  function bgPush(
    run: (c: NonNullable<ReturnType<typeof cloudClient>>, uid: string) => Promise<void>,
    op: { op: 'pushEscrow' | 'pushProfile' | 'pushInvite' | 'pushRevoke'; escrowId?: string; inviteId?: string } | null,
  ): void {
    if (!cloudConfigured()) return; // truly local build: nothing to queue
    if (cloudOk()) {
      const c = client();
      const uid = userId;
      if (!c || !uid) return;
      // The user's explicit action dirties the row synchronously — before
      // any await — so a concurrent pull can never interleave a stale
      // overwrite between the tap and the push.
      const key = op ? outboxOpKey(op) : null;
      if (key) dirtyInflight.add(key);
      void (async () => {
        try {
          // Enqueue BEFORE the push is attempted: the row stays dirty for
          // the whole flight, so pulls skip it; and a crash mid-push
          // leaves the op queued for the boot drain (a pure-pull boot must
          // never wipe an unconfirmed local edit).
          if (op) await enqueueOutbox(kv, { ...op, attempts: 0 });
          await run(c, uid);
          // Confirmed on the server: the row is clean again.
          if (op) await dequeueOutboxOp(kv, op);
        } catch (e) {
          // Sync-failure surface (Anuraj, Sept 2026): the write did not
          // reach the server. It is already queued for retry (above), AND
          // the failure is recorded so the realtor sees it on screen
          // immediately — no silent queueing, no "looks saved but wasn't".
          if (op) {
            await recordSyncError(kv, syncErrorForOp(op, e));
          }
        } finally {
          if (key) dirtyInflight.delete(key);
        }
      })();
      return;
    }
    // Ping pending or failed: queue the op, then kick off a background
    // re-init (throttled) so the outbox drains as soon as the cloud is
    // reachable again — without waiting for the next app reload. This
    // covers the "boot ping failed transiently, user stays in the app and
    // creates an invite" case.
    //
    // Sync-failure surface (Anuraj, Sept 2026): when sync is NOT dormant,
    // a queued-but-unsent write is still a write that is not on the
    // server, and the realtor must see it. Dormant sync (no session yet,
    // or the project unconfigured) is the designed local-only path, not
    // a failure — nothing is recorded there.
    const dormant =
      !userId && (!ping || /no realtor session|not configured/i.test(ping.error ?? ''));
    if (op && !dormant) {
      void (async () => {
        await enqueueOutbox(kv, { ...op, attempts: 0 });
        // Same visibility rule as an immediate push failure: the write is
        // queued but not on the server, and the realtor must know.
        await recordSyncError(kv, syncErrorForOp(op, new Error('network: cloud not reachable')));
      })();
    } else if (op) {
      void enqueueOutbox(kv, { ...op, attempts: 0 });
    }
    const now = Date.now();
    if (now - lastBgReinit > 60_000) {
      lastBgReinit = now;
      void initCloudSync().catch(() => {});
    }
  }

  /**
   * Best-effort immediate outbox drain (fire-and-forget). enqueueOutbox
   * alone never pushes — without this, ops queued from an already-open app
   * sit until the next boot (the only other drain is in initCloudSync).
   * Anuraj bug (Sept 2026): closing an escrow left the server's
   * client_links row live, so the client kept access. Failures stay queued
   * for the boot-time drain, so this is purely additive.
   */
  /**
   * Drain the outbox and reconcile the failure records (Sept 2026
   * sync-failure surface): every op that fails during the drain is
   * recorded for the on-screen bar, and every record whose op is no
   * longer pending (it drained) is cleared. Retryable records survive
   * only while their write is still unsent. Pass manual=true for an
   * explicit user Retry so manual-only ops are attempted too.
   */
  async function drainAndReconcileErrors(
    c: NonNullable<ReturnType<typeof cloudClient>>,
    uid: string,
    manual = false,
  ): Promise<void> {
    const load = {
      getEscrow: (id: string) => local.getEscrow(id),
      getProfile: () => local.getProfile(),
      getInvite: (id: string) => local.getInvite(id),
      updateInviteCode: (id: string, code: string) => local.updateInviteCode(id, code),
      // Media convergence (Sept 2026 stale-client-photo fix): the drain
      // must upload a changed photo/banner, not just push the row.
      saveProfile: (prof: RealtorProfile) => local.saveProfile(prof),
      manual,
      onOpError: (op: OutboxOp, error: unknown) => {
        // A cap rejection is authoritative and final: retrying it would
        // never succeed, so it gets the final (dismissable) copy instead
        // of the retryable one.
        const copy =
          op.op === 'pushInvite' && isCapViolation(error)
            ? syncErrorCopy('inviteCap', 'rejected')
            : syncErrorForOp(
                { op: op.op, escrowId: op.escrowId, inviteId: op.inviteId, linkId: op.linkId },
                error,
              );
        void recordSyncError(kv, {
          key: opErrorKey(op),
          op: op.op === 'pushInvite' && isCapViolation(error) ? 'inviteCap' : op.op,
          escrowId: op.escrowId,
          inviteId: op.inviteId,
          linkId: op.linkId,
          kind: classifySyncError(error),
          ...copy,
          at: Date.now(),
        });
      },
    };
    try {
      await drainOutbox(c, uid, kv, load);
    } finally {
      // Clear records whose writes landed: retryable records persist only
      // while their op is still in the outbox. Final (non-retryable)
      // records are dismissed by the user, never auto-cleared.
      const remaining = await readOutboxOps(kv);
      const pendingKeys = new Set(remaining.map(opErrorKey));
      const errors = await readSyncErrors(kv);
      for (const err of errors) {
        if (err.retryable && !pendingKeys.has(err.key)) {
          await clearSyncError(kv, err.key);
        }
      }
    }
  }

  async function drainOutboxNow(): Promise<void> {
    if (!cloudOk()) return;
    const c = client();
    const uid = userId;
    if (!c || !uid) return;
    try {
      await drainAndReconcileErrors(c, uid);
    } catch {
      // Stays queued; the boot-time drain retries.
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
        await drainAndReconcileErrors(c, userId);
      } catch {
        // Outbox drain is best-effort; ops stay queued for next time.
      }
      // Deal-list hydration: a realtor logging in on a device/browser whose
      // local KV was never seeded must see the escrows that already exist
      // under their account. Runs after the outbox drain (queued
      // user-action pushes retry first); boot is pull-only after that.
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
      // Server-is-truth (Anuraj, Sept 2026): boot and foreground return are
      // PULL ONLY. The old "push everything to converge" background
      // reconcile is deleted as a pattern — pushing clean local snapshots
      // on boot is what let a stale device overwrite newer server data
      // (Sept 27 profile rollback: the server's "jimmy ola" was replaced by
      // a stale local "Jimmy"). Pushes happen only as the direct result of
      // an explicit user action (Save, check-off, invite generate/regenerate,
      // close, revoke); a failed action's op stays queued in the outbox and
      // the boot drain above retries it.
    }
    return result;
  }

  /**
   * Converge-when-clean (Sept 2026 stale-profile fix): replace the local
   * profile snapshot with the live server row — unless this device has
   * queued (unsynced) profile edits, which win, mirroring
   * pullEscrowsFromCloud's dirty-row rule. A missing server row never
   * wipes the local snapshot (a profile created while the cloud was
   * unconfigured may never have been pushed). Never throws.
   */
  async function convergeProfileFromCloud(): Promise<void> {
    try {
      if (!cloudConfigured()) return;
      const c = client();
      if (!c) return;
      // Never clobber a local edit that is still awaiting push: a dirty
      // profile (in-flight or queued pushProfile op) means the local
      // snapshot is the explicit user intent — the pull must not touch it.
      if (await isDirty(outboxOpKey({ op: 'pushProfile' }))) return; // local is ahead
      const uid = await ensureCloudUser(c);
      if (!uid) return;
      const pulled = await pullProfileNow(c, uid);
      if (!pulled) return;
      // Re-check just before overwriting: a user Save that landed while
      // the fetch was in flight marks the row dirty, and its explicit push
      // is the only writer — the save's confirmation is the last word.
      if (await isDirty(outboxOpKey({ op: 'pushProfile' }))) return;
      const localProfile = await local.getProfile();
      if (localProfile && profileCanon(localProfile) !== profileCanon(pulled)) {
        // Genuine two-writer divergence (e.g. another device saved newer
        // values): the server row wins — log the resolution for audit
        // (ARCHITECTURE.md principle 5).
        await logConflict(kv, {
          entity: 'profile',
          id: uid,
          resolution: 'server-wins',
          detail: 'pull replaced a diverged clean snapshot with the server row (last committed push wins)',
        });
      }
      await local.saveProfile(pulled);
    } catch {
      // Fail open: the local snapshot keeps rendering.
    }
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
      // Re-read AFTER the fetch: a user Save that landed while the fetch
      // was in flight marks its row dirty, and its explicit push is the
      // only writer — the pull must not clobber it. The memory flag is
      // checked per row (synchronously) so even a save that lands mid-merge
      // is seen.
      const ops = await readOutboxOps(kv);
      for (const e of cloud) {
        const key = outboxOpKey({ op: 'pushEscrow', escrowId: e.id });
        const dirty = dirtyInflight.has(key) || ops.some((o) => outboxOpKey(o) === key);
        if (dirty) continue;
        const prev = existing.find((x) => x.id === e.id);
        if (prev && escrowCanon(prev) !== escrowCanon(e)) {
          // Genuine two-writer divergence (e.g. another device pushed a
          // newer escrow unit): the server unit wins — log the resolution
          // for audit (ARCHITECTURE.md principle 5).
          await logConflict(kv, {
            entity: 'escrow',
            id: e.id,
            resolution: 'server-wins',
            detail:
              'pull replaced a diverged clean escrow with the server unit (last committed push wins)',
          });
        }
        await local.replaceEscrow(e);
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
     * Logout wipe (Sept 2026): drop every account-scoped artifact so a
     * different realtor using this device next never sees the previous
     * account's data. The base clear() drops the local snapshot (profile,
     * escrows, invites, links); this additionally drops the synced store's
     * cloud caches, the unsynced outbox (its ops carry the old uid), and
     * the managed photo/banner files. Device-scoped state (role, device
     * id, push-asked) is NOT touched. The device client link is NOT
     * touched here either — it is auth-domain state cleared by
     * auth.signOut(), which the logout flow always calls right after this.
     */
    clearLocalAccountData: async (): Promise<void> => {
      // Cloud-view keys are per-escrow: collect the ids before the wipe.
      // Read BOTH the local escrow list and the cached cloud links — a
      // cloud view can be cached for an escrow that no longer exists
      // locally (deleted locally, or fetched under the previous account).
      const escrowIdSet = new Set<string>();
      try {
        for (const e of await local.listEscrows()) escrowIdSet.add(e.id);
      } catch {
        // best-effort
      }
      let cloudLinksRaw: string | null = null;
      try {
        cloudLinksRaw = await kv.getItem(K_CLOUD_LINKS);
      } catch {
        // best-effort
      }
      if (cloudLinksRaw) {
        try {
          const links = JSON.parse(cloudLinksRaw) as Array<{ escrowId?: string }>;
          for (const l of links) if (l && typeof l.escrowId === 'string') escrowIdSet.add(l.escrowId);
        } catch {
          // malformed cache: it is removed below regardless
        }
      }
      await local.clear();
      profileCache.clear();
      ping = null;
      userId = null;
      await Promise.all([
        kv.removeItem(K_CLOUD_LINKS).catch(() => {}),
        clearOutbox(kv),
        clearAllSyncErrors(kv),
        ...[...escrowIdSet].map((id) => kv.removeItem(K_CLOUD_VIEW_PREFIX + id).catch(() => {})),
        deleteManagedMedia(),
      ]);
    },

    /** Base logout wipe: the local snapshot only. */
    clear: () => local.clear(),

    /**
     * Boot/login profile hydration.
     *
     * The routing decision in login.tsx and the boot router must not trust
     * the local KV alone: a realtor logging in on a device/browser whose
     * local store was never seeded (new device, cleared storage) would
     * otherwise land on profile creation even though their profile exists
     * in the cloud. When the local copy is missing we pull the cloud row
     * once, persist it locally, and return it.
     *
     * Converge-when-clean (Sept 2026 stale-profile fix): when a local copy
     * EXISTS, it used to be returned as-is forever — a profile saved on
     * another device/browser never converged, so refresh kept rendering
     * stale name/email. Now, when no local edits are awaiting push, the
     * snapshot is replaced with the live server row before returning.
     *
     * A locally saved profile is still returned as-is regardless of its
     * name: an existing profile with an empty name still counts as an
     * existing profile and must not be re-fetched or discarded — the
     * converge only swaps in the server row, it never nulls the result.
     */
    pullProfileFromCloud: async (): Promise<RealtorProfile | null> => {
      try {
        const existing = await local.getProfile();
        if (existing) {
          await convergeProfileFromCloud();
          return (await local.getProfile()) ?? existing;
        }
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

    /**
     * Realtor foreground refresh (Sept 2026 stale-profile fix): converge
     * the local profile snapshot from the server row. Never throws; never
     * clobbers local edits awaiting push.
     */
    refreshProfile: async (): Promise<void> => {
      await convergeProfileFromCloud();
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
      // Media-removal detection (Sept 28, 2026, Anuraj: profile/banner
      // image removal): compare against the STORED profile before
      // overwriting — a kind the user cleared in the form (X button) must
      // delete its Storage file and null the server URL. The pending flags
      // are written BEFORE the push so a failed push retries the removal
      // instead of silently keeping the old photo_url/banner_image.
      const prev = await local.getProfile();
      const removed = mediaKindsRemoved(prev, p);
      if (removed.length > 0) await writePendingMediaRemovals(kv, removed);
      await local.saveProfile(p);
      bgPush(
        async (c, uid) => {
          // Photo/banner convergence (Sept 2026 stale-client-photo fix):
          // the managed media upload whenever the local image changed
          // since the last successful upload (fingerprint-guarded, so a
          // name-only edit does not re-upload or churn the ?v= cache
          // buster). Every profile-push path funnels through
          // pushProfileWithMedia — never pushProfileNow alone — so a save
          // that converges via the outbox or the boot reconcile still
          // uploads the new image instead of stranding the old photo_url
          // on the server. Removed kinds converge the same way: Storage
          // delete + explicit URL nulls (see cloudSync.removeProfileMediaNow).
          await pushProfileWithMedia(c, uid, kv, p, (next) => local.saveProfile(next), removed, deleteLocalMedia);
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

    activateEscrow: async (escrowId, input): Promise<Escrow> => {
      const e = await local.activateEscrow(escrowId, input);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      return e;
    },

    cancelEscrow: async (escrowId): Promise<CancelEscrowResult> => {
      const { escrow: e, revokedInvites } = await local.cancelEscrow(escrowId);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      // The invite revocations must reach the server now — a cancelled
      // escrow's codes die with it (Anuraj, Sept 28, 2026).
      if (cloudConfigured()) {
        for (const inv of revokedInvites) {
          await enqueueOutbox(kv, {
            op: 'pushRevoke',
            inviteId: inv.id,
            revokedAt: inv.revokedAt,
            attempts: 0,
          });
        }
        // Same immediate-drain rationale as closeEscrow: the revocation must
        // reach the server now, not at next boot. Non-blocking; failures
        // stay queued for the boot drain.
        void drainOutboxNow();
      }
      return { escrow: e, revokedInvites };
    },

    // Per-side close (escrow lifecycle, Sept 2026): closing is per side —
    // dual-agency escrows close the buyer and seller sides independently.
    // An explicit close kills client access: the killed links are converged
    // to the cloud (client_links.revoked_at) so the public gate rejects
    // them and the client lands on the dead-link screen.
    closeEscrow: async (escrowId, role): Promise<CloseEscrowResult> => {
      const { escrow: e, revokedLinks, revokedInvites } = await local.closeEscrow(escrowId, role);
      bgPush((c, uid) => pushEscrowNow(c, uid, e), { op: 'pushEscrow', escrowId });
      if (cloudConfigured()) {
        for (const link of revokedLinks) {
          await enqueueOutbox(kv, {
            op: 'revokeClientLink',
            linkId: link.id,
            revokedAt: link.revokedAt,
            attempts: 0,
          });
        }
        // Invite codes die with the close (Anuraj, Sept 28, 2026): converge
        // the revocations to the cloud so the codes are dead on the server
        // too (redeem path reads invite.revoked_at).
        for (const inv of revokedInvites) {
          await enqueueOutbox(kv, {
            op: 'pushRevoke',
            inviteId: inv.id,
            revokedAt: inv.revokedAt,
            attempts: 0,
          });
        }
        // The revocation must reach the server now — the outbox otherwise
        // only drains at next boot, leaving the client's link live (Anuraj,
        // Sept 2026). Non-blocking; failures stay queued for the boot drain.
        void drainOutboxNow();
      }
      return { escrow: e, revokedLinks, revokedInvites };
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
              //
              // Sync-failure surface (Anuraj, Sept 2026): this is a final
              // server rejection the realtor must see on screen (what
              // failed, why, next step) — not just a console warning.
              await local.revokeInvite(invite.id);
              const cap = syncErrorCopy('inviteCap', 'rejected');
              await recordSyncError(kv, {
                key: `inviteCap:${invite.id}`,
                op: 'inviteCap',
                escrowId,
                inviteId: invite.id,
                kind: 'rejected',
                ...cap,
                at: Date.now(),
              });
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
        // Same immediate-drain rationale as closeEscrow: the old device must
        // lose access now, not at next boot (Anuraj, Sept 2026).
        void drainOutboxNow();
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
            if (res.ok) {
              // Foreground-refresh fix (Sept 2026): this payload carries the
              // live realtor profile — land it in the snapshot caches instead
              // of discarding it, so a foreground revalidation converges the
              // client instead of leaving the stale snapshot rendered.
              await cacheCloudViewPayload(res);
              return { valid: true };
            }
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

    /**
     * Sync-failure surface (Anuraj, Sept 2026): every write that did not
     * reach the server is recorded and shown on screen until it lands.
     */
    /** Pending failure records, oldest first. Never throws. */
    getSyncErrors: async (): Promise<SyncError[]> => {
      try {
        return await readSyncErrors(kv);
      } catch {
        return [];
      }
    },
    /** Subscribe to failure-record changes (the SyncErrorBar). */
    onSyncErrors: (fn: () => void): (() => void) => subscribeSyncErrors(fn),
    /**
     * Retry every pending write now: drain the outbox immediately when the
     * cloud is healthy, otherwise re-run the boot sync so the drain
     * happens as soon as the cloud is reachable. This is a MANUAL drain:
     * ops that exhausted their automatic attempts are attempted again.
     * Records clear as their writes land.
     */
    retrySync: async (): Promise<void> => {
      if (!cloudConfigured()) return;
      if (cloudOk()) {
        const c = client();
        const uid = userId;
        if (!c || !uid) return;
        await drainAndReconcileErrors(c, uid, true);
        return;
      }
      await initCloudSync();
    },
    /** Dismiss a final (non-retryable) failure record. Never throws. */
    dismissSyncError: async (key: string): Promise<void> => {
      try {
        await clearSyncError(kv, key);
      } catch {
        // best-effort
      }
    },
    getTcView: (escrowId: string) => viewForTc(escrowId),

    /**
     * Client refresh/foreground (Sept 2026): refetch this escrow's cloud view
     * so the linked realtor profile (name/photo) converges even when the
     * screen never refocuses (foreground return) or never fetched at all
     * (the in-app realtor profile screen, which used to read only the cached
     * snapshot). Fails open to the cached snapshot; never throws.
     */
    refreshClientView: async (escrowId: string): Promise<void> => {
      try {
        const link = await cloudLinkFor(escrowId);
        if (!link) return;
        if (link.role === 'tc') {
          await viewForTc(escrowId);
        } else {
          await viewForRole(escrowId, link.role);
        }
      } catch {
        // Fail open: the cached snapshot keeps rendering.
      }
    },
  };

  /**
   * Land a freshly fetched get_client_view payload in the snapshot caches
   * (Sept 2026 foreground-refresh fix). Shared by the view fetchers and the
   * link-gate revalidation: every successful RPC must converge the
   * ctc:cloudview snapshot, never silently discard the live profile.
   */
  async function cacheCloudViewPayload(res: {
    view?: ClientView;
    tcView?: TcView;
    profile?: RealtorProfile | null;
  }): Promise<void> {
    const escrowId = res.view?.escrowId ?? res.tcView?.escrowId;
    if (!escrowId) return;
    const profile = res.profile ?? null;
    profileCache.set(escrowId, profile);
    if (res.view) {
      await writeJson(kv, K_CLOUD_VIEW_PREFIX + escrowId, { view: res.view, profile });
    } else if (res.tcView) {
      await writeJson(kv, K_CLOUD_VIEW_PREFIX + escrowId, { tcView: res.tcView, profile });
    }
  }

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
