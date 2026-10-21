// team_store.test.ts — Team Access app-data layer (Oct 2026, migration
// 0044). Pins:
//  - the pure jsonb mappers in teamModel.ts (pending invites, invited
//    escrows, participants, activity, action results),
//  - the accessRole derivation (own escrows default to owner; invited
//    escrows carry their grant role + owner identity),
//  - refreshTeam's merge through the synced store (scripted mock client),
//  - the team action RPC wrappers (names, params, passthrough results),
//  - the actor stamps: toggle -> completed_by, custom step -> created_by,
//    intake saves -> owner_id (the escrow OWNER) + updated_by (writer),
//  - the three team push tap routes.
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { createSyncedStore } from '../src/lib/syncedStore';
import {
  decorateInvitedEscrow,
  deriveAccessRole,
  mapEscrowActivity,
  mapEscrowParticipants,
  mapInvitedEscrowEntries,
  mapPendingTeamInvites,
  sanitizeGrantRole,
  teamResultFromRpc,
} from '../src/lib/teamModel';
import { fromEscrowRow, fromStepRow, toStepRows } from '../src/lib/cloudSync';
import { escrowRouteFromResponse, pushTapRoute, teamPushTapRoute } from '../src/lib/push';
import type { Escrow, StepT } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const MEMBER = 'member-1'; // the mock session's auth uid
const OWNER = 'owner-1'; // the invited escrow's owner

// ------------------------------------------------------------ fixtures --

const PENDING_INVITES_JSONB = [
  {
    grant_id: 'grant-pending-1',
    role: 'associate',
    created_at: '2026-10-19T15:04:00Z',
    invited_email: 'member@example.com',
    owner_name: 'Olivia Owner',
    owner_photo_url: 'https://cdn.test/owner.jpg',
    escrow: {
      id: 'esc-pending',
      address: '12 Palm Ct',
      city: 'Valencia',
      side: 'buy',
      buyer_name: 'Ben Buyer',
      seller_name: null,
      close_date: '2026-11-20',
      status: 'open',
    },
  },
  {
    grant_id: 'grant-pending-2',
    role: 'tc',
    created_at: '2026-10-19T16:00:00Z',
    invited_email: 'member@example.com',
    owner_name: null,
    owner_photo_url: null,
    escrow: {
      id: 'esc-pending-2',
      address: '9 Oak Ave',
      city: '',
      side: 'both',
      buyer_name: 'Bea Buyer',
      seller_name: 'Sal Seller',
      close_date: '2026-12-01',
      status: 'open',
    },
  },
];

const INVITED_ESCROW_ROW = {
  id: 'esc-invited',
  user_id: OWNER,
  address: '44 River Rd',
  city: 'Newhall',
  side: 'buy',
  buyer_name: 'Ben Buyer',
  seller_name: null,
  open_date: '2026-10-01',
  close_date: '2026-11-15',
  status: 'open',
  inspection_deadline: null,
  appraisal_deadline: null,
  loan_approval_date: null,
  last_action: null,
  buyer_closed_at: null,
  seller_closed_at: null,
  created_at: '2026-10-01T09:00:00Z',
};

const INVITED_JSONB = [
  {
    grant_id: 'grant-accepted-1',
    role: 'associate',
    accepted_at: '2026-10-18T10:00:00Z',
    owner_name: 'Olivia Owner',
    owner_photo_url: 'https://cdn.test/owner.jpg',
    escrow: INVITED_ESCROW_ROW,
  },
];

const INVITED_STEP_ROWS = [
  {
    id: 'step-b1',
    escrow_id: 'esc-invited',
    role: 'buyer',
    position: 0,
    title: 'Escrow opened',
    subtitle: '',
    done: true,
    custom: false,
    completed_at: '2026-10-10T12:00:00Z',
    completed_by: OWNER,
    created_by: null,
    explainer: null,
    template_key: 'escrow-opened',
  },
  {
    id: 'step-b2',
    escrow_id: 'esc-invited',
    role: 'buyer',
    position: 1,
    title: 'Custom thing',
    subtitle: '',
    done: false,
    custom: true,
    completed_at: null,
    completed_by: null,
    created_by: OWNER,
    explainer: null,
    template_key: null,
  },
];

