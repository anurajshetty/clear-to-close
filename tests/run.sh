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
  "$ROOT/src/lib/escrowConfirm.ts" \
  "$ROOT/src/lib/dates.ts" \
  "$ROOT/src/lib/keyDates.ts" \
  "$ROOT/src/lib/stepExplainers.ts" \
  "$ROOT/src/lib/pace.ts" \
  "$ROOT/src/lib/topCard.ts" \
  "$ROOT/src/lib/shareCopy.ts" \
  "$ROOT/src/lib/shareSections.ts" \
  "$ROOT/src/lib/latest.ts" \
  "$ROOT/src/lib/lifecycle.ts" \
  "$ROOT/src/lib/cloudSync.ts" \
  "$ROOT/src/lib/syncErrors.ts" \
  "$ROOT/src/lib/confetti.ts" \
  "$ROOT/src/lib/bannerSize.ts" \
  "$ROOT/src/lib/cropMath.ts" \
  "$ROOT/src/lib/mediaUpload.ts" \
  "$ROOT/src/lib/profile.ts" \
  "$ROOT/src/lib/push.ts" \
  "$ROOT/src/lib/clientView.ts" \
  "$ROOT/src/lib/invites.ts" \
  "$ROOT/src/lib/reviewLinks.ts" \
  "$ROOT/src/lib/escrowList.ts" \
  "$ROOT/src/lib/tcIntake.ts" \
  "$ROOT/src/lib/buyerIntake.ts" \
  "$ROOT/supabase/functions/send-client-push/push.ts" \
  "$ROOT/tests/assert.ts" \
  "$ROOT/tests/outbox_seed.ts" \
  "$ROOT/tests/invite.test.ts" \
  "$ROOT/tests/sync.test.ts" \
  "$ROOT/tests/uniqueness.test.ts" \
  "$ROOT/tests/checklist.test.ts" \
  "$ROOT/tests/checklist_edit.test.ts" \
  "$ROOT/tests/sidepicker.test.ts" \
  "$ROOT/tests/editcancel.test.ts" \
  "$ROOT/tests/persistence.test.ts" \
  "$ROOT/tests/dates.test.ts" \
  "$ROOT/tests/pace.test.ts" \
  "$ROOT/tests/sharecopy.test.ts" \
  "$ROOT/tests/share_side.test.ts" \
  "$ROOT/tests/latest.test.ts" \
  "$ROOT/tests/lifecycle.test.ts" \
  "$ROOT/tests/cloudsync.test.ts" \
  "$ROOT/tests/push.test.ts" \
  "$ROOT/tests/push_coalesce_quiet.test.ts" \
  "$ROOT/tests/auth.test.ts" \
  "$ROOT/tests/syncedstore.test.ts" \
  "$ROOT/tests/profilepull.test.ts" \
  "$ROOT/tests/realtygroup.test.ts" \
  "$ROOT/tests/reviews.test.ts" \
  "$ROOT/tests/invite_resolve.test.ts" \
  "$ROOT/tests/invite_sync.test.ts" \
  "$ROOT/tests/redeem_no_local_fallback.test.ts" \
  "$ROOT/tests/media_upload.test.ts" \
  "$ROOT/tests/profilefetch_live.test.ts" \
  "$ROOT/tests/escrowpull.test.ts" \
  "$ROOT/tests/tc_view.test.ts" \
  "$ROOT/tests/tc_intake.test.ts" \
  "$ROOT/tests/buyer_intake.test.ts" \
  "$ROOT/tests/invite_cap_sync.test.ts" \
  "$ROOT/tests/invite_closed_block.test.ts" \
  "$ROOT/tests/celebration_kicker.test.ts" \
  "$ROOT/tests/confetti.test.ts" \
  "$ROOT/tests/banner_size.test.ts" \
  "$ROOT/tests/topcard_photo.test.ts" \
  "$ROOT/tests/review_gate.test.ts" \
  "$ROOT/tests/review_links.test.ts" \
  "$ROOT/tests/topcard_status.test.ts" \
  "$ROOT/tests/topcard_colors.test.ts" \
  "$ROOT/tests/topcard_responsive.test.ts" \
  "$ROOT/tests/topcard_timeline.test.ts" \
  "$ROOT/tests/celebration_redesign.test.ts" \
  "$ROOT/tests/sync_failure_ui.test.ts" \
  "$ROOT/tests/profile_view_fixes.test.ts" \
  "$ROOT/tests/triumph_removed.test.ts" \
  "$ROOT/tests/close_revokes_links.test.ts" \
  "$ROOT/tests/close_revoke_converges.test.ts" \
  "$ROOT/tests/cancel_sync_writes.test.ts" \
  "$ROOT/tests/account_isolation.test.ts" \
  "$ROOT/tests/photo_cropper.test.ts" \
  "$ROOT/tests/profile_form_fields.test.ts" \
  "$ROOT/tests/photo_stale_client_chain.test.ts" \
  "$ROOT/tests/sync_chain_broad.test.ts" \
  "$ROOT/tests/client_refresh_foreground.test.ts" \
  "$ROOT/tests/profile_boot_converge.test.ts" \
  "$ROOT/tests/sync_error_bar_safe_area.test.ts" \
  "$ROOT/tests/pull_then_push.test.ts" \
  "$ROOT/tests/conflict_rules.test.ts" \
  "$ROOT/tests/date_field_web_width.test.ts" \
  "$ROOT/tests/date_field_collapsed.test.ts" \
  "$ROOT/tests/sheet_detent_lock.test.ts" \
  "$ROOT/tests/city_removed.test.ts" \
  "$ROOT/tests/keyboard_avoidance.test.ts" \
  "$ROOT/tests/cancel_escrow_confirm.test.ts" \
  "$ROOT/tests/header_top_gap.test.ts" \
  "$ROOT/tests/sync_writes.test.ts" \
  "$ROOT/tests/realtor_home_banner.test.ts" \
  "$ROOT/tests/recovery.test.ts" \
  "$ROOT/tests/password_eye_toggle.test.ts" \
  "$ROOT/tests/activate_escrow.test.ts" \
  "$ROOT/tests/invite_expiry.test.ts" \
  "$ROOT/tests/side_lock_confirm_create.test.ts" \
  "$ROOT/tests/profile_media_removal.test.ts" \
  "$ROOT/tests/revoke_invite_kills_link.test.ts" \
  "$ROOT/tests/revoke_links_server_authoritative.test.ts" \
  "$ROOT/tests/outbox_concurrency.test.ts" \
  "$ROOT/tests/checklist_bulk_apply.test.ts" \
  "$ROOT/tests/key_dates.test.ts" \
  "$ROOT/tests/keydate_clear.test.ts" \
  "$ROOT/tests/update_closed_lifecycle.test.ts" \
  "$ROOT/tests/escrow_list.test.ts" \
  "$ROOT/tests/multi_escrow.test.ts" \
  "$ROOT/src/lib/clientRealtime.ts" \
  "$ROOT/tests/client_realtime.test.ts" \
  "$ROOT/src/lib/toast.ts" \
  "$ROOT/tests/toast_dismiss.test.ts" \
  "$ROOT/tests/share_screen.test.ts" \
  "$ROOT/tests/tc_intake_decimal.test.ts" \
  "$ROOT/tests/pool_strip.test.ts" \
  "$ROOT/tests/step_key_dates.test.ts" \
  "$ROOT/tests/share_button_label.test.ts" \
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
node "$OUT/tests/checklist_edit.test.js"
node "$OUT/tests/sidepicker.test.js"
node "$OUT/tests/editcancel.test.js"
node "$OUT/tests/persistence.test.js"
# Pinned TZ so the DST-crossing day-count regression is deterministic.
TZ="America/Los_Angeles" node "$OUT/tests/dates.test.js"
node "$OUT/tests/pace.test.js"
node "$OUT/tests/sharecopy.test.js"
node "$OUT/tests/share_side.test.js"
# Pinned TZ so the calendar-day relative-time buckets are deterministic.
TZ="America/Los_Angeles" node "$OUT/tests/latest.test.js"
node "$OUT/tests/cloudsync.test.js"
node "$OUT/tests/push.test.js"
node "$OUT/tests/push_coalesce_quiet.test.js"
node "$OUT/tests/lifecycle.test.js"
node "$OUT/tests/auth.test.js"
node "$OUT/tests/syncedstore.test.js"
node "$OUT/tests/tc_view.test.js"
node "$OUT/tests/tc_intake.test.js"
node "$OUT/tests/buyer_intake.test.js"
node "$OUT/tests/profilepull.test.js"
node "$OUT/tests/realtygroup.test.js"
node "$OUT/tests/reviews.test.js"
node "$OUT/tests/invite_resolve.test.js"
node "$OUT/tests/invite_sync.test.js"
node "$OUT/tests/redeem_no_local_fallback.test.js"
node "$OUT/tests/invite_cap_sync.test.js"
node "$OUT/tests/invite_closed_block.test.js"
node "$OUT/tests/celebration_kicker.test.js"
node "$OUT/tests/confetti.test.js"
node "$OUT/tests/banner_size.test.js"
node "$OUT/tests/topcard_photo.test.js"
node "$OUT/tests/review_gate.test.js"
node "$OUT/tests/topcard_status.test.js"
node "$OUT/tests/topcard_colors.test.js"
node "$OUT/tests/topcard_responsive.test.js"
node "$OUT/tests/topcard_timeline.test.js"
node "$OUT/tests/celebration_redesign.test.js"
node "$OUT/tests/sync_failure_ui.test.js"
node "$OUT/tests/profile_view_fixes.test.js"
node "$OUT/tests/media_upload.test.js"
node "$OUT/tests/profilefetch_live.test.js"
node "$OUT/tests/escrowpull.test.js"
node "$OUT/tests/triumph_removed.test.js"
node "$OUT/tests/close_revokes_links.test.js"
node "$OUT/tests/close_revoke_converges.test.js"
node "$OUT/tests/cancel_sync_writes.test.js"
node "$OUT/tests/account_isolation.test.js"
node "$OUT/tests/photo_cropper.test.js"
node "$OUT/tests/profile_form_fields.test.js"
node "$OUT/tests/photo_stale_client_chain.test.js"
node "$OUT/tests/sync_writes.test.js"
node "$OUT/tests/sync_chain_broad.test.js"
node "$OUT/tests/client_refresh_foreground.test.js"
node "$OUT/tests/profile_boot_converge.test.js"
node "$OUT/tests/sync_error_bar_safe_area.test.js"
node "$OUT/tests/pull_then_push.test.js"
node "$OUT/tests/conflict_rules.test.js"
node "$OUT/tests/date_field_web_width.test.js"
node "$OUT/tests/date_field_collapsed.test.js"
node "$OUT/tests/sheet_detent_lock.test.js"
node "$OUT/tests/city_removed.test.js"
node "$OUT/tests/keyboard_avoidance.test.js"
node "$OUT/tests/cancel_escrow_confirm.test.js"
node "$OUT/tests/header_top_gap.test.js"
node "$OUT/tests/realtor_home_banner.test.js"
node "$OUT/tests/recovery.test.js"
node "$OUT/tests/password_eye_toggle.test.js"
node "$OUT/tests/activate_escrow.test.js"
node "$OUT/tests/invite_expiry.test.js"
node "$OUT/tests/side_lock_confirm_create.test.js"
node "$OUT/tests/profile_media_removal.test.js"
node "$OUT/tests/revoke_invite_kills_link.test.js"
node "$OUT/tests/revoke_links_server_authoritative.test.js"
node "$OUT/tests/outbox_concurrency.test.js"
node "$OUT/tests/checklist_bulk_apply.test.js"
node "$OUT/tests/key_dates.test.js"
node "$OUT/tests/keydate_clear.test.js"
node "$OUT/tests/update_closed_lifecycle.test.js"
node "$OUT/tests/escrow_list.test.js"
node "$OUT/tests/multi_escrow.test.js"
node "$OUT/tests/client_realtime.test.js"

