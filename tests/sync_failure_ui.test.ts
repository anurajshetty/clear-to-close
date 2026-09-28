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
} from '../src/lib/syncErrors';
import { SyncNotAppliedError } from '../src/lib/cloudSync';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const UID = 'user-sync-fail-1';

type UpsertBehavior = 'ok' | 'network-fail' | 'zero-rows' | 'cap-violation';

// Scripted mock cloud: a mutable behavior object so a test can fail the
// push, assert the error surfaced, then flip to success and retry.
function makeCloud(behavior: { sessionUid: string | null; upsert: UpsertBehavior; failLinkSelect?: boolean }) {
  const stats = { writes: 0 };
  const builder = (table: string): unknown => {
    let rows: unknown[] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: Record<string, (...args: any[]) => any> = {
      select: () => b,
      eq: () => b,
      is: () => b,
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
          if (behavior.failLinkSelect && table === 'client_links' && rows === null) {
            // Scripted outage of the server-side link lookup: the
            // convergeLinkRevokes op cannot list live links.
            throw new TypeError('fetch failed');
          }
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
    const ops = ['pushEscrow', 'pushProfile', 'pushInvite', 'pushRevoke', 'revokeClientLink', 'convergeLinkRevokes', 'inviteCap'] as const;
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

  // ----------------- a failed push throws at once: no record, no queue -----
  // (Sept 28, 2026: synchronous confirmed writes. The failure IS the UI
  // signal — the screen shows the plain copy immediately. Nothing is
  // recorded in the background and nothing is queued; retry is the action
  // called again.)
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'network-fail' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    let msg = '';
    try {
      await store.createEscrow({
        address: '1 Fail Ct', city: 'Valencia, CA 91355', side: 'buy',
        buyerName: 'Fail Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/Couldn't reach the server/.test(msg),
      'failed push throws the plain network copy immediately');
    assert((await store.listEscrows()).length === 0,
      'failed push leaves no local escrow (nothing was confirmed)');
    assert((await store.getSyncErrors()).length === 0,
      'a failed user write records no background error');
    const { readOutboxOps } = await import('../src/lib/cloudSync');
    assert((await readOutboxOps(kv)).length === 0,
      'a failed user write queues no outbox op');

    // Retry is just the action again: the network recovers and the write lands.
    behavior.upsert = 'ok';
    const e = await store.createEscrow({
      address: '1 Fail Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Fail Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    assert((await store.getEscrow(e.id)) !== null,
      'retrying the action after recovery applies it locally');
    assert((await store.getSyncErrors()).length === 0,
      'a landed retry records nothing');
  }

  // --------------------------------------- RLS silent no-op is 'refused' ----
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'zero-rows' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    let msg = '';
    try {
      await store.createEscrow({
        address: '2 Reject Ct', city: 'Valencia, CA 91355', side: 'buy',
        buyerName: 'Reject Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/server refused/.test(msg),
      'RLS silent no-op throws the refused copy (the write touched nothing)');
    assert((await store.listEscrows()).length === 0,
      'a refused write leaves no local escrow');
    assert((await store.getSyncErrors()).length === 0,
      'a refused user write records no background error');
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

  // -------------------------------- invite cap: final, plain, unrecorded -----
  // The cap rejection throws the plain cap copy at once. Nothing is
  // recorded and nothing is queued: a cap rejection is final, and the
  // realtor reads the reason in the thrown error, not on an error bar.
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'ok' as UpsertBehavior };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '3 Cap Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Cap Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    behavior.upsert = 'cap-violation';
    let msg = '';
    try {
      await store.createInvite(e.id, 'buyer', 'Cap Client');
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/2 active invite codes/.test(msg), 'cap rejection throws the plain cap copy');
    assert((await store.listInvites(e.id)).length === 0,
      'cap rejection leaves no local invite row');
    assert((await store.getSyncErrors()).length === 0,
      'cap rejection records no background error');
    // A manually recorded final error can still be dismissed.
    await recordSyncError(kv, {
      key: 'inviteCap:manual:', op: 'inviteCap', kind: 'rejected',
      ...syncErrorCopy('inviteCap', 'rejected'), at: Date.now(),
    });
    assert((await store.getSyncErrors()).length === 1, 'manual record present');
    await store.dismissSyncError('inviteCap:manual:');
    assert((await store.getSyncErrors()).length === 0,
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
  // (The record layer now only carries legacy-drain failures, but the
  // identity-bound wipe rule still holds: whatever is recorded is dropped
  // on logout.)
  {
    const kv = memoryKV();
    await recordSyncError(kv, {
      key: 'pushEscrow:e1::', op: 'pushEscrow', escrowId: 'e1', kind: 'network',
      ...syncErrorCopy('pushEscrow', 'network'), at: Date.now(),
    });
    const { store } = createSyncedStore(kv, { cloudClient: () => null });
    assert((await store.getSyncErrors()).length === 1, 'record present before wipe');
    await store.clearLocalAccountData();
    assert((await store.getSyncErrors()).length === 0,
      'logout wipe drops the failure records (identity-bound)');
  }

  // ------------------------------------------- invite revocation throws ----
  // A failed revocation throws at once and leaves the invite live locally;
  // the retry is the revoke action called again.
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
    assert((await store.getSyncErrors()).length === 0, 'healthy invite flow records nothing');
    // The revocation write now fails at the server.
    behavior.upsert = 'network-fail';
    let msg = '';
    try {
      await store.revokeInvite(inv.id);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/Couldn't reach the server/.test(msg),
      'failed invite revocation throws the plain copy');
    assert((await store.getInvite(inv.id))?.revokedAt == null,
      'failed revocation leaves the local invite live (code still works)');
    assert((await store.getSyncErrors()).length === 0,
      'failed revocation records no background error');
    // Retry is the action again: it lands and the invite is revoked locally.
    behavior.upsert = 'ok';
    await store.revokeInvite(inv.id);
    assert((await store.getInvite(inv.id))?.revokedAt != null,
      'a revocation retry lands and revokes the local invite');
  }

  // ------- link-revocation convergence (close) throws on lookup failure ----
  // Close/revoke converge each revoked invite's live server links inside
  // the same confirmed write. A failed link lookup throws at once and
  // leaves the side open locally; calling close again retries safely.
  {
    const kv = memoryKV();
    const behavior = { sessionUid: UID, upsert: 'ok' as UpsertBehavior, failLinkSelect: false };
    const { store, initCloudSync } = createSyncedStore(kv, { cloudClient: () => makeCloud(behavior) as never });
    await initCloudSync();
    const e = await store.createEscrow({
      address: '6 Link Ct', city: 'Valencia, CA 91355', side: 'buy',
      buyerName: 'Link Buyer', openDate: '2026-09-25', closeDate: '2026-11-25',
    });
    const inv = await store.createInvite(e.id, 'buyer', 'Link Client');
    // Per-side close requires every step on the side to be complete.
    const le = await store.getEscrow(e.id);
    for (const s of le!.buyerSteps) {
      if (!s.done) await store.toggleStep(e.id, 'buyer', s.id);
    }
    // The server-side link lookup fails: the confirmed write throws and
    // the side stays open locally — no silent zombie link, no partial apply.
    behavior.failLinkSelect = true;
    let msg = '';
    try {
      await store.closeEscrow(e.id, 'buyer');
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(/Couldn't reach the server/.test(msg),
      'close with a failed link lookup throws the plain copy');
    assert((await store.getEscrow(e.id))?.buyerClosedAt == null,
      'failed close leaves the side open locally');
    assert((await store.getInvite(inv.id))?.revokedAt == null,
      'failed close leaves the invite live locally');
    // Recovery: the lookup succeeds and the close lands on retry.
    behavior.failLinkSelect = false;
    await store.closeEscrow(e.id, 'buyer');
    assert((await store.getEscrow(e.id))?.buyerClosedAt != null,
      'a close retry lands and closes the side');
  }

  summary('sync_failure_ui');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', e);
  process.exitCode = 1;
});
