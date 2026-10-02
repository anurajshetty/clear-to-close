// Clear to Close — Supabase backend connection.
//
// The client is created lazily and only when both env vars are present.
// @supabase/supabase-js is require()d inside the function body (guarded by
// try/catch), so this module can be imported in a Node test environment
// where the package may not be installed yet.
//
// Auth session storage is platform-differentiated (Anuraj, Sept 26, 2026 —
// this REVERSES the Sept 25 "web = sign-in screen on every return"
// decision):
//   - native iOS/Android: the session persists in the OS keychain/keystore
//     via expo-secure-store (M6a, Oct 2026) — returning realtors go straight
//     into the app, no re-sign-in. First run after the upgrade migrates the
//     token from the old AsyncStorage location exactly once
//     (migrateAuthStorageToSecureStore).
//   - web: the session persists in localStorage — a refresh keeps the
//     realtor signed in, on the same screen. The session ends ONLY on Log
//     out, or when the browser session ends (in incognito, closing the
//     incognito window wipes localStorage automatically, so that keeps
//     working).
//
// NOTE (M6a): expo-secure-store is a native module. If this JS ever runs on
// a native binary built before the module was added (or SecureStore can't
// be loaded), the native adapter falls back to the previous AsyncStorage
// behavior so auth keeps working — tokens just aren't keychain-backed
// until the binary is rebuilt.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

declare const process: { env: Record<string, string | undefined> };

export type AuthStorageKind = 'native' | 'web';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cached: Record<string, any> = {};

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

interface AuthStorage {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}

/**
 * Web auth storage: the Supabase session lives in localStorage, so it
 * survives page refreshes. In incognito, closing the incognito window wipes
 * localStorage, so the session still ends with the browser session there.
 * localStorage is read lazily: this module also loads in Node test runs
 * where it is undefined.
 */
function webAuthStorage(): AuthStorage {
  const ls = (): Storage | null =>
    typeof localStorage !== 'undefined' ? localStorage : null;
  return {
    async getItem(k: string): Promise<string | null> {
      try {
        return ls()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    async setItem(k: string, v: string): Promise<void> {
      try {
        ls()?.setItem(k, v);
      } catch {
        // Quota/full: the session just won't survive the refresh.
      }
    },
    async removeItem(k: string): Promise<void> {
      try {
        ls()?.removeItem(k);
      } catch {
        // ignore
      }
    },
  };
}

/** In-memory fallback for native when AsyncStorage can't be loaded. */
function memoryAuthStorage(): AuthStorage {
  const map = new Map<string, string>();
  return {
    async getItem(k: string): Promise<string | null> {
      return map.has(k) ? map.get(k)! : null;
    },
    async setItem(k: string, v: string): Promise<void> {
      map.set(k, v);
    },
    async removeItem(k: string): Promise<void> {
      map.delete(k);
    },
  };
}

function asyncAuthStorage(): AuthStorage {
  try {
    // Lazy require: the native module is unavailable in node test runs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-async-storage/async-storage');
    const AS = mod && mod.default ? mod.default : mod;
    if (AS && typeof AS.getItem === 'function') {
      return {
        getItem: (k: string) => AS.getItem(k),
        setItem: (k: string, v: string) => AS.setItem(k, v),
        removeItem: (k: string) => AS.removeItem(k),
      };
    }
  } catch {
    // fall through to in-memory
  }
  return memoryAuthStorage();
}

// ---------------------------------------------------------------------------
// M6a: SecureStore-backed auth token storage (native only).
// ---------------------------------------------------------------------------

/** Minimal surface of expo-secure-store we rely on (injectable for tests). */
export interface SecureStoreLike {
  getItemAsync(k: string): Promise<string | null>;
  setItemAsync(k: string, v: string): Promise<void>;
  deleteItemAsync(k: string): Promise<void>;
}

/** Migration flag, kept inside SecureStore itself. */
export const AUTH_STORAGE_MIGRATION_FLAG_KEY = 'ctc:auth-storage:migrated-to-securestore:v1';
const AUTH_STORAGE_MIGRATION_FLAG_VALUE = '1';

export type AuthStorageMigrationOutcome =
  | 'migrated'
  | 'already-migrated'
  | 'nothing-to-migrate'
  | 'write-unconfirmed';

/**
 * Derives the Supabase auth storage key exactly the way @supabase/supabase-js
 * does when no custom storageKey is passed:
 *   `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
 * This is the key the pre-M6a AsyncStorage adapter stored the session under.
 */
export function supabaseAuthStorageKey(url: string): string {
  try {
    const ref = new URL(url).hostname.split('.')[0];
    if (ref) return `sb-${ref}-auth-token`;
  } catch {
    // fall through to the fallback below
  }
  return 'sb-auth-token';
}

function isWebPlatform(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Platform } = require('react-native');
    return !!Platform && Platform.OS === 'web';
  } catch {
    return false;
  }
}

