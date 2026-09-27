#!/usr/bin/env bash
# Clear to Close data-layer tests: typecheck + compile the lib + tests, then
# run each compiled test with node. Keeps strictly to src/lib + tests (sibling
# workstreams' files may not have landed yet).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Unique per-run output dir: parallel worktrees on the same machine must not
# clobber each other's compiled tests (a fixed /tmp/ctc-tests raced and
# deleted .js files mid-run). Override with CTC_TESTS_OUT if needed.
OUT="${CTC_TESTS_OUT:-}"
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d /tmp/ctc-tests.XXXXXX)"
  trap 'rm -rf "$OUT"' EXIT
else
  rm -rf "$OUT"
fi

npx tsc --ignoreConfig \
  "$ROOT/src/lib/types.ts" \
  "$ROOT/src/lib/steps.ts" \
  "$ROOT/src/lib/kv.ts" \
  "$ROOT/src/lib/store.ts" \
  "$ROOT/src/lib/store-instance.ts" \
  "$ROOT/src/lib/supabase.ts" \
  "$ROOT/src/lib/auth.ts" \
  "$ROOT/src/lib/bootRoute.ts" \
  "$ROOT/src/lib/sidePicker.ts" \
  "$ROOT/src/lib/dates.ts" \
  "$ROOT/src/lib/pace.ts" \
  "$ROOT/src/lib/topCard.ts" \
  "$ROOT/src/lib/shareCopy.ts" \
  "$ROOT/src/lib/latest.ts" \
  "$ROOT/src/lib/lifecycle.ts" \
  "$ROOT/src/lib/cloudSync.ts" \
  "$ROOT/src/lib/confetti.ts" \
  "$ROOT/src/lib/bannerSize.ts" \
  "$ROOT/src/lib/mediaUpload.ts" \
  "$ROOT/src/lib/profile.ts" \
  "$ROOT/src/lib/push.ts" \
  "$ROOT/src/lib/clientView.ts" \
  "$ROOT/supabase/functions/send-client-push/push.ts" \
  "$ROOT/tests/assert.ts" \
  "$ROOT/tests/invite.test.ts" \
  "$ROOT/tests/sync.test.ts" \
  "$ROOT/tests/uniqueness.test.ts" \
  "$ROOT/tests/checklist.test.ts" \
  "$ROOT/tests/sidepicker.test.ts" \
  "$ROOT/tests/editcancel.test.ts" \
  "$ROOT/tests/persistence.test.ts" \
  "$ROOT/tests/dates.test.ts" \
  "$ROOT/tests/pace.test.ts" \
  "$ROOT/tests/sharecopy.test.ts" \
  "$ROOT/tests/latest.test.ts" \
  "$ROOT/tests/lifecycle.test.ts" \
  "$ROOT/tests/cloudsync.test.ts" \
  "$ROOT/tests/push.test.ts" \
  "$ROOT/tests/auth.test.ts" \
  "$ROOT/tests/syncedstore.test.ts" \
  "$ROOT/tests/profilepull.test.ts" \
  "$ROOT/tests/realtygroup.test.ts" \
  "$ROOT/tests/reviews.test.ts" \
  "$ROOT/tests/invite_resolve.test.ts" \
  "$ROOT/tests/invite_sync.test.ts" \
  "$ROOT/tests/media_upload.test.ts" \
  "$ROOT/tests/profilefetch_live.test.ts" \
  "$ROOT/tests/escrowpull.test.ts" \
  "$ROOT/tests/tc_view.test.ts" \
  "$ROOT/tests/invite_cap_sync.test.ts" \
  "$ROOT/tests/celebration_kicker.test.ts" \
  "$ROOT/tests/confetti.test.ts" \
  "$ROOT/tests/banner_size.test.ts" \
  "$ROOT/tests/topcard_photo.test.ts" \
  "$ROOT/tests/review_gate.test.ts" \
  "$ROOT/tests/topcard_status.test.ts" \
  "$ROOT/tests/topcard_colors.test.ts" \
  "$ROOT/tests/celebration_redesign.test.ts" \
  --outDir "$OUT" \
  --module commonjs \
  --target es2020 \
  --moduleResolution bundler \
  --skipLibCheck

# NODE_PATH lets the compiled tests resolve @supabase/supabase-js for the
# platform-storage tests (they run from /tmp, outside the repo tree).
export NODE_PATH="$ROOT/node_modules"

# CTC_REPO_ROOT lets the structural regression tests read component/route
# sources (RN components are not importable in the node suite).
export CTC_REPO_ROOT="$ROOT"

node "$OUT/tests/invite.test.js"
node "$OUT/tests/sync.test.js"
node "$OUT/tests/uniqueness.test.js"
node "$OUT/tests/checklist.test.js"
node "$OUT/tests/sidepicker.test.js"
node "$OUT/tests/editcancel.test.js"
node "$OUT/tests/persistence.test.js"
# Pinned TZ so the DST-crossing day-count regression is deterministic.
TZ="America/Los_Angeles" node "$OUT/tests/dates.test.js"
node "$OUT/tests/pace.test.js"
node "$OUT/tests/sharecopy.test.js"
# Pinned TZ so the calendar-day relative-time buckets are deterministic.
TZ="America/Los_Angeles" node "$OUT/tests/latest.test.js"
node "$OUT/tests/cloudsync.test.js"
node "$OUT/tests/push.test.js"
node "$OUT/tests/lifecycle.test.js"
node "$OUT/tests/auth.test.js"
node "$OUT/tests/syncedstore.test.js"
node "$OUT/tests/tc_view.test.js"
node "$OUT/tests/profilepull.test.js"
node "$OUT/tests/realtygroup.test.js"
node "$OUT/tests/reviews.test.js"
node "$OUT/tests/invite_resolve.test.js"
node "$OUT/tests/invite_sync.test.js"
node "$OUT/tests/invite_cap_sync.test.js"
node "$OUT/tests/celebration_kicker.test.js"
node "$OUT/tests/confetti.test.js"
node "$OUT/tests/banner_size.test.js"
node "$OUT/tests/topcard_photo.test.js"
node "$OUT/tests/review_gate.test.js"
node "$OUT/tests/topcard_status.test.js"
node "$OUT/tests/topcard_colors.test.js"
node "$OUT/tests/celebration_redesign.test.js"
node "$OUT/tests/media_upload.test.js"
node "$OUT/tests/profilefetch_live.test.js"
node "$OUT/tests/escrowpull.test.js"

# Top-card redesign structural guard (Sept 2026): guided-by strip removed,
# escrow status tag present, 100% = same card + burst with the "Just closed!"
# triumph card below, review/share section preserved (RN components are not
# importable in the node suite).
python3 "$ROOT/tests/topcard_redesign.py"

# Em/en-dash sweep (Sept 2026): user-facing copy must read professional and
# human — no em dashes (—) or en dashes (–) outside code comments.
python3 "$ROOT/tests/em_dash_sweep.py"

# Migration 0011 additive/rollback guard (Sept 2026): the reviews migration
# must stay additive-only so pre-release code keeps working against the
# migrated DB; no public exposure of the reviews link_id.
python3 "$ROOT/tests/migration_0011_guard.py"

# Push migration self-check: forward-only trigger guards, kill switch,
# RPCs, additive-only shape (SQL, not runnable in node).
python3 "$ROOT/tests/push_migration.py"
