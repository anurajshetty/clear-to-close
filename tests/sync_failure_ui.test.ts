// sync_failure_ui.test.ts — REGRESSION (Anuraj, Sept 2026).
//
// REQUIREMENT: whenever any data fails to save to the server (rejected
// push, RLS silent no-op, network failure, anything), the realtor must see
// the error IMMEDIATELY on screen — no silent queueing, no "looks saved
// but wasn't."
//
// These pin the failure-record layer that feeds the SyncErrorBar:
//   - classification of each failure kind (network / rejected / unknown)
//   - an immediate bgPush failure records a visible error AND queues the op
//   - an RLS silent no-op (SyncNotAppliedError) records a 'rejected' error
//   - a successful retry clears the record (retry works -> bar goes away)
//   - records persist in kv so they survive app boot until resolved
//   - the invite-cap server rejection records a FINAL (non-retryable,
//     dismissable) error instead of a silent console warning
//   - subscribers are notified on record and on clear
//   - the logout wipe drops the records (identity-bound)
//   - no em dashes in any user-facing copy
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';
import {
  classifySyncError,
  readSyncErrors,
  recordSyncError,
  clearSyncError,
  clearAllSyncErrors,
  subscribeSyncErrors,
  syncErrorCopy,
  syncErrorHeadline,
  opErrorKey,
} from '../src/lib/syncErrors';
import { SyncNotAppliedError } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-sync-fail-1';
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

type UpsertBehavior = 'ok' | 'network-fail' | 'zero-rows' | 'cap-violation';

// Scripted mock cloud: a mutable behavior object so a test can fail the
// push, assert the error surfaced, then flip to success and retry.
function makeCloud(behavior: { sessionUid: string | null; upsert: UpsertBehavior }) {
  const stats = { writes: 0 };
  const builder = (table: string): unknown => {
    let rows: unknown[] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: Record<string, (...args: any[]) => any> = {
      select: () => b,
      eq: () => b,
      limit: () => b,
      order: () => b,
      upsert: (r: unknown) => {
        rows = Array.isArray(r) ? r : [r];
        return b;
      },
      insert: (r: unknown) => {
        rows = Array.isArray(r) ? r : [r];
        return b;
      },
      update: (r: unknown) => {
        rows = [r];
        return b;
      },
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) => {
        try {
          if (rows) {
            stats.writes++;
            switch (behavior.upsert) {
              case 'network-fail':
                throw new TypeError('fetch failed');
              case 'zero-rows':
                // RLS owner-policy silent rejection: success, zero rows.
                res({ data: [], error: null });
                break;
              case 'cap-violation':
                res({ data: null, error: { message: 'two clients per side max' } });
                break;
              default:
                res({ data: rows, error: null });
            }
          } else {
            res({ data: [], error: null }); // read probes / pulls
          }
        } catch (e) {
          if (rej) rej(e);
          else throw e;
        }
      },
    };
    return b;
  };
  return {
    stats,
    auth: {
      getSession: async () => ({
        data: { session: behavior.sessionUid ? { user: { id: behavior.sessionUid } } : null },
      }),
    },
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
  };
}

