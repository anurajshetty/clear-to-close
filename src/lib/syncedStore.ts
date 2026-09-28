// Clear to Close — synced store.
//
// Wraps the local KV store with the Store interface. Realtor mutations are
// SYNCHRONOUS server-first writes (Anuraj, Sept 28, 2026): every
// user-initiated write computes its candidate state against a cloned local
// snapshot, pushes to Supabase with a per-write timeout, and applies the
// snapshot locally ONLY after the server confirms. Any failure throws a
// plain-language error immediately and leaves local state unchanged — there
// is no background push, no user-action outbox enqueue, no fire-and-forget.
// A crash before confirmation leaves local unchanged; a crash after server
// confirmation but before the local apply is healed by the next pull.
//
// Reads prefer the cloud only when it is proven healthy:
//   - redeemInvite: redeem_invite RPC when Supabase is configured (public
//     gate — no realtor session needed), otherwise a retryable 'network'
//     error. The old local v1 redeem path is deleted (Sept 28, 2026): the
//     RPC is the single authority.
//   - getBuyerView/getSellerView: get_client_view RPC when this device holds
//     a cloud link for the escrow (public gate — works on client devices
//     with no session), with a cached-view and local fallback.
//   - validateClientLink: get_client_view authority under the public gate.
// Realtor-owned writes still require the email/password session. A persisted
// session resolves even offline, so an offline write fails fast with a plain
// error instead of silently going local. Boot, foreground, and
// pull-to-refresh are pure pull; when the ping fails (offline / no realtor
// session / RLS blocking) the app behaves exactly as the local-only v1 —
// sync stays dormant.

