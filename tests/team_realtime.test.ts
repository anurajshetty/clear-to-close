// team_realtime.test.ts — live team updates (Nov 2026, migration 0050).
//
// Realtor-side realtime mirrors the client module's posture with the
// opposite auth shape: NO minted token — channels ride the shared
// client's realtor session, and Realtime's per-subscriber RLS
// evaluation (escrows_select / steps_select / escrow_activity_select)
// scopes every event to escrows the subscriber can already read.
//
// Contract pinned here:
//   * INVALIDATION-ONLY: events are debounced (~750ms) and delivered to
//     callbacks with NO payload; state is re-pulled through the gated
//     pull functions, never merged from the wire.
//   * INSERT/UPDATE only — DELETE events are out of v1 scope.
//   * Home channel: escrows/steps/escrow_activity, unfiltered (RLS
//     scopes). Escrow channel: the same tables filtered to one escrow.
//   * Identity binding: no channel exists without a bound identity;
//     sign-out or identity change tears EVERY channel down; re-setting
//     the same identity is a no-op.
//   * Best-effort: unconfigured deps degrade silently (null handle).
//
// Sockets are faked via injected deps, as in client_realtime.test.ts.

import { assert, summary } from './assert';
import {
  setTeamRealtimeUser,
  startTeamRealtimeEscrow,
  startTeamRealtimeHome,
  stopAllTeamRealtime,
  syncTeamRealtimeIdentity,
  __activeManagerCount,
  __resetForTests,
} from '../src/lib/teamRealtime';
import type {
  TeamRealtimeDeps,
  TeamRealtimeChannelLike,
  TeamRealtimeClientLike,
} from '../src/lib/teamRealtime';

declare const process: { exitCode?: number };

// ---------------------------------------------------------------- fakes --

