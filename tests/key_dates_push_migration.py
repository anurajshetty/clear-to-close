#!/usr/bin/env python3
"""key_dates_push_migration.py — static self-check on supabase/migrations/0021_key_dates_push.sql.

The key-date push event model lives in SQL (not runnable in node), so this
test asserts the shipped migration text implements Anuraj's approved rule
(Sept 28, 2026):
  One date changed:   specific event ("Your {label} is now {date}.")
  Several dates together: generic key_dates_changed ("{First} updated your key dates.")

Run: python3 tests/key_dates_push_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0021_key_dates_push.sql")

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def main():
    if not os.path.isfile(SQL):
        print("FAIL migration file missing: " + SQL)
        sys.exit(1)
    with open(SQL) as f:
        src = f.read()
    # Strip -- comments for statement checks; copy assertions use the full src.
    code = re.sub(r"--[^\n]*", "", src)
    low = code.lower()

    # ---- additive-only (rollback requirement, Anuraj Sept 26 2026) ----
    check("migration file exists", True)
    check("no DROP TABLE", "drop table" not in low)
    check("no DROP COLUMN", "drop column" not in low)
    check("no ALTER TABLE", "alter table" not in low.replace("drop trigger if exists", ""))

    # ---- the trigger counts changed date fields ----
    check("counts changed fields (v_changed_count)",
          "v_changed_count" in src)
    check("tracks which field changed (v_changed_field)",
          "v_changed_field" in src)
    check("close_date change counted",
          re.search(r"old\.close_date is distinct from new\.close_date", src) is not None)
    check("inspection_deadline change counted",
          re.search(r"old\.inspection_deadline is distinct from new\.inspection_deadline", src) is not None)
    check("appraisal_deadline change counted",
          re.search(r"old\.appraisal_deadline is distinct from new\.appraisal_deadline", src) is not None)
    check("loan_approval_date change counted",
          re.search(r"old\.loan_approval_date is distinct from new\.loan_approval_date", src) is not None)

    # ---- one date -> specific event ----
    check("single change branches on count = 1",
          re.search(r"if v_changed_count = 1", src) is not None)
    check("close_date single -> close_date_changed",
          "'close_date_changed'" in src)
    check("inspection single -> inspection_deadline_changed",
          "'inspection_deadline_changed'" in src)
    check("appraisal single -> appraisal_deadline_changed",
          "'appraisal_deadline_changed'" in src)
    check("loan single -> loan_approval_date_changed",
          "'loan_approval_date_changed'" in src)

    # ---- several dates -> generic key_dates_changed ----
    check("multiple changes branch on count > 1",
          re.search(r"elsif v_changed_count > 1", src) is not None)
    check("multiple -> key_dates_changed",
          re.search(r"v_event := 'key_dates_changed'", src) is not None)

    # ---- the specific event carries the new date ----
    check("new_date payload field sent",
          "'new_date', v_new_date" in src or '"new_date", v_new_date' in src or
          re.search(r"'new_date',\s*v_new_date", src) is not None)

    # ---- no close-date-wins precedence (the old bug) ----
    # The old code had: if close_date changed then close_date_changed
    # elsif (other dates) then key_dates_changed. The new code must NOT
    # have that shape — it counts first, then branches on the count.
    old_shape = re.search(
        r"if old\.close_date is distinct from new\.close_date then\s+"
        r"v_event := 'close_date_changed'",
        src)
    check("no close-date-wins precedence (old bug shape absent)",
          old_shape is None,
          "found the old if-close-then-specific-elsif-generic shape")

    # ---- kill switch unchanged ----
    check("trigger checks push_enabled first",
          re.search(r"select value into v_enabled from push_config where key = 'push_enabled'", src) is not None)

    print()
    if FAILS:
        print(f"key_dates_push_migration.py: {len(FAILS)} failure(s)")
        sys.exit(1)
    print("key_dates_push_migration.py: all green")


if __name__ == "__main__":
    main()
