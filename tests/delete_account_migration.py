#!/usr/bin/env python3
"""delete_account_migration.py — static self-check on
supabase/migrations/0052_delete_account.sql (Stream 4, Nov 2026; in-app
account deletion, auditor PASS WITH CONDITIONS).

The deletion data layer lives in SQL (not runnable in node), so this
test asserts the shipped migration text implements the auditor's
binding conditions:

  1. ONE definer RPC, delete_account_data, SECURITY DEFINER with a
     pinned search_path, EXECUTE revoked from public/anon/authenticated
     and granted to service_role ONLY.
  2. The explicit manifest: every table the FK graph ties to the
     caller or their owned escrows is deleted in the function —
     profile, escrows, steps, both intakes, client_links, client
     invites, both push-token classes plus the token-keyed queue and
     reminder rows, reviews, team grants (owned-escrow grants, the
     caller's seats, pending invites to the caller's email),
     owned-escrow activity, team_invite_email_log, delivery log.
  3. The outbox purge is LAST: the pending_event_pushes /
     pending_step_pushes deletes sit after the escrows delete in the
     function body.
  4. A minimal audit table (account_deletion_log: timestamp + counts,
     no personal content) created WITH explicit grants — service_role
     only, RLS on — per the standing explicit-grants rule.

Run: python3 tests/delete_account_migration.py (also wired into
tests/run.sh). The behavioral proof (residue scan, no-one-else
battery) lives in ~/workspace/pg-scratch/proof_0052.py.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0052_delete_account.sql")

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
    code = re.sub(r"--[^\n]*", "", src).lower()

    # 1. The RPC and its grant posture.
    check("defines delete_account_data", "create or replace function" in code and "delete_account_data" in code)
    check("security definer", "security definer" in code)
    check("search_path pinned", "set search_path" in code)
    check(
        "execute revoked from public/anon/authenticated",
        re.search(r"revoke\s+(all|execute)[^;]*delete_account_data[^;]*from[^;]*(public|anon)", code) is not None,
    )
    check(
        "execute granted to service_role",
        re.search(r"grant execute on function[^;]*delete_account_data[^;]*to\s+service_role", code) is not None,
    )
    check(
        "no execute grant to anon/authenticated",
        re.search(r"grant execute on function[^;]*delete_account_data[^;]*to[^;]*\b(anon|authenticated)\b", code) is None,
    )

    # 2. The manifest: every table is an explicit delete target.
    manifest = [
        "push_queue", "push_reminder_log", "push_delivery_log",
        "push_tokens", "reviews", "team_invite_email_log",
        "escrow_team_grants", "escrow_activity", "steps",
        "buyer_intakes", "tc_intakes", "client_links", "invites",
        "escrows", "realtor_profiles",
    ]
    for t in manifest:
        check(f"manifest deletes from {t}", f"delete from {t}" in code or f"delete from public.{t}" in code)
    check("captures owned escrows", "from escrows" in code and "user_id = p_uid" in code)
    check("captures the caller's seats", "user_id = p_uid" in code and "escrow_team_grants" in code)
    check(
        "pending invites to the caller's email are covered",
        "invited_email = p_email" in code,
    )
    check(
        "caller's step stamps on foreign escrows are NOT rewritten",
        "completed_by" not in code and "created_by" not in code,
    )

    # 3. Outbox purge last.
    i_escrows = code.find("delete from escrows")
    i_event = code.find("delete from pending_event_pushes")
    i_step = code.find("delete from pending_step_pushes")
    check("outbox purge present", i_event >= 0 and i_step >= 0)
    check(
        "outbox purge is after the escrows delete",
        i_escrows >= 0 and i_event > i_escrows and i_step > i_escrows,
    )

    # 4. The audit table with explicit grants.
    check("creates account_deletion_log", "create table" in code and "account_deletion_log" in code)
    check("audit table RLS on", re.search(r"alter table[^;]*account_deletion_log[^;]*enable row level security", code) is not None)
    check(
        "audit table granted to service_role",
        re.search(r"grant[^;]*on[^;]*account_deletion_log[^;]*to\s+service_role", code) is not None,
    )
    check(
        "audit table not granted to anon/authenticated",
        re.search(r"grant[^;]*on[^;]*account_deletion_log[^;]*to[^;]*\b(anon|authenticated)\b", code) is None,
    )
    check("audit row inserted by the RPC", "insert into account_deletion_log" in code or "insert into public.account_deletion_log" in code)

    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed")
        sys.exit(1)
    print("\nall green")


if __name__ == "__main__":
    main()