import { createStore, type CancelEscrowResult, type CloseEscrowResult, type KV, type LocalSnapshot, type Preview, type RevokedClientLink, type Store } from './store';
import type {
  ApplyChecklistResult,
  ChecklistDraftStep,
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
  convergeInviteLinkRevokesNow,
  drainOutbox,
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
  deleteStepRowsNow,
  readOutboxOps,
  readPendingMediaRemovals,
  clearPendingMediaRemovals,
  redeemViaCloud,
  regenerateInviteNow,
  resolveInviteRealtor as resolveInviteRealtorViaCloud,
  isClosedEscrowRejection,
  withWriteTimeout,
  WriteTimeoutError,
  type Cloud,
  type OutboxOp,
  type PingResult,
} from './cloudSync';
import type { MediaKind } from './mediaUpload';
import { deleteMediaAtPath, storagePathFromUrl } from './mediaUpload';
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
/** Marker: the retired user-action outbox got its one final drain. */
const K_OUTBOX_RETIRED = 'ctc:outbox-retired';

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
    /** Override the confirmed-write timeout (unit tests use a short timeout). */
    writeTimeoutMs?: number;
    /** Override the long confirmed-write timeout (profile media, close/cancel). */
    writeTimeoutLongMs?: number;
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
   * Per-write deadline (Anuraj, Sept 28, 2026): every user-initiated
   * server write has a timeout. Exceeding it fails exactly like a network
   * failure — plain error, local state unchanged.
   */
  const WRITE_TIMEOUT_MS = deps?.writeTimeoutMs ?? 15000;
  /** Multi-entity confirmed writes (profile media, close/cancel) get a longer deadline. */
  const WRITE_TIMEOUT_LONG_MS = deps?.writeTimeoutLongMs ?? 30000;

  /**
   * Plain-language error for a failed synchronous write (Anuraj, Sept 28,
   * 2026): the realtor sees immediately that the change was NOT saved, and
   * local state is unchanged. No em dashes in user-facing copy.
   */
  function plainWriteError(error: unknown): Error {
    if (isCapViolation(error)) {
      return new Error(
        'This escrow already has 2 active invite codes. Revoke an unused code first, then create a new one.',
      );
    }
    // Closed-escrow race (Anuraj, Sept 28, 2026): the invite passed the
    // app-level gate while the escrow was open, but the escrow was
    // closed/cancelled before the push landed and the 0018 server trigger
    // rejected it. Nothing local was created, so there is nothing to roll
    // back — the realtor just needs the plain-words reason.
    if (isClosedEscrowRejection(error)) {
      return new Error(
        'This escrow is closed or cancelled. The invite was not created.',
      );
    }
    // Missing cloud/session (Sept 28, 2026): the message is already
    // plain-language — pass it through unchanged.
    if ((error as { code?: string } | null)?.code === NO_CLOUD_SESSION) {
      return error as Error;
    }
    const kind = classifySyncError(error);
    if (error instanceof WriteTimeoutError || kind === 'network') {
      return new Error(
        "Couldn't reach the server. Your change was not saved. Check your connection and try again.",
      );
    }
    if (kind === 'rejected') {
      return new Error('The server refused the update. Your change was not saved.');
    }
    return new Error("Couldn't save. Your change was not saved. Please try again.");
  }

  /**
   * Rows with a user action's confirmed write currently in flight. Marked
   * synchronously when the action fires (before any await), so a pull that
   * is already in flight never overwrites a row whose server write has not
   * confirmed yet. Cleared when the write settles. User actions never
   * enqueue to the outbox anymore, so this is a pure in-memory guard — the
   * write's own confirmation is the last word on the row.
   */
  const writeInflight = new Set<string>();

  /**
   * Resolve the session a confirmed write runs under. Null when sync is
   * dormant (project unconfigured or no realtor session). confirmedWrite
   * converts null into a plain "not saved" throw — it never commits
   * locally unconfirmed. A persisted session resolves even when the ping
   * never ran or the device is offline, so an offline write fails fast
   * with a plain network error instead of silently going local.
   */
  const NO_CLOUD_SESSION = 'ctc:no-cloud-session';
  async function serverSession(): Promise<{
    c: NonNullable<ReturnType<typeof cloudClient>>;
    uid: string;
  } | null> {
    if (!cloudConfigured()) return null;
    const c = client();
    if (!c) return null;
    if (userId) return { c, uid: userId };
    try {
      const uid = await ensureCloudUser(c);
      return uid ? { c, uid } : null;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous server-first write (Anuraj, Sept 28, 2026):
   *   1. wait for every earlier write to finish (single global chain);
   *   2. compute the candidate state against a CLONED local snapshot
   *      (preview) — live data and persisted keys are untouched;
   *   3. require cloud + an authenticated realtor (else a plain
   *      "not saved" throw — never a local-only commit);
   *   4. push the candidate to the server with a per-write timeout;
   *   5. ONLY on confirmation, commit the snapshot locally.
   * Any failure (network, timeout, server rejection) throws a
   * plain-language error and leaves local state byte-identical. The
   * in-flight key guards concurrent pulls for the duration of the write.
   *
   * Concurrency: previews carry the whole snapshot, so confirmed writes
   * run on a SINGLE global chain — each write computes its preview only
   * after every earlier write committed, and commits before the next
   * preview is computed. A per-key chain would still clobber: two writes
   * to different keys (e.g. a profile save and a checklist toggle) could
   * commit stale snapshots over each other. The `inflightKey` argument
   * now only labels the timeout error and the write-inflight pull guard.
   */
  /**
   * Exclusive state-mutation gate (Anuraj, Sept 28, 2026): confirmed writes
   * AND pull merges serialize through one chain. A write's preview is
   * computed from a cloned snapshot but its commit swaps whole collections,
   * so a pull that merged between the preview compute and the commit would
   * be silently overwritten; conversely a pull that fetched before a commit
   * must not merge stale rows over it (the commitSeq guard covers that
   * direction). Serializing both directions here means a pull either merges
   * fully before a write's preview is computed (the preview sees the pulled
   * state) or waits for the write to commit (its fetch is then stale for
   * the written rows, which the commitSeq guard skips). The network fetch
   * always happens OUTSIDE the gate; only the local mutation holds it.
   * Callbacks must never re-enter this gate (no confirmedWrite inside a
   * pull merge and vice versa).
   */
  let exclusiveChain: Promise<void> = Promise.resolve();
  async function enqueueExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = exclusiveChain;
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    exclusiveChain = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  // Commit-sequence guard against pull/write races (Anuraj, Sept 28,
  // 2026): a pull that FETCHED before a confirmed write committed must not
  // MERGE its stale rows over the fresh commit. confirmedWrite bumps
  // writeSeq and records each key's commit seq; pull-apply sites record
  // the seq before fetching and skip rows whose key committed after.
  let writeSeq = 0;
  const committedSeq = new Map<string, number>();
  async function confirmedWrite<T>(
    inflightKey: string,
    preview: () => Promise<Preview<T>>,
    push: (
      session: { c: NonNullable<ReturnType<typeof cloudClient>>; uid: string },
      result: T,
      snapshot: LocalSnapshot,
    ) => Promise<void>,
    timeoutMs = WRITE_TIMEOUT_MS,
  ): Promise<T> {
    // Every confirmed write runs inside the exclusive gate: the preview is
    // computed only after every earlier write committed AND every earlier
    // pull merge finished, so it sees the latest committed state; the
    // commit holds the gate so no pull can merge between confirmation and
    // local apply.
    return enqueueExclusive(async () => {
      writeInflight.add(inflightKey);
      let result: T;
      let snapshot: LocalSnapshot;
      try {
        ({ result, snapshot } = await preview());
      } catch (e) {
        // App-level validation gates (the closed/cancelled-escrow invite
        // block, the per-role invite cap, ...) throw from the preview
        // BEFORE any server contact. Their messages are already
        // plain-language for the on-screen surface — surface them
        // unchanged, never remapped to a generic "couldn't save".
        throw e;
      }
      try {
        // Session resolution is part of the bounded write: ensureCloudUser
        // may hit the network, and every network operation in a user action
        // must sit inside the timeout. Required cloud + authenticated
        // realtor: a missing session throws a plain "not saved" error —
        // never a local-only commit that would look saved while the server
        // never saw the write.
        await withWriteTimeout(
          (async () => {
            const session = await serverSession();
            if (!session) {
              const e = new Error(
                "Couldn't save. You're signed out or the cloud isn't set up. Sign in and try again.",
              );
              (e as { code?: string }).code = NO_CLOUD_SESSION;
              throw e;
            }
            await push(session, result, snapshot);
          })(),
          timeoutMs,
          inflightKey,
        );
        // Commit ONLY after the server confirmed. No awaits between the
        // timeout resolving and this call, so a pull cannot interleave a
        // stale convergence between confirmation and local apply. The
        // commit seq lets pulls that fetched earlier skip this row instead
        // of merging stale server data over the fresh commit.
        const committed = await local.commitPreview({ result, snapshot });
        writeSeq += 1;
        committedSeq.set(inflightKey, writeSeq);
        return committed;
      } catch (e) {
        // Failure (server error, offline, timeout, crash-before-confirm):
        // local state is unchanged — the preview was never committed.
        // The error is plain-language for the on-screen surface.
        throw plainWriteError(e);
      } finally {
        writeInflight.delete(inflightKey);
      }
    });
  }

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
      onOpError: async (op: OutboxOp, error: unknown) => {
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
        // Awaited (not fire-and-forget): the drain awaits onOpError, so
        // two ops failing in the same drain record sequentially. A void
        // call here raced concurrent read-modify-writes on the persisted
        // error map and silently dropped one record (Sept 28 2026).
        await recordSyncError(kv, {
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
      // FINAL drain of the retired user-action outbox (Anuraj, Sept 28,
      // 2026): installs upgrading from the background-push model get one
      // last drain of already-queued operations, then the outbox is
      // retired — user actions never enqueue again, so no later boot
      // drains. Failures are recorded on the sync-failure surface;
      // whatever remains is user-retryable via retrySync.
      try {
        const retired = await kv.getItem(K_OUTBOX_RETIRED).catch(() => null);
        if (!retired) {
          await drainAndReconcileErrors(c, userId);
          // Pending media removals queued by the old model (removal flags
          // without a surviving op): converge them once, then clear. The
          // retired marker is set ONLY after the media convergence
          // succeeded — a failure leaves the marker unset so the next boot
          // retries, and the flags are cleared only after a successful
          // convergence (a failed delete must not strand an orphaned
          // Storage file with no flag left to retry it).
          const pendingRemoval = await readPendingMediaRemovals(kv);
          if (pendingRemoval.length) {
            const p = await local.getProfile();
            if (p) {
              // Run through a preview so the media helpers mutate a
              // draft, never the live profile, and the converged URLs
              // persist in one commit after confirmation.
              const preview = await local.previewSaveProfile(p);
              const draft = preview.snapshot.profile;
              if (draft) await pushProfileWithMedia(c, userId, kv, draft, pendingRemoval);
              // The one-time legacy commit joins the exclusive gate like
              // every other local mutation.
              await enqueueExclusive(async () => {
                await local.commitPreview(preview);
              });
              await clearPendingMediaRemovals(kv);
            }
          }
          await kv.setItem(K_OUTBOX_RETIRED, '1');
        }
      } catch {
        // Outbox drain is best-effort; the retired marker stays unset so
        // ops and flags stay queued for the next boot.
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
      // Commit-seq guard (Sept 28, 2026): an invite write that committed
      // after this fetch started already applied its fresh state locally —
      // merging the stale fetched rows would resurrect pre-write codes.
      const inviteStaleAfter = (escrowId: string, rows: { id: string }[], seq0: number): boolean => {
        if ((committedSeq.get(`invite:${escrowId}`) ?? 0) > seq0) return true;
        return rows.some((r) => (committedSeq.get(`invite:${r.id}`) ?? 0) > seq0);
      };
      try {
        if (c) {
          for (const escrow of await local.listEscrows()) {
            const seq0 = writeSeq;
            const rows = await pullFullInvitesNow(c, escrow.id);
            if (rows.length && !inviteStaleAfter(escrow.id, rows, seq0)) {
              // Inside the exclusive gate: a confirmed invite write's
              // commit can never be overwritten mid-merge.
              await enqueueExclusive(async () => {
                await local.mergeInvites(rows);
              });
            }
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
      // a stale local "Jimmy"). User-initiated writes push synchronously
      // (confirmedWrite) and fail loudly; a failed write never touches
      // local state, so there is nothing for boot to retry or reconcile.
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
      // Never clobber a confirmed write that is still in flight: a write
      // in progress means its server confirmation is the last word on the
      // row — the pull must not touch it. (New user actions never enqueue
      // outbox ops, so the in-memory set is the write-in-flight check; a
      // LEGACY queued pushProfile still means the local snapshot is dirty,
      // so its key is checked against the outbox for the one final drain.)
      if (writeInflight.has('profile')) return; // local write in flight
      const legacyOps = await readOutboxOps(kv);
      const legacyProfileKey = outboxOpKey({ op: 'pushProfile' });
      if (legacyOps.some((o) => outboxOpKey(o) === legacyProfileKey)) return;
      const seq0 = writeSeq;
      const uid = await ensureCloudUser(c);
      if (!uid) return;
      const pulled = await pullProfileNow(c, uid);
      if (!pulled) return;
      // Re-check just before overwriting: a user Save that landed while
      // the fetch was in flight marks the row in-flight, and its explicit
      // confirmation is the only writer — the save's confirmation is the
      // last word. A save that COMMITTED after our fetch started is
      // covered by the commit-seq check: merging our stale row over its
      // fresh commit would resurrect the pre-save profile.
      if (writeInflight.has('profile')) return;
      if (legacyOps.some((o) => outboxOpKey(o) === legacyProfileKey)) return;
      if ((committedSeq.get('profile') ?? 0) > seq0) return;
      // The local apply runs inside the exclusive gate so a confirmed
      // profile write's commit can never be overwritten mid-apply.
      await enqueueExclusive(async () => {
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
      });
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
      const seq0 = writeSeq;
      const cloud = await pullEscrowsNow(c);
      if (cloud === null) return existing;
      // Re-check per row AFTER the fetch: a user write that landed while
      // the fetch was in flight marks its row in the in-flight set, and
      // its server confirmation is the only writer — the pull must not
      // clobber it. A write that already COMMITTED after our fetch started
      // is covered by the commit-seq check: merging our stale rows over its
      // fresh commit would resurrect pre-write server data. The set is
      // checked per row (synchronously) so even a write that lands
      // mid-merge is seen. New user actions never enqueue outbox ops, but
      // a LEGACY queued pushEscrow (one final drain for existing installs)
      // still means the local row is dirty — its edits never reached the
      // server, so the pull must not clobber it before the drain runs.
      const legacyOps = await readOutboxOps(kv);
      await enqueueExclusive(async () => {
        for (const e of cloud) {
          const key = `escrow:${e.id}`;
          if (writeInflight.has(key)) continue;
          if ((committedSeq.get(key) ?? 0) > seq0) continue;
          const legacyKey = outboxOpKey({ op: 'pushEscrow', escrowId: e.id });
          if (legacyOps.some((o) => outboxOpKey(o) === legacyKey)) continue;
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
      });
      return local.listEscrows();
    } catch {
      try {
        return await local.listEscrows();
      } catch {
        return [];
      }
    }
  }

  const store: Store = {
    getProfile: () => local.getProfile(),

    // Preview/commit surface (synchronous server-first writes, Anuraj,
    // Sept 28, 2026): pass-throughs to the local store. The synced write
    // methods above use these to compute candidates against a cloned
    // snapshot and commit only after server confirmation.
    previewSaveProfile: (p) => local.previewSaveProfile(p),
    previewCreateEscrow: (input) => local.previewCreateEscrow(input),
    previewToggleStep: (escrowId, role, stepId) => local.previewToggleStep(escrowId, role, stepId),
    previewAddCustomStep: (escrowId, role, title) => local.previewAddCustomStep(escrowId, role, title),
    previewReorderSteps: (escrowId, role, orderedIds) =>
      local.previewReorderSteps(escrowId, role, orderedIds),
    previewApplyChecklist: (escrowId, role, steps) =>
      local.previewApplyChecklist(escrowId, role, steps),
    previewUpdateTargetDate: (escrowId, closeDate) =>
      local.previewUpdateTargetDate(escrowId, closeDate),
    previewUpdateEscrow: (escrowId, input) => local.previewUpdateEscrow(escrowId, input),
    previewActivateEscrow: (escrowId, input) => local.previewActivateEscrow(escrowId, input),
    previewCancelEscrow: (escrowId) => local.previewCancelEscrow(escrowId),
    previewCloseEscrow: (escrowId, role) => local.previewCloseEscrow(escrowId, role),
    previewCreateInvite: (escrowId, role, partyName) =>
      local.previewCreateInvite(escrowId, role, partyName),
    previewRevokeInvite: (inviteId) => local.previewRevokeInvite(inviteId),
    previewRegenerateInvite: (inviteId, codeOverride, newId) =>
      local.previewRegenerateInvite(inviteId, codeOverride, newId),
    commitPreview: (p) => local.commitPreview(p),

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
      // computing — a kind the user cleared in the form (X button) must
      // delete its Storage file and null the server URL as part of the
      // confirmed write. The detection runs INSIDE the write chain so a
      // concurrent save cannot compute against a stale profile. Under the
      // synchronous model the removal is not flagged for a later retry:
      // upload + profile row + Storage delete are ONE confirmed write, and
      // a failure leaves local state — including the managed files —
      // unchanged. The row upserts BEFORE any Storage delete, so a row
      // failure can never delete a file the confirmed row still
      // references; uploads go to unique per-upload paths, so a row
      // failure orphans an unreferenced file instead of changing what
      // clients see.
      let removed: MediaKind[] = [];
      let prev: RealtorProfile | null = null;
      await confirmedWrite<void>(
        'profile',
        async () => {
          prev = await local.getProfile();
          removed = mediaKindsRemoved(prev, p);
          return local.previewSaveProfile(p);
        },
        async ({ c, uid }, _result, snapshot) => {
          // Media convergence mutates the preview draft's remote URLs in
          // place, so the commit persists the confirmed URLs. It never
          // persists locally itself and never touches the device files —
          // those are deleted below, only after confirmation.
          const draft = snapshot.profile;
          if (!draft) throw new Error('saveProfile: profile vanished mid-write');
          await pushProfileWithMedia(c, uid, kv, draft, removed);
          // Best-effort orphan cleanup (never throws, never fails the
          // write): a replaced kind's old unique-path file is unreferenced
          // now that the row points at the new upload. Removed kinds are
          // deleted by the write itself, not here.
          try {
            const kinds: MediaKind[] = ['photo', 'banner'];
            for (const kind of kinds) {
              if (removed.includes(kind)) continue;
              const oldUrl = kind === 'photo' ? prev?.photoRemoteUrl : prev?.bannerRemoteUrl;
              const newUrl = kind === 'photo' ? draft.photoRemoteUrl : draft.bannerRemoteUrl;
              if (oldUrl && newUrl && oldUrl !== newUrl) {
                const path = storagePathFromUrl(oldUrl);
                if (path) await deleteMediaAtPath(c, path);
              }
            }
          } catch {
            // Orphan cleanup must not fail a confirmed save.
          }
        },
        WRITE_TIMEOUT_LONG_MS,
      );
      // Only after the server confirmed: delete the device-local managed
      // files for removed kinds. On failure they are kept, so a retry
      // still has the upload source.
      for (const kind of removed) await deleteLocalMedia(kind);
    },

    listEscrows: () => local.listEscrows(),
    getEscrow: (id: string) => local.getEscrow(id),
    replaceEscrow: (e: Escrow) => local.replaceEscrow(e),

    createEscrow: async (input): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        'escrow:new',
        () => local.previewCreateEscrow(input),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    toggleStep: async (escrowId, role, stepId): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewToggleStep(escrowId, role, stepId),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    addCustomStep: async (escrowId, role, title): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewAddCustomStep(escrowId, role, title),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    reorderSteps: async (escrowId, role, orderedIds): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewReorderSteps(escrowId, role, orderedIds),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    /**
     * Bulk checklist apply for edit mode (Sept 28, 2026): the draft is the
     * full new step list for one side — adds, removes, and reorders land
     * in ONE confirmed synchronous server write (upsert escrow + all step
     * rows, then delete the rows the edit removed). Server first, local
     * commit only on confirmation; any failure throws a plain-language
     * error and leaves local state unchanged. Structural edits send no
     * push notification (lastAction untouched) and the closed-side rules
     * from the spec apply (remove-checked-from-complete keeps closed; an
     * unchecked step reopens the side).
     */
    applyChecklistEdits: async (
      escrowId: string,
      role: ClientRole,
      steps: ChecklistDraftStep[],
    ): Promise<Escrow> => {
      const { escrow } = await confirmedWrite<ApplyChecklistResult>(
        `escrow:${escrowId}`,
        () => local.previewApplyChecklist(escrowId, role, steps),
        async ({ c, uid }, { escrow: candidate, removedStepIds }) => {
          await pushEscrowNow(c, uid, candidate);
          await deleteStepRowsNow(c, removedStepIds);
        },
      );
      return escrow;
    },

    updateTargetDate: async (escrowId, closeDate): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewUpdateTargetDate(escrowId, closeDate),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    updateEscrow: async (escrowId, input): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewUpdateEscrow(escrowId, input),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    activateEscrow: async (escrowId, input): Promise<Escrow> => {
      return confirmedWrite<Escrow>(
        `escrow:${escrowId}`,
        () => local.previewActivateEscrow(escrowId, input),
        async ({ c, uid }, escrow) => {
          await pushEscrowNow(c, uid, escrow);
        },
      );
    },

    cancelEscrow: async (escrowId): Promise<CancelEscrowResult> => {
      // Cancel is one confirmed write (Anuraj, Sept 28, 2026): the escrow
      // row, every invite revocation, and the server-side device-link kills
      // all run inside the awaited server effect, and the local preview
      // commits only after every step returned successfully. This is NOT a
      // database transaction — the steps run sequentially, so a failure
      // partway can leave the server partially updated (e.g. the escrow
      // row cancelled but one invite's links still live). That window is
      // by design fail-safe: local state is unchanged (the user sees the
      // escrow as still open and can retry the cancel), and the next
      // invite/pull cycle converges the server truth locally — a live
      // invite the server already revoked arrives as revoked, a cancelled
      // escrow row arrives as cancelled. Nothing applies locally until the
      // whole effect confirms.
      return confirmedWrite<CancelEscrowResult>(
        `escrow:${escrowId}`,
        () => local.previewCancelEscrow(escrowId),
        async ({ c, uid }, { escrow: e, revokedInvites }) => {
          await pushEscrowNow(c, uid, e);
          for (const inv of revokedInvites) {
            await pushRevokeNow(c, inv.id, inv.revokedAt);
            // Zombie-link convergence, server-authoritative (Sept 28,
            // 2026): the redeem_invite RPC creates client_links rows
            // server-side, which this device never holds locally — the
            // killed links are discovered with a live server query per
            // invite and stamped revoked_at inline, inside the same
            // confirmed write.
            await convergeInviteLinkRevokesNow(c, inv.id, inv.revokedAt);
          }
        },
        WRITE_TIMEOUT_LONG_MS,
      );
    },

    // Per-side close (escrow lifecycle, Sept 2026): closing is per side —
    // dual-agency escrows close the buyer and seller sides independently.
    // An explicit close kills client access: the killed links are converged
    // to the cloud (client_links.revoked_at) so the public gate rejects
    // them and the client lands on the dead-link screen.
    closeEscrow: async (escrowId, role): Promise<CloseEscrowResult> => {
      // Close is one confirmed write (Anuraj, Sept 28, 2026): the escrow
      // row, the per-side invite revocations, and the server-side
      // device-link kills all run inside the awaited server effect, and the
      // local preview commits only after every step returned successfully.
      // This is NOT a database transaction — the steps run sequentially, so
      // a failure partway can leave the server partially updated. That
      // window is by design fail-safe: local state is unchanged (the user
      // sees the side as still open and can retry the close), and the next
      // pull converges the server truth locally. Nothing applies locally
      // until the whole effect confirms.
      return confirmedWrite<CloseEscrowResult>(
        `escrow:${escrowId}`,
        () => local.previewCloseEscrow(escrowId, role),
        async ({ c, uid }, { escrow: e, revokedInvites }) => {
          await pushEscrowNow(c, uid, e);
          for (const inv of revokedInvites) {
            await pushRevokeNow(c, inv.id, inv.revokedAt);
            await convergeInviteLinkRevokesNow(c, inv.id, inv.revokedAt);
          }
        },
        WRITE_TIMEOUT_LONG_MS,
      );
    },

    createInvite: async (escrowId, role, partyName): Promise<Invite> => {
      // Stale-cache path (Sept 2026): the local invite cache can lag behind
      // the server (initCloudSync hydrates on a best-effort pull), so the
      // local cap check could see fewer than two active invites and
      // optimistically create a third. Refresh the full server rows and
      // merge them into the PREVIEW DRAFT — never into live local state —
      // so the cap check sees server truth while a failure still leaves
      // local byte-identical. The DB trigger enforces the cap
      // authoritatively at push time regardless.
      let serverRows: Invite[] | null = null;
      const session = await serverSession();
      if (session) {
        try {
          const rows = await Promise.race([
            pullFullInvitesNow(session.c, escrowId),
            timeoutMs(4000),
          ]);
          if (Array.isArray(rows)) serverRows = rows;
        } catch {
          // Offline/slow: fall through to the local cap check — the
          // authoritative DB cap still applies at push time.
        }
      }
      // The DB trigger enforces the cap authoritatively: a creation race
      // lost to another device surfaces as a cap violation from the push,
      // which throws the plain-language cap error below. No local row is
      // created on failure — there is nothing to roll back. pushInviteNow
      // may regenerate the code on a global 6-char collision; it mutates
      // the preview's invite in place, so the commit carries the final
      // code.
      return confirmedWrite<Invite>(
        `invite:${escrowId}`,
        async () => {
          const preview = await local.previewCreateInvite(escrowId, role, partyName);
          if (serverRows) {
            // Merge server-fresh invite states into the draft only (same
            // merge rule as mergeInvites: server is the authority on
            // revoked/redeemed timestamps; server-only rows are inserted).
            for (const row of serverRows) {
              const inv = preview.snapshot.invites.find((i) => i.id === row.id);
              if (!inv) {
                preview.snapshot.invites.push({ ...row });
              } else {
                if (row.revokedAt && !inv.revokedAt) inv.revokedAt = row.revokedAt;
                if (row.redeemedAt && !inv.redeemedAt) inv.redeemedAt = row.redeemedAt;
              }
            }
            const cap = role === 'tc' ? 1 : 2;
            const active = preview.snapshot.invites.filter(
              (i) => i.escrowId === escrowId && i.role === role && !i.revokedAt,
            ).length;
            if (active > cap) {
              // Plain-language: preview errors surface unchanged through
              // confirmedWrite (sync-writes, Sept 28, 2026), so this IS the
              // user-facing copy. Unified with the push-time cap rejection
              // copy (plainWriteError / syncErrorCopy inviteCap) for both
              // roles.
              throw new Error(
                'This escrow already has 2 active invite codes. Revoke an unused code first, then create a new one.',
              );
            }
          }
          return preview;
        },
        async ({ c }, invite) => {
          await pushInviteNow(c, invite);
        },
      );
    },

    revokeInvite: async (inviteId: string): Promise<{ revokedLinks: RevokedClientLink[] }> => {
      // One confirmed write (Anuraj, Sept 28, 2026): the invite row
      // revocation and the server-side device-link kill run inside the same
      // awaited server effect and confirm together before anything applies
      // locally. The killed links are converged server-authoritatively —
      // the redeem_invite RPC creates client_links rows server-side, which
      // this device never holds locally, so a local-state-only convergence
      // would be a no-op in production. The invite row revokes FIRST:
      // get_client_view locks the client out via the invite check even if
      // the link kill never runs, so a lookup failure can never strand a
      // live link on a live code. A failure anywhere throws and leaves
      // local state unchanged — the retry is idempotent (the invite revoke
      // re-lands, the link kill converges).
      return confirmedWrite<{ revokedLinks: RevokedClientLink[] }>(
        `invite:${inviteId}`,
        () => local.previewRevokeInvite(inviteId),
        async ({ c }, _result, snapshot) => {
          const inv = snapshot.invites.find((i) => i.id === inviteId);
          const revokedAt = inv?.revokedAt ?? new Date().toISOString();
          await pushRevokeNow(c, inviteId, revokedAt);
          await convergeInviteLinkRevokesNow(c, inviteId, revokedAt);
        },
      );
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
            const seq0 = writeSeq;
            const rows = await Promise.race([pullInvitesNow(c, escrowId), timeoutMs(4000)]);
            const list = rows as { id: string; revoked_at: string | null; redeemed_at: string | null }[];
            // Commit-seq guard: an invite write that committed after this
            // fetch started already applied its fresh state — don't merge
            // stale rows over it.
            const stale =
              (committedSeq.get(`invite:${escrowId}`) ?? 0) > seq0 ||
              list.some((r) => (committedSeq.get(`invite:${r.id}`) ?? 0) > seq0);
            if (!stale) {
              // Inside the exclusive gate: a confirmed invite write's
              // commit can never be overwritten mid-merge.
              await enqueueExclusive(async () => {
                await local.mergeInviteStates(list);
              });
            }
          } catch {
            // Best-effort: local state is still returned below.
          }
        }
      }
      return local.listInvites(escrowId);
    },

    redeemInvite: async (code: string, name: string, deviceId?: string): Promise<RedeemResult> => {
      // Synchronous server-first redeem (Anuraj, Sept 28, 2026): the
      // redeem_invite RPC is the single authority. There is NO local
      // fallback — the old local.redeemInvite path minted a device link the
      // server never authorized, which violates "confirmed by the server or
      // fail loudly" (an offline client would see an escrow the server does
      // not recognize, with the realtor never seeing the device). Offline /
      // unconfigured / RPC failure all report the retryable 'network'
      // error ("Something went wrong on our end. Check your connection and
      // try again."); a genuine bad code reports the server's verdict.
      // The local-invite push-and-retry fallback is gone too: createInvite
      // is confirmed server-first, so a local-only invite cannot exist, and
      // that path ran unbounded network work outside any timeout.
      if (!publicOk()) return { ok: false, error: 'network' };
      const c = client();
      if (!c) return { ok: false, error: 'network' };
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
            // The server doesn't know this code. The old local-invite
            // push-and-retry fallback is gone (Sept 28, 2026): createInvite
            // is confirmed server-first, so a local-only invite cannot
            // exist, and that path ran unbounded network work outside any
            // timeout. Fall through to the read-only local resolve, which
            // serves the offline branding case without touching the server.
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
     * Synchronous server-first (Anuraj, Sept 28, 2026): the
     * regenerate_invite RPC kills the old code + the old device link and
     * issues the fresh code in ONE atomic server transaction. The local
     * mirror applies ONLY after the RPC confirms; a failure throws the
     * plain-language error and leaves local state byte-identical. There is
     * no local-only fallback — a half-regenerated invite must be
     * impossible. The RPC's authoritative new code/id replaces the
     * preview's placeholder before commit.
     */
    regenerateInvite: async (
      inviteId: string,
      codeOverride?: string,
    ): Promise<{
      oldCode: string;
      invite: Invite;
      revokedLink: { id: string; revokedAt: string } | null;
    }> => {
      if (codeOverride) {
        throw new Error(
          "Couldn't reach the server. Your change was not saved. Check your connection and try again.",
        );
      }
      return confirmedWrite(
        `invite:${inviteId}`,
        () => local.previewRegenerateInvite(inviteId),
        async ({ c }, result, snapshot) => {
          const { newCode, newInviteId } = await regenerateInviteNow(c, inviteId);
          // Swap the preview's placeholder code/id for the server's
          // authoritative values before committing.
          const placeholderId = result.invite.id;
          const idx = snapshot.invites.findIndex((i) => i.id === placeholderId);
          if (idx >= 0) {
            snapshot.invites[idx] = { ...snapshot.invites[idx], id: newInviteId, code: newCode };
          }
          result.invite = { ...result.invite, id: newInviteId, code: newCode };
        },
      );
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
      // Legacy-drain only: user actions never enqueue new ops under the
      // synchronous model, so this only retries failures left by the
      // retired background-push model (surfaced on the SyncErrorBar).
      const session = await serverSession();
      if (session) {
        await drainAndReconcileErrors(session.c, session.uid, true);
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
