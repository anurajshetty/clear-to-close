// Node-test-only shim for 'expo-crypto' (Stream D, L1 regression, Oct 2026).
//
// Metro and web bundlers never see this file: it exists so the plain-Node
// unit-test runtime can load src/lib/store.ts's native branch, which lazily
// requires 'expo-crypto' when WebCrypto is unavailable (Hermes). It is wired
// in via NODE_PATH in tests/run.sh, ahead of the real node_modules copy.
//
// Backed by Node's own WebCrypto CSPRNG, so the security property under test
// (codes come from a CSPRNG, never Math.random) holds in the test runtime
// exactly as it does on device (SecRandom on iOS, window.crypto on web).
const nodeCrypto = require('node:crypto');

function getRandomBytes(byteCount) {
  return nodeCrypto.getRandomValues(new Uint8Array(byteCount));
}

async function getRandomBytesAsync(byteCount) {
  return getRandomBytes(byteCount);
}

module.exports = { getRandomBytes, getRandomBytesAsync };
