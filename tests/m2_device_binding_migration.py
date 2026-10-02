#!/usr/bin/env python3
"""m2_device_binding_migration.py — static self-check on
supabase/migrations/0037_unregister_push_token_device_binding.sql.

M2 staged lockstep (Oct 1, 2026), STAGE 1 (DB, backward-compatible): the
unregister_push_token_for_link bearer-only RPC gains an OPTIONAL p_device_id
(default null). When supplied AND the link's bound device differs, the delete
is rejected; otherwise behavior is unchanged (old app versions keep working).

The SQL is not runnable in node, so this test asserts the shipped migration
text implements the stage-1 contract:
  1. Exactly one unregister_push_token_for_link function survives: the old
     1-arg signature is dropped first (CREATE OR REPLACE with a changed
     argument list would create a second overload and leave the bearer-only
     1-arg version live).
  2. The new signature is (uuid, text default null) — old 1-arg callers
     resolve against it via the default.
  3. SECURITY DEFINER + set search_path = public, matching the original.
  4. Mismatch rule: p_device_id non-null AND bound device_id non-null AND
     different -> no delete (early return with device_mismatch).
  5. Backward-compat paths preserved: p_device_id null, link device null, or
     ids matching -> the link's token rows are deleted.
  6. anon + authenticated execute grant on the new (uuid, text) signature.

Run: python3 tests/m2_device_binding_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0037_unregister_push_token_device_binding.sql")

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
    low = code.lower()

    # ---- 1. single surviving function: drop the old 1-arg signature first ----
    check("drops the old 1-arg signature before recreate",
          re.search(r"drop\s+function\s+if\s+exists\s+unregister_push_token_for_link\s*\(\s*uuid\s*\)",
                    low) is not None)
    check("no CREATE OR REPLACE that would leave a 1-arg overload",
          "create or replace function unregister_push_token_for_link" not in low)

    # ---- 2. new signature: (uuid, text default null) ----
    check("new signature has optional p_device_id with default null",
          re.search(r"create\s+function\s+unregister_push_token_for_link\s*\(\s*"
                    r"p_link_id\s+uuid\s*,\s*p_device_id\s+text\s+default\s+null\s*\)",
                    low) is not None)

    # ---- 3. definer + search_path match the original (0022) ----
    check("SECURITY DEFINER preserved", "security definer" in low)
    check("set search_path = public preserved",
          re.search(r"set\s+search_path\s*=\s*public", low) is not None)

    # ---- 4. mismatch rule: supplied + bound + different -> no delete ----
    body = low
    check("reads the link's bound device_id from client_links",
          re.search(r"select\s+device_id\s+into\s+v_bound_device\s+from\s+client_links\s+"
                    r"where\s+id\s*=\s*p_link_id", body) is not None)
    check("rejects when p_device_id is set and differs from the bound device",
          re.search(r"if\s+p_device_id\s+is\s+not\s+null\s+and\s+"
                    r"v_bound_device\s+is\s+not\s+null\s+and\s+"
                    r"v_bound_device\s*<>\s*p_device_id\s+then", body) is not None)
    check("mismatch path returns before the delete",
          body.index("device_mismatch") < body.index("delete from push_tokens"))
    check("mismatch return signals ok=false",
          re.search(r"return\s+jsonb_build_object\s*\(\s*'ok'\s*,\s*false", body) is not None)

    # ---- 5. backward-compat: the delete still fires on the other paths ----
    check("delete targets the link's token rows",
          re.search(r"delete\s+from\s+push_tokens\s+where\s+link_id\s*=\s*p_link_id", low) is not None)
    check("match path returns ok=true",
          re.search(r"return\s+jsonb_build_object\s*\(\s*'ok'\s*,\s*true\s*\)", low) is not None)

    # ---- 6. grant on the new signature ----
    check("grant execute on (uuid, text) to anon, authenticated",
          re.search(r"grant\s+execute\s+on\s+function\s+unregister_push_token_for_link\s*\(\s*"
                    r"uuid\s*,\s*text\s*\)\s+to\s+anon\s*,\s*authenticated", low) is not None)
    check("no stale grant on the dropped 1-arg signature",
          not re.search(r"grant\s+execute\s+on\s+function\s+unregister_push_token_for_link\s*\(\s*"
                        r"uuid\s*\)\s+to", low))

    # ---- stage-1 does not enforce: null p_device_id must NOT be rejected ----
    check("stage-1 stays permissive: no null-device rejection",
          not re.search(r"if\s+p_device_id\s+is\s+null\s+then", low))

    if FAILS:
        print(f"\n{len(FAILS)} check(s) FAILED")
        sys.exit(1)
    print("\nAll M2 stage-1 migration checks passed.")


main()
