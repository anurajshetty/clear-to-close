// Clear to Close — the singleton store instance used by screens.
// Local KV store wrapped with cloud sync; initCloudSync() runs the boot-time
// connectivity check (auth + read/write round-trip) and exposes the result on
// globalThis.__ctcCloudPing for diagnostics and the boot test.
import { getDefaultKV } from './kv';
import { createSyncedStore } from './syncedStore';

const { store, initCloudSync } = createSyncedStore(getDefaultKV());

export { store, initCloudSync };
