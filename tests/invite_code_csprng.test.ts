// invite_code_csprng.test.ts — L1 regression (Oct 2026): invite codes must
// come from a CSPRNG, never Math.random.
//
// store.ts's randomCode() draws from secureRandomBytes(), which uses
// WebCrypto's getRandomValues where present (web, Node test runtime) and
// falls back to expo-crypto's native secure random on Hermes (which ships
// no crypto.getRandomValues — verified in the installed RN 0.86.3 tree).
// The native branch is exercised here by hiding WebCrypto, at which point
// the lazy require('expo-crypto') resolves to tests/stubs/expo-crypto.js
// (NODE_PATH, see tests/run.sh), itself backed by Node's WebCrypto CSPRNG.
import { assert, summary } from './assert';
import { randomCode } from '../src/lib/store';

declare const process: { exitCode?: number };
declare const require: (id: string) => any;

// Must match CODE_ALPHABET in src/lib/store.ts.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function isWellFormed(code: string): boolean {
  return code.length === 6 && [...code].every((c) => ALPHABET.includes(c));
}

async function main(): Promise<void> {
  // 1. Math.random must never be consulted. Swap in a thrower: the old
  //    Math.random-based implementation throws on every call (fails without
  //    the fix); the CSPRNG implementation never touches it.
  {
    const origRandom = Math.random;
    (Math as { random: () => number }).random = () => {
      throw new Error('Math.random must not be used for invite codes');
    };
    try {
      for (let i = 0; i < 200; i++) {
        const code = randomCode();
        assert(isWellFormed(code), `csprng: code ${i} is 6 chars from the safe alphabet (no Math.random)`);
      }
    } finally {
      (Math as { random: () => number }).random = origRandom;
    }
  }

  // 2. WebCrypto branch: getRandomValues is actually the entropy source when
  //    present (fails without the fix — the old code never called it).
  {
    const g = globalThis as {
      crypto?: { getRandomValues: (a: Uint8Array) => Uint8Array };
    };
    const origCrypto = g.crypto;
    const realGRV = origCrypto!.getRandomValues.bind(origCrypto);
    let calls = 0;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      writable: true,
      value: {
        getRandomValues: (a: Uint8Array): Uint8Array => {
          calls++;
          return realGRV(a);
        },
      },
    });
    try {
      randomCode();
      assert(calls > 0, 'csprng: WebCrypto getRandomValues is used when available');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: origCrypto,
      });
    }
  }

  // 3. Native (Hermes) branch: with WebCrypto hidden, randomCode must draw
  //    from expo-crypto's getRandomBytes (fails without the fix).
  {
    const g = globalThis as {
      crypto?: { getRandomValues: (a: Uint8Array) => Uint8Array } | undefined;
    };
    const origCrypto = g.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const stub = require('expo-crypto') as {
      getRandomBytes: (n: number) => Uint8Array;
    };
    const origGetRandomBytes = stub.getRandomBytes;
    const realBytes = origGetRandomBytes.bind(stub);
    let calls = 0;
    stub.getRandomBytes = (n: number): Uint8Array => {
      calls++;
      return realBytes(n);
    };
    try {
      const code = randomCode();
      assert(calls > 0, 'csprng: expo-crypto getRandomBytes is used on the native branch');
      assert(isWellFormed(code), 'csprng: native-branch code is 6 chars from the safe alphabet');
    } finally {
      stub.getRandomBytes = origGetRandomBytes;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: origCrypto,
      });
    }
  }

  // 4. Distribution sanity: every alphabet symbol appears across many codes
  //    (catches degenerate generators; the rejection-sampling loop in
  //    secureAlphabetIndex must terminate and stay unbiased).
  {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const c of randomCode()) seen.add(c);
    }
    assert(
      seen.size === ALPHABET.length,
      `csprng: all ${ALPHABET.length} alphabet symbols appear (${seen.size} seen)`,
    );
  }

  summary('invite_code_csprng');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
