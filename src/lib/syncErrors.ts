// Clear to Close — sync failure records (Anuraj, Sept 2026).
//
// Whenever a realtor write fails to reach the server (rejected push, RLS
// silent no-op, network failure, exhausted retries, anything), the failure
// is recorded HERE — never silently queued. The record carries what failed,
// why in plain words, and the next step, and the SyncErrorBar renders it as
// a persistent, unmissable surface at the top of every realtor screen.
//
// Records are keyed by the outbox op key (one record per pending write) and
// persisted in kv so they survive app boot: a failure from yesterday is
// still on screen until the write lands or the user resolves it. Retryable
// records clear the moment their op drains; final (non-retryable) records
// are dismissed by the user.
//
// This module is UI-free so the node unit tests can drive it directly.
import type { KV } from './store';
import { SyncNotAppliedError } from './cloudSync';

export type SyncOpKind =
  | 'pushEscrow'
  | 'pushProfile'
  | 'pushInvite'
  | 'pushRevoke'
  | 'revokeClientLink'
  | 'convergeLinkRevokes';

export type SyncErrorKind = 'network' | 'rejected' | 'unknown';

export interface SyncError {
  /** One record per pending write; matches the outbox coalescing key. */
  key: string;
  op: SyncOpKind | 'inviteCap';
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
  kind: SyncErrorKind;
  /** Short noun phrase, e.g. "Your profile changes". */
  what: string;
  /** Plain-words explanation of why the write is not on the server. */
  why: string;
  /** The next step, e.g. "Check your connection, then tap Retry." */
  hint: string;
  /** Retryable records clear when the write lands; final ones are dismissed. */
  retryable: boolean;
  /** Epoch ms when the failure was recorded. */
  at: number;
}

const K_SYNC_ERRORS = 'ctc:sync_errors';

const WHAT: Record<SyncOpKind | 'inviteCap', string> = {
  pushProfile: 'Your profile changes',
  pushEscrow: "This escrow's updates",
  pushInvite: 'The invite code',
  pushRevoke: 'The invite revocation',
  revokeClientLink: 'The client access revocation',
  // Server-authoritative link convergence (Sept 28, 2026): same
  // user-visible outcome as revokeClientLink — the client's device access.
  convergeLinkRevokes: 'The client access revocation',
  inviteCap: 'The invite code',
};

export function syncErrorHeadline(e: SyncError): string {
  return e.kind === 'network'
    ? `${e.what} could not reach the server.`
    : `${e.what} did not save.`;
}

/** Same coalescing key as enqueueOutbox: one pending op per write target. */
export function opErrorKey(op: {
  op: SyncOpKind;
  escrowId?: string;
  inviteId?: string;
  linkId?: string;
}): string {
  return `${op.op}:${op.escrowId ?? ''}:${op.inviteId ?? ''}:${op.linkId ?? ''}`;
}

function isNetworkLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { message?: unknown; code?: unknown; name?: unknown };
  const hay = `${String(e.message ?? '')} ${String(e.code ?? '')} ${String(e.name ?? '')}`;
  return /fetch|network|timeout|timed out|econn|enotfound|eai_again|ehostunreach|offline|socket/i.test(hay);
}

/** Classify a push failure for plain-words copy. */
export function classifySyncError(error: unknown): SyncErrorKind {
  if (error instanceof SyncNotAppliedError) return 'rejected';
  if (isNetworkLike(error)) return 'network';
  return 'unknown';
}

/** Plain-words copy for a failed write. No em dashes in user-facing copy. */
export function syncErrorCopy(
  op: SyncOpKind | 'inviteCap',
  kind: SyncErrorKind,
): { what: string; why: string; hint: string; retryable: boolean } {
  const what = WHAT[op];
  if (op === 'inviteCap') {
    return {
      what,
      why: 'This escrow already has 2 active invite codes.',
      hint: 'Revoke an unused code first, then create a new one.',
      retryable: false,
    };
  }
  switch (kind) {
    case 'network':
      return {
        what,
        why: 'Your change is saved on this device. It is not on the server yet.',
        hint: 'Check your connection, then tap Retry.',
        retryable: true,
      };
    case 'rejected':
      return {
        what,
        why: 'The server refused the update. This usually means you are signed in as a different account than the one that owns this data.',
        hint: 'Try signing out and back in, then tap Retry.',
        retryable: true,
      };
    default:
      return {
        what,
        why: 'Something went wrong while saving.',
        hint: 'Tap Retry to try again.',
        retryable: true,
      };
  }
}

async function readMap(kv: KV): Promise<Record<string, SyncError>> {
  try {
    const raw = await kv.getItem(K_SYNC_ERRORS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SyncError>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMap(kv: KV, map: Record<string, SyncError>): Promise<void> {
  try {
    await kv.setItem(K_SYNC_ERRORS, JSON.stringify(map));
  } catch {
    // Best-effort; the local write already succeeded.
  }
}

// ---------------------------------------------------------------- listeners --

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A broken listener must never break sync recording.
    }
  }
}

/** The SyncErrorBar subscribes; returns an unsubscribe function. */
export function subscribeSyncErrors(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ------------------------------------------------------------------ records --

/** Record (or refresh) a failure. Overwrites any existing record for the key. */
export async function recordSyncError(kv: KV, error: SyncError): Promise<void> {
  const map = await readMap(kv);
  map[error.key] = error;
  await writeMap(kv, map);
  emit();
}

/** Clear one record (its write landed, or the user dismissed a final error). */
export async function clearSyncError(kv: KV, key: string): Promise<void> {
  const map = await readMap(kv);
  if (!(key in map)) return;
  delete map[key];
  await writeMap(kv, map);
  emit();
}

/** Drop every record (logout wipe: records are identity-bound). */
export async function clearAllSyncErrors(kv: KV): Promise<void> {
  try {
    await kv.removeItem(K_SYNC_ERRORS);
  } catch {
    // best-effort
  }
  emit();
}

/** All pending records, oldest first. */
export async function readSyncErrors(kv: KV): Promise<SyncError[]> {
  const map = await readMap(kv);
  return Object.values(map).sort((a, b) => a.at - b.at);
}
