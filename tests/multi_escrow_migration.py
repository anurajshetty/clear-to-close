#!/usr/bin/env python3
"""multi_escrow_migration.py — static self-check on supabase/migrations/0022_multi_escrow.sql.

The multi-escrow data model lives in SQL (not runnable in node), so this
test asserts the shipped migration text implements Anuraj's approved rules
(Sept 28, 2026):
  1. One live link per (device_id, escrow_id) — the 0002 device-wide index is
     gone, replaced by the (device_id, escrow_id) partial unique index.
  2. redeem_invite is idempotent for same-device/same-escrow: it returns the
     existing link instead of minting a duplicate, including under a
     concurrent-redeem race (unique_violation backstop).
  3. Push tokens are link-scoped: unique (device_id, link_id); the upsert
     targets (device_id, link_id); a per-link unregister RPC exists.

Run: python3 tests/multi_escrow_migration.py (also wired into tests/run.sh)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, "supabase", "migrations", "0022_multi_escrow.sql")

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

    # ---- additive-safe (Anuraj Sept 26 2026: rollback requirement) ----
    check("migration file exists", True)
    check("no DROP TABLE", "drop table" not in low)
    check("no DROP COLUMN", "drop column" not in low)

    # ---- 1. device-link index: (device_id, escrow_id) ----
    check("drops the old device-wide index",
          "drop index if exists client_links_device_live_uidx" in low)
    check("creates the (device_id, escrow_id) live unique index",
          re.search(r"create unique index if not exists client_links_device_escrow_live_uidx\s+"
                    r"on client_links\s*\(\s*device_id\s*,\s*escrow_id\s*\)", low) is not None)
    check("new index keeps the live-link predicate (revoked_at is null)",
          re.search(r"client_links_device_escrow_live_uidx.*?where device_id is not null and revoked_at is null",
                    low, re.DOTALL) is not None)
    check("no device-wide live-link unique index remains",
          not re.search(r"create unique index[^\n]*on client_links\s*\(\s*device_id\s*\)", low))

    # ---- 2. idempotent redeem_invite ----
    check("redeem_invite keeps the (text, text, text) signature",
          "create or replace function redeem_invite(p_code text, p_name text, p_device_id text default null)" in low)
    check("name check still precedes the idempotent return",
          low.index("lower(trim(v_invite.party_name))") < low.index("reused', true"),
          "a wrong name must never ride an existing link")
    check("same-device/same-escrow returns the existing link",
          re.search(r"where device_id = v_device\s+and escrow_id = v_invite\.escrow_id\s+and revoked_at is null",
                    low) is not None)
    check("idempotent return carries the existing link_id",
          "'link_id',v_link.id" in low.replace(" ", ""))
    check("concurrent-redeem race caught (unique_violation backstop)",
          "exception when unique_violation" in low)
    check("same-code race guard unchanged (redeemed_at)",
          "where id = v_invite.id and redeemed_at is null" in low)
    # Concurrent same-code/same-device redeem: the loser of the guarded
    # redeemed_at update re-queries the live (device, escrow) link and
    # returns it (one link, both callers) instead of always failing with
    # already_used. (Comment text is stripped by the harness, so these
    # match the SQL statements inside the `if not found` race branch.)
    check("race loser re-checks the live (device, escrow) link before failing",
          re.search(r"where id = v_invite\.id and redeemed_at is null;\s*"
                    r"if not found then\s+"
                    r"select \* into v_link\s+from client_links\s+"
                    r"where device_id = v_device\s+and escrow_id = v_invite\.escrow_id\s+and revoked_at is null",
                    low, re.DOTALL) is not None)
    check("race loser returns the winner's link when it exists",
          re.search(r"where id = v_invite\.id and redeemed_at is null;\s*"
                    r"if not found then.*?if found then.*?return jsonb_build_object\(\s*"
                    r"'ok', true,.*?'link_id', v_link\.id,.*?'reused', true",
                    low, re.DOTALL) is not None)
    check("race loser still reports already_used with no live link",
          re.search(r"where id = v_invite\.id and redeemed_at is null;\s*"
                    r"if not found then.*?if found then.*?end if;\s*"
                    r"return jsonb_build_object\('ok', false, 'error', 'already_used'\);",
                    low, re.DOTALL) is not None)
    check("redeem grants preserved", "grant execute on function redeem_invite(text, text, text)" in low)

    # ---- 3. link-scoped push tokens ----
    check("drops the device-wide token index",
          "drop index if exists push_tokens_device_uidx" in low)
    check("creates the (device_id, link_id) token unique index",
          re.search(r"create unique index if not exists push_tokens_device_link_uidx\s+"
                    r"on push_tokens\s*\(\s*device_id\s*,\s*link_id\s*\)", low) is not None)
    check("register_push_token upserts on (device_id, link_id)",
          "on conflict (device_id, link_id)" in low)
    check("register_push_token still rejects revoked links",
          "if v_link.revoked_at is not null" in low)
    check("per-link unregister RPC exists",
          "create or replace function unregister_push_token_for_link(p_link_id uuid)" in low)
    check("per-link unregister deletes by link_id only",
          re.search(r"unregister_push_token_for_link.*?delete from push_tokens where link_id = p_link_id",
                    low, re.DOTALL) is not None)
    check("per-link unregister grant",
          "grant execute on function unregister_push_token_for_link(uuid)" in low)

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        sys.exit(1)
    print("all multi-escrow migration checks passed")


if __name__ == "__main__":
    main()
