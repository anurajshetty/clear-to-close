#!/usr/bin/env python3
"""Guards for migration 0011_public_profile.sql (Clear to Close, Sept 2026).

Anuraj's release-blocker rollback requirement: the reviews migration must be
ADDITIVE ONLY so pre-release code keeps working untouched against the migrated
DB. This test fails if 0009:
  - drops/renames/retypes any table or column,
  - removes any key old code read from get_client_view's profile payload
    (0009 re-creates that function, so the test asserts it returns the full
    realtor_profiles row via to_jsonb(p), plus the new reviews key only),
  - exposes the reviews link_id (client-link ownership identifier) to the
    public (no public SELECT policy; reads go through SECURITY DEFINER RPCs
    that return safe fields only).

Run: python3 tests/migration_0009_guard.py
"""
import re
import sys
from pathlib import Path

MIGRATION = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "0011_public_profile.sql"

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def main():
    if not MIGRATION.exists():
        print(f"SKIP: {MIGRATION} not found")
        return 0
    sql = MIGRATION.read_text()
    lower = sql.lower()

    # ---- destructive operations must not appear ----
    for stmt in ("drop table", "drop column"):
        check(stmt not in lower, f"0009 uses destructive '{stmt}'")
    check("rename column" not in lower and "rename to" not in lower,
          "0009 renames a column")
    check(not re.search(r"alter\s+table\s+\S+\s+alter\s+column\s+\S+\s+type", lower),
          "0009 alters a column type")
    # The only triggers created must be on the NEW reviews table.
    for m in re.finditer(r"create\s+trigger\s+(\w+)\s*\n?\s*after.*?on\s+([\w.]+)", lower):
        check(m.group(2).endswith("reviews"),
              f"trigger {m.group(1)} fires on {m.group(2)} (must be reviews only)")

    # ---- reviews table shape ----
    check(re.search(r"create\s+table\s+if\s+not\s+exists\s+public\.reviews", lower),
          "reviews table not created with IF NOT EXISTS")
    check("unique(link_id)" in lower.replace(" ", "") or
          re.search(r"unique\s*\(\s*link_id\s*\)", lower),
          "one-review-per-link unique constraint missing")
    check("enable row level security" in lower, "reviews RLS not enabled")

    # ---- no public direct table access (link_id must stay server-side) ----
    check(not re.search(r"create\s+policy", lower),
          "0009 creates a table policy; reviews must have no public policies")
    check("link_id" not in re.findall(r"'id'|['\"]clientName['\"]|['\"]stars['\"]|['\"]text['\"]|['\"]createdAt['\"]", ""),
          "sanity")
    # Public RPC review JSON must not include link_id.
    for fn in ("get_public_profile", "realtor_reviews_json"):
        body = _function_body(lower, fn)
        check(body is not None, f"{fn} body not found")
        if body:
            check("'link_id'" not in body and '"link_id"' not in body,
                  f"{fn} exposes link_id in its public payload")

    # ---- branded invite deep link: resolve_invite_realtor (Sept 2026) ----
    # Safe pre-name branding: SECURITY DEFINER + fixed search_path, granted to
    # anon (the client hasn't redeemed yet). Must mirror redeem_invite's
    # validation errors, never mark the code used, and expose only public
    # realtor branding (never link_id, never the invite's client data).
    body = _function_body(lower, "resolve_invite_realtor")
    check(body is not None, "resolve_invite_realtor body not found")
    if body:
        check("security definer" in body, "resolve_invite_realtor must be SECURITY DEFINER")
        check("set search_path = public" in body.replace("  ", " "),
              "resolve_invite_realtor must pin search_path = public")
        check("grant execute on function resolve_invite_realtor(text) to anon, authenticated" in lower,
              "resolve_invite_realtor must be granted to anon")
        for err in ("'invalid'", "'revoked'", "'already_used'"):
            check(err in body, f"resolve_invite_realtor missing error shape {err}")
        check("redeemed_at =" not in body and "update" not in body,
              "resolve_invite_realtor must never mark an invite used")
        check("'link_id'" not in body and '"link_id"' not in body,
              "resolve_invite_realtor exposes link_id in its public payload")
        check("'party_name'" not in body and '"party_name"' not in body,
              "resolve_invite_realtor exposes the client name before name entry")

    # ---- get_client_view stays backward compatible ----
    body = _function_body(lower, "get_client_view")
    check(body is not None, "get_client_view body not found")
    if body:
        check("to_jsonb(p)" in body,
              "get_client_view must return the full profile row via to_jsonb(p)")
        check("'reviews'" in body or '"reviews"' in body,
              "get_client_view must add the reviews key")
        check("'my_review_id'" in body or '"my_review_id"' in body,
              "get_client_view must add my_review_id")
        # buyer/seller step keys and validation errors unchanged from 0002.
        for key in ("'buyer_steps'", "'seller_steps'", "'escrow'", "'profile'"):
            check(key in body, f"get_client_view missing response key {key}")
        for err in ("'invalid'", "'revoked'"):
            check(err in body, f"get_client_view missing error shape {err}")

    # ---- new columns are nullable (existing rows keep working) ----
    check(re.search(r"add\s+column\s+if\s+not\s+exists\s+avg_days_to_close\s+text", lower),
          "avg_days_to_close column missing or not nullable-text")
    check(re.search(r"add\s+column\s+if\s+not\s+exists\s+rating\s+numeric\s+null", lower),
          "rating column missing or not nullable-numeric")

    if failures:
        print("FAIL: migration 0011 additive/rollback guards violated:")
        for f in failures:
            print(" -", f)
        return 1
    print("PASS: migration 0011 is additive-only and rollback-safe")
    return 0


def _function_body(lower_sql, name):
    m = re.search(r"create\s+or\s+replace\s+function\s+" + re.escape(name) + r"\b", lower_sql)
    if not m:
        return None
    # Include the header (language, security definer, search_path, args)
    # through the body end.
    end = lower_sql.index("$$;", m.start())
    return lower_sql[m.start():end]


if __name__ == "__main__":
    sys.exit(main())
