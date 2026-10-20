#!/usr/bin/env python3
"""step_push_side_targeting_migration.py — static self-check on
supabase/migrations/0039_step_push_side_targeting.sql.

P0.3 side-aware targeting (Oct 15, 2026): the coalescing buffer learns
which side each buffered check-off belongs to, so the flush can target
the step's side + TC instead of every client device.

The contract pinned here:
  1. pending_step_pushes gains step_role (text, CHECK buyer/seller,
     nullable for pre-0039 in-flight rows).
  2. ctc_push_notify is re-created: the diff against 0024's definition
     is EXACTLY the two pending_step_pushes inserts gaining step_role /
     new.role — everything else (kill switch, escrows key-date branch,
     pg_net post, activity stamp) is byte-identical. This test performs
     that diff itself.
  3. SECURITY DEFINER + search_path preserved.

Run: python3 tests/step_push_side_targeting_migration.py (also wired into tests/run.sh)
"""
import difflib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL39 = os.path.join(ROOT, "supabase", "migrations", "0039_step_push_side_targeting.sql")
SQL24 = os.path.join(ROOT, "supabase", "migrations", "0024_push_coalesce_quiet.sql")

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def extract_fn(path):
    with open(path) as f:
        src = f.read()
    start = src.index("create or replace function ctc_push_notify()")
    end = src.index("$$;", start) + len("$$;")
    return src[start:end]


def main():
    if not os.path.isfile(SQL39):
        print("FAIL migration file missing: " + SQL39)
        sys.exit(1)
    with open(SQL39) as f:
        src = f.read()
    code = re.sub(r"--[^\n]*", "", src)
    low = code.lower()

    # ---- 1. the column ----
    check("step_role column added with buyer/seller CHECK",
          re.search(r"add\s+column\s+if\s+not\s+exists\s+step_role\s+text\s+"
                    r"check\s*\(\s*step_role\s+in\s*\('buyer',\s*'seller'\)\s*\)",
                    low) is not None)
    check("step_role is nullable (no NOT NULL)",
          re.search(r"step_role\s+text\s+not\s+null", low) is None)

    # ---- 2. function diff vs 0024 is exactly the two inserts ----
    fn24 = extract_fn(SQL24)
    fn39 = extract_fn(SQL39)
    diff = [ln for ln in difflib.unified_diff(fn24.splitlines(), fn39.splitlines(), lineterm="")
            if (ln.startswith("+") or ln.startswith("-")) and not ln.startswith("+++") and not ln.startswith("---")]
    removed = [ln[1:].strip() for ln in diff if ln.startswith("-")]
    added = [ln[1:].strip() for ln in diff if ln.startswith("+")]
    check("function diff removes exactly the 2 old insert lines",
          removed == ["insert into pending_step_pushes (escrow_id, event, step_title)",
                      "values (new.escrow_id, 'step_done', new.title);"] * 1 or
          sorted(removed) == sorted(["insert into pending_step_pushes (escrow_id, event, step_title)",
                                     "values (new.escrow_id, 'step_done', new.title);",
                                     "insert into pending_step_pushes (escrow_id, event, step_title)",
                                     "values (new.escrow_id, 'step_done', new.title);"]),
          f"removed={removed}")
    check("function diff adds exactly the 2 new insert lines",
          sorted(added) == sorted(["insert into pending_step_pushes (escrow_id, event, step_title, step_role)",
                                   "values (new.escrow_id, 'step_done', new.title, new.role);",
                                   "insert into pending_step_pushes (escrow_id, event, step_title, step_role)",
                                   "values (new.escrow_id, 'step_done', new.title, new.role);"]),
          f"added={added}")

    # ---- 3. definer discipline ----
    check("SECURITY DEFINER preserved", "security definer" in fn39.lower())
    check("search_path preserved (public, extensions)",
          "set search_path = public, extensions" in fn39.lower())

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        sys.exit(1)
    print("all step-push side-targeting migration checks green")


if __name__ == "__main__":
    main()
