// Clear to Close — secure realtime for client views (Sept 2026).
//
// Client devices have no login; they authenticate by device link. This
// module opens ONE realtime channel per linked escrow:
//
//   1. It mints a short-lived JWT (15 min) from the `client-realtime-token`
//      Edge Function, which validates (link_id, device_id) server-side and
//      signs with the project's JWT secret. A forged token is impossible
//      without that secret.
//   2. The token goes to realtime.setAuth() on a DEDICATED supabase client
//      (the shared client keeps the realtor session untouched).
//   3. The 0030 RLS policies admit exactly that token's escrow — steps,
//      escrow row, the realtor profile, and the client's own link row —
//      and only while the device link is live. Revocation cuts the event
//      stream at the database immediately.
//   4. On any data event the client RE-PULLS get_client_view (server is
//      the single source of truth). Realtime payloads are never applied
//      directly: realtime is a read-only invalidation signal, debounced
//      to coalesce rapid check-offs.
//   5. On the client's own link row flipping to revoked, onLinkDead fires
//      and the screen routes to /link-dead — no waiting for a foreground
//      round-trip.
//
// Failure posture (Anuraj's bar): realtime is best-effort. Any failure —
// no env, token mint failure, socket error, channel close — degrades
// silently to the existing foreground-focus refetch. Nothing here ever
// throws to the UI or shows an error.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;
declare const process: { env: Record<string, string | undefined> };

export const CLIENT_REALTIME_TOKEN_TTL_S = 15 * 60;
const REFRESH_SKEW_S = 120; // refresh the token 2 min before expiry
const REFRESH_DEBOUNCE_MS = 750; // coalesce rapid check-offs into one pull
const RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 30000];

export interface ClientRealtimeCallbacks {
  /** A data row changed — re-pull the client view (debounced). */
  onDataChanged: () => void;
  /** This device's link was revoked — route to /link-dead. */
  onLinkDead: () => void;
}

export interface ClientRealtimeHandle {
  stop: () => void;
}

// Minimal shapes of the supabase-js pieces we touch (injectable for tests).
export interface RealtimeChannelLike {
  on(
    event: 'postgres_changes',
    filter: Record<string, string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (payload: any) => void,
  ): RealtimeChannelLike;
  subscribe(cb: (status: string) => void): RealtimeChannelLike;
}

export interface RealtimeClientLike {
  realtime: { setAuth(token: string): Promise<void> };
  channel(name: string): RealtimeChannelLike;
  removeChannel(ch: RealtimeChannelLike): Promise<unknown> | unknown;
}

export interface ClientRealtimeDeps {
  supabaseUrl: string;
  anonKey: string;
  createRealtimeClient: (url: string, key: string) => RealtimeClientLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchFn: (url: string, init: any) => Promise<any>;
  nowMs: () => number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (t: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => void;
}

function defaultDeps(): ClientRealtimeDeps | null {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anonKey) return null;
  let createClient: ((url: string, key: string, opts?: object) => RealtimeClientLike) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createClient = require('@supabase/supabase-js').createClient;
  } catch {
    return null;
  }
  if (!createClient) return null;
  const cc = createClient;
  const fetchFn =
    typeof fetch !== 'undefined'
      ? fetch.bind(globalThis)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_url: string, _init: any): Promise<any> =>
          Promise.reject(new Error('fetch unavailable'));
  return {
    supabaseUrl,
    anonKey,
    createRealtimeClient: (url, key) =>
      cc(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    fetchFn,
    nowMs: () => Date.now(),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    // eslint-disable-next-line no-console
    warn: (...args) => console.warn('[clientRealtime]', ...args),
  };
}

interface TokenResult {
  token: string;
  expiresAt: number; // epoch seconds
}

async function mintToken(
  deps: ClientRealtimeDeps,
  linkId: string,
  deviceId: string,
): Promise<TokenResult | { dead: true } | null> {
  let res: { ok?: boolean; token?: string; expires_at?: number; error?: string };
  try {
    const raw = await deps.fetchFn(
      deps.supabaseUrl + '/functions/v1/client-realtime-token',
      {
        method: 'POST',
        headers: {
          apikey: deps.anonKey,
          Authorization: 'Bearer ' + deps.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ link_id: linkId, device_id: deviceId }),
      },
    );
    res = (await raw.json()) as typeof res;
  } catch (err) {
    deps.warn('token mint failed (network)', err);
    return null;
  }
  if (res && res.ok && typeof res.token === 'string' && typeof res.expires_at === 'number') {
    return { token: res.token, expiresAt: res.expires_at };
  }
  // The server says this link is dead (revoked / invalid / device
  // mismatch): tell the caller so the screen can route to /link-dead now
  // instead of waiting for the next foreground validation.
  if (res && (res.error === 'revoked' || res.error === 'invalid' || res.error === 'device_mismatch')) {
    return { dead: true };
  }
  deps.warn('token mint rejected', res && res.error);
  return null;
}

// One live manager per escrow (multi-escrow: one channel per linked
// escrow; a second start for the same escrow reuses the live handle).
const active = new Map<string, ClientRealtimeHandle>();

