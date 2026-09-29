// client_realtime.test.ts — REGRESSION: secure realtime for client views
// (Sept 2026).
//
// The client has no login; it authenticates by device link. The manager:
//   1. mints a short-lived JWT from the client-realtime-token Edge Function,
//   2. passes it to realtime.setAuth() on a dedicated client,
//   3. subscribes to steps/escrows/realtor_profiles/client_links with
//      escrow-scoped filters (the 0030 RLS policies enforce the rest),
//   4. re-pulls on data events (debounced), routes to link-dead on revoke,
//   5. degrades silently on any failure (never throws to the UI).
//
// Sockets are faked via injected deps; the assertions pin the wiring
// contract (token -> setAuth -> channel bindings -> callbacks).

import { assert, summary } from './assert';
import {
  startClientRealtime,
  __resetForTests,
  __activeCount,
} from '../src/lib/clientRealtime';
import type {
  ClientRealtimeDeps,
  RealtimeChannelLike,
  RealtimeClientLike,
} from '../src/lib/clientRealtime';

declare const process: { exitCode?: number };

const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------- fakes --

interface Timer {
  id: number;
  fn: () => void;
}

class FakeTimers {
  private next = 1;
  private pending = new Map<number, Timer>();
  setTimeoutFn = (fn: () => void, _ms: number): number => {
    const id = this.next++;
    this.pending.set(id, { id, fn });
    return id;
  };
  clearTimeoutFn = (t: unknown): void => {
    this.pending.delete(t as number);
  };
  count(): number {
    return this.pending.size;
  }
  /** Fire only the most recently scheduled timer (leaves the rest). */
  fireLast(): void {
    const ids = [...this.pending.keys()];
    if (ids.length === 0) return;
    const last = this.pending.get(ids[ids.length - 1])!;
    this.pending.delete(last.id);
    last.fn();
  }
  /** Run every pending timer until none remain (cap: re-entrancy). */
  fireAll(): void {
    let guard = 0;
    while (this.pending.size > 0 && guard++ < 50) {
      const timers = [...this.pending.values()];
      this.pending.clear();
      for (const t of timers) t.fn();
    }
  }
}

interface Binding {
  table: string;
  event: string;
  filter?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (p: any) => void;
}

