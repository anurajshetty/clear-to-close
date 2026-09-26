// Clear to Close — Supabase backend connection.
//
// The client is created lazily and only when both env vars are present.
// @supabase/supabase-js is require()d inside the function body (guarded by
// try/catch), so this module can be imported in a Node test environment
// where the package may not be installed yet.
//
// Auth session storage is platform-differentiated (approved spec §4):
//   - native iOS: the session persists in AsyncStorage — returning realtors
//     go straight into the app, no re-sign-in.
//   - web: an in-memory store with persistSession:false — returning realtors
//     see the email + password sign-in screen on every visit, no auto-login.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabaseClient(kind: AuthStorageKind): any | null {
  if (!isSupabaseConfigured()) return null;
  if (cached[kind] !== undefined) return cached[kind];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require('@supabase/supabase-js');
    const persist = kind === 'native';
    cached[kind] = createClient(
      process.env.EXPO_PUBLIC_SUPABASE_URL!,
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          storage: persist ? asyncAuthStorage() : memoryAuthStorage(),
          persistSession: persist,
          autoRefreshToken: persist,
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