function makeStep(partial: Partial<StepT>): StepT {
  return {
    id: 's1',
    title: 'Step',
    subtitle: '',
    done: false,
    custom: false,
    order: 0,
    completedAt: null,
    explainer: null,
    templateKey: null,
    ...partial,
  };
}

function makeEscrow(partial: Partial<Escrow>): Escrow {
  return {
    id: 'esc-own',
    address: '1 Main St',
    city: 'Santa Clarita',
    side: 'buy',
    buyerName: 'Ben Buyer',
    sellerName: null,
    openDate: '2026-10-01',
    closeDate: '2026-11-01',
    status: 'open',
    buyerSteps: [makeStep({ id: 'own-b1' })],
    sellerSteps: [],
    buyerClosedAt: null,
    sellerClosedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    ...partial,
  };
}

// ------------------------------------------------------- mock client ----

interface RpcResponse {
  data?: unknown;
  error?: unknown;
}

/**
 * Scripted supabase client for the synced store: rpc responses are
 * consumed per name in order; table upserts are captured; the steps
 * select returns the seeded rows.
 */
function makeTeamClient(script: Record<string, RpcResponse[]>) {
  const rpcCalls: { name: string; params?: Record<string, unknown> }[] = [];
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: MEMBER } } }, error: null }),
    },
    rpc: async (name: string, params?: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      const q = script[name];
      if (!q || q.length === 0) return { data: null, error: null };
      const r = q.shift()!;
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from: (table: string) => ({
      select: (_cols?: string) => ({
        in: (_col: string, _vals: unknown[]) =>
          Promise.resolve({
            data: table === 'steps' ? INVITED_STEP_ROWS : [],
            error: null,
          }),
        eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
      }),
      upsert: (rows: Record<string, unknown>[], _opts?: unknown) => {
        upserts.push({ table, rows });
        return {
          select: (_cols?: string) => Promise.resolve({ data: rows, error: null }),
        };
      },
    }),
  };
  return { client, rpcCalls, upserts };
}

function teamScript(extra: Record<string, RpcResponse[]> = {}): Record<string, RpcResponse[]> {
  return {
    claim_team_invites: [{ data: 1 }, { data: 0 }, { data: 0 }],
    list_my_team_invites: [{ data: PENDING_INVITES_JSONB }, { data: [] }, { data: [] }],
    list_invited_escrows: [{ data: INVITED_JSONB }, { data: INVITED_JSONB }, { data: INVITED_JSONB }],
    ...extra,
  };
}

// ------------------------------------------------------------- mappers --

