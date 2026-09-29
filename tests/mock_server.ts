// mock_server.ts — FAITHFUL in-memory Supabase stand-in for the sync tests.
//
// The production truth this mock encodes (Sept 28, 2026):
//  - client_links rows are created SERVER-SIDE by the redeem_invite RPC.
//    The redeeming device never puts them in its local store; the
//    realtor's device never holds them locally at all (local data.links
//    is written only by the offline redeem fallback).
//  - redeem_invite enforces the (device_id, escrow_id) live unique index
//    (multi-escrow, migration 0022): the same device redeeming the same
//    escrow again returns the EXISTING link (idempotent, no duplicate); a
//    redeem for a different escrow mints a new link. A revoked link frees
//    the (device, escrow) slot.
//  - A revoked invite's code is dead ('revoked').
// Tests that seed local data.links instead of this server pass for the
// wrong reason — they must drive this mock's RPC/query surface instead.

export interface Filter {
  col: string;
  op: 'eq' | 'is';
  val: unknown;
}

interface ServerInvite {
  id: string;
  code: string;
  escrowId: string;
  role: string;
  revokedAt: string | null;
}

interface ServerLink {
  id: string;
  inviteId: string;
  escrowId: string;
  deviceId: string;
  revokedAt: string | null;
}

export interface PushedLinkRevocation {
  linkId: string;
  revokedAt: string;
}

type Resolve = (v: { data: unknown; error: unknown }) => void;
type Reject = (e: unknown) => void;

export interface MockServer {
  links: Map<string, ServerLink>;
  invites: Map<string, ServerInvite>;
  /** Server-side step rows by step id (bulk checklist apply, Sept 28, 2026). */
  steps: Map<string, Record<string, unknown>>;
  pushedLinkRevocations: PushedLinkRevocation[];
  /**
   * Test-only failure injection: when true, the client_links live-link
   * select throws, simulating a transient query failure. Lets tests prove
   * the converge op stays queued and retries instead of stranding a zombie.
   */
  failLinkSelect: boolean;
  /**
   * Test-only failure injection: when true, the steps delete throws,
   * simulating a transient delete failure. Lets tests prove a bulk
   * checklist apply fails loudly, leaves local state unchanged, and
   * converges on retry.
   */
  failStepDelete: boolean;
  /**
   * Test-seeded rows returned by select() for tables the mock does not
   * otherwise model (e.g. 'escrows' for pull-heal tests). The rows are
   * returned verbatim (the test shapes them like real server rows).
   */
  seedRows: Record<string, unknown[]>;
  /** Every upsert call, in order (lets tests assert what the server received). */
  upsertLog: { table: string; rows: unknown }[];
  /**
   * Link-scoped push tokens (multi-escrow, migration 0022): key
   * `${deviceId}|${linkId}` — one row per link for the same Expo token.
   */
  pushTokens: Map<string, { deviceId: string; linkId: string; token: string }>;
  /**
   * Per-escrow realtor profiles returned by get_client_view in this mock,
   * keyed by escrow id. Lets branding-isolation tests prove each escrow's
   * view carries only its own realtor's profile.
   */
  viewProfiles: Record<string, unknown>;
  select(table: string, filters: Filter[]): { data: unknown; error: unknown };
  update(
    table: string,
    patch: Record<string, unknown>,
    filters: Filter[],
  ): { data: unknown; error: unknown };
  remove(table: string, inFilters: { col: string; vals: unknown[] }[]): { data: unknown; error: unknown };
  upsert(table: string, rows: unknown): { data: unknown; error: unknown };
  rpc(name: string, params?: Record<string, unknown>): { data: unknown; error: unknown };
}

