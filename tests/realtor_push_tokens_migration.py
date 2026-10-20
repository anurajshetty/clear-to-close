#!/usr/bin/env python3
"""realtor_push_tokens_migration.py — static self-check on
supabase/migrations/0038_realtor_push_tokens.sql.

P0 notification foundations (Oct 15, 2026): authenticated realtors can
register their own devices for push. The auditor's binding requirements
are the contract this test pins:

  1. Identity is DERIVED, never supplied: no function in the migration
     takes a user-id parameter; the realtor functions stamp auth.uid().
  2. Streams separated by JWT/grant: the realtor register overload is a
     (text, text, text) signature granted to `authenticated` only; the
     client register overloads (p_link_id uuid, ...) are NOT redefined
     anywhere in this file (their anon grants/model stay byte-identical).
  3. Exactly-one-binding CHECK on push_tokens: link-bound (link + escrow
     set, user null) XOR user-bound (user set, link + escrow null).
  4. Partial unique index on (device_id, user_id) WHERE user_id IS NOT
     NULL, and the registration upsert's conflict target repeats the
     predicate (H3/42P10 lesson).
  5. Rebind: registration deletes other users' user-bound rows for the
     same device_id before the upsert.
  6. Sign-out unregister + M6b prune exist, derive identity the same way,
     and are authenticated-only.
  7. Every new function is SECURITY DEFINER with search_path = public.

Run: python3 tests/realtor_push_tokens_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0038_realtor_push_tokens.sql")

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

    # ---- 1. derived identity: no user-id parameter anywhere ----
    check("no p_user_id parameter exists", "p_user_id" not in low)
    check("no parameter of any name carries a user id into register",
          re.search(r"register_push_token\s*\([^)]*user[^)]*\)", low) is None)
    check("realtor functions derive identity via auth.uid()",
          low.count("auth.uid()") >= 3)
    check("realtor functions check the JWT role claim",
          low.count("auth.jwt() ->> 'role'") >= 3)

    # ---- 2. distinct function name (v2) + grant posture ----
    check("client register overloads are NOT redefined (no p_link_id here)",
          "p_link_id" not in low)
    check("v2: realtor registration is NOT a register_push_token overload",
          re.search(r"create\s+or\s+replace\s+function\s+register_push_token\s*\(",
                    low) is None)
    check("realtor register is register_push_token_for_user (text, text, text)",
          re.search(r"create\s+or\s+replace\s+function\s+register_push_token_for_user\(\s*"
                    r"p_device_id\s+text\s*,\s*p_token\s+text\s*,\s*p_timezone\s+text\s+default\s+null\s*\)",
                    low) is not None)
    check("realtor register granted to authenticated only",
          re.search(r"grant\s+execute\s+on\s+function\s+register_push_token_for_user\(text,\s*text,\s*text\)\s+to\s+authenticated\s*;",
                    low) is not None)
    check("no grant of the realtor register to anon",
          re.search(r"grant\s+execute\s+on\s+function\s+register_push_token_for_user\(text,\s*text,\s*text\)\s+to\s+anon",
                    low) is None)
    # v2 (a): the wall must not rest on role checks alone - every
    # authenticated function carries an explicit revoke from public/anon.
    for fn, sig in [
        ("register_push_token_for_user", "text, text, text"),
        ("unregister_push_token_for_user", "text"),
        ("unregister_push_tokens_except_device", "text"),
    ]:
        check(f"v2: explicit revoke from public, anon on {fn}",
              re.search(rf"revoke\s+execute\s+on\s+function\s+{fn}\({re.escape(sig)}\)\s+from\s+public,\s*anon\s*;",
                        low) is not None)


    # ---- 3. exactly-one-binding shape ----
    check("user_id column added with auth.users FK + cascade",
          re.search(r"add\s+column\s+if\s+not\s+exists\s+user_id\s+uuid\s+references\s+auth\.users\(id\)\s+on\s+delete\s+cascade",
                    low) is not None)
    check("escrow_id and link_id become nullable",
          "alter column escrow_id drop not null" in low and "alter column link_id drop not null" in low)
    check("exactly-one-binding CHECK present with both disjuncts",
          "push_tokens_exactly_one_binding" in low
          and "(link_id is not null and escrow_id is not null and user_id is null)" in low
          and "(link_id is null and escrow_id is null and user_id is not null)" in low)

    # ---- 4. partial unique index + matching conflict target ----
    check("partial unique index on (device_id, user_id) with predicate",
          re.search(r"create\s+unique\s+index\s+if\s+not\s+exists\s+push_tokens_device_user_uidx\s+"
                    r"on\s+push_tokens\s*\(device_id,\s*user_id\)\s+where\s+user_id\s+is\s+not\s+null",
                    low) is not None)
    check("upsert conflict target repeats the predicate (H3)",
          re.search(r"on\s+conflict\s*\(device_id,\s*user_id\)\s+where\s+user_id\s+is\s+not\s+null\s+do\s+update",
                    low) is not None)

    # ---- 5. rebind on registration ----
    check("registration deletes other users' rows for the device first",
          re.search(r"delete\s+from\s+push_tokens\s+where\s+device_id\s*=\s*trim\(p_device_id\)\s+"
                    r"and\s+user_id\s+is\s+not\s+null\s+and\s+user_id\s*<>\s*v_uid",
                    low) is not None)

    # ---- 6. sign-out unregister + M6b prune ----
    check("unregister_push_token_for_user(text) exists, authenticated only",
          re.search(r"create\s+or\s+replace\s+function\s+unregister_push_token_for_user\(\s*p_device_id\s+text\s*\)",
                    low) is not None
          and re.search(r"grant\s+execute\s+on\s+function\s+unregister_push_token_for_user\(text\)\s+to\s+authenticated\s*;",
                        low) is not None)
    check("unregister deletes only the caller's row for this device",
          re.search(r"delete\s+from\s+push_tokens\s+where\s+user_id\s*=\s*v_uid\s+and\s+device_id\s*=\s*trim\(p_device_id\)",
                    low) is not None)
    check("unregister_push_tokens_except_device(text) exists, authenticated only",
          re.search(r"create\s+or\s+replace\s+function\s+unregister_push_tokens_except_device\(\s*p_device_id\s+text\s*\)",
                    low) is not None
          and re.search(r"grant\s+execute\s+on\s+function\s+unregister_push_tokens_except_device\(text\)\s+to\s+authenticated\s*;",
                        low) is not None)
    check("prune keeps the current device row (device_id <> param)",
          re.search(r"delete\s+from\s+push_tokens\s+where\s+user_id\s*=\s*v_uid\s+and\s+device_id\s*<>\s*trim\(p_device_id\)",
                    low) is not None)

    # ---- 7. definer discipline ----
    check("every new function is SECURITY DEFINER with search_path pinned",
          low.count("security definer") >= 4 and low.count("set search_path = public") >= 4)

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        sys.exit(1)
    print("all realtor-push-token migration checks green")


if __name__ == "__main__":
    main()