function testMappers(): void {
  const pending = mapPendingTeamInvites(PENDING_INVITES_JSONB);
  assert(pending.length === 2, 'pending invites: both rows map');
  const p0 = pending[0];
  assert(p0.grantId === 'grant-pending-1', 'pending invite: grant_id -> grantId');
  assert(p0.role === 'associate', 'pending invite: role passes through');
  assert(p0.createdAt === '2026-10-19T15:04:00Z', 'pending invite: created_at -> createdAt');
  assert(p0.ownerName === 'Olivia Owner', 'pending invite: owner_name -> ownerName');
  assert(p0.ownerPhotoUrl === 'https://cdn.test/owner.jpg', 'pending invite: owner_photo_url');
  assert(p0.escrow.id === 'esc-pending' && p0.escrow.address === '12 Palm Ct', 'pending invite: escrow summary id/address');
  assert(p0.escrow.buyerName === 'Ben Buyer' && p0.escrow.sellerName === null, 'pending invite: party names (null stays null)');
  assert(p0.escrow.closeDate === '2026-11-20' && p0.escrow.status === 'open', 'pending invite: close_date + status');
  assert(pending[1].role === 'tc' && pending[1].escrow.side === 'both', 'pending invite: tc role + both side');
  assert(mapPendingTeamInvites(null).length === 0, 'pending invites: null payload -> []');
  assert(mapPendingTeamInvites([{ nope: true }]).length === 0, 'pending invites: malformed rows are dropped');

  const entries = mapInvitedEscrowEntries(INVITED_JSONB);
  assert(entries.length === 1, 'invited escrows: row maps');
  assert(entries[0].grantId === 'grant-accepted-1' && entries[0].role === 'associate', 'invited escrows: grant id + role');
  assert(entries[0].acceptedAt === '2026-10-18T10:00:00Z', 'invited escrows: accepted_at');
  assert(entries[0].escrowRow.user_id === OWNER, 'invited escrows: raw row keeps user_id (the owner uid)');

  const mapped = fromEscrowRow(INVITED_ESCROW_ROW as Record<string, unknown>);
  assert(mapped.accessRole === 'owner', 'fromEscrowRow: table rows default to owner before decoration');
  const decorated = decorateInvitedEscrow(mapped, entries[0]);
  assert(decorated.accessRole === 'associate', 'decorate: grant role lands on the escrow');
  assert(decorated.ownerName === 'Olivia Owner' && decorated.ownerPhotoUrl === 'https://cdn.test/owner.jpg', 'decorate: owner identity lands');
  assert(deriveAccessRole(decorated) === 'associate', 'deriveAccessRole: invited escrow -> grant role');
  assert(deriveAccessRole(makeEscrow({})) === 'owner', 'deriveAccessRole: missing accessRole -> owner');
  assert(deriveAccessRole(makeEscrow({ accessRole: 'tc' })) === 'tc', 'deriveAccessRole: tc passes through');
  assert(sanitizeGrantRole('bogus') === 'associate', 'sanitizeGrantRole: unknown -> associate');

  const participants = mapEscrowParticipants({
    ok: true,
    owner: { user_id: OWNER, name: 'Olivia Owner', photo_url: 'https://cdn.test/owner.jpg' },
    members: [
      {
        grant_id: 'g1',
        user_id: MEMBER,
        invited_email: 'member@example.com',
        name: 'Mel Member',
        photo_url: null,
        role: 'associate',
        status: 'accepted',
        created_at: '2026-10-18T09:00:00Z',
        accepted_at: '2026-10-18T10:00:00Z',
      },
      {
        grant_id: 'g2',
        user_id: null,
        invited_email: 'tc@example.com',
        name: null,
        photo_url: null,
        role: 'tc',
        status: 'pending',
        created_at: '2026-10-19T09:00:00Z',
        accepted_at: null,
      },
    ],
  });
  assert(participants !== null, 'participants: ok payload maps');
  assert(participants!.owner?.userId === OWNER && participants!.owner?.name === 'Olivia Owner', 'participants: owner user_id/name');
  assert(participants!.members.length === 2, 'participants: both members map');
  assert(participants!.members[0].grantId === 'g1' && participants!.members[0].status === 'accepted', 'participants: member grant + status');
  assert(participants!.members[1].userId === null && participants!.members[1].role === 'tc', 'participants: pending member has no user id yet');
  assert(mapEscrowParticipants({ ok: false, error: 'not_found' }) === null, 'participants: not-ok -> null');
  assert(mapEscrowParticipants(null) === null, 'participants: null payload -> null');

  const activity = mapEscrowActivity([
    {
      id: 'act-1',
      kind: 'step_checked',
      actor_id: MEMBER,
      actor_name: 'Mel Member',
      actor_label: 'Associate',
      detail: { title: 'Home inspection', role: 'buyer', done: true },
      created_at: '2026-10-19T12:00:00Z',
    },
    { id: 'act-2', kind: 'team_joined', actor_id: null, actor_name: null, actor_label: null, detail: {}, created_at: '2026-10-18T10:00:00Z' },
  ]);
  assert(activity.length === 2, 'activity: rows map');
  assert(activity[0].kind === 'step_checked' && activity[0].actorLabel === 'Associate', 'activity: kind + frozen actor label');
  assert((activity[0].detail as { title?: string }).title === 'Home inspection', 'activity: detail jsonb passes through');
  assert(activity[1].actorId === null, 'activity: null actor stays null');
  assert(mapEscrowActivity('junk').length === 0, 'activity: non-array -> []');

  assert(teamResultFromRpc({ ok: true }).ok === true, 'team result: ok true');
  const seat = teamResultFromRpc({ ok: false, error: 'seat_taken' });
  assert(seat.ok === false && seat.error === 'seat_taken', 'team result: error code passes through');
  assert(teamResultFromRpc(null).ok === false, 'team result: null payload -> not ok');

  // Step stamp round-trip through the cloud row mappers.
  const rows = toStepRows('esc-x', 'buyer', [
    makeStep({ id: 'sx', done: true, completedAt: '2026-10-19T00:00:00Z', completedBy: MEMBER, createdBy: OWNER }),
    makeStep({ id: 'sy' }),
  ]);
  assert(rows[0].completed_by === MEMBER && rows[0].created_by === OWNER, 'toStepRows: stamps ship as completed_by/created_by');
  assert(rows[1].completed_by === null && rows[1].created_by === null, 'toStepRows: unstamped step ships null stamps (uncheck clears)');
  const back = fromStepRow({
    id: 'sx', role: 'buyer', position: 0, title: 'T', subtitle: '', done: true, custom: false,
    completed_at: '2026-10-19T00:00:00Z', completed_by: MEMBER, created_by: OWNER,
    explainer: null, template_key: null,
  });
  assert(back.completedBy === MEMBER && back.createdBy === OWNER, 'fromStepRow: stamps map back');
}

