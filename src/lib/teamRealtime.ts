// Clear to Close — live team updates via realtime (Nov 2026).
//
// The realtor-side mirror of clientRealtime.ts, with the opposite auth
// shape: there is NO minted token and NO dedicated client. Realtors are
// signed in, so channels ride the SHARED supabase client, whose session
// JWT Realtime presents on the socket; Realtime evaluates the existing
// SELECT policies per subscriber (escrows_select / steps_select /
// escrow_activity_select), so a subscriber receives exactly the rows it
// could already read through PostgREST — a removed member's stream goes
// silent when the grant ends, and a never-member receives nothing.
//
// Posture (identical to the client module):
//   * INVALIDATION-ONLY: an event marks its scope dirty and, after a
//     ~750ms debounce, the screen re-pulls through the existing gated
//     pull functions. Payloads are NEVER applied or merged — callbacks
//     receive no arguments at all, so there is nothing to apply.
//   * INSERT/UPDATE only: DELETE events are out of v1 scope (a remote
//     step delete converges on the next focus/foreground pull).
//   * Table-level home channel (escrows, steps, escrow_activity,
//     unfiltered — RLS does the scoping) plus per-escrow channels
//     filtered to one escrow for the detail and activity screens.
//   * Identity binding: no channel exists without a bound identity.
//     The layout/login identity sync binds the LIVE session's uid in
//     step with initCloudSync; sign-out or an identity change tears
//     EVERY channel down before anything can run under a stale user.
//   * Best-effort: any failure (unconfigured client, socket error,
//     channel close) degrades silently to the focus/foreground pulls.
//     Nothing here throws to the UI. Channel errors reconnect with
//     backoff, mirroring the client module.

import { auth } from './auth';
import { getSupabase } from './supabase';

export const TEAM_REALTIME_DEBOUNCE_MS = 750;
const RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 30000];

export interface TeamRealtimeCallbacks {
  /** Escrow/step data changed — re-pull escrow state (debounced). */
  onDataChanged?: () => void;
  /** escrow_activity gained a row — re-pull activity/participants. */
  onActivity?: () => void;
}

export interface TeamRealtimeHandle {
  stop: () => void;
}

// Minimal shapes of the supabase-js pieces we touch (injectable for
// tests). Deliberately the same shape as clientRealtime's channel.
export interface TeamRealtimeChannelLike {
  on(
    event: 'postgres_changes',
    filter: Record<string, string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (payload: any) => void,
  ): TeamRealtimeChannelLike;
  subscribe(cb: (status: string) => void): TeamRealtimeChannelLike;
}

export interface TeamRealtimeClientLike {
  channel(name: string): TeamRealtimeChannelLike;
  removeChannel(ch: TeamRealtimeChannelLike): Promise<unknown> | unknown;
}

