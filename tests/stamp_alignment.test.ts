// stamp_alignment.test.ts — REGRESSION (Benito defect, Nov 10, 2026):
// on old escrows, ONE step stamp (completed_by/created_by) that diverged
// between the local cache and the server makes the FULL-LIST steps
// upsert die with 42501 under migration 0046's step_stamps_allowed, so
// every confirmed write on the escrow fails with "Couldn't save"
// forever — the local model preserves the diverged stamp verbatim on
// every push and nothing ever heals it.
//
// The auditor-blessed repair (predicate-scoped align-to-server): when
// the steps upsert — and ONLY the steps upsert — is denied 42501, the
// write pulls the server's stored stamps fresh, surrenders exactly the
// local stamps step_stamps_allowed would reject (to the stored value;
// to NULL for local-only steps), persists the alignment into the local
// model, and retries the upsert exactly once. A stamp the predicate
// allows (the saver's own fresh check-off) keeps its attribution.
// Every alignment is recorded in the stamp-alignment diagnostics log.
//
// These cells run pushEscrowForRole/pushEscrowNow against a stateful
// fake steps server that enforces the 0046 predicate exactly.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import {
  pushEscrowForRole,
  readStampAlignmentLog,
} from '../src/lib/cloudSync';
import type { Escrow, StepT } from '../src/lib/types';

declare const process: { exitCode?: number };

const SAVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ESCROW_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const RLS_STEPS = {
  code: '42501',
  message: 'new row violates row-level security policy for table "steps"',
};

interface StoredStep {
  id: string;
  title: string;
  completed_by: string | null;
  created_by: string | null;
}

/** The 0046 predicate, one stamp: allowed iff null, equal to stored,
 * or the saver's while stored is null/the saver's. A missing stored
 * row reads as stored = null (the SQL subquery returns null). */
function stampAllowed(v: string | null, stored: StoredStep | undefined, field: 'completed_by' | 'created_by'): boolean {
  if (v === null) return true;
  const s = stored ? stored[field] : null;
  if (stored && v === s) return true;
  if (v === SAVER && (s === null || s === SAVER)) return true;
  return false;
}

interface FakeOpts {
  escrowError?: unknown;
  stepsSelectError?: unknown;
  /** 1-based steps-upsert call number from which to fail with this error. */
  failStepsFromCall?: number;
  failStepsError?: unknown;
}

function makeFake(storedSeed: StoredStep[], opts: FakeOpts = {}) {
  const stored = new Map<string, StoredStep>(storedSeed.map((s) => [s.id, { ...s }]));
  const calls = { stepsUpsert: 0, stepsSelect: 0, escrowUpsert: 0, escrowUpdate: 0 };

  const stepsUpsert = (rows: Record<string, unknown>[]) => {
    calls.stepsUpsert += 1;
    if (opts.failStepsFromCall && calls.stepsUpsert >= opts.failStepsFromCall) {
      return { data: null, error: opts.failStepsError ?? RLS_STEPS };
    }
    for (const r of rows) {
      const cur = stored.get(String(r.id));
      if (
        !stampAllowed((r.completed_by as string | null) ?? null, cur, 'completed_by') ||
        !stampAllowed((r.created_by as string | null) ?? null, cur, 'created_by')
      ) {
        return { data: null, error: RLS_STEPS };
      }
    }
    for (const r of rows) {
      stored.set(String(r.id), {
        id: String(r.id),
        title: String(r.title ?? ''),
        completed_by: (r.completed_by as string | null) ?? null,
        created_by: (r.created_by as string | null) ?? null,
      });
    }
    return { data: rows.map((r) => ({ id: String(r.id) })), error: null };
  };

  const builder = (table: string): any => ({
    upsert: (rows: Record<string, unknown>[]) => ({
      select: () => {
        if (table === 'escrows') {
          calls.escrowUpsert += 1;
          if (opts.escrowError) return { data: null, error: opts.escrowError };
          return { data: rows.map((r) => ({ id: String(r.id) })), error: null };
        }
        return stepsUpsert(rows);
      },
    }),
    update: () => ({
      eq: () => ({
        select: () => {
          calls.escrowUpdate += 1;
          if (opts.escrowError) return { data: null, error: opts.escrowError };
          return { data: [{ id: ESCROW_ID }], error: null };
        },
      }),
    }),
    select: () => ({
      eq: () => {
        calls.stepsSelect += 1;
        if (opts.stepsSelectError) return { data: null, error: opts.stepsSelectError };
        return {
          data: [...stored.values()].map((s) => ({
            id: s.id,
            completed_by: s.completed_by,
            created_by: s.created_by,
          })),
          error: null,
        };
      },
    }),
  });

  return { client: { from: (t: string) => builder(t) } as never, stored, calls };
}

