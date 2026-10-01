// client_refresh_foreground.test.ts — Sept 2026: the client page showed the
// realtor's STALE profile (name/photo) even after refresh / foreground return,
// while get_client_view already returned the live realtor_profiles row.
//
// Two breaks at the store level:
//   (1) The link gate's foreground revalidation (validateClientLink) downloads
//       a fresh get_client_view payload and DISCARDS it — only {valid} comes
//       back. The rendered cloud-view snapshot stays stale even though fresh
//       data was just fetched.
//   (2) The in-app realtor profile screen reads only the cached snapshot
//       (getLinkedProfile -> ctc:cloudview:<escrowId>) and has no refetch path
//       at all: refresh re-reads the same stale cache forever.
//
// Required behavior: a foreground revalidation must land the fresh profile in
// the snapshot, and the client must be able to refetch the linked profile on
// demand (refreshClientView) — failing open to the cached snapshot offline.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createSyncedStore } from '../src/lib/syncedStore';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const ESCROW_ID = 'esc-1';
const LINK_ID = 'link-1';

const STALE_NAME = 'Jimmy';
const FRESH_NAME = 'anuraj';

interface Backend {
  netUp: boolean;
  rpcCalls: string[];
}

function makeBackend(): Backend {
  return { netUp: true, rpcCalls: [] };
}

function profileRow(name: string): Record<string, unknown> {
  return {
    name,
    photo_url: null,
    banner_image: null,
    about: name === FRESH_NAME ? 'Fresh about text' : 'Old about text',
    years_experience: '',
    email: '',
    areas_served: '',
    phone: '',
    dre_license: '',
    realty_group: '',
    googleReviewLink: '',
    realtorComReviewLink: '',
  };
}

function mockCloud(be: Backend) {
  return {
    rpc: async (name: string, _params: Record<string, unknown>) => {
      be.rpcCalls.push(name);
      if (name !== 'get_client_view') return { data: null, error: new Error('unknown rpc') };
      if (!be.netUp) return { data: null, error: new Error('offline') };
      return {
        error: null,
        data: {
          ok: true,
          escrow: {
            id: ESCROW_ID,
            address: '1 Main St',
            city: 'Valencia',
            open_date: '2026-09-01',
            close_date: '2026-10-15',
          },
          profile: profileRow(FRESH_NAME),
          role: 'buyer',
          buyer_steps: [],
        },
      };
    },
  };
}

function seedStaleSnapshot(kv: ReturnType<typeof memoryKV>): void {
  void kv.setItem(
    'ctc:cloudlinks',
    JSON.stringify({ [ESCROW_ID]: { linkId: LINK_ID, role: 'buyer' } }),
  );
  void kv.setItem(
    `ctc:cloudview:${ESCROW_ID}`,
    JSON.stringify({
      view: { escrowId: ESCROW_ID, role: 'buyer' },
      profile: { name: STALE_NAME },
    }),
  );
}

async function main(): Promise<void> {
  // (1) Foreground revalidation must land the fresh profile, not discard it.
  {
    const be = makeBackend();
    const kv = memoryKV();
    seedStaleSnapshot(kv);
    const { store } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });

    const before = await store.getLinkedProfile(ESCROW_ID);
    assert(before?.name === STALE_NAME, `setup: snapshot starts stale (got ${before?.name})`);

    // What useClientLinkGate does on every foreground return.
    const res = await store.validateClientLink(LINK_ID);
    assert(res.valid === true, 'foreground link revalidation reports valid');
    assert(
      be.rpcCalls.includes('get_client_view'),
      'foreground revalidation calls get_client_view',
    );

    const after = await store.getLinkedProfile(ESCROW_ID);
    assert(
      after?.name === FRESH_NAME,
      `foreground revalidation lands the fresh profile (got ${after?.name})`,
    );
  }

  // (2) The client can refetch the linked profile on demand (what the
  // in-app realtor profile screen uses on focus/foreground).
  {
    const be = makeBackend();
    const kv = memoryKV();
    seedStaleSnapshot(kv);
    const { store } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });

    await store.refreshClientView(ESCROW_ID);
    const p = await store.getLinkedProfile(ESCROW_ID);
    assert(
      p?.name === FRESH_NAME,
      `refreshClientView refetches the linked profile (got ${p?.name})`,
    );
  }

  // (3) Offline: refresh fails open to the cached snapshot, never throws.
  {
    const be = makeBackend();
    be.netUp = false;
    const kv = memoryKV();
    seedStaleSnapshot(kv);
    const { store } = createSyncedStore(kv, { cloudClient: () => mockCloud(be) });

    let threw = false;
    try {
      await store.refreshClientView(ESCROW_ID);
    } catch {
      threw = true;
    }
    assert(!threw, 'refreshClientView never throws offline');
    const p = await store.getLinkedProfile(ESCROW_ID);
    assert(
      p?.name === STALE_NAME,
      `offline keeps serving the cached snapshot (got ${p?.name})`,
    );
  }

  summary('client_refresh_foreground');
}

void main();
