#!/usr/bin/env python3
"""team_realtime_migration.py — static self-check on
supabase/migrations/0050_realtime_activity.sql.

Live team updates (Nov 2026) need exactly ONE server delta: the
escrow_activity table joins the supabase_realtime publication, so a
member's step/intake/team events can invalidate the owner's open
screens. The auditor's pass was publication-only:

  * escrow_activity added IDEMPOTENTLY (pg_publication_tables guard),
    in the same DO-block style as 0030.
  * NOTHING else: no grants, no policies, no functions — Realtime
    evaluates the EXISTING SELECT policies per subscriber
    (escrow_activity_select, 0044, already has its SELECT grant).
  * escrow_team_grants stays OFF the publication (it has no direct
    SELECT grant by design; roster changes ride escrow_activity).
  * realtor_profiles stays OFF (removed after 0030; not re-added).
  * The header enumerates the publication's membership and documents
    the kill switch.

Run: python3 tests/team_realtime_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0050_realtime_activity.sql")

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
    code = re.sub(r"--[^\n]*", "", src)
    low = code.lower()

    check("migration file exists", True)

    # ---- the one change: escrow_activity joins, idempotently ----
    check("adds escrow_activity to the publication",
          re.search(r"array\[[^\]]*'escrow_activity'", src) is not None)
    check("publication add is idempotent (pg_publication_tables guard)",
          "pg_publication_tables" in src and "supabase_realtime" in src)
    check("alter publication targets supabase_realtime",
          "alter publication supabase_realtime add table" in low)

    # ---- publication-only: nothing else may ride along ----
    check("no GRANT statements", "grant " not in low)
    check("no CREATE POLICY", "create policy" not in low)
    check("no DROP POLICY", "drop policy" not in low)
    check("no functions created or replaced", "create or replace function" not in low)
    check("no ALTER TABLE", "alter table" not in low)
    check("no DROP TABLE", "drop table" not in low)
    check("escrow_team_grants is never added",
          not re.search(r"array\[[^\]]*'escrow_team_grants'", src))
    check("realtor_profiles is not re-added",
          not re.search(r"array\[[^\]]*'realtor_profiles'", src))
    check("client_links is not re-added (already in from 0030)",
          not re.search(r"array\[[^\]]*'client_links'", src))

    # ---- header: enumeration + kill switch ----
    check("header enumerates existing members (escrows, steps, client_links)",
          all(w in src for w in ["escrows", "steps", "client_links"]))
    check("kill switch documented", "KILL SWITCH" in src)
    check("numbering record names 0050", "0050" in src)

    if FAILS:
        print(f"\nteam_realtime_migration: {len(FAILS)} failure(s)")
        sys.exit(1)
    print("\nteam_realtime_migration: all green")


if __name__ == "__main__":
    main()
