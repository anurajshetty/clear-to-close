// securestore_migration.test.ts — M6a regression suite: auth tokens live in
// expo-secure-store (OS keychain/keystore) on native, with a one-time,
// idempotent migration from the previous AsyncStorage location.
//
// Cases:
//  - adapter round-trip (set/get/remove) against a mocked SecureStore
//  - migration (a): old has data + new empty -> copies, confirms, removes old
//  - migration (b): already migrated -> no-op, legacy untouched
//  - migration (c): write failure -> old copy NEVER deleted, flag not set
//  - migration: new already authoritative -> stale legacy copy dropped,
//    secure value NOT overwritten
//  - migration: nothing in legacy -> flag set, no copy
//  - storage key derivation matches the supabase-js default key formula
//  - wiring: getSupabaseClient('native') hands supabase a SecureStore-backed
//    adapter (mocked module) and the migration runs on first use
//  - wiring: without the SecureStore module the adapter falls back to the
//    previous AsyncStorage behavior (old binary / node test env)
import { assert, summary } from './assert';
import {
  AUTH_STORAGE_MIGRATION_FLAG_KEY,
  createMigratingAuthStorage,
  migrateAuthStorageToSecureStore,
  supabaseAuthStorageKey,
  type SecureStoreLike,
} from '../src/lib/supabase';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: any;

const STORAGE_KEY = 'sb-svmqlhhqsgubxcwutanf-auth-token';

// ------------------------------------------------------------------ mocks --

interface MockSecure extends SecureStoreLike {
  store: Map<string, string>;
  failOnSet: boolean;
  readBackMismatch: boolean;
  poisoned: boolean;
  calls: string[];
}

function mockSecure(): MockSecure {
  const m: MockSecure = {
    store: new Map<string, string>(),
    failOnSet: false,
    readBackMismatch: false,
    poisoned: false,
    calls: [],
    async getItemAsync(k: string): Promise<string | null> {
      m.calls.push('get:' + k);
      // Simulates a write that didn't stick: reads before any write behave
      // normally; the read-back after setItemAsync returns garbage.
      if (m.readBackMismatch && m.poisoned && k === STORAGE_KEY) return 'corrupted-read-back';
      return m.store.has(k) ? m.store.get(k)! : null;
    },
    async setItemAsync(k: string, v: string): Promise<void> {
      m.calls.push('set:' + k);
      if (m.failOnSet) throw new Error('SecureStore unavailable');
      if (m.readBackMismatch) m.poisoned = true;
      m.store.set(k, v);
    },
    async deleteItemAsync(k: string): Promise<void> {
      m.calls.push('del:' + k);
      m.store.delete(k);
    },
  };
  return m;
}

interface MockLegacy {
  store: Map<string, string>;
  removed: string[];
  getCalls: number;
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}

function mockLegacy(initial?: Record<string, string>): MockLegacy {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const m: MockLegacy = {
    store,
    removed: [],
    getCalls: 0,
    async getItem(k: string): Promise<string | null> {
      m.getCalls++;
      return store.has(k) ? store.get(k)! : null;
    },
    async setItem(k: string, v: string): Promise<void> {
      store.set(k, v);
    },
    async removeItem(k: string): Promise<void> {
      m.removed.push(k);
      store.delete(k);
    },
  };
  return m;
}

// ------------------------------------------------------------------ tests --

async function storageKeyTests(): Promise<void> {
  assert(
    supabaseAuthStorageKey('https://svmqlhhqsgubxcwutanf.supabase.co') ===
      'sb-svmqlhhqsgubxcwutanf-auth-token',
    'storage key derives exactly like the supabase-js default (sb-<ref>-auth-token)',
  );
  assert(
    supabaseAuthStorageKey('not a url') === 'sb-auth-token',
    'storage key derivation never throws on a malformed URL',
  );
}

async function adapterRoundTripTests(): Promise<void> {
  const secure = mockSecure();
  const legacy = mockLegacy();
  const adapter = createMigratingAuthStorage(secure, legacy, STORAGE_KEY);

  await adapter.setItem(STORAGE_KEY, 'session-json');
  assert(secure.store.get(STORAGE_KEY) === 'session-json', 'adapter setItem writes to SecureStore');
  assert(
    (await adapter.getItem(STORAGE_KEY)) === 'session-json',
    'adapter getItem reads back from SecureStore',
  );
  await adapter.removeItem(STORAGE_KEY);
  assert(!secure.store.has(STORAGE_KEY), 'adapter removeItem clears SecureStore');
  assert((await adapter.getItem(STORAGE_KEY)) === null, 'adapter getItem returns null after remove');

  // The one-time migration ran ahead of the first op and set the flag.
  assert(
    secure.store.get(AUTH_STORAGE_MIGRATION_FLAG_KEY) === '1',
    'migration flag persisted in SecureStore after first use',
  );
}