export function startClientRealtime(
  opts: { linkId: string; deviceId: string; escrowId: string } & ClientRealtimeCallbacks,
  deps?: ClientRealtimeDeps | null,
): ClientRealtimeHandle | null {
  const d = deps === undefined ? defaultDeps() : deps;
  if (!d) return null; // unconfigured or no supabase-js: focus refetch stays
  if (!opts.linkId || !opts.deviceId || !opts.escrowId) return null;
  const existing = active.get(opts.escrowId);
  if (existing) return existing;

  let stopped = false;
  let channel: RealtimeChannelLike | null = null;
  let client: RealtimeClientLike | null = null;
  let refreshTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;
  let refreshTimerHandle: unknown = null;

  const clear = (t: unknown) => {
    if (t !== null) d.clearTimeoutFn(t);
  };

  const scheduleDataRefresh = () => {
    if (stopped) return;
    clear(refreshTimerHandle);
    refreshTimerHandle = d.setTimeoutFn(() => {
      refreshTimerHandle = null;
      if (stopped) return;
      try {
        opts.onDataChanged();
      } catch (err) {
        d.warn('onDataChanged threw', err);
      }
    }, REFRESH_DEBOUNCE_MS);
  };

  const teardownChannel = () => {
    clear(refreshTimer);
    refreshTimer = null;
    clear(reconnectTimer);
    reconnectTimer = null;
    if (channel && client) {
      try {
        const c = channel;
        channel = null;
        void client.removeChannel(c);
      } catch (err) {
        d.warn('removeChannel failed', err);
      }
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clear(refreshTimerHandle);
    refreshTimerHandle = null;
    teardownChannel();
    if (active.get(opts.escrowId) === handle) active.delete(opts.escrowId);
  };
  const handle: ClientRealtimeHandle = { stop };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const wait =
      RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = d.setTimeoutFn(() => {
      reconnectTimer = null;
      void connect();
    }, wait);
  };

  const scheduleTokenRefresh = (expiresAt: number) => {
    clear(refreshTimer);
    const waitMs = Math.max(expiresAt * 1000 - d.nowMs() - REFRESH_SKEW_S * 1000, 1000);
    refreshTimer = d.setTimeoutFn(() => {
      refreshTimer = null;
      void refreshToken();
    }, waitMs);
  };

  const refreshToken = async () => {
    if (stopped || !client) return;
    const t = await mintToken(d, opts.linkId, opts.deviceId);
    if (stopped || !client) return;
    if (t && 'token' in t) {
      try {
        await client.realtime.setAuth(t.token);
        scheduleTokenRefresh(t.expiresAt);
      } catch (err) {
        d.warn('setAuth on refresh failed', err);
        scheduleReconnect();
      }
      return;
    }
    if (t && 'dead' in t) {
      try {
        opts.onLinkDead();
      } catch (err) {
        d.warn('onLinkDead threw', err);
      }
      stop();
      return;
    }
    // Mint failed transiently: keep the current token until it expires;
    // the socket closing at expiry drives the reconnect path, which mints
    // again. Retry a touch earlier than expiry as a backstop.
    scheduleTokenRefresh(Math.floor(d.nowMs() / 1000) + 60);
  };

  const onLinkRow = (payload: { new?: { revoked_at?: string | null } }) => {
    if (stopped) return;
    if (payload && payload.new && payload.new.revoked_at) {
      try {
        opts.onLinkDead();
      } catch (err) {
        d.warn('onLinkDead threw', err);
      }
      stop();
    }
  };

  const connect = async () => {
    if (stopped) return;
    teardownChannel();
    let t: TokenResult | { dead: true } | null;
    try {
      t = await mintToken(d, opts.linkId, opts.deviceId);
    } catch (err) {
      d.warn('connect mint threw', err);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    if (!t) {
      scheduleReconnect(); // transient: back off and retry
      return;
    }
    if ('dead' in t) {
      try {
        opts.onLinkDead();
      } catch (err) {
        d.warn('onLinkDead threw', err);
      }
      stop();
      return;
    }
    try {
      client = d.createRealtimeClient(d.supabaseUrl, d.anonKey);
      await client.realtime.setAuth(t.token);
    } catch (err) {
      d.warn('realtime client setup failed', err);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    try {
      channel = client
        .channel('ctc-client-escrow:' + opts.escrowId)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'steps', filter: 'escrow_id=eq.' + opts.escrowId },
          scheduleDataRefresh,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'escrows', filter: 'id=eq.' + opts.escrowId },
          scheduleDataRefresh,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'realtor_profiles' },
          scheduleDataRefresh,
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'client_links', filter: 'id=eq.' + opts.linkId },
          onLinkRow,
        )
        .subscribe((status) => {
          if (stopped) return;
          if (status === 'SUBSCRIBED') {
            reconnectAttempt = 0;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            d.warn('channel status ' + status + ': reconnecting');
            scheduleReconnect();
          }
        });
      scheduleTokenRefresh(t.expiresAt);
    } catch (err) {
      d.warn('subscribe failed', err);
      scheduleReconnect();
    }
  };

  active.set(opts.escrowId, handle);
  void connect();
  return handle;
}

/** Test seam: how many live managers exist. */
export function __activeCount(): number {
  return active.size;
}

/** Test seam: drop all managers without touching sockets. */
export function __resetForTests(): void {
  active.clear();
}