function step(id: string, over: Partial<StepT> = {}): StepT {
  return {
    id,
    title: `Step ${id}`,
    subtitle: '',
    done: false,
    custom: false,
    order: 0,
    completedAt: null,
    completedBy: null,
    createdBy: null,
    ...over,
  } as StepT;
}

function escrowWith(steps: StepT[], over: Partial<Escrow> = {}): Escrow {
  return {
    id: ESCROW_ID,
    address: '26207 Benito Ct',
    city: 'Santa Clarita, CA 91355',
    side: 'sell',
    buyerName: null,
    sellerName: 'June',
    openDate: '2026-09-25',
    closeDate: '2026-11-25',
    buyerSteps: [],
    sellerSteps: steps,
    status: 'open',
    buyerClosedAt: null,
    sellerClosedAt: null,
    createdAt: '2026-09-25T09:00:00Z',
    ...over,
  } as Escrow;
}

async function main(): Promise<void> {
  // --- Cell 1: diverged stamps -> align to stored, retry lands, -------
  // --- server stamps byte-identical, content lands, model persisted. --
  {
    const kv = memoryKV();
    const fake = makeFake([
      { id: 's1', title: 'Old title', completed_by: null, created_by: null },
    ]);
    const e = escrowWith([
      step('s1', { title: 'New title', done: true, completedAt: '2026-11-10T10:00:00Z', completedBy: FOREIGN, createdBy: FOREIGN2 }),
    ]);
    await pushEscrowForRole(fake.client, SAVER, e, { kv });
    const s1 = fake.stored.get('s1')!;
    assert(s1.title === 'New title' && s1.completed_by === null && s1.created_by === null,
      'cell 1: content landed; server stamps byte-identical to stored (null)');
    const local = e.sellerSteps[0];
    assert(local.completedBy === null && local.createdBy === null,
      'cell 1: alignment persisted into the local model');
    assert(fake.calls.stepsUpsert === 2 && fake.calls.stepsSelect === 1,
      'cell 1: exactly one fresh pull and one retry');
    const log = await readStampAlignmentLog(kv);
    assert(log.length === 1, 'cell 1: one alignment recorded');
    const rec = log[0];
    assert(rec.escrowId === ESCROW_ID && rec.saverUid === SAVER && rec.retryOutcome === 'landed',
      'cell 1: record carries escrow, saver, landed outcome');
    assert(rec.stepIds.length === 1 && rec.stepIds[0] === 's1', 'cell 1: record names the aligned step');
    const froms = rec.surrendered.map((x) => `${x.field}:${x.from}->${x.to}`).sort();
    assert(froms[0] === `completed_by:${FOREIGN}->null` && froms[1] === `created_by:${FOREIGN2}->null`,
      'cell 1: record carries surrendered-from uid -> to value per stamp');
  }

  // --- Cell 2: diverged + the saver's fresh check-off in the same -----
  // --- write -> the fresh attribution survives. ------------------------
  {
    const kv = memoryKV();
    const fake = makeFake([
      { id: 's1', title: 'A', completed_by: null, created_by: null },
      { id: 's2', title: 'B', completed_by: null, created_by: null },
    ]);
    const e = escrowWith([
      step('s1', { done: true, completedBy: FOREIGN }),
      step('s2', { done: true, completedAt: '2026-11-10T11:00:00Z', completedBy: SAVER }),
    ]);
    await pushEscrowForRole(fake.client, SAVER, e, { kv });
    assert(fake.stored.get('s1')!.completed_by === null, 'cell 2: diverged stamp surrendered to stored');
    assert(fake.stored.get('s2')!.completed_by === SAVER, 'cell 2: fresh check-off kept its attribution server-side');
    assert(e.sellerSteps[1].completedBy === SAVER, 'cell 2: fresh check-off kept locally too');
    const log = await readStampAlignmentLog(kv);
    assert(log.length === 1 && log[0].stepIds.length === 1 && log[0].stepIds[0] === 's1',
      'cell 2: only the diverged step is recorded as aligned');
  }

  // --- Cell 3: diverged stamp on a LOCAL-ONLY step -> surrender to ----
  // --- NULL (never the saver); a local-only step stamped BY the saver -
  // --- survives (the predicate allows an insert with one's own stamp). -
  {
    const kv = memoryKV();
    const fake = makeFake([]);
    const e = escrowWith([
      step('s3', { custom: true, createdBy: FOREIGN, completedBy: FOREIGN }),
      step('s4', { custom: true, createdBy: SAVER }),
    ]);
    await pushEscrowForRole(fake.client, SAVER, e, { kv });
    const s3 = fake.stored.get('s3')!;
    assert(s3.created_by === null && s3.completed_by === null,
      'cell 3: local-only diverged stamps landed as null');
    assert(e.sellerSteps[0].createdBy === null && e.sellerSteps[0].completedBy === null,
      'cell 3: local-only alignment persisted as null');
    assert(fake.stored.get('s4')!.created_by === SAVER,
      'cell 3: local-only step stamped by the saver survives');
  }

  // --- Cell 4: genuine non-stamp denial (stamps all pass the predicate,
  // --- the upsert still 42501s) -> no retry loop, fails loud, no record.
  {
    const kv = memoryKV();
    const fake = makeFake(
      [{ id: 's1', title: 'A', completed_by: SAVER, created_by: null }],
      { failStepsFromCall: 1, failStepsError: RLS_STEPS },
    );
    const e = escrowWith([step('s1', { done: true, completedBy: SAVER })]);
    let threw: unknown = null;
    try {
      await pushEscrowForRole(fake.client, SAVER, e, { kv });
    } catch (err) {
      threw = err;
    }
    assert(!!threw && (threw as { code?: string }).code === '42501', 'cell 4: the denial propagates');
    assert(fake.calls.stepsUpsert === 1, 'cell 4: no retry when nothing is surrenderable');
    assert((await readStampAlignmentLog(kv)).length === 0, 'cell 4: nothing recorded (no alignment happened)');
    assert(e.sellerSteps[0].completedBy === SAVER, 'cell 4: local stamps untouched');
  }

  // --- Cell 5: a 42501 from the ESCROW upsert never arms alignment. ---
  {
    const kv = memoryKV();
    const fake = makeFake([], {
      escrowError: { code: '42501', message: 'new row violates row-level security policy for table "escrows"' },
    });
    const e = escrowWith([step('s1', { completedBy: FOREIGN })]);
    let threw: unknown = null;
    try {
      await pushEscrowForRole(fake.client, SAVER, e, { kv });
    } catch (err) {
      threw = err;
    }
    assert(!!threw, 'cell 5: escrow denial propagates');
    assert(fake.calls.stepsSelect === 0 && fake.calls.stepsUpsert === 0,
      'cell 5: no steps pull and no steps upsert attempted (alignment not armed)');
  }

  // --- Cell 6: the fresh pull fails -> no retry, fail as today. -------
  {
    const kv = memoryKV();
    const fake = makeFake(
      [{ id: 's1', title: 'A', completed_by: null, created_by: null }],
      { stepsSelectError: { code: 'PGRST000', message: 'connection reset' } },
    );
    const e = escrowWith([step('s1', { completedBy: FOREIGN })]);
    let threw: unknown = null;
    try {
      await pushEscrowForRole(fake.client, SAVER, e, { kv });
    } catch (err) {
      threw = err;
    }
    assert(!!threw && (threw as { code?: string }).code === '42501',
      'cell 6: the original steps denial propagates when the pull fails');
    assert(fake.calls.stepsUpsert === 1, 'cell 6: no retry after a failed pull');
    assert((await readStampAlignmentLog(kv)).length === 0, 'cell 6: nothing recorded');
  }

  // --- Cell 7: retry fails again -> fails loud, recorded distinctly ---
  // --- (retryOutcome 'failed'); the surrender still persisted locally. -
  {
    const kv = memoryKV();
    const fake = makeFake(
      [{ id: 's1', title: 'A', completed_by: null, created_by: null }],
      { failStepsFromCall: 2, failStepsError: { code: '42501', message: 'still denied' } },
    );
    const e = escrowWith([step('s1', { completedBy: FOREIGN })]);
    let threw: unknown = null;
    try {
      await pushEscrowForRole(fake.client, SAVER, e, { kv });
    } catch (err) {
      threw = err;
    }
    assert(!!threw, 'cell 7: the second failure propagates');
    assert(fake.calls.stepsUpsert === 2, 'cell 7: exactly one retry was attempted');
    const log = await readStampAlignmentLog(kv);
    assert(log.length === 1 && log[0].retryOutcome === 'failed',
      'cell 7: the failed retry is recorded distinctly');
    assert(e.sellerSteps[0].completedBy === null, 'cell 7: surrender persisted in the local model');
  }

  // --- Cell 8: the member path arms the same alignment ----------------
  {
    const kv = memoryKV();
    const fake = makeFake([
      { id: 's1', title: 'A', completed_by: null, created_by: null },
    ]);
    const e = escrowWith([step('s1', { completedBy: FOREIGN })], { accessRole: 'associate' } as Partial<Escrow>);
    await pushEscrowForRole(fake.client, SAVER, e, { kv });
    assert(fake.stored.get('s1')!.completed_by === null, 'cell 8: member-path diverged stamp aligned');
    assert(fake.calls.escrowUpdate === 1 && fake.calls.escrowUpsert === 0,
      'cell 8: member path taken (escrow UPDATE, no upsert)');
  }

  summary('stamp_alignment');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
