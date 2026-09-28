// mock_server.ts — FAITHFUL in-memory Supabase stand-in for the sync tests.
//
// The production truth this mock encodes (Sept 28, 2026):
//  - client_links rows are created SERVER-SIDE by the redeem_invite RPC.
//    The redeeming device never puts them in its local store; the
//    realtor's device never holds them locally at all (local data.links
//    is written only by the offline redeem fallback).
//  - redeem_invite enforces the one-live-link-per-device unique index:
//    a redeem on a device that already holds a LIVE link for a different
//    escrow fails with the 23505 violation, which the app maps to
//    device_has_link. A revoked link frees the slot.
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
  pushedLinkRevocations: PushedLinkRevocation[];
  /**
   * Test-only failure injection: when true, the client_links live-link
   * select throws, simulating a transient query failure. Lets tests prove
   * the converge op stays queued and retries instead of stranding a zombie.
   */
  failLinkSelect: boolean;
  select(table: string, filters: Filter[]): { data: unknown; error: unknown };
  update(
    table: string,
    patch: Record<string, unknown>,
    filters: Filter[],
  ): { data: unknown; error: unknown };
  upsert(table: string, rows: unknown): { data: unknown; error: unknown };
  rpc(name: string, params?: Record<string, unknown>): { data: unknown; error: unknown };
}

export function createMockServer(): MockServer {
  const invites = new Map<string, ServerInvite>();
  const invitesByCode = new Map<string, string>();
  const links = new Map<string, ServerLink>();
  const pushedLinkRevocations: PushedLinkRevocation[] = [];
  let linkSeq = 0;

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
    // Invites pull, realtor_profiles probe, etc.: nothing seeded server-side.
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
      const liveForDevice = [...links.values()].find(
        (l) => l.deviceId === deviceId && l.revokedAt === null,
      );
      // The one-live-link-per-device unique index: a live link on ANY
      // other escrow blocks this redeem.
      if (liveForDevice) return { data: { ok: false, error: 'device_has_link' }, error: null };
      const id = `srv-link-${++linkSeq}`;
      links.set(id, { id, inviteId: inv.id, deviceId, revokedAt: null });
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
        data: { ok: true, escrow: { close_date: '2026-11-28' }, buyer_steps: [], profile: null },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  const server: MockServer = {
    links,
    invites,
    pushedLinkRevocations,
    failLinkSelect: false,
    select,
    update,
    upsert,
    rpc,
  };
  return server;
}

// PostgREST-style chainable query surface over a MockServer.
class SelectQuery {
  private filters: Filter[] = [];
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
  return () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
    },
    from: (table: string) => ({
      select: (_cols?: string) => new SelectQuery(server, table),
      update: (patch: Record<string, unknown>) => new UpdateQuery(server, table, patch),
      upsert: (rows: unknown, _opts?: unknown) => ({
        select: (_cols?: string) => thenable(server.upsert(table, rows)),
      }),
    }),
    rpc: async (name: string, params?: Record<string, unknown>) => server.rpc(name, params),
  });
}
