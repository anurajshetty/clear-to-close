#!/usr/bin/env python3
"""client_realtime_migration.py — static self-check on
supabase/migrations/0030_client_realtime.sql.

The realtime security model lives in SQL (not runnable in node), so this
test asserts the shipped migration text implements the approved design
(Sept 2026):

  * escrows, steps, client_links, realtor_profiles join the
    supabase_realtime publication (idempotently).
  * SELECT grants to anon are RLS-gated: four TO anon policies keyed on
    the short-lived JWT claims (device_link_id, escrow_id) minted by the
    client-realtime-token Edge Function.
  * client_links exposes the client's OWN row without a revoked_at
    filter (so the client observes its own revocation); steps/escrows/
    realtor_profiles additionally require a LIVE link (revoked_at IS NULL
    on both link and invite) — revocation cuts the event stream at the DB.
  * The stock anon key (no token claims) matches zero rows.
  * Additive-only: no existing policy/function/trigger touched.

Run: python3 tests/client_realtime_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0030_client_realtime.sql")

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

    # ---- additive-only (rollback requirement, Anuraj Sept 26 2026) ----
    check("no DROP TABLE", "drop table" not in low)
    check("no DROP COLUMN", "drop column" not in low)
    check("no ALTER TABLE", "alter table" not in low)
    check("no existing function replaced except ctc_client_* helpers",
          len(re.findall(r"create or replace function (?!ctc_client_)", low)) == 0)
    check("existing owner policies untouched",
          "realtor_profiles_owner" not in src and "escrows_owner" not in src
          and "steps_owner" not in src)

    # ---- publication membership (idempotent DO block) ----
    for t in ["escrows", "steps", "client_links", "realtor_profiles"]:
        check(f"publication adds {t}",
              re.search(r"array\[[^\]]*'" + t + r"'", src) is not None)
    check("publication add is idempotent (pg_publication_tables guard)",
          "pg_publication_tables" in src)

    # ---- grants are SELECT-only, to anon (RLS still enforced) ----
    for t in ["escrows", "steps", "client_links", "realtor_profiles"]:
        check(f"grant select on {t} to anon",
              re.search(r"grant select on public\." + t + r" to anon", low) is not None)
    check("no INSERT/UPDATE/DELETE grant to anon",
          not re.search(r"grant (insert|update|delete)", low))

    # ---- the four client policies ----
    check("client_links self policy (own row only)",
          "create policy client_links_client_self" in low)
    check("steps live-link policy", "create policy steps_client_live" in low)
    check("escrows live-link policy", "create policy escrows_client_live" in low)
    check("realtor_profiles live-link policy",
          "create policy realtor_profiles_client_live" in low)
    check("all four are SELECT-only TO anon",
          len(re.findall(r"for select\s+to anon", low)) == 4,
          f"found {len(re.findall(r'for select\\s+to anon', low))}")
    check("no policy grants to authenticated (realtor sessions unaffected)",
          "to authenticated" not in low)

    # ---- token-claim keying ----
    check("policies read device_link_id claim",
          "device_link_id" in src)
    check("policies read escrow_id claim", "escrow_id" in src)
    check("claim readers are null-safe (nullif)",
          src.count("nullif(auth.jwt()") >= 2)

    # ---- liveness: revocation cuts steps/escrows/profile at the DB ----
    check("liveness helper checks link revoked_at",
          "cl.revoked_at is null" in low)
    check("liveness helper checks invite revoked_at",
          "i.revoked_at is null" in low)
    check("steps policy requires live link",
          re.search(r"steps_client_live[\s\S]*?ctc_client_link_live", low) is not None)
    check("escrows policy requires live link",
          re.search(r"escrows_client_live[\s\S]*?ctc_client_link_live", low) is not None)

    # ---- the client's own link row must NOT be revoked-filtered ----
    m = re.search(r"create policy client_links_client_self[\s\S]*?;", low)
    check("client_links self policy has no revoked_at filter (sees own revocation)",
          m is not None and "revoked_at" not in m.group(0))

    # ---- realtime profile scoped to the token escrow's realtor ----
    check("profile policy scopes to the escrow owner",
          re.search(r"realtor_profiles_client_live[\s\S]*?user_id\s*=", low) is not None)

    # ---- kill switch documented ----
    check("kill switch documented", "KILL SWITCH" in src)

    # ---- numbering record ----
    check("numbering record names 0030 and warns multi-escrow off it",
          "0030" in src and "0022" in src)

    if FAILS:
        print(f"\nclient_realtime_migration: {len(FAILS)} failure(s)")
        sys.exit(1)
    print("\nclient_realtime_migration: all green")


if __name__ == "__main__":
    main()