class FakeTimers {
  private next = 1;
  private pending = new Map<number, () => void>();
  setTimeoutFn = (fn: () => void, _ms: number): number => {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  };
  clearTimeoutFn = (t: unknown): void => {
    this.pending.delete(t as number);
  };
  fireAll(): void {
    let guard = 0;
    while (this.pending.size > 0 && guard++ < 50) {
      const fns = [...this.pending.values()];
      this.pending.clear();
      for (const fn of fns) fn();
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

class FakeChannel implements TeamRealtimeChannelLike {
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
  ): TeamRealtimeChannelLike {
    this.bindings.push({
      table: filter.table,
      event: filter.event,
      filter: filter.filter,
      cb,
    });
    return this;
  }
  subscribe(cb: (status: string) => void): TeamRealtimeChannelLike {
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

class FakeClient implements TeamRealtimeClientLike {
  channels: FakeChannel[] = [];
  removed: FakeChannel[] = [];
  channel(name: string): TeamRealtimeChannelLike {
    const ch = new FakeChannel(name);
    this.channels.push(ch);
    return ch;
  }
  removeChannel(ch: TeamRealtimeChannelLike): Promise<unknown> {
    this.removed.push(ch as FakeChannel);
    return Promise.resolve(true);
  }
}

function makeDeps(
  timers: FakeTimers,
  client: FakeClient,
  over: Partial<TeamRealtimeDeps> = {},
): TeamRealtimeDeps {
  return {
    client,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    warn: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------- tests --

function t_noIdentityNoChannel(): void {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeClient();
  const deps = makeDeps(timers, client);
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, deps);
  assert(h === null, 'no bound identity -> no home handle');
  const e = startTeamRealtimeEscrow('E1', { onDataChanged: () => {} }, deps);
  assert(e === null, 'no bound identity -> no escrow handle');
  assert(client.channels.length === 0, 'no bound identity -> no channel opened');
}

function t_unconfiguredDegrades(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, null);
  assert(h === null, 'null deps (unconfigured) -> no handle, silent degrade');
  assert(__activeManagerCount() === 0, 'unconfigured -> nothing registered');
}

function t_homeWiring(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, makeDeps(timers, client));
  assert(h !== null, 'home start -> handle returned');
  assert(client.channels.length === 1, 'home start -> exactly one channel');
  const ch = client.channels[0];
  assert(ch.name === 'ctc-team-home', 'home channel name');
  const keys = ch.bindings.map((b) => `${b.table}:${b.event}`).sort();
  assert(
    JSON.stringify(keys) ===
      JSON.stringify(
        [
          'escrow_activity:INSERT',
          'escrows:INSERT',
          'escrows:UPDATE',
          'steps:INSERT',
          'steps:UPDATE',
        ].sort(),
      ),
    'home bindings = escrows/steps INSERT+UPDATE + escrow_activity INSERT',
  );
  assert(
    ch.bindings.every((b) => b.filter === undefined),
    'home bindings are unfiltered (RLS scopes per subscriber)',
  );
  assert(
    ch.bindings.every((b) => b.event !== 'DELETE' && b.event !== '*'),
    'no DELETE (or wildcard) binding anywhere — deletes are out of v1',
  );
  h!.stop();
}

function t_homeDebounceInvalidationOnly(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  let calls = 0;
  let argCount = -1;
  const h = startTeamRealtimeHome(
    {
      onDataChanged: (...args: unknown[]) => {
        calls++;
        argCount = args.length;
      },
    },
    makeDeps(timers, client),
  );
  const ch = client.channels[0];
  ch.emit('steps', { new: { id: 's1', completed_by: 'someone-else' } });
  ch.emit('steps', { new: { id: 's2' } });
  ch.emit('escrows', { new: { id: 'E1' } });
  ch.emit('escrow_activity', { new: { id: 'a1' } });
  assert(calls === 0, 'events debounced: no synchronous callback');
  timers.fireAll();
  assert(calls === 1, 'a burst of events coalesces into ONE invalidation');
  assert(argCount === 0, 'invalidation carries NO payload (never applied from the wire)');
  h!.stop();
}

function t_escrowWiringAndSplit(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  let data = 0;
  let activity = 0;
  const h = startTeamRealtimeEscrow(
    'E9',
    { onDataChanged: () => data++, onActivity: () => activity++ },
    makeDeps(timers, client),
  );
  assert(h !== null, 'escrow start -> handle');
  const ch = client.channels[0];
  assert(ch.name === 'ctc-team-escrow:E9', 'escrow channel scoped by name');
  const byTable = new Map<string, Binding[]>();
  for (const b of ch.bindings) {
    const arr = byTable.get(b.table) ?? [];
    arr.push(b);
    byTable.set(b.table, arr);
  }
  assert(
    byTable.get('escrows')!.every((b) => b.filter === 'id=eq.E9'),
    'escrow channel: escrows filtered to the escrow',
  );
  assert(
    byTable.get('steps')!.every((b) => b.filter === 'escrow_id=eq.E9'),
    'escrow channel: steps filtered to the escrow',
  );
  assert(
    byTable.get('escrow_activity')!.length === 1 &&
      byTable.get('escrow_activity')![0].event === 'INSERT' &&
      byTable.get('escrow_activity')![0].filter === 'escrow_id=eq.E9',
    'escrow channel: activity INSERT filtered to the escrow',
  );
  ch.emit('steps', { new: { id: 's1' } });
  ch.emit('escrow_activity', { new: { id: 'a1' } });
  timers.fireAll();
  assert(data === 1 && activity === 1, 'data and activity invalidations split by table');
  ch.emit('escrow_activity', { new: { id: 'a2' } });
  timers.fireAll();
  assert(data === 1 && activity === 2, 'activity-only burst does not fire the data callback');
  h!.stop();
}

function t_sharedEscrowChannelSubscribers(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  let a = 0;
  let b = 0;
  const deps = makeDeps(timers, client);
  const h1 = startTeamRealtimeEscrow('E5', { onActivity: () => a++ }, deps);
  const h2 = startTeamRealtimeEscrow('E5', { onActivity: () => b++ }, deps);
  assert(client.channels.length === 1, 'two subscribers on one escrow share ONE channel');
  h1!.stop();
  assert(client.removed.length === 0, 'first subscriber leaving keeps the channel');
  client.channels[0].emit('escrow_activity', { new: { id: 'x' } });
  timers.fireAll();
  assert(a === 0 && b === 1, 'only the remaining subscriber is called');
  h2!.stop();
  assert(client.removed.length === 1, 'last subscriber leaving removes the channel');
  assert(__activeManagerCount() === 0, 'manager unregisters when its channel dies');
}

function t_identityTeardownAndChange(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  const deps = makeDeps(timers, client);
  let calls = 0;
  startTeamRealtimeHome({ onDataChanged: () => calls++ }, deps);
  startTeamRealtimeEscrow('E1', { onDataChanged: () => calls++ }, deps);
  assert(__activeManagerCount() === 2, 'home + escrow managers live under u1');
  setTeamRealtimeUser('u1');
  assert(client.removed.length === 0, 're-setting the SAME identity is a no-op');
  setTeamRealtimeUser(null);
  assert(client.removed.length === 2, 'sign-out removes ALL channels');
  assert(__activeManagerCount() === 0, 'sign-out unregisters every manager');
  for (const ch of client.channels) ch.emit('steps', { new: { id: 's' } });
  timers.fireAll();
  assert(calls === 0, 'no callbacks fire after identity teardown');
  const dead = startTeamRealtimeHome({ onDataChanged: () => {} }, deps);
  assert(dead === null, 'no new channels while signed out');
  setTeamRealtimeUser('u2');
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, deps);
  assert(h !== null && client.channels.length === 3, 'identity change -> fresh channel under the new user');
  h!.stop();
}

function t_reconnectOnChannelError(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  let calls = 0;
  const h = startTeamRealtimeHome(
    { onDataChanged: () => calls++ },
    makeDeps(timers, client),
  );
  const ch1 = client.channels[0];
  ch1.emitStatus('SUBSCRIBED');
  ch1.emitStatus('CHANNEL_ERROR');
  assert(client.channels.length === 1, 'channel error does not reconnect synchronously');
  timers.fireAll();
  assert(client.channels.length === 2, 'backoff fires -> a fresh channel is opened');
  assert(client.removed.includes(ch1), 'the errored channel was removed');
  client.channels[1].emit('steps', { new: { id: 's1' } });
  timers.fireAll();
  assert(calls === 1, 'events flow again on the reconnected channel');
  h!.stop();
}

async function t_syncIdentity(): Promise<void> {
  __resetForTests();
  const timers = new FakeTimers();
  const client = new FakeClient();
  let uid: string | null = 'u9';
  const deps = makeDeps(timers, client, {
    getSessionUserId: async () => uid,
  });
  await syncTeamRealtimeIdentity(deps);
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, deps);
  assert(h !== null, 'sync binds the live session uid -> channels may start');
  uid = null;
  await syncTeamRealtimeIdentity(deps);
  assert(__activeManagerCount() === 0, 'sync with no session tears everything down');
  assert(client.removed.length === 1, 'sync sign-out removed the channel');
}

function t_stopIsIdempotent(): void {
  __resetForTests();
  setTeamRealtimeUser('u1');
  const timers = new FakeTimers();
  const client = new FakeClient();
  const h = startTeamRealtimeHome({ onDataChanged: () => {} }, makeDeps(timers, client));
  h!.stop();
  h!.stop();
  assert(client.removed.length === 1, 'double stop removes the channel once');
  stopAllTeamRealtime();
  assert(__activeManagerCount() === 0, 'stopAll after stop is a no-op');
}

async function main(): Promise<void> {
  t_noIdentityNoChannel();
  t_unconfiguredDegrades();
  t_homeWiring();
  t_homeDebounceInvalidationOnly();
  t_escrowWiringAndSplit();
  t_sharedEscrowChannelSubscribers();
  t_identityTeardownAndChange();
  t_reconnectOnChannelError();
  await t_syncIdentity();
  t_stopIsIdempotent();
  summary('team_realtime');
}

void main();
