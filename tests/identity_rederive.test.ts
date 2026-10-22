// identity_rederive.test.ts — REGRESSION (live incident, Oct 21, 2026):
// escrow creates/updates failed in production with "Couldn't save" while
// profile saves worked. Postgres logs showed SQLSTATE 42501 (RLS WITH
// CHECK) on every escrow upsert.
//
// Root cause: serverSession() trusted the boot/login-time captured
// userId forever (`if (userId) return { c, uid: userId }`) and never
// re-derived identity from the live session. When the session changed
// underneath the store (the reused test browser carried the previous
// run's persisted session; the new account's session landed via the
// email-confirmation flow), every escrow write kept stamping the OLD
// account's uid while the JWT carried the new one — RLS correctly
// refused the cross-account write. Paths that resolve identity
// independently (profile) kept working, masking the cause.
//
// The fix: serverSession() re-derives the uid from the live session
// on every call and REFUSES (IdentityMismatchError -> the refused
// copy) when it diverges from the captured identity, instead of
// stamping the stale capture. A sanctioned re-init (initCloudSync,
// now also fired on SIGNED_IN in app/_layout for the confirmation
// landing) re-captures; local data is never wiped on a switch
// (wiping stays a logout-time rule).
//
// Each assertion below FAILS without the fix and PASSES with it.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const USER_B = 'user-b-old-session';
const USER_A = 'user-a-new-session';

function makeClient(session: { uid: string | null }) {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const empty = { data: [], error: null };
  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: session.uid ? { user: { id: session.uid } } : null,
        },
        error: null,
      }),
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => ({
      select: (_cols?: string) => ({
        eq: () => ({
          limit: () => Promise.resolve(empty),
          then: (res: (v: unknown) => void) => res(empty),
        }),
        in: () => Promise.resolve(empty),
        then: (res: (v: unknown) => void) => res(empty),
      }),
      upsert: (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return {
          select: (_cols?: string) => Promise.resolve({ data: rows, error: null }),
        };
      },
    }),
  };
  return { client, upserts };
}

const closeDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const session: { uid: string | null } = { uid: USER_B };
  const { client, upserts } = makeClient(session);
  const kv = memoryKV();
  const { store, initCloudSync } = createSyncedStore(kv, {
    cloudClient: () => client as never,
  });

  // Boot under the OLD session: init captures USER_B.
  const ping = await initCloudSync();
  assert(ping.ok, 'init: ping ok under the old session');

  const first = await store.createEscrow({
    address: '1 Old Session Way',
    city: 'Valencia',
    side: 'buy',
    buyerName: 'Before Switch',
    openDate: '2026-10-01',
    closeDate,
  });
  const escrowUpserts1 = upserts.filter((u) => u.table === 'escrows');
  assert(escrowUpserts1.length === 1, 'first create: one escrow upsert');
  assert(
    escrowUpserts1[0].rows[0].user_id === USER_B,
    'first create: stamped with the boot session uid',
  );

  // The session flips to a DIFFERENT account underneath the store (no
  // logout, no re-init — the confirmation-landing shape from the
  // incident). The next write must REFUSE loudly with the refused copy
  // and stamp NOTHING — never the stale capture (the production 42501)
  // and never a silent adoption of the new identity for data the store
  // captured under the old one (the Sept 28, 2026 mismatch contract).
  session.uid = USER_A;

  let refusedMsg = '';
  try {
    await store.createEscrow({
      address: '2 New Session Way',
      city: 'Valencia',
      side: 'buy',
      buyerName: 'After Switch',
      openDate: '2026-10-01',
      closeDate,
    });
  } catch (e) {
    refusedMsg = (e as Error).message;
  }
  assert(
    /server refused/.test(refusedMsg),
    'after a session switch, a write refuses with the refused copy (no stale stamp)',
  );
  assert(
    upserts.filter((u) => u.table === 'escrows').length === 1,
    'the refused write sent no escrow upsert',
  );

  // Nothing wiped, nothing committed: the old account's local escrow
  // survives the refused write untouched.
  const listAfterRefusal = await store.listEscrows();
  assert(
    listAfterRefusal.some((e) => e.id === first.id) && listAfterRefusal.length === 1,
    'the refused write leaves local data untouched (no wipe, no commit)',
  );

  // The sanctioned re-capture (initCloudSync — fired by the login /
  // signup screens and by the SIGNED_IN listener) adopts the live
  // identity; the same create now lands, stamped with the LIVE uid.
  const reping = await initCloudSync();
  assert(reping.ok && reping.userId === USER_A, 're-init re-captures the live identity');

  const second = await store.createEscrow({
    address: '2 New Session Way',
    city: 'Valencia',
    side: 'buy',
    buyerName: 'After Switch',
    openDate: '2026-10-01',
    closeDate,
  });
  const escrowUpserts2 = upserts.filter((u) => u.table === 'escrows');
  assert(escrowUpserts2.length === 2, 'after re-init: the create lands');
  assert(
    escrowUpserts2[1].rows[0].user_id === USER_A,
    'after re-init, writes stamp the LIVE session uid',
  );
  const list = await store.listEscrows();
  assert(
    list.some((e) => e.id === second.id),
    'the new account escrow is present after re-init',
  );

  // Same-session writes keep working under the adopted identity.
  const third = await store.createEscrow({
    address: '3 Same Session Way',
    city: 'Valencia',
    side: 'buy',
    buyerName: 'Same Session',
    openDate: '2026-10-01',
    closeDate,
  });
  const list2 = await store.listEscrows();
  assert(
    list2.some((e) => e.id === second.id) && list2.some((e) => e.id === third.id),
    'same-session writes keep the account data intact',
  );
  const escrowUpserts3 = upserts.filter((u) => u.table === 'escrows');
  assert(
    escrowUpserts3[2].rows[0].user_id === USER_A,
    'third create: still stamped with the live uid',
  );

  summary('identity_rederive');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