/** Lazy-loads expo-secure-store; null when the module can't be loaded. */
function loadSecureStore(): SecureStoreLike | null {
  try {
    // Lazy require: the native module is unavailable in node test runs and
    // on native binaries built before expo-secure-store was added.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-secure-store');
    const SS = mod && mod.default ? mod.default : mod;
    if (
      SS &&
      typeof SS.getItemAsync === 'function' &&
      typeof SS.setItemAsync === 'function' &&
      typeof SS.deleteItemAsync === 'function'
    ) {
      return {
        getItemAsync: (k: string) => SS.getItemAsync(k),
        setItemAsync: (k: string, v: string) => SS.setItemAsync(k, v),
        deleteItemAsync: (k: string) => SS.deleteItemAsync(k),
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * One-time migration of the auth session token from the legacy AsyncStorage
 * location into SecureStore.
 *
 * - Idempotent: a flag persisted in SecureStore makes repeat runs a no-op.
 * - Safe: the legacy copy is removed ONLY after the SecureStore write is
 *   confirmed by a read-back. If confirmation fails, the old copy is left
 *   untouched and the flag is not set, so the next launch retries.
 * - If SecureStore already holds a value for the key, it is authoritative
 *   and only the stale legacy copy is dropped.
 */
export async function migrateAuthStorageToSecureStore(
  secure: SecureStoreLike,
  legacy: AuthStorage,
  storageKey: string,
): Promise<AuthStorageMigrationOutcome> {
  if ((await secure.getItemAsync(AUTH_STORAGE_MIGRATION_FLAG_KEY)) === AUTH_STORAGE_MIGRATION_FLAG_VALUE) {
    return 'already-migrated';
  }
  const oldValue = await legacy.getItem(storageKey);
  const newValue = await secure.getItemAsync(storageKey);
  if (oldValue === null || oldValue === undefined) {
    await secure.setItemAsync(AUTH_STORAGE_MIGRATION_FLAG_KEY, AUTH_STORAGE_MIGRATION_FLAG_VALUE);
    return 'nothing-to-migrate';
  }
  if (newValue === null || newValue === undefined) {
    await secure.setItemAsync(storageKey, oldValue);
    const confirmed = await secure.getItemAsync(storageKey);
    if (confirmed !== oldValue) {
      // New copy not confirmed: never touch the old copy; retry next launch.
      return 'write-unconfirmed';
    }
    await legacy.removeItem(storageKey);
  } else {
    // SecureStore already authoritative: drop the stale legacy copy.
    await legacy.removeItem(storageKey);
  }
  await secure.setItemAsync(AUTH_STORAGE_MIGRATION_FLAG_KEY, AUTH_STORAGE_MIGRATION_FLAG_VALUE);
  return 'migrated';
}

/**
 * AuthStorage adapter that keeps the session token in SecureStore on native.
 * The one-time migration runs (deduplicated) ahead of the first storage
 * operation; migration is best-effort and never breaks auth startup.
 */
export function createMigratingAuthStorage(
  secure: SecureStoreLike,
  legacy: AuthStorage,
  storageKey: string,
): AuthStorage {
  let migrationPromise: Promise<void> | null = null;
  const ensureMigrated = (): Promise<void> => {
    if (!migrationPromise) {
      migrationPromise = migrateAuthStorageToSecureStore(secure, legacy, storageKey).then(
        () => undefined,
        () => undefined, // best-effort: never break auth startup; retries next launch
      );
    }
    return migrationPromise;
  };
  return {
    async getItem(k: string): Promise<string | null> {
      await ensureMigrated();
      return secure.getItemAsync(k);
    },
    async setItem(k: string, v: string): Promise<void> {
      await ensureMigrated();
      await secure.setItemAsync(k, v);
      const confirmed = await secure.getItemAsync(k);
      if (confirmed !== v) {
        throw new Error(`SecureStore write for auth storage key "${k}" could not be confirmed`);
      }
      // The token now lives in SecureStore only: drop any stale legacy copy.
      try {
        await legacy.removeItem(k);
      } catch {
        // best-effort cleanup; the SecureStore copy is already confirmed
      }
    },
    async removeItem(k: string): Promise<void> {
      await ensureMigrated();
      await secure.deleteItemAsync(k);
      try {
        await legacy.removeItem(k);
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/**
 * Native auth storage: SecureStore (OS keychain/keystore) with a one-time
 * migration from the previous AsyncStorage location.
 *
 * - web (Platform.OS === 'web'): SecureStore is unavailable — keep the
 *   existing AsyncStorage-backed behavior.
 * - expo-secure-store not loadable (node test runs, or a native binary that
 *   predates the module): keep the previous AsyncStorage behavior so auth
 *   keeps working.
 */
function nativeAuthStorage(): AuthStorage {
  if (isWebPlatform()) return asyncAuthStorage();
  const secure = loadSecureStore();
  const legacy = asyncAuthStorage();
  if (!secure) return legacy;
  return createMigratingAuthStorage(
    secure,
    legacy,
    supabaseAuthStorageKey(process.env.EXPO_PUBLIC_SUPABASE_URL!),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabaseClient(kind: AuthStorageKind): any | null {
  if (!isSupabaseConfigured()) return null;
  if (cached[kind] !== undefined) return cached[kind];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require('@supabase/supabase-js');
    cached[kind] = createClient(
      process.env.EXPO_PUBLIC_SUPABASE_URL!,
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          storage: kind === 'native' ? nativeAuthStorage() : webAuthStorage(),
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      },
    );
  } catch {
    cached[kind] = null;
  }
  return cached[kind];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabase(): any | null {
  return getSupabaseClient('native');
}
