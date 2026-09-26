// Clear to Close — the singleton store instance used by screens.
import { getDefaultKV } from './kv';
import { createStore } from './store';

export const store = createStore(getDefaultKV());
