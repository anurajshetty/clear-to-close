#!/usr/bin/env python3
"""p1_event_pushes_migration.py — static self-check on
supabase/migrations/0040_p1_event_pushes.sql.

P1 key action events (Oct 15, 2026). The contract pinned here:
  1. pending_event_pushes outbox exists with the five P1 events in its
     CHECK, RLS enabled, and NO policies or grants (service-role only,
     mirroring pending_step_pushes).
  2. push_queue's kind CHECK is widened to include 'event' without
     dropping the existing kinds.
  3. ctc_push_notify is re-created from 0039's definition: the ONLY
     differences are the steps-branch comment refresh and the
     custom-step outbox insert. This test performs that diff itself.
  4. Join/review triggers: AFTER INSERT, SECURITY DEFINER, kill-switch
     gated; the review trigger resolves the escrow via the review's
     link and skips when the link is gone.
  5. The closed/cancelled snapshot trigger is BEFORE UPDATE OF status,
     fires only on open -> closed/cancelled, snapshots only live
     (non-revoked link + invite) tokens, and records the device's
     escrow count for the multi-escrow address suffix.

Run: python3 tests/p1_event_pushes_migration.py (also wired into tests/run.sh)
"""
import difflib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL40 = os.path.join(ROOT, "supabase", "migrations", "0040_p1_event_pushes.sql")
SQL39 = os.path.join(ROOT, "supabase", "migrations", "0039_step_push_side_targeting.sql")

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def extract_fn(path, fname):
    with open(path) as f:
        text = f.read()
    m = re.search(
        r"(create or replace function " + re.escape(fname) + r"\(\).*?\$\$;)",
        text,
        re.S,
    )
    return m.group(1) if m else None


with open(SQL40) as f:
    sql = f.read()
low = sql.lower()

# 1. Outbox table.
check("outbox table created", "create table if not exists pending_event_pushes" in low)
for ev in ["client_joined", "review_submitted", "custom_step_added", "escrow_closed", "escrow_cancelled", "buyer_intake_submitted", "seller_intake_submitted"]:
    check(f"outbox CHECK includes {ev}", f"'{ev}'" in sql)
check("outbox payload jsonb default", "payload jsonb not null default '{}'::jsonb" in low)
check("outbox snapshot_tokens column", "snapshot_tokens jsonb" in low)
check("outbox RLS enabled", "alter table pending_event_pushes enable row level security" in low)
check(
    "outbox TABLE has NO policies or grants (service-role only)",
    "create policy" not in low
    and re.search(r"(?m)^\s*grant\s+.*\s+on\s+table\s+pending_event_pushes", low) is None
    and re.search(r"(?m)^\s*grant\s+.*\s+pending_event_pushes\s+to\s", low) is None,
)

# 2. Queue kind widening.
check("queue kind constraint dropped by name", "drop constraint if exists push_queue_kind_check" in low)
check(
    "queue kind widened with 'event', old kinds kept",
    "check (kind in ('step', 'keydate', 'checkin', 'event'))" in low,
)

# 3. ctc_push_notify diff vs 0039: exactly the two intended hunks.
fn40 = extract_fn(SQL40, "ctc_push_notify")
fn39 = extract_fn(SQL39, "ctc_push_notify")
check("ctc_push_notify present in both migrations", bool(fn40) and bool(fn39))
if fn40 and fn39:
    old_comment = """    -- Buffer, don't POST: the per-minute flush coalesces rapid check-offs.
    -- Unchecks / reorders / title edits / structural adds insert nothing
    -- (forward progress only). A checked custom step is a normal
    -- completion — structural edits never push."""
    new_comment = """    -- Buffer, don't POST: the per-minute flush coalesces rapid check-offs.
    -- Unchecks / reorders / title edits insert nothing (forward progress
    -- only). A checked custom step is a normal completion. A custom
    -- step ADDED (not done) queues a P1 event instead (0040)."""
    anchor = "    if TG_OP = 'INSERT' and new.done then"
    branch = """    if TG_OP = 'INSERT' and new.custom and not new.done then
      insert into pending_event_pushes (escrow_id, event, payload)
      values (new.escrow_id, 'custom_step_added',
              jsonb_build_object('step_role', new.role));
    end if;
"""
    expected = fn39.replace(old_comment, new_comment).replace(anchor, branch + anchor)
    if expected != fn40:
        diff = "\n".join(
            difflib.unified_diff(
                expected.splitlines(), fn40.splitlines(), "expected(0039+2 hunks)", "0040", lineterm=""
            )
        )
        check("ctc_push_notify diff vs 0039 is EXACTLY the comment + custom branch", False, "\n" + diff)
    else:
        check("ctc_push_notify diff vs 0039 is EXACTLY the comment + custom branch", True)
    check("custom branch requires custom + not done", "new.custom and not new.done" in fn40)
    check("ctc_push_notify stays SECURITY DEFINER", "security definer" in fn40.lower())

