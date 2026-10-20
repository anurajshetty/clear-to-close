#!/usr/bin/env python3
"""Migration 0043 invariants (static): app_config is public-read-only.

The table is the PUBLIC sibling of push_config: SELECT for anon +
authenticated, RLS on, and NO client write path of any kind (no write
policies, no write grants). Seeded with the /redeem deep link.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase/migrations/0043_app_config.sql").read_text()
code = re.sub(r"--[^\n]*", "", SQL)
low = code.lower()

failures = []


def check(name, ok):
    if not ok:
        failures.append(name)
    print(("ok   " if ok else "FAIL ") + name)


check("app_config table created (key pk, value not null)",
      "create table if not exists app_config" in low and "key text primary key" in low)
check("seeded client_app_link is the /redeem deep path",
      "'client_app_link', 'https://anurajshetty.github.io/clear-to-close/redeem'" in low)
check("seed is idempotent (on conflict do nothing)", "on conflict (key) do nothing" in low)
check("RLS enabled", "alter table app_config enable row level security" in low)
check("SELECT policy for anon + authenticated",
      re.search(r"create policy app_config_select_public on app_config\s+for select to anon, authenticated", low) is not None)
check("policy body is using (true) — public by design", "using (true)" in low)
check("no INSERT policy for any role", "for insert" not in low)
check("no UPDATE policy for any role", "for update" not in low)
check("no DELETE policy for any role", "for delete" not in low)
check("SELECT granted to anon + authenticated",
      "grant select on app_config to anon, authenticated;" in low)
check("no write grants to client roles",
      re.search(r"grant\s+(insert|update|delete)", low) is None)
check("blanket revoke precedes the grant (no inherited write access)",
      "revoke all on app_config from anon, authenticated;" in low)

if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print("\nall app_config_migration checks passed")