export interface TeamRealtimeDeps {
  client: TeamRealtimeClientLike | null;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (t: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => void;
  getSessionUserId?: () => Promise<string | null>;
}

function defaultDeps(): TeamRealtimeDeps {
  return {
    client: getSupabase() as TeamRealtimeClientLike | null,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    // eslint-disable-next-line no-console
    warn: (...args) => console.warn('[teamRealtime]', ...args),
    getSessionUserId: () => auth.getSessionUserId(),
  };
}

// ------------------------------------------------------------- identity --

/**
 * The identity every live channel is bound to. Set ONLY from the live
 * session (see syncTeamRealtimeIdentity); a channel may exist solely
 * while this is non-null and equal to the uid its manager started
 * under. Any change — sign-out (null) or a different user — tears all
 * channels down first.
 */
let boundUserId: string | null = null;

export function setTeamRealtimeUser(userId: string | null): void {
  if (userId === boundUserId) return;
  boundUserId = userId;
  stopAllManagers();
}

/** Bind the realtime identity to the LIVE session (or unbind). */
export async function syncTeamRealtimeIdentity(
  deps?: TeamRealtimeDeps | null,
): Promise<void> {
  const d = deps === undefined ? defaultDeps() : deps;
  let uid: string | null = null;
  try {
    uid = d?.getSessionUserId
      ? await d.getSessionUserId()
      : await auth.getSessionUserId();
  } catch {
    uid = null;
  }
  setTeamRealtimeUser(uid);
}

// ------------------------------------------------------------- managers --

interface Subscriber {
  onDataChanged?: () => void;
  onActivity?: () => void;
}

interface Manager {
  key: string; // 'home' or the escrow id
  foldActivityIntoData: boolean; // home: activity rows are data invalidations
  userId: string;
  deps: TeamRealtimeDeps;
  subscribers: Set<Subscriber>;
  channel: TeamRealtimeChannelLike | null;
  connLive: boolean;
  stopped: boolean;
  pendingData: boolean;
  pendingActivity: boolean;
  flushTimer: unknown;
  reconnectTimer: unknown;
  reconnectAttempt: number;
}

const managers = new Map<string, Manager>();

function clearTimer(m: Manager, field: 'flushTimer' | 'reconnectTimer'): void {
  if (m[field] !== null) {
    m.deps.clearTimeoutFn(m[field]);
    m[field] = null;
  }
}

function scheduleFlush(m: Manager): void {
  if (m.stopped || m.flushTimer !== null) return;
  m.flushTimer = m.deps.setTimeoutFn(() => {
    m.flushTimer = null;
    if (m.stopped) return;
    const data = m.pendingData;
    const activity = m.pendingActivity;
    m.pendingData = false;
    m.pendingActivity = false;
    for (const sub of [...m.subscribers]) {
      try {
        if (data) sub.onDataChanged?.();
        if (activity) sub.onActivity?.();
      } catch (err) {
        m.deps.warn('subscriber callback threw', err);
      }
    }
  }, TEAM_REALTIME_DEBOUNCE_MS);
}

function markData(m: Manager): void {
  if (m.stopped) return;
  m.pendingData = true;
  scheduleFlush(m);
}

function markActivity(m: Manager): void {
  if (m.stopped) return;
  if (m.foldActivityIntoData) m.pendingData = true;
  else m.pendingActivity = true;
  scheduleFlush(m);
}

function teardownChannel(m: Manager): void {
  m.connLive = false;
  if (m.channel && m.deps.client) {
    try {
      const c = m.channel;
      m.channel = null;
      void m.deps.client.removeChannel(c);
    } catch (err) {
      m.deps.warn('removeChannel failed', err);
    }
  }
  m.channel = null;
}

function scheduleReconnect(m: Manager): void {
  if (m.stopped || m.reconnectTimer !== null) return;
  const wait =
    RECONNECT_BACKOFF_MS[Math.min(m.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  m.reconnectAttempt += 1;
  m.reconnectTimer = m.deps.setTimeoutFn(() => {
    m.reconnectTimer = null;
    connect(m);
  }, wait);
}

function connect(m: Manager): void {
  if (m.stopped || !m.deps.client) return;
  teardownChannel(m);
  m.connLive = true;
  const escrowId = m.key === 'home' ? null : m.key;
  try {
    let ch = m.deps.client.channel(
      escrowId ? 'ctc-team-escrow:' + escrowId : 'ctc-team-home',
    );
    const bind = (
      table: string,
      event: string,
      filter: string | undefined,
      mark: () => void,
    ) => {
      const f: Record<string, string> = { event, schema: 'public', table };
      if (filter !== undefined) f.filter = filter;
      ch = ch.on('postgres_changes', f, () => {
        if (m.connLive) mark();
      });
    };
    const escrowFilter = escrowId ? 'id=eq.' + escrowId : undefined;
    const rowFilter = escrowId ? 'escrow_id=eq.' + escrowId : undefined;
    bind('escrows', 'INSERT', escrowFilter, () => markData(m));
    bind('escrows', 'UPDATE', escrowFilter, () => markData(m));
    bind('steps', 'INSERT', rowFilter, () => markData(m));
    bind('steps', 'UPDATE', rowFilter, () => markData(m));
    bind('escrow_activity', 'INSERT', rowFilter, () => markActivity(m));
    m.channel = ch.subscribe((status) => {
      if (!m.connLive || m.stopped) return;
      if (status === 'SUBSCRIBED') {
        m.reconnectAttempt = 0;
      } else if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        m.deps.warn('channel status ' + status + ': reconnecting');
        teardownChannel(m);
        scheduleReconnect(m);
      }
    });
  } catch (err) {
    m.deps.warn('subscribe failed', err);
    scheduleReconnect(m);
  }
}

function stopManager(m: Manager): void {
  if (m.stopped) return;
  m.stopped = true;
  clearTimer(m, 'flushTimer');
  clearTimer(m, 'reconnectTimer');
  teardownChannel(m);
  m.subscribers.clear();
  if (managers.get(m.key) === m) managers.delete(m.key);
}

function stopAllManagers(): void {
  for (const m of [...managers.values()]) stopManager(m);
}

/** Tear down every channel (identity binding is left untouched). */
export function stopAllTeamRealtime(): void {
  stopAllManagers();
}

function startManager(
  key: string,
  callbacks: TeamRealtimeCallbacks,
  deps?: TeamRealtimeDeps | null,
): TeamRealtimeHandle | null {
  if (!boundUserId) return null; // no identity, no channel — ever
  const d = deps === undefined ? defaultDeps() : deps;
  if (!d || !d.client) return null; // unconfigured: focus/foreground pulls stay
  let m = managers.get(key);
  if (m && m.userId !== boundUserId) {
    stopManager(m);
    m = undefined;
  }
  if (!m) {
    m = {
      key,
      foldActivityIntoData: key === 'home',
      userId: boundUserId,
      deps: d,
      subscribers: new Set(),
      channel: null,
      connLive: false,
      stopped: false,
      pendingData: false,
      pendingActivity: false,
      flushTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
    };
    managers.set(key, m);
    connect(m);
  }
  const sub: Subscriber = {
    onDataChanged: callbacks.onDataChanged,
    onActivity: callbacks.onActivity,
  };
  m.subscribers.add(sub);
  const mgr = m;
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      mgr.subscribers.delete(sub);
      if (mgr.subscribers.size === 0) stopManager(mgr);
    },
  };
}

/**
 * The session-scoped home channel: escrows + steps + escrow_activity,
 * unfiltered (RLS scopes per subscriber). Any event is a data
 * invalidation — home re-pulls own escrows and re-runs refreshTeam.
 */
export function startTeamRealtimeHome(
  callbacks: TeamRealtimeCallbacks,
  deps?: TeamRealtimeDeps | null,
): TeamRealtimeHandle | null {
  return startManager('home', { onDataChanged: callbacks.onDataChanged }, deps);
}

/**
 * The per-escrow channel for the detail and activity screens (they
 * share one channel per escrow; it lives while either is subscribed).
 */
export function startTeamRealtimeEscrow(
  escrowId: string,
  callbacks: TeamRealtimeCallbacks,
  deps?: TeamRealtimeDeps | null,
): TeamRealtimeHandle | null {
  if (!escrowId) return null;
  return startManager(escrowId, callbacks, deps);
}

/** Test seam: how many live managers exist. */
export function __activeManagerCount(): number {
  return managers.size;
}

/** Test seam: drop identity + all managers without touching sockets. */
export function __resetForTests(): void {
  stopAllManagers();
  boundUserId = null;
}