// --------------------------------------------------------- tap routes ---

function testTapRoutes(): void {
  assert(teamPushTapRoute('team_invite_received', 'esc-9') === '/', 'tap route: team_invite_received -> home');
  assert(teamPushTapRoute('team_invite_accepted', 'esc-9') === '/escrow/esc-9', 'tap route: team_invite_accepted -> escrow detail');
  assert(teamPushTapRoute('member_step_activity', 'esc-9') === '/activity/esc-9', 'tap route: member_step_activity -> activity timeline');
  assert(teamPushTapRoute('client_joined', 'esc-9') === null, 'tap route: non-team kind -> null (role routing decides)');
  assert(pushTapRoute('esc-9', 'realtor', 'team_invite_received') === '/', 'pushTapRoute: kind wins over role');
  assert(pushTapRoute('esc-9', 'realtor', 'member_step_activity') === '/activity/esc-9', 'pushTapRoute: activity kind routes to timeline');
  assert(pushTapRoute('esc-9', 'realtor') === '/escrow/esc-9', 'pushTapRoute: no kind keeps realtor routing');
  assert(pushTapRoute('esc-9', 'buyer') === '/client/buyer/esc-9', 'pushTapRoute: no kind keeps client routing');
  const resp = {
    notification: {
      request: { content: { data: { escrowId: 'esc-9', role: 'realtor', kind: 'team_invite_accepted' } } },
    },
  };
  const target = escrowRouteFromResponse(resp);
  assert(target !== null && target.kind === 'team_invite_accepted', 'escrowRouteFromResponse: kind extracted');
  assert(target !== null && pushTapRoute(target.escrowId, target.role, target.kind) === '/escrow/esc-9', 'escrowRouteFromResponse + pushTapRoute: accepted invite opens the escrow');
  const plain = escrowRouteFromResponse({
    notification: { request: { content: { data: { escrowId: 'esc-9', role: 'buyer' } } } },
  });
  assert(plain !== null && plain.kind === null, 'escrowRouteFromResponse: non-team payload -> kind null');
}

// ---------------------------------------------------------- base store --

async function testBaseStore(): Promise<void> {
  const kv = memoryKV();
  const base = createStore(kv);
  assert(base.pendingTeamInvites.length === 0, 'base store: pendingTeamInvites starts empty');
  const denied = await base.respondToTeamInvite('g1', true);
  assert(denied.ok === false && denied.error === 'unavailable', 'base store: team actions are unavailable offline');
  assert((await base.getEscrowParticipants('esc-1')) === null, 'base store: participants null offline');
  assert((await base.listEscrowActivity('esc-1')).length === 0, 'base store: activity [] offline');
  const invites = mapPendingTeamInvites(PENDING_INVITES_JSONB);
  await base.setPendingTeamInvites(invites);
  assert(base.pendingTeamInvites.length === 2, 'base store: setPendingTeamInvites updates state');
  const base2 = createStore(kv);
  await base2.getProfile(); // triggers the lazy load
  assert(base2.pendingTeamInvites.length === 2, 'base store: pending invites survive a reload (KV round-trip)');
  await base2.clear();
  assert(base2.pendingTeamInvites.length === 0, 'base store: clear() wipes team invites');

  // Checklist edits preserve actor stamps (Oct 2026): a step checked off
  // by a teammate keeps completedBy/createdBy through a bulk apply.
  const kv2 = memoryKV();
  const base3 = createStore(kv2);
  const stamped = makeEscrow({
    id: 'esc-stamps',
    buyerSteps: [
      makeStep({
        id: 'st-1',
        title: 'Inspection',
        done: true,
        completedAt: '2026-10-10T00:00:00Z',
        completedBy: OWNER,
        createdBy: OWNER,
        custom: true,
      }),
    ],
  });
  await base3.replaceEscrow(stamped);
  const applied = await base3.previewApplyChecklist('esc-stamps', 'buyer', [
    { id: 'st-1', title: 'Inspection', done: true, custom: true },
  ]);
  const kept = applied.result.escrow.buyerSteps[0];
  assert(kept.completedBy === OWNER && kept.createdBy === OWNER, 'applyChecklist: actor stamps preserved across edits');
}