# 4. Join + review triggers.
for fname, tname, table in [
    ("ctc_push_event_from_link", "trg_client_links_event_push", "client_links"),
    ("ctc_push_event_from_review", "trg_reviews_event_push", "reviews"),
]:
    fn = extract_fn(SQL40, fname)
    check(f"{fname} present", bool(fn))
    if fn:
        check(f"{fname} is SECURITY DEFINER", "security definer" in fn.lower())
        check(f"{fname} is kill-switch gated", "push_enabled" in fn)
    check(
        f"{tname} is AFTER INSERT on {table}",
        re.search(rf"create trigger {tname}\s+after insert on {table}", low) is not None,
    )
fn_review = extract_fn(SQL40, "ctc_push_event_from_review") or ""
check("review trigger resolves escrow via link", "from client_links where id = new.link_id" in fn_review)
check("review trigger skips when link is gone", "if v_escrow_id is null" in fn_review)
check("review payload carries client_name + stars", "'client_name', new.client_name" in sql and "'stars', new.stars" in sql)
fn_link = extract_fn(SQL40, "ctc_push_event_from_link") or ""
check("join payload carries role + party_name", "'role', new.role" in fn_link and "'party_name', new.party_name" in fn_link)

# 5. Snapshot trigger.
fn_snap = extract_fn(SQL40, "ctc_push_event_snapshot") or ""
check("snapshot fn present", bool(fn_snap))
check("snapshot fn is SECURITY DEFINER", "security definer" in fn_snap.lower())
check("snapshot fn is kill-switch gated", "push_enabled" in fn_snap)
check(
    "snapshot trigger is BEFORE UPDATE OF status on escrows",
    re.search(r"create trigger trg_escrows_event_snapshot\s+before update of status on escrows", low) is not None,
)
check("snapshot fires only from open", "old.status is distinct from 'open'" in fn_snap)
check("snapshot targets closed/cancelled", "new.status not in ('closed', 'cancelled')" in fn_snap)
check("snapshot excludes revoked links", "l.revoked_at is null" in fn_snap)
check("snapshot excludes revoked invites", "i.revoked_at is null" in fn_snap)
check("snapshot records escrow_count per device", "'escrow_count'" in fn_snap and "count(distinct t2.escrow_id)" in fn_snap)
check("snapshot records realtor_first", "'realtor_first', v_first" in fn_snap)

# 6b. Grant posture (auditor conditional pass): every function this
# migration creates carries an explicit revoke from client roles.
for fn in [
    "ctc_push_event_from_link()",
    "ctc_push_event_from_review()",
    "ctc_push_event_snapshot()",
    "ctc_push_event_from_intake()",
    "ctc_push_notify()",
]:
    check(
        f"{fn} EXECUTE revoked from public/anon/authenticated",
        f"revoke execute on function {fn} from public, anon, authenticated;" in low,
    )

# 6. Intake triggers -> the TC (Option A).
fn_intake = extract_fn(SQL40, "ctc_push_event_from_intake") or ""
check("intake fn present", bool(fn_intake))
check("intake fn is SECURITY DEFINER", "security definer" in fn_intake.lower())
check("intake fn is kill-switch gated", "push_enabled" in fn_intake)
check("buyer_intakes maps to buyer event", "'buyer_intake_submitted'" in fn_intake and "TG_TABLE_NAME = 'buyer_intakes'" in fn_intake)
check("tc_intakes maps to seller event", "'seller_intake_submitted'" in fn_intake and "TG_TABLE_NAME = 'tc_intakes'" in fn_intake)
for tname, table in [
    ("trg_buyer_intakes_event_push", "buyer_intakes"),
    ("trg_tc_intakes_event_push", "tc_intakes"),
]:
    check(
        f"{tname} is AFTER INSERT OR UPDATE on {table}",
        re.search(rf"create trigger {tname}\s+after insert or update on {table}", low) is not None,
    )

print()
if FAILS:
    print(f"{len(FAILS)} FAILURES")
    sys.exit(1)
print("all p1_event_pushes_migration checks passed")
