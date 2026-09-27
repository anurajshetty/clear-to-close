#!/usr/bin/env python3
"""push_migration.py — static self-check on supabase/migrations/0008_push_tokens.sql.

The forward-only trigger logic lives in SQL (not runnable in node), so this
test asserts the shipped migration text carries the required transition
guards, the kill switch, the RPCs, and additive-only shape. Run:
  python3 tests/push_migration.py   (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0008_push_tokens.sql")

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
    # Strip -- comments: the kill-switch docs and guard explanations live
    # there; checks below assert on real statements only.
    code = re.sub(r"--[^\n]*", "", src)
    low = code.lower()

    # ---- additive-only (rollback requirement) ----
    check("migration file exists", True)
    check("no DROP TABLE", "drop table" not in low)
    check("no DROP COLUMN", "drop column" not in low)
    check("no RENAME", re.search(r"\brename\b", low) is None)
    check("no ALTER on existing tables", re.search(r"alter table (?!push_tokens|push_config)", low) is None,
          "only push_tokens/push_config may be altered")
    check("existing tables untouched (no add column to steps/escrows/client_links)",
          re.search(r"alter table (steps|escrows|client_links|invites|realtor_profiles)", low) is None)

    # ---- kill switch ----
    check("push_config table created", "create table if not exists push_config" in low)
    check("push_enabled flag seeded true", "'push_enabled', 'true'" in src)
    check("trigger checks push_enabled first",
          re.search(r"select value into v_enabled from push_config where key = 'push_enabled'", src) is not None)
    check("kill-switch update documented", "set value = 'false' where key = 'push_enabled'" in src)
    check("one-statement trigger disable documented", "disable trigger trg_steps_push_notify" in src)

    # ---- forward-only transition guards ----
    check("step INSERT fires only when done=true",
          re.search(r"TG_OP = 'INSERT' and new\.done", src) is not None)
    check("custom insert maps to custom_step_added",
          re.search(r"case when new\.custom then 'custom_step_added'", src) is not None)
    check("step UPDATE fires only on false->true",
          re.search(r"old\.done = false and new\.done = true", src) is not None)
    check("uncheck can never fire (no NEW.done = false arm)",
          re.search(r"new\.done = false", src) is None)
    check("close_date change fires via IS DISTINCT FROM",
          re.search(r"old\.close_date is distinct from new\.close_date", src) is not None)
    check("buyer/seller closed_at never fire",
          "buyer_closed_at" not in low and "seller_closed_at" not in low)

    # ---- transport ----
    check("pg_net extension", "create extension if not exists pg_net" in low)
    check("pg_net http_post used", "net.http_post" in src)
    check("trigger secret header sent", "X-Trigger-Secret" in src)
    check("secret read from Vault", "vault.decrypted_secrets" in src)
    check("secret minted into Vault", "vault.create_secret" in src)
    check("no hardcoded secret value", re.search(r"eyJ[A-Za-z0-9_-]{10,}", src) is None)

    # ---- triggers ----
    check("steps trigger after insert or update",
          re.search(r"after insert or update on steps", low) is not None)
    check("escrows trigger after update",
          re.search(r"after update on escrows", low) is not None)
    check("trg_steps_push_notify named", "trg_steps_push_notify" in src)
    check("trg_escrows_push_notify named", "trg_escrows_push_notify" in src)

    # ---- RPCs ----
    check("register_push_token RPC", "function register_push_token" in low)
    check("unregister_push_token RPC", "function unregister_push_token" in low)
    check("RPCs are SECURITY DEFINER", src.lower().count("security definer") >= 2)
    check("RPCs granted to anon", "to anon, authenticated" in low)
    check("register validates link liveness", "revoked_at is not null" in low)
    check("register derives escrow from link", "v_link.escrow_id" in src)
    check("push_tokens RLS enabled", re.search(r"alter table push_tokens enable row level security", low) is not None)
    check("unique live token per device", "push_tokens_device_uidx" in src)

    if FAILS:
        print(f"\n{len(FAILS)} failure(s)")
        sys.exit(1)
    print("\npush_migration.py: all green")


if __name__ == "__main__":
    main()