# Profile picker options (Sept 2026): the library pickers must launch with
# allowsEditing: false and stay single-select, so the raw image flows
# straight into our own crop editor with no native edit UI.
python3 "$ROOT/tests/profile_picker_options.py"

# Top-card redesign structural guard (Sept 2026): guided-by strip removed,
# escrow status tag present, 100% = same card + burst, the "Just closed!"
# triumph card and the pace/completion pills removed, review/share section
# preserved (RN components are not importable in the node suite).
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

# Key-dates push migration self-check (Sept 28, 2026): the 0021 trigger
# counts changed date fields — one date -> specific event, several together
# -> generic key_dates_changed (SQL, not runnable in node).
python3 "$ROOT/tests/key_dates_push_migration.py"

# Multi-escrow migration self-check (Sept 28, 2026): the 0022 migration
# replaces the device-wide live-link unique index with (device_id,
# escrow_id), keeps redeem_invite idempotent per (device, escrow)
# (including the concurrent same-code race-loser path), and scopes push
# tokens per link (SQL, not runnable in node).
python3 "$ROOT/tests/multi_escrow_migration.py"
# TC intake migration self-check (Sept 29, 2026): the 0031 migration
# creates tc_intakes (escrow_id PK -> escrows cascade), locks direct access
# to the owner (no anon grant), and replaces get_client_view so the tc
# branch alone embeds the intake data payload — buyer/seller branches carry
# no tc_intake key (SQL, not runnable in node).
python3 "$ROOT/tests/tc_intake_migration.py"
# Buyer intake migration self-check (Oct 1, 2026): the 0034 migration
# creates buyer_intakes (escrow_id PK -> escrows cascade), locks direct access
# to the owner (no anon grant), and replaces get_client_view so the tc
# branch alone embeds the buyer intake data payload — buyer/seller branches
# carry no buyer_intake key, and the 0031/0033 tc_intake contract is
# preserved (SQL, not runnable in node).
python3 "$ROOT/tests/buyer_intake_migration.py"
# Client realtime migration self-check (Sept 2026): the 0030 migration puts
# escrows/steps/client_links/realtor_profiles on the supabase_realtime
# publication and adds the four TO anon, token-claim-keyed SELECT policies
# (live-link liveness on steps/escrows/profiles; own-row, unfiltered on
# client_links so the client observes its own revocation). SQL, not
# runnable in node.
python3 "$ROOT/tests/client_realtime_migration.py"
node "$OUT/tests/toast_dismiss.test.js"
node "$OUT/tests/share_screen.test.js"
node "$OUT/tests/tc_intake_decimal.test.js"
node "$OUT/tests/pool_strip.test.js"
node "$OUT/tests/step_key_dates.test.js"
node "$OUT/tests/share_button_label.test.js"