class FakeChannel implements RealtimeChannelLike {
  bindings: Binding[] = [];
  statusCb: ((s: string) => void) | null = null;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  on(
    event: 'postgres_changes',
    filter: Record<string, string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (p: any) => void,
  ): RealtimeChannelLike {
    this.bindings.push({
      table: filter.table,
      event: filter.event,
      filter: filter.filter,
      cb,
    });
    return this;
  }
  subscribe(cb: (status: string) => void): RealtimeChannelLike {
    this.statusCb = cb;
    return this;
  }
  emitStatus(s: string): void {
    if (this.statusCb) this.statusCb(s);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(table: string, payload: any): void {
    for (const b of this.bindings) {
      if (b.table === table) b.cb(payload);
    }
  }
}

class FakeRealtimeClient implements RealtimeClientLike {
  authTokens: string[] = [];
  channels: FakeChannel[] = [];
  removed: FakeChannel[] = [];
  realtime = {
    setAuth: async (token: string): Promise<void> => {
      this.authTokens.push(token);
    },
  };
  channel(name: string): RealtimeChannelLike {
    const ch = new FakeChannel(name);
    this.channels.push(ch);
    return ch;
  }
  removeChannel(ch: RealtimeChannelLike): Promise<unknown> {
    this.removed.push(ch as FakeChannel);
    return Promise.resolve(true);
  }
}

interface MintResponse {
  ok: boolean;
  token?: string;
  expires_at?: number;
  error?: string;
}

function makeDeps(
  timers: FakeTimers,
  mints: MintResponse[],
  client: FakeRealtimeClient,
): { deps: ClientRealtimeDeps; fetchCalls: string[] } {
  const fetchCalls: string[] = [];
  let mintIdx = 0;
  const deps: ClientRealtimeDeps = {
    supabaseUrl: 'https://xyz.supabase.co',
    anonKey: 'anon-key',
    createRealtimeClient: () => client,
    fetchFn: async (url: string) => {
      fetchCalls.push(url);
      const m = mints[Math.min(mintIdx++, mints.length - 1)];
      return { json: async () => m };
    },
    nowMs: () => NOW_MS,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    warn: () => {},
  };
  return { deps, fetchCalls };
}

function okMint(token: string): MintResponse {
  return { ok: true, token, expires_at: NOW_MS / 1000 + 900 };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    linkId: 'L1',
    deviceId: 'D1',
    escrowId: 'E1',
    onDataChanged: () => {},
    onLinkDead: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------- tests --

async function t_unconfigured(): Promise<void> {
  __resetForTests();
  const h = startClientRealtime(baseOpts(), null);
  assert(h === null, 'null deps (unconfigured) -> no handle, silent degrade');
  assert(__activeCount() === 0, 'unconfigured -> nothing registered');
}

async function t_missingLink(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const { deps, fetchCalls } = makeDeps(timers, [okMint('t')], client);
  const h = startClientRealtime(baseOpts({ linkId: '' }), deps);
  assert(h === null, 'missing linkId -> no handle');
  assert(fetchCalls.length === 0, 'missing linkId -> no token fetch');
}

async function t_happyPathWiring(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const { deps, fetchCalls } = makeDeps(timers, [okMint('tok-1')], client);
  const h = startClientRealtime(baseOpts(), deps);
  assert(h !== null, 'happy path -> handle returned');
  await flush();
  assert(fetchCalls.length === 1, 'happy path -> exactly one token mint');
  assert(
    fetchCalls[0].endsWith('/functions/v1/client-realtime-token'),
    'token fetched from the client-realtime-token function',
  );
  assert(client.authTokens[0] === 'tok-1', 'minted token passed to setAuth');
  assert(client.channels.length === 1, 'one channel opened');
  const ch = client.channels[0];
  assert(ch.name === 'ctc-client-escrow:E1', 'channel scoped to the escrow');
  const byTable: Record<string, Binding | undefined> = {};
  for (const b of ch.bindings) byTable[b.table] = b;
  assert(
    byTable['steps'] !== undefined && byTable['steps']!.filter === 'escrow_id=eq.E1',
    'steps binding filtered to the escrow',
  );
  assert(
    byTable['escrows'] !== undefined && byTable['escrows']!.filter === 'id=eq.E1',
    'escrows binding filtered to the escrow',
  );
  assert(
    byTable['realtor_profiles'] !== undefined,
    'realtor_profiles subscribed (RLS scopes to the escrow owner)',
  );
  assert(
    byTable['client_links'] !== undefined &&
      byTable['client_links']!.event === 'UPDATE' &&
      byTable['client_links']!.filter === 'id=eq.L1',
    'own link row watched for revocation',
  );
  h!.stop();
}

async function t_dataEventsDebounced(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  let dataChanged = 0;
  const { deps } = makeDeps(timers, [okMint('t')], client);
  const h = startClientRealtime(baseOpts({ onDataChanged: () => dataChanged++ }), deps);
  await flush();
  const ch = client.channels[0];
  ch.emit('steps', { new: { id: 's1' } });
  ch.emit('steps', { new: { id: 's2' } });
  ch.emit('escrows', { new: { id: 'E1' } });
  assert(dataChanged === 0, 'data events debounced: no sync pull yet');
  timers.fireAll();
  assert(dataChanged === 1, 'rapid check-offs coalesce into one re-pull');
  h!.stop();
}

async function t_revokeRoutesToLinkDead(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  let dead = 0;
  let dataChanged = 0;
  const { deps } = makeDeps(timers, [okMint('t')], client);
  const h = startClientRealtime(
    baseOpts({ onLinkDead: () => dead++, onDataChanged: () => dataChanged++ }),
    deps,
  );
  await flush();
  const ch = client.channels[0];
  // A non-revoking update to the link row is not a death.
  ch.emit('client_links', { new: { id: 'L1', revoked_at: null } });
  assert(dead === 0, 'link update without revoked_at -> no link-dead');
  ch.emit('client_links', { new: { id: 'L1', revoked_at: '2026-09-29T00:00:00Z' } });
  assert(dead === 1, 'revoked_at set -> onLinkDead fires');
  assert(__activeCount() === 0, 'revoked link -> manager unregisters itself');
  assert(client.removed.length === 1, 'revoked link -> channel removed');
  h!.stop();
}

async function t_serverSaysDeadOnMint(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  let dead = 0;
  const { deps, fetchCalls } = makeDeps(
    timers,
    [{ ok: false, error: 'revoked' }],
    client,
  );
  const h = startClientRealtime(baseOpts({ onLinkDead: () => dead++ }), deps);
  await flush();
  assert(dead === 1, 'mint rejected as revoked -> onLinkDead immediately');
  assert(client.channels.length === 0, 'dead link -> no channel opened');
  assert(fetchCalls.length === 1, 'dead link -> no retry loop');
  assert(__activeCount() === 0, 'dead link -> nothing registered');
  h!.stop();
}

async function t_socketErrorReconnects(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const { deps, fetchCalls } = makeDeps(timers, [okMint('t1'), okMint('t2')], client);
  const h = startClientRealtime(baseOpts(), deps);
  await flush();
  assert(client.channels.length === 1, 'first channel open');
  client.channels[0].emitStatus('CHANNEL_ERROR');
  assert(fetchCalls.length === 1, 'error -> reconnect scheduled, not immediate');
  timers.fireLast(); // the reconnect timer only (the 780s refresh stays pending)
  await flush();
  assert(fetchCalls.length === 2, 'backoff elapsed -> token re-minted');
  assert(client.channels.length === 2, 'reconnect opens a fresh channel');
  assert(client.authTokens[1] === 't2', 'fresh token applied on reconnect');
  assert(client.removed.length === 1, 'old channel removed on reconnect');
  h!.stop();
}

async function t_tokenRefresh(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const { deps, fetchCalls } = makeDeps(timers, [okMint('t1'), okMint('t2')], client);
  const h = startClientRealtime(baseOpts(), deps);
  await flush();
  assert(timers.count() >= 1, 'token refresh timer scheduled');
  timers.fireAll();
  await flush();
  assert(fetchCalls.length === 2, 'refresh timer -> new token minted');
  assert(client.authTokens[1] === 't2', 'refreshed token passed to setAuth');
  assert(client.channels.length === 1, 'refresh does not reopen the channel');
  h!.stop();
}

async function t_stopIsClean(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  let dataChanged = 0;
  const { deps } = makeDeps(timers, [okMint('t')], client);
  const h = startClientRealtime(baseOpts({ onDataChanged: () => dataChanged++ }), deps);
  await flush();
  const ch = client.channels[0];
  h!.stop();
  assert(client.removed.length === 1, 'stop -> channel removed');
  assert(__activeCount() === 0, 'stop -> unregistered');
  ch.emit('steps', { new: { id: 's1' } });
  timers.fireAll();
  assert(dataChanged === 0, 'stop -> no callbacks after teardown');
}

async function t_dedupPerEscrow(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const { deps, fetchCalls } = makeDeps(timers, [okMint('t')], client);
  const h1 = startClientRealtime(baseOpts(), deps);
  const h2 = startClientRealtime(baseOpts(), deps);
  assert(h1 === h2, 'second start for the same escrow reuses the handle');
  await flush();
  assert(fetchCalls.length === 1, 'dedup -> single token mint');
  h1!.stop();
}

async function t_mintNetworkFailureRetries(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeRealtimeClient();
  const fetchCalls: string[] = [];
  let calls = 0;
  const deps: ClientRealtimeDeps = {
    supabaseUrl: 'https://xyz.supabase.co',
    anonKey: 'anon-key',
    createRealtimeClient: () => client,
    fetchFn: async (url: string) => {
      fetchCalls.push(url);
      calls++;
      if (calls === 1) throw new Error('offline');
      return { json: async () => okMint('t2') };
    },
    nowMs: () => NOW_MS,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    warn: () => {},
  };
  const h = startClientRealtime(baseOpts(), deps);
  await flush();
  assert(client.channels.length === 0, 'offline mint -> no channel, no crash');
  timers.fireAll();
  await flush();
  assert(fetchCalls.length === 2, 'backoff elapsed -> mint retried');
  assert(client.channels.length === 1, 'retry success -> channel opens');
  h!.stop();
}

async function main(): Promise<void> {
  await t_unconfigured();
  await t_missingLink();
  await t_happyPathWiring();
  await t_dataEventsDebounced();
  await t_revokeRoutesToLinkDead();
  await t_serverSaysDeadOnMint();
  await t_socketErrorReconnects();
  await t_tokenRefresh();
  await t_stopIsClean();
  await t_dedupPerEscrow();
  await t_mintNetworkFailureRetries();
  summary('client_realtime');
  __resetForTests();
}

void main();