async function migrationCopiesTests(): Promise<void> {
  // (a) old has data, new empty -> copy, confirm, remove old
  {
    const secure = mockSecure();
    const legacy = mockLegacy({ [STORAGE_KEY]: 'old-session' });
    const outcome = await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    assert(outcome === 'migrated', 'migration outcome is "migrated" when old has data');
    assert(secure.store.get(STORAGE_KEY) === 'old-session', 'old token copied into SecureStore');
    assert(!legacy.store.has(STORAGE_KEY), 'legacy copy removed only after confirmed write');
    assert(legacy.removed.includes(STORAGE_KEY), 'legacy removeItem was called for the key');
    assert(
      secure.store.get(AUTH_STORAGE_MIGRATION_FLAG_KEY) === '1',
      'migration flag set after successful migration',
    );
  }
  // (b) already migrated -> no-op
  {
    const secure = mockSecure();
    secure.store.set(AUTH_STORAGE_MIGRATION_FLAG_KEY, '1');
    secure.store.set(STORAGE_KEY, 'new-session');
    const legacy = mockLegacy({ [STORAGE_KEY]: 'stale-session' });
    const legacyGetCallsBefore = legacy.getCalls;
    const outcome = await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    assert(outcome === 'already-migrated', 'second run is a no-op ("already-migrated")');
    assert(legacy.getCalls === legacyGetCallsBefore, 'no-op run never reads the legacy store');
    assert(secure.store.get(STORAGE_KEY) === 'new-session', 'no-op run never touches SecureStore data');
    assert(legacy.store.has(STORAGE_KEY), 'no-op run leaves the legacy store alone');
  }
  // Repeat through the adapter: migration runs exactly once.
  {
    const secure = mockSecure();
    const legacy = mockLegacy({ [STORAGE_KEY]: 'old-session' });
    const adapter = createMigratingAuthStorage(secure, legacy, STORAGE_KEY);
    await adapter.getItem('unrelated-key');
    await adapter.getItem('unrelated-key');
    const migrationSets = secure.calls.filter((c) => c === 'set:' + AUTH_STORAGE_MIGRATION_FLAG_KEY);
    assert(migrationSets.length === 1, 'adapter triggers the migration exactly once across calls');
  }
}

async function migrationWriteFailureTests(): Promise<void> {
  // (c) SecureStore write throws -> legacy copy MUST survive, flag unset.
  {
    const secure = mockSecure();
    secure.failOnSet = true;
    const legacy = mockLegacy({ [STORAGE_KEY]: 'old-session' });
    let threw = false;
    try {
      await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    } catch {
      threw = true;
    }
    assert(threw, 'migration propagates the SecureStore write failure');
    assert(
      legacy.store.get(STORAGE_KEY) === 'old-session',
      'CRITICAL: legacy copy untouched when the SecureStore write fails',
    );
    assert(legacy.removed.length === 0, 'legacy removeItem never called on write failure');
    assert(
      !secure.store.has(AUTH_STORAGE_MIGRATION_FLAG_KEY),
      'migration flag NOT set when the write fails (retries next launch)',
    );
  }
  // Write "succeeds" but read-back differs -> same guarantee.
  {
    const secure = mockSecure();
    secure.readBackMismatch = true;
    const legacy = mockLegacy({ [STORAGE_KEY]: 'old-session' });
    const outcome = await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    assert(outcome === 'write-unconfirmed', 'unconfirmed write reports "write-unconfirmed"');
    assert(
      legacy.store.get(STORAGE_KEY) === 'old-session',
      'CRITICAL: legacy copy untouched when the SecureStore write is unconfirmed',
    );
    assert(
      !secure.store.has(AUTH_STORAGE_MIGRATION_FLAG_KEY),
      'migration flag NOT set when the write is unconfirmed',
    );
  }
  // Adapter-level: setItem whose write can't be confirmed throws loudly.
  {
    const secure = mockSecure();
    secure.readBackMismatch = true;
    const legacy = mockLegacy();
    const adapter = createMigratingAuthStorage(secure, legacy, STORAGE_KEY);
    let threw = false;
    try {
      await adapter.setItem(STORAGE_KEY, 'v');
    } catch {
      threw = true;
    }
    assert(threw, 'adapter setItem throws loudly when the SecureStore write is unconfirmed');
  }
}

