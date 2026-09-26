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
//   - native iOS: the session persists in AsyncStorage — returning realtors
//     go straight into the app, no re-sign-in.
//   - web: the session persists in localStorage — a refresh keeps the
//     realtor signed in, on the same screen. The session ends ONLY on Log
//     out, or when the browser session ends (in incognito, closing the
//     incognito window wipes localStorage automatically, so that keeps
//     working).

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
          storage: kind === 'native' ? asyncAuthStorage() : webAuthStorage(),
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
