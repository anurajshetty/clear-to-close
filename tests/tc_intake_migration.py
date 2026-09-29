#!/usr/bin/env python3
"""tc_intake_migration.py — static self-check on supabase/migrations/0031_tc_intake.sql.

The TC intake data model lives in SQL (not runnable in node), so this test
asserts the shipped migration text implements Anuraj's approved rules
(Sept 29, 2026, mockup 04):
  1. tc_intakes: escrow_id uuid PK -> escrows(id) on delete cascade,
     owner_id uuid not null, data jsonb default '{}', updated_at default now().
  2. RLS enabled; the only direct-access policy is owner-only
     (auth.uid() = owner_id, both using and with check).
  3. No grant to anon on the table — anonymous clients can never query it
     directly; the TC reads it only through get_client_view.
  4. get_client_view is replaced in full: the tc branch embeds 'tc_intake'
     as the DATA payload only (select data ...; never to_jsonb of the row,
     so owner_id and other row metadata never leave the server). The buyer
     and seller branches carry NO tc_intake key at all (not even null).

Run: python3 tests/tc_intake_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0031_tc_intake.sql")

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
    # Strip -- comments for statement checks.
    code = re.sub(r"--[^\n]*", "", src)

    # 1. Table shape.
    check("tc_intakes table created", "create table" in code and "tc_intakes" in code)
    check(
        "escrow_id uuid primary key references escrows(id) on delete cascade",
        re.search(r"escrow_id\s+uuid\s+primary\s+key\s+references\s+escrows\s*\(\s*id\s*\)\s+on\s+delete\s+cascade", code, re.I) is not None,
    )
    check("owner_id uuid not null", re.search(r"owner_id\s+uuid\s+not\s+null", code, re.I) is not None)
    check(
        "data jsonb not null default '{}'",
        re.search(r"data\s+jsonb\s+not\s+null\s+default\s+'\{\}'::jsonb", code, re.I) is not None,
    )
    check("updated_at timestamptz default now()", re.search(r"updated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)", code, re.I) is not None)

    # 2. RLS: enabled, owner-only policy.
    check("RLS enabled on tc_intakes", re.search(r"enable\s+row\s+level\s+security", code, re.I) is not None)
    check(
        "owner-only policy (using + with check on auth.uid() = owner_id)",
        re.search(r"using\s*\(\s*auth\.uid\(\)\s*=\s*owner_id\s*\)", code, re.I) is not None
        and re.search(r"with\s+check\s*\(\s*auth\.uid\(\)\s*=\s*owner_id\s*\)", code, re.I) is not None,
    )

    # 3. No anon grant on the table.
    check(
        "no grant to anon on tc_intakes",
        re.search(r"grant\s+[^;]*on\s+tc_intakes\s+to\s+[^;]*\banon\b", code, re.I) is None,
        "anon must never query the table directly",
    )
    check(
        "authenticated gets direct table access",
        re.search(r"grant\s+[^;]*on\s+tc_intakes\s+to\s+authenticated", code, re.I) is not None,
    )

    # 4. get_client_view replacement.
    check("get_client_view replaced", "create or replace function get_client_view" in code)
    check("function stays security definer", re.search(r"security\s+definer", code, re.I) is not None)
    tc_branch = code.split("if v_link.role = 'tc' then")
    check("tc branch present", len(tc_branch) == 2)
    if len(tc_branch) == 2:
        tc_body, rest = tc_branch[1].split("end if;", 1)
        check("'tc_intake' embedded in the tc branch", "'tc_intake'" in tc_body)
        check(
            "intake selected as data only (no to_jsonb of the row)",
            re.search(r"select\s+data\s+into\s+v_tc_intake", tc_body, re.I) is not None
            and "to_jsonb(tc_intakes)" not in tc_body,
            "owner_id must never leave the server",
        )
        buyer_seller = rest
        check(
            "buyer/seller branches carry no tc_intake key",
            "tc_intake" not in buyer_seller,
            "buyer and seller client views must never see intake data",
        )
    check("execute grant restated for anon, authenticated", re.search(r"grant\s+execute\s+on\s+function\s+get_client_view\(uuid\)\s+to\s+anon,\s*authenticated", code, re.I) is not None)

    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed")
        sys.exit(1)
    print("\ntc_intake_migration: all green")


main()