async function migrationPrecedenceTests(): Promise<void> {
  // SecureStore already authoritative -> stale legacy copy dropped, secure kept.
  {
    const secure = mockSecure();
    secure.store.set(STORAGE_KEY, 'new-session');
    const legacy = mockLegacy({ [STORAGE_KEY]: 'stale-session' });
    const outcome = await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    assert(outcome === 'migrated', 'secure-authoritative run still reports "migrated"');
    assert(
      secure.store.get(STORAGE_KEY) === 'new-session',
      'existing SecureStore value is never overwritten by stale legacy data',
    );
    assert(!legacy.store.has(STORAGE_KEY), 'stale legacy copy dropped');
  }
  // Nothing in legacy -> flag set, no copy.
  {
    const secure = mockSecure();
    const legacy = mockLegacy();
    const outcome = await migrateAuthStorageToSecureStore(secure, legacy, STORAGE_KEY);
    assert(outcome === 'nothing-to-migrate', 'empty legacy reports "nothing-to-migrate"');
    assert(
      secure.store.get(AUTH_STORAGE_MIGRATION_FLAG_KEY) === '1',
      'flag set even when there was nothing to copy',
    );
  }
}

async function wiringTests(): Promise<void> {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://svmqlhhqsgubxcwutanf.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'fake-key';

  const supabasePath: string = require.resolve('../src/lib/supabase.js');

  // Stub @supabase/supabase-js to capture the storage adapter per kind.
  let supabaseSpec: string | null = null;
  try {
    supabaseSpec = require.resolve('@supabase/supabase-js');
  } catch {
    supabaseSpec = null;
  }
  if (!supabaseSpec) {
    console.log('ok   - (supabase-js not resolvable: wiring tests skipped)');
    return;
  }
  const captured: { storage: any }[] = [];
  require.cache[supabaseSpec] = {
    exports: {
      createClient: (_url: string, _key: string, opts: any) => {
        captured.push({ storage: opts.auth.storage });
        return { __stubClient: true };
      },
    },
  };

  // Case 1: SecureStore module present (mocked) -> native adapter is
  // SecureStore-backed and migrates the legacy token on first use.
  let secureSpec: string | null = null;
  try {
    secureSpec = require.resolve('expo-secure-store');
  } catch {
    secureSpec = null;
  }
  assert(!!secureSpec, 'expo-secure-store resolves (dependency installed)');
  if (!secureSpec) {
    console.log('ok   - (expo-secure-store not resolvable: wiring tests skipped)');
    delete require.cache[supabaseSpec];
    return;
  }
  const secureBacking = new Map<string, string>();
  const legacyBacking = new Map<string, string>([[STORAGE_KEY, 'legacy-session']]);
  require.cache[secureSpec!] = {
    exports: {
      getItemAsync: async (k: string) => (secureBacking.has(k) ? secureBacking.get(k)! : null),
      setItemAsync: async (k: string, v: string) => { secureBacking.set(k, v); },
      deleteItemAsync: async (k: string) => { secureBacking.delete(k); },
    },
  };
  let asyncSpec: string | null = null;
  try {
    asyncSpec = require.resolve('@react-native-async-storage/async-storage');
  } catch {
    asyncSpec = null;
  }
  if (asyncSpec) {
    require.cache[asyncSpec] = {
      exports: {
        default: {
          getItem: async (k: string) => (legacyBacking.has(k) ? legacyBacking.get(k)! : null),
          setItem: async (k: string, v: string) => { legacyBacking.set(k, v); },
          removeItem: async (k: string) => { legacyBacking.delete(k); },
        },
      },
    };
  }

  delete require.cache[supabasePath];
  const wired = require(supabasePath);
  wired.getSupabaseClient('native');
  assert(captured.length === 1, 'native client created through createClient');
  const nativeStorage = captured[0].storage;
  await nativeStorage.setItem('probe', '1');
  assert(secureBacking.get('probe') === '1', 'wired native adapter writes go to SecureStore');
  assert(
    secureBacking.get(STORAGE_KEY) === 'legacy-session',
    'wired native adapter migrated the legacy token into SecureStore on first use',
  );
  assert(!legacyBacking.has(STORAGE_KEY), 'wired migration removed the legacy copy after confirm');
  assert(
    secureBacking.get(AUTH_STORAGE_MIGRATION_FLAG_KEY) === '1',
    'wired migration set the done flag',
  );

  // Case 2: SecureStore module missing -> falls back to previous behavior.
  delete require.cache[secureSpec!];
  delete require.cache[supabasePath];
  const fallbackMod = require(supabasePath);
  captured.length = 0;
  fallbackMod.getSupabaseClient('native');
  const fallbackStorage = captured[0].storage;
  await fallbackStorage.setItem('probe2', '2');
  assert(legacyBacking.get('probe2') === '2', 'without SecureStore the adapter keeps AsyncStorage behavior');
  assert(
    !secureBacking.has('probe2'),
    'without SecureStore nothing is written to the SecureStore backing',
  );

  delete require.cache[supabaseSpec];
  delete require.cache[secureSpec!];
  if (asyncSpec) delete require.cache[asyncSpec];
  delete require.cache[supabasePath];
}

async function main(): Promise<void> {
  await storageKeyTests();
  await adapterRoundTripTests();
  await migrationCopiesTests();
  await migrationWriteFailureTests();
  await migrationPrecedenceTests();
  await wiringTests();
  summary('securestore_migration');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