// -------------------------------------------------------- synced store --

async function testRefreshTeam(): Promise<void> {
  const kv = memoryKV();
  const { client, rpcCalls } = makeTeamClient(teamScript());
  const { store } = createSyncedStore(kv, { cloudClient: () => client as never });
  await store.refreshTeam();
  const names = rpcCalls.map((r) => r.name);
  assert(names[0] === 'claim_team_invites', 'refreshTeam: claim runs first');
  assert(names.includes('list_my_team_invites') && names.includes('list_invited_escrows'), 'refreshTeam: both lists pulled');
  assert(store.pendingTeamInvites.length === 2, 'refreshTeam: pending invites land in the store');
  assert(store.pendingTeamInvites[0].escrow.address === '12 Palm Ct', 'refreshTeam: pending invite escrow summary intact');
  const invited = await store.getEscrow('esc-invited');
  assert(invited !== null, 'refreshTeam: invited escrow merged into the escrow list');
  // (The local Escrow model carries no owner uid — the owner identity the
  // intake saves need is pinned via the owner_id assertions below.)
  assert(invited!.accessRole === 'associate', 'refreshTeam: invited escrow carries the grant role');
  assert(invited!.ownerName === 'Olivia Owner' && invited!.ownerPhotoUrl === 'https://cdn.test/owner.jpg', 'refreshTeam: owner identity on the escrow');
  assert(invited!.buyerSteps.length === 2, 'refreshTeam: invited escrow steps pulled by escrow id');
  assert(invited!.buyerSteps[0].completedBy === OWNER, 'refreshTeam: pulled step carries completed_by');
  assert(invited!.buyerSteps[1].createdBy === OWNER, 'refreshTeam: pulled step carries created_by');
  const list = await store.listEscrows();
  assert(list.some((e) => e.id === 'esc-invited'), 'refreshTeam: invited escrow appears in listEscrows');
}

async function testRefreshTeamPrunesEndedGrants(): Promise<void> {
  // Merge addition (Oct 2026): a grant that ends drops the local invited
  // copy on the next successful converge; own escrows are never pruned,
  // and a FAILED list pull prunes nothing.
  const kv = memoryKV();
  const { client } = makeTeamClient({
    claim_team_invites: [{ data: 0 }, { data: 0 }, { data: 0 }],
    list_my_team_invites: [{ data: [] }, { data: [] }, { data: [] }],
    list_invited_escrows: [
      { data: INVITED_JSONB },
      { data: null, error: { message: 'boom' } },
      { data: [] },
    ],
  });
  const { store } = createSyncedStore(kv, { cloudClient: () => client as never });
  await store.replaceEscrow(makeEscrow({ id: 'esc-own', accessRole: 'owner' }));
  await store.refreshTeam();
  assert((await store.getEscrow('esc-invited')) !== null, 'prune: invited escrow merged on first converge');
  await store.refreshTeam(); // list pull fails
  assert((await store.getEscrow('esc-invited')) !== null, 'prune: a failed pull prunes nothing');
  await store.refreshTeam(); // grants now empty
  assert((await store.getEscrow('esc-invited')) === null, 'prune: ended grant drops the local invited copy');
  assert((await store.getEscrow('esc-own')) !== null, 'prune: own escrows are never pruned');
}