export function createMockServer(): MockServer {
  const invites = new Map<string, ServerInvite>();
  const invitesByCode = new Map<string, string>();
  const links = new Map<string, ServerLink>();
  const steps = new Map<string, Record<string, unknown>>();
  const pushedLinkRevocations: PushedLinkRevocation[] = [];
  let linkSeq = 0;
  let regenSeq = 0;
  const upsertLog: { table: string; rows: unknown }[] = [];

  function select(table: string, filters: Filter[]): { data: unknown; error: unknown } {
    if (table === 'client_links') {
      if (server.failLinkSelect) throw new Error('injected client_links select failure');
      let rows = [...links.values()];
      for (const f of filters) {
        if (f.op === 'eq' && f.col === 'invite_id') rows = rows.filter((r) => r.inviteId === f.val);
        if (f.op === 'is' && f.col === 'revoked_at' && f.val === null)
          rows = rows.filter((r) => r.revokedAt === null);
      }
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    // Invites pull, realtor_profiles probe, etc.: nothing seeded server-side
    // unless the test put rows in seedRows.
    const seeded = server.seedRows[table];
    if (seeded) return { data: seeded.map((r) => ({ ...(r as Record<string, unknown>) })), error: null };
    return { data: [], error: null };
  }

  function update(
    table: string,
    patch: Record<string, unknown>,
    filters: Filter[],
  ): { data: unknown; error: unknown } {
    if (table === 'client_links') {
      const idEq = filters.find((f) => f.op === 'eq' && f.col === 'id');
      const link = idEq ? links.get(String(idEq.val)) : undefined;
      if (link && patch.revoked_at != null) {
        link.revokedAt = String(patch.revoked_at);
        pushedLinkRevocations.push({ linkId: link.id, revokedAt: link.revokedAt });
      }
      return { data: link ? [{ id: link.id }] : [], error: null };
    }
    if (table === 'invites') {
      const idEq = filters.find((f) => f.op === 'eq' && f.col === 'id');
      const inv = idEq ? invites.get(String(idEq.val)) : undefined;
      if (inv && patch.revoked_at != null) inv.revokedAt = String(patch.revoked_at);
      return { data: inv ? [{ id: inv.id }] : [], error: null };
    }
    return { data: [], error: null };
  }

  function upsert(table: string, rows: unknown): { data: unknown; error: unknown } {
    const arr = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
    upsertLog.push({ table, rows });
    if (table === 'steps') {
      for (const r of arr) steps.set(String(r.id), { ...r });
    }
    if (table === 'invites') {
      for (const r of arr) {
        const id = String(r.id);
        invites.set(id, {
          id,
          code: String(r.code),
          escrowId: String(r.escrow_id),
          role: String(r.role),
          revokedAt: r.revoked_at ? String(r.revoked_at) : null,
        });
        invitesByCode.set(String(r.code), id);
      }
    }
    return { data: arr.map((r) => ({ id: String(r.id ?? '') })), error: null };
  }

  function rpc(name: string, params?: Record<string, unknown>): { data: unknown; error: unknown } {
    if (name === 'redeem_invite') {
      const code = String(params?.p_code ?? '').toUpperCase();
      const deviceId = String(params?.p_device_id ?? '');
      const inviteId = invitesByCode.get(code);
      const inv = inviteId ? invites.get(inviteId) : undefined;
      if (!inv) return { data: { ok: false, error: 'invalid' }, error: null };
      if (inv.revokedAt) return { data: { ok: false, error: 'revoked' }, error: null };
      // Multi-escrow idempotency (migration 0022): the same device
      // redeeming the same escrow again returns the EXISTING live link —
      // no duplicate row.
      const existingForEscrow = [...links.values()].find(
        (l) => l.deviceId === deviceId && l.escrowId === inv.escrowId && l.revokedAt === null,
      );
      if (existingForEscrow) {
        return {
          data: {
            ok: true,
            escrow_id: inv.escrowId,
            role: inv.role,
            party_name: String(params?.p_name ?? ''),
            link_id: existingForEscrow.id,
          },
          error: null,
        };
      }
      const id = `srv-link-${++linkSeq}`;
      links.set(id, { id, inviteId: inv.id, escrowId: inv.escrowId, deviceId, revokedAt: null });
      return {
        data: {
          ok: true,
          escrow_id: inv.escrowId,
          role: inv.role,
          party_name: String(params?.p_name ?? ''),
          link_id: id,
        },
        error: null,
      };
    }
    if (name === 'get_client_view') {
      const link = links.get(String(params?.p_link_id ?? ''));
      if (!link || link.revokedAt) return { data: { ok: false, error: 'revoked' }, error: null };
      return {
        data: {
          ok: true,
          escrow: {
            id: link.escrowId,
            address: `mock-${link.escrowId}`,
            city: 'Santa Clarita',
            close_date: '2026-11-28',
          },
          buyer_steps: [],
          // Per-escrow realtor branding (multi-escrow, Sept 28, 2026):
          // tests seed server.viewProfiles[escrowId] to prove each escrow's
          // view carries only its own realtor's profile.
          profile: server.viewProfiles[link.escrowId] ?? null,
        },
        error: null,
      };
    }
    if (name === 'register_push_token') {
      // Migration 0022: upsert on (device_id, link_id) — one row per link.
      const deviceId = String(params?.p_device_id ?? '');
      const linkId = String(params?.p_link_id ?? '');
      const token = String(params?.p_token ?? '');
      server.pushTokens.set(`${deviceId}|${linkId}`, { deviceId, linkId, token });
      return { data: { ok: true }, error: null };
    }
    if (name === 'unregister_push_token_for_link') {
      const linkId = String(params?.p_link_id ?? '');
      for (const key of [...server.pushTokens.keys()]) {
        if (key.endsWith(`|${linkId}`)) server.pushTokens.delete(key);
      }
      return { data: { ok: true }, error: null };
    }
    if (name === 'unregister_push_token') {
      const deviceId = String(params?.p_device_id ?? '');
      for (const key of [...server.pushTokens.keys()]) {
        if (key.startsWith(`${deviceId}|`)) server.pushTokens.delete(key);
      }
      return { data: { ok: true }, error: null };
    }
    if (name === 'regenerate_invite') {
      const inviteId = String(params?.p_invite_id ?? '');
      const inv = invites.get(inviteId);
      if (!inv || inv.revokedAt)
        return { data: { ok: false, error: 'invite not found or already revoked' }, error: null };
      // Atomic, like the real RPC: old code killed + old device links
      // killed + fresh code issued in one transaction.
      const now = new Date().toISOString();
      inv.revokedAt = now;
      for (const l of links.values()) {
        if (l.inviteId === inviteId && l.revokedAt === null) {
          l.revokedAt = now;
          pushedLinkRevocations.push({ linkId: l.id, revokedAt: now });
        }
      }
      const newId = `inv-regen-${++regenSeq}`;
      const newCode = `RG${String(regenSeq).padStart(4, '0')}`;
      invites.set(newId, {
        id: newId,
        code: newCode,
        escrowId: inv.escrowId,
        role: inv.role,
        revokedAt: null,
      });
      invitesByCode.set(newCode, newId);
      return {
        data: { ok: true, new_code: newCode, old_code: inv.code, new_invite_id: newId },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  function remove(
    table: string,
    inFilters: { col: string; vals: unknown[] }[],
  ): { data: unknown; error: unknown } {
    if (table === 'steps') {
      if (server.failStepDelete) throw new Error('injected steps delete failure');
      const idIn = inFilters.find((f) => f.col === 'id');
      const ids = new Set((idIn?.vals ?? []).map(String));
      const deleted: { id: string }[] = [];
      for (const id of ids) {
        if (steps.delete(id)) deleted.push({ id });
      }
      return { data: deleted, error: null };
    }
    return { data: [], error: null };
  }

  const server: MockServer = {
    links,
    invites,
    steps,
    pushedLinkRevocations,
    failLinkSelect: false,
    failStepDelete: false,
    seedRows: {},
    upsertLog,
    pushTokens: new Map<string, { deviceId: string; linkId: string; token: string }>(),
    viewProfiles: {},
    select,
    update,
    remove,
    upsert,
    rpc,
  };
  return server;
}

// PostgREST-style chainable query surface over a MockServer.
class SelectQuery {
  private filters: Filter[] = [];
  private inFilters: { col: string; vals: unknown[] }[] = [];
  constructor(
    private server: MockServer,
    private table: string,
  ) {}
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push({ col, op: 'is', val });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.inFilters.push({ col, vals });
    return this;
  }
  limit(_n: number): this {
    return this;
  }
  then(resolve: Resolve, reject?: Reject): void {
    try {
      resolve(this.server.select(this.table, this.filters));
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
}

class UpdateQuery {
  private filters: Filter[] = [];
  constructor(
    private server: MockServer,
    private table: string,
    private patch: Record<string, unknown>,
  ) {}
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  select(_cols?: string): this {
    return this;
  }
  then(resolve: Resolve, reject?: Reject): void {
    try {
      resolve(this.server.update(this.table, this.patch, this.filters));
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
}

class DeleteQuery {
  private inFilters: { col: string; vals: unknown[] }[] = [];
  constructor(
    private server: MockServer,
    private table: string,
  ) {}
  in(col: string, vals: unknown[]): this {
    this.inFilters.push({ col, vals });
    return this;
  }
  select(_cols?: string): this {
    return this;
  }
  then(resolve: Resolve, reject?: Reject): void {
    try {
      resolve(this.server.remove(this.table, this.inFilters));
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
}

const thenable = (result: { data: unknown; error: unknown }) => ({
  then: (resolve: Resolve, reject?: Reject) => {
    try {
      resolve(result);
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  },
});

/** A mock supabase client backed by a MockServer. Pass the same server to
 *  every store under test so they share one "database". */
export function mockCloudFromServer(server: MockServer): any {
  const storageFiles = new Map<string, Uint8Array | string>();
  return () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (p: string, body: unknown, _opts?: unknown) => {
          storageFiles.set(`${bucket}/${p}`, body as Uint8Array);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) storageFiles.delete(`${bucket}/${p}`);
          return { error: null };
        },
        getPublicUrl: (p: string) => ({
          data: { publicUrl: `https://cdn.test/${bucket}/${p}` },
        }),
      }),
    },
    from: (table: string) => ({
      select: (_cols?: string) => new SelectQuery(server, table),
      update: (patch: Record<string, unknown>) => new UpdateQuery(server, table, patch),
      delete: () => new DeleteQuery(server, table),
      upsert: (rows: unknown, _opts?: unknown) => ({
        select: (_cols?: string) => thenable(server.upsert(table, rows)),
      }),
    }),
    rpc: async (name: string, params?: Record<string, unknown>) => server.rpc(name, params),
    __storageFiles: storageFiles,
  });
}
