#!/usr/bin/env bash
# Clear to Close data-layer tests: typecheck + compile the lib + tests, then
# run each compiled test with node. Keeps strictly to src/lib + tests (sibling
# workstreams' files may not have landed yet).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="/tmp/ctc-tests"
rm -rf "$OUT"

npx tsc --ignoreConfig \
  "$ROOT/src/lib/types.ts" \
  "$ROOT/src/lib/steps.ts" \
  "$ROOT/src/lib/kv.ts" \
  "$ROOT/src/lib/store.ts" \
  "$ROOT/src/lib/store-instance.ts" \
  "$ROOT/src/lib/supabase.ts" \
  "$ROOT/src/lib/auth.ts" \
  "$ROOT/src/lib/bootRoute.ts" \
  "$ROOT/src/lib/recency.ts" \
  "$ROOT/src/lib/sidePicker.ts" \
  "$ROOT/src/lib/clientView.ts" \
  "$ROOT/src/lib/dates.ts" \
  "$ROOT/src/lib/cloudSync.ts" \
  "$ROOT/tests/assert.ts" \
  "$ROOT/tests/invite.test.ts" \
  "$ROOT/tests/sync.test.ts" \
  "$ROOT/tests/uniqueness.test.ts" \
  "$ROOT/tests/recency.test.ts" \
  "$ROOT/tests/checklist.test.ts" \
  "$ROOT/tests/sidepicker.test.ts" \
  "$ROOT/tests/persistence.test.ts" \
  "$ROOT/tests/dates.test.ts" \
  "$ROOT/tests/cloudsync.test.ts" \
  "$ROOT/tests/auth.test.ts" \
  "$ROOT/tests/syncedstore.test.ts" \
  --outDir "$OUT" \
  --module commonjs \
  --target es2020 \
  --moduleResolution bundler \
  --skipLibCheck

# NODE_PATH lets the compiled tests resolve @supabase/supabase-js for the
# platform-storage tests (they run from /tmp, outside the repo tree).
export NODE_PATH="$ROOT/node_modules"

node "$OUT/tests/invite.test.js"
node "$OUT/tests/sync.test.js"
node "$OUT/tests/uniqueness.test.js"
node "$OUT/tests/recency.test.js"
node "$OUT/tests/checklist.test.js"
node "$OUT/tests/sidepicker.test.js"
node "$OUT/tests/persistence.test.js"
# Pinned TZ so the DST-crossing day-count regression is deterministic.
TZ="America/Los_Angeles" node "$OUT/tests/dates.test.js"
node "$OUT/tests/cloudsync.test.js"
node "$OUT/tests/auth.test.js"
node "$OUT/tests/syncedstore.test.js"
