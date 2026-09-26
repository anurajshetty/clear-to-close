// Clear to Close — key/value persistence backends.
//
// memoryKV() is a pure in-memory Map implementation (used by tests).
// getDefaultKV() resolves React Native AsyncStorage at call time via
// require(), so this module can be imported in a Node test environment
// where the native package is not installed.

import type { KV } from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

export function memoryKV(): KV {
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

export function getDefaultKV(): KV {
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
    // fall through to in-memory backend
  }
  return memoryKV();
}