async function testRefreshTeamFailureIsSilent(): Promise<void> {  const kv = memoryKV();
  const failing = {
    auth: { getSession: async () => ({ data: { session: { user: { id: MEMBER } } }, error: null }) },
    rpc: async () => ({ data: null, error: { message: 'boom' } }),
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
      upsert: (rows: Record<string, unknown>[]) => ({
        select: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  };
  const { store } = createSyncedStore(kv, { cloudClient: () => failing as never });
  await store.refreshTeam(); // must not throw
  assert(store.pendingTeamInvites.length === 0, 'refreshTeam failure: team state stays empty, no throw');
}

async function testTeamActions(): Promise<void> {
  const kv = memoryKV();
  const { client, rpcCalls } = makeTeamClient(
    teamScript({
      respond_team_invite: [{ data: { ok: true } }, { data: { ok: false, error: 'not_found' } }],
      create_team_invite: [{ data: { ok: false, error: 'seat_taken' } }, { data: { ok: true, grant_id: 'g-new' } }],
      remove_team_member: [{ data: { ok: true } }],
      cancel_team_invite: [{ data: { ok: true } }],
      leave_team_escrow: [{ data: { ok: true } }],
      get_escrow_participants: [
        {
          data: {
            ok: true,
            owner: { user_id: OWNER, name: 'Olivia Owner', photo_url: null },
            members: [],
          },
        },
        { data: { ok: false, error: 'not_found' } },
      ],
      list_escrow_activity: [
        {
          data: [
            {
              id: 'act-1', kind: 'step_checked', actor_id: MEMBER, actor_name: 'Mel Member',
              actor_label: 'Associate', detail: {}, created_at: '2026-10-19T12:00:00Z',
            },
          ],
        },
      ],
    }),
  );
  const { store } = createSyncedStore(kv, { cloudClient: () => client as never });

  const accepted = await store.respondToTeamInvite('grant-pending-1', true);
  assert(accepted.ok === true, 'respondToTeamInvite: ok passes through');
  const respondCall = rpcCalls.find((r) => r.name === 'respond_team_invite');
  assert(
    respondCall?.params?.p_grant_id === 'grant-pending-1' && respondCall?.params?.p_accept === true,
    'respondToTeamInvite: rpc params are p_grant_id + p_accept',
  );
  assert(
    rpcCalls.filter((r) => r.name === 'claim_team_invites').length === 1,
    'respondToTeamInvite: an ok triggers refreshTeam (claim ran)',
  );
  const missing = await store.respondToTeamInvite('grant-gone', false);
  assert(missing.ok === false && missing.error === 'not_found', 'respondToTeamInvite: not_found passes through');

  const seat = await store.createTeamInvite('esc-own', 'pal@example.com', 'associate');
  assert(seat.ok === false && seat.error === 'seat_taken', 'createTeamInvite: seat_taken surfaces');
  const created = await store.createTeamInvite('esc-own', 'pal@example.com', 'tc');
  assert(created.ok === true, 'createTeamInvite: ok passes through');
  const createCall = rpcCalls.filter((r) => r.name === 'create_team_invite')[1];
  assert(
    createCall?.params?.p_escrow_id === 'esc-own' &&
      createCall?.params?.p_email === 'pal@example.com' &&
      createCall?.params?.p_role === 'tc',
    'createTeamInvite: rpc params are p_escrow_id + p_email + p_role',
  );

  assert((await store.removeTeamMember('g1')).ok === true, 'removeTeamMember: ok');
  assert((await store.cancelTeamInvite('g2')).ok === true, 'cancelTeamInvite: ok');
  assert((await store.leaveTeamEscrow('g3')).ok === true, 'leaveTeamEscrow: ok');
  assert(rpcCalls.some((r) => r.name === 'remove_team_member' && r.params?.p_grant_id === 'g1'), 'removeTeamMember: rpc name + param');
  assert(rpcCalls.some((r) => r.name === 'cancel_team_invite' && r.params?.p_grant_id === 'g2'), 'cancelTeamInvite: rpc name + param');
  assert(rpcCalls.some((r) => r.name === 'leave_team_escrow' && r.params?.p_grant_id === 'g3'), 'leaveTeamEscrow: rpc name + param');

  const parts = await store.getEscrowParticipants('esc-invited');
  assert(parts !== null && parts.owner?.userId === OWNER && parts.members.length === 0, 'getEscrowParticipants: mapped result');
  assert((await store.getEscrowParticipants('esc-nope')) === null, 'getEscrowParticipants: not-ok -> null');
  const acts = await store.listEscrowActivity('esc-invited');
  assert(acts.length === 1 && acts[0].kind === 'step_checked', 'listEscrowActivity: mapped rows');
}

async function testStampsAndIntakeOwners(): Promise<void> {
  const kv = memoryKV();
  const { client, upserts } = makeTeamClient(teamScript());
  const { store } = createSyncedStore(kv, { cloudClient: () => client as never });
  await store.refreshTeam(); // learns esc-invited + its owner (OWNER)

  // --- toggle stamps completed_by on the pushed row AND the local copy.
  const own = makeEscrow({});
  await store.replaceEscrow(own);
  const toggled = await store.toggleStep('esc-own', 'buyer', 'own-b1');
  assert(toggled.buyerSteps[0].done === true, 'toggle: step done');
  assert(toggled.buyerSteps[0].completedBy === MEMBER, 'toggle: local step carries completedBy = session uid');
  const stepUpserts = upserts.filter((u) => u.table === 'steps');
  const pushedRow = stepUpserts[stepUpserts.length - 1].rows.find((r) => r.id === 'own-b1');
  assert(pushedRow?.completed_by === MEMBER, 'toggle: pushed row completed_by = session uid');
  assert(typeof pushedRow?.completed_at === 'string', 'toggle: pushed row completed_at set');
  const untoggled = await store.toggleStep('esc-own', 'buyer', 'own-b1');
  assert(untoggled.buyerSteps[0].completedBy === null, 'uncheck: local completedBy cleared');
  const stepUpserts2 = upserts.filter((u) => u.table === 'steps');
  const pushedRow2 = stepUpserts2[stepUpserts2.length - 1].rows.find((r) => r.id === 'own-b1');
  assert(pushedRow2?.completed_by === null, 'uncheck: pushed row completed_by = null');

  // --- custom step stamps created_by.
  const withCustom = await store.addCustomStep('esc-own', 'buyer', 'Order drone photos');
  const custom = withCustom.buyerSteps.find((s) => s.custom);
  assert(custom !== undefined && custom.createdBy === MEMBER, 'addCustomStep: local createdBy = session uid');
  const stepUpserts3 = upserts.filter((u) => u.table === 'steps');
  const pushedCustom = stepUpserts3[stepUpserts3.length - 1].rows.find((r) => r.id === custom!.id);
  assert(pushedCustom?.created_by === MEMBER, 'addCustomStep: pushed row created_by = session uid');

  // --- intake saves on an INVITED escrow: owner_id is the owner, not me.
  await store.saveTcIntake('esc-invited', { emdAmount: '5000' } as never);
  const tcUpsert = upserts.filter((u) => u.table === 'tc_intakes').pop();
  assert(tcUpsert?.rows[0].owner_id === OWNER, 'saveTcIntake (invited): owner_id = escrow owner');
  assert(tcUpsert?.rows[0].updated_by === MEMBER, 'saveTcIntake (invited): updated_by = writer');
  await store.saveBuyerIntake('esc-invited', {} as never);
  const buyerUpsert = upserts.filter((u) => u.table === 'buyer_intakes').pop();
  assert(buyerUpsert?.rows[0].owner_id === OWNER, 'saveBuyerIntake (invited): owner_id = escrow owner');
  assert(buyerUpsert?.rows[0].updated_by === MEMBER, 'saveBuyerIntake (invited): updated_by = writer');

  // --- intake saves on an OWN escrow: owner and writer are the same uid.
  await store.saveTcIntake('esc-own', { emdAmount: '100' } as never);
  const ownTcUpsert = upserts.filter((u) => u.table === 'tc_intakes').pop();
  assert(ownTcUpsert?.rows[0].owner_id === MEMBER, 'saveTcIntake (own): owner_id = session uid');
  assert(ownTcUpsert?.rows[0].updated_by === MEMBER, 'saveTcIntake (own): updated_by = session uid');
}

// ----------------------------------------------------------------- main --

async function main(): Promise<void> {
  testMappers();
  testTapRoutes();
  await testBaseStore();
  await testRefreshTeam();
  await testRefreshTeamPrunesEndedGrants();
  await testRefreshTeamFailureIsSilent();
  await testTeamActions();
  await testStampsAndIntakeOwners();
  summary('team_store');
}

void main();