async function main(): Promise<void> {
  // ------------------------------------------------------- classification --
  {
    assert(classifySyncError(new SyncNotAppliedError('escrows', 1, 0)) === 'rejected',
      'SyncNotAppliedError classifies as rejected');
    assert(classifySyncError(new TypeError('fetch failed')) === 'network',
      'fetch TypeError classifies as network');
    assert(classifySyncError(new Error('timeout of 8000ms exceeded')) === 'network',
      'timeout classifies as network');
    assert(classifySyncError(new Error('Network request failed')) === 'network',
      'network request failure classifies as network');
    assert(classifySyncError(new Error('something bizarre')) === 'unknown',
      'unrecognized error classifies as unknown');
    assert(classifySyncError(null) === 'unknown', 'null classifies as unknown');
  }

  // ------------------------------------------------------------- copy pins --
  {
    const ops = ['pushEscrow', 'pushProfile', 'pushInvite', 'pushRevoke', 'revokeClientLink', 'inviteCap'] as const;
    const kinds = ['network', 'rejected', 'unknown'] as const;
    for (const op of ops) {
      for (const kind of kinds) {
        const c = syncErrorCopy(op, kind);
        const all = `${c.what} ${c.why} ${c.hint} ${syncErrorHeadline({ key: 'k', op, kind, ...c, at: 0 })}`;
        assert(!all.includes('—') && !all.includes('–'), `no em dashes in copy (${op}/${kind})`);
        assert(c.what.length > 0 && c.why.length > 0 && c.hint.length > 0,
          `copy has what/why/hint (${op}/${kind})`);
      }
    }
    const rejected = syncErrorCopy('pushEscrow', 'rejected');
    assert(/different account/.test(rejected.why), 'rejected copy names the account mismatch');
    assert(rejected.retryable, 'rejected copy is retryable');
    const cap = syncErrorCopy('inviteCap', 'rejected');
    assert(!cap.retryable, 'invite-cap copy is final (not retryable)');
    assert(/2 active invite codes/.test(cap.why), 'invite-cap copy names the cap');
  }

  // --------------------------------- immediate push failure records + queues --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'network-fail' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '1 Fail Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Fail Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    await tick(150); // bgPush is fire-and-forget
    const errors = await store.getSyncErrors();
    assert(errors.length === 1, 'failed push records exactly one error');
    assert(errors[0].op === 'pushEscrow' && errors[0].kind === 'network',
      'failed escrow push records a network error');
    assert(errors[0].retryable, 'network error is retryable');
    assert(errors[0].key === opErrorKey({ op: 'pushEscrow', escrowId: e.id }),
      'error key matches the outbox op key');
    assert(/could not reach the server/.test(syncErrorHeadline(errors[0])),
      'headline says what failed in plain words');

    // The op is still queued (existing self-heal behavior preserved).
    const { readOutboxOps } = await import('../src/lib/cloudSync');
    const ops = await readOutboxOps(kv);
    assert(ops.some((o) => o.op === 'pushEscrow' && o.escrowId === e.id),
      'failed push still queues the op for retry');

    // ---- retry clears the record -------------------------------------
    behavior.upsert = 'ok';
    await store.retrySync();
    await tick(50);
    assert((await store.getSyncErrors()).length === 0,
      'a successful retry clears the error record');
  }

  // --------------------------------------- RLS silent no-op is 'rejected' --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'zero-rows' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    await store.createEscrow({
      address: '2 Reject Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Reject Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    await tick(150);
    const errors = await store.getSyncErrors();
    assert(errors.length === 1 && errors[0].kind === 'rejected',
      'RLS silent no-op records a rejected error');
    assert(/different account/.test(errors[0].why),
      'rejected error explains the likely account mismatch');
    assert(/did not save/.test(syncErrorHeadline(errors[0])), 'rejected headline is plain');
  }

  // ---------------------------------------------- records survive a boot --
  {
    const kv = memoryKV();
    await recordSyncError(kv, {
      key: 'pushProfile:::', op: 'pushProfile', kind: 'network',
      ...syncErrorCopy('pushProfile', 'network'), at: Date.now(),
    });
    // A brand-new store instance on the same kv (the next app boot).
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    const errors = await store.getSyncErrors();
    assert(errors.length === 1 && errors[0].op === 'pushProfile',
      'failure records persist across boots until resolved');
    const direct = await readSyncErrors(kv);
    assert(direct.length === 1, 'readSyncErrors reads the persisted record');
    await clearSyncError(kv, 'pushProfile:::');
    assert((await readSyncErrors(kv)).length === 0, 'clearSyncError removes one record');
    await recordSyncError(kv, {
      key: 'pushProfile:::', op: 'pushProfile', kind: 'network',
      ...syncErrorCopy('pushProfile', 'network'), at: Date.now(),
    });
    await clearAllSyncErrors(kv);
    assert((await readSyncErrors(kv)).length === 0, 'clearAllSyncErrors drops every record');
  }

  // -------------------------------- invite cap: final, visible, dismissable --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'cap-violation' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '3 Cap Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Cap Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    await store.createInvite(e.id, 'buyer', 'Cap Client');
    await tick(150);
    const errors = await store.getSyncErrors();
    const cap = errors.find((x) => x.op === 'inviteCap');
    assert(!!cap, 'cap rejection records a visible error (not just a console warning)');
    assert(cap!.retryable === false, 'cap error is final, not retryable');
    assert(/2 active invite codes/.test(cap!.why), 'cap error says why in plain words');
    await store.dismissSyncError(cap!.key);
    assert(!(await store.getSyncErrors()).some((x) => x.op === 'inviteCap'),
      'a final error can be dismissed');
  }

  // ------------------------------------------------- subscriber notified --
  {
    const kv = memoryKV();
    let calls = 0;
    const off = subscribeSyncErrors(() => { calls++; });
    await recordSyncError(kv, {
      key: 'pushEscrow:e1::', op: 'pushEscrow', escrowId: 'e1', kind: 'network',
      ...syncErrorCopy('pushEscrow', 'network'), at: Date.now(),
    });
    assert(calls === 1, 'subscriber fires on record');
    await clearSyncError(kv, 'pushEscrow:e1::');
    assert(calls === 2, 'subscriber fires on clear');
    off();
    await recordSyncError(kv, {
      key: 'pushEscrow:e1::', op: 'pushEscrow', escrowId: 'e1', kind: 'network',
      ...syncErrorCopy('pushEscrow', 'network'), at: Date.now(),
    });
    assert(calls === 2, 'unsubscribed listener stays silent');
  }

  // ------------------------------------------------- logout wipe clears --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'network-fail' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    await store.createEscrow({
      address: '4 Wipe Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Wipe Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    await tick(150);
    assert((await store.getSyncErrors()).length === 1, 'error recorded before wipe');
    await store.clearLocalAccountData();
    assert((await store.getSyncErrors()).length === 0,
      'logout wipe drops the failure records (identity-bound)');
  }

  // ------------------------------------------- invite revocation surfaces --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'ok' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '5 Revoke Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Revoke Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    const inv = await store.createInvite(e.id, 'buyer', 'Revoke Client');
    await tick(150);
    assert((await store.getSyncErrors()).length === 0, 'healthy invite flow records nothing');
    // The revocation write now fails at the server.
    behavior.upsert = 'network-fail';
    await store.revokeInvite(inv.id);
    await tick(150);
    const errors = await store.getSyncErrors();
    const rev = errors.find((x) => x.op === 'pushRevoke');
    assert(!!rev, 'failed invite revocation records a visible error');
    assert(rev!.kind === 'network' && rev!.retryable, 'revocation error is retryable');
    assert(/invite revocation/.test(rev!.what), 'revocation copy names what failed');
    // The failed revocation stayed queued: retry lands it and clears it.
    behavior.upsert = 'ok';
    await store.retrySync();
    await tick(50);
    assert(!(await store.getSyncErrors()).some((x) => x.op === 'pushRevoke'),
      'a successful revocation retry clears the error');
  }

  // ----------------------- client-link revocation (close) surfaces as well --
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'ok' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '6 Link Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Link Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    const inv = await store.createInvite(e.id, 'buyer', 'Link Client');
    await tick(150);
    const res = await store.redeemInvite(inv.code, 'Link Client');
    assert(res.ok === true && Boolean((res as { linkId?: string }).linkId),
      'local redeem binds a device link');
    // Per-side close requires every step on the side to be complete.
    const le = await store.getEscrow(e.id);
    for (const s of le!.buyerSteps) {
      if (!s.done) await store.toggleStep(e.id, 'buyer', s.id);
    }
    await tick(300);
    // RLS owner-policy rejects the close + link-revocation writes.
    behavior.upsert = 'zero-rows';
    await store.closeEscrow(e.id, 'buyer');
    await tick(300); // closeEscrow kicks a non-blocking immediate drain
    const errors = await store.getSyncErrors();
    const linkRev = errors.find((x) => x.op === 'revokeClientLink');
    assert(!!linkRev, 'failed client-link revocation records a visible error');
    assert(linkRev!.kind === 'rejected', 'RLS-rejected link revocation is a rejection');
    assert(/different account/.test(linkRev!.why), 'link-revocation copy explains the mismatch');
  }

  // -------- exhausted automatic attempts stay manually retryable ---------
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'network-fail' as UpsertBehavior };
    const cloud = makeCloud(behavior);
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => cloud as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '7 Manual Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Manual Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    await tick(150);
    const { readOutboxOps } = await import('../src/lib/cloudSync');
    // Burn through the automatic attempts via explicit retries.
    for (let i = 0; i < 10; i++) await store.retrySync();
    const ops = await readOutboxOps(kv);
    const op = ops.find((o) => o.op === 'pushEscrow' && o.escrowId === e.id);
    assert(!!op, 'the op is NOT dropped after the automatic attempt cap');
    assert(op!.manualOnly === true, 'the op becomes manual-only after the cap');
    assert((await store.getSyncErrors()).length === 1,
      'the failure record survives the attempt cap');
    // An automatic drain (boot) must not hammer it again...
    cloud.stats.writes = 0;
    await initCloudSync();
    assert(cloud.stats.writes === 0, 'automatic drains skip manual-only ops');
    assert((await store.getSyncErrors()).length === 1,
      'the record stays visible while the op waits for manual retry');
    // ...but an explicit Retry attempts it, and success clears everything.
    behavior.upsert = 'ok';
    await store.retrySync();
    assert(cloud.stats.writes > 0, 'manual Retry attempts the manual-only op');
    assert((await readOutboxOps(kv)).length === 0, 'a landed retry removes the op');
    assert((await store.getSyncErrors()).length === 0,
      'a successful manual retry clears the error');
  }

  summary('sync_failure_ui');
}

void main();
