#!/usr/bin/env python3
"""P3 halfway-milestone invariants (0042), statically checked.

The load-bearing pin: 0042's ctc_push_notify must equal 0040's text
plus EXACTLY the two halfway hook lines — the same verbatim-diff bar
as 0039/0040. The claim helper's crossing math and atomic stamp are
checked against the migration text.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SQL42 = (ROOT / "supabase/migrations/0042_p3_halfway_milestone.sql").read_text()
SQL40 = (ROOT / "supabase/migrations/0040_p1_event_pushes.sql").read_text()
low = SQL42.lower()

failures = []


def check(name, ok):
    if not ok:
        failures.append(name)
    print(("ok   " if ok else "FAIL ") + name)


def extract_fn(sql, name):
    start = sql.index(f"create or replace function {name}()")
    end = sql.index("$$;", start) + 3
    return sql[start:end]


# 1. Trigger verbatim bar: 0040 + exactly two hook lines, nothing else.
fn40 = extract_fn(SQL40, "ctc_push_notify")
fn42 = extract_fn(SQL42, "ctc_push_notify")
hook = "perform ctc_maybe_push_halfway(new.escrow_id);"
check("exactly two halfway hooks in the trigger", fn42.count(hook) == 2)
stripped = "\n".join(l for l in fn42.split("\n") if hook not in l)
check("trigger minus hooks == 0040 verbatim", stripped == fn40)

# 1b. PLACEMENT (the stop-ship lesson, Oct 15 2026): the strip-compare
# above cannot catch a placement error — the first version of this
# migration inserted the hook between the UPDATE's SET and WHERE
# lines, a syntax error the golden reproduced faithfully. Assert the
# placement structurally: every hook must directly follow the
# COMPLETED activity-stamp statement, and no hook may sit between a
# `set last_checkoff_activity_at = now()` line and its WHERE line.
fn42_lines = fn42.split("\n")
for i, line in enumerate(fn42_lines):
    if hook in line:
        prev = fn42_lines[i - 1].strip() if i > 0 else ""
        check(
            f"hook at fn line {i + 1} follows the completed UPDATE",
            prev == "where id = new.escrow_id;",
        )
        check(
            f"hook at fn line {i + 1} does not split SET from WHERE",
            "last_checkoff_activity_at = now()" not in prev,
        )

# 2. Once-per-escrow state.
check("escrows gains halfway_push_sent_at", "alter table escrows add column if not exists halfway_push_sent_at" in low)
check("outbox CHECK gains halfway_milestone", "'halfway_milestone'" in low)

# 3. The claim helper.
helper = ""
m = re.search(r"function ctc_maybe_push_halfway.*?\$\$;", SQL42, re.S)
if m:
    helper = m.group(0)
check("helper present", bool(helper))
check("helper is SECURITY DEFINER", "security definer" in helper.lower())
check("crossing math: reached half", "v_done * 2 >= v_total" in helper)
check("crossing math: was below half", "(v_done - 1) * 2 < v_total" in helper)
check("claim is the atomic stamp (NULL-guarded update)", "halfway_push_sent_at is null" in helper)
check("claim winner checks row_count", "get diagnostics v_claimed = row_count" in helper)
check("winner inserts the outbox row", "insert into pending_event_pushes" in helper and "'halfway_milestone'" in helper)
check("payload snapshots the crossing counts", "'done', v_done" in helper and "'total', v_total" in helper)
check("empty checklist never fires", "v_total = 0" in helper)
check(
    "grant posture: trigger + helper revoked from client roles",
    "revoke execute on function ctc_push_notify() from public, anon, authenticated;" in low
    and "revoke execute on function ctc_maybe_push_halfway(uuid) from public, anon, authenticated;" in low,
)

if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print("\nall p3_halfway_migration checks passed")
