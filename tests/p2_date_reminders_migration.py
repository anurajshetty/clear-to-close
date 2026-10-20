#!/usr/bin/env python3
"""P2 date-reminder invariants (0041), statically checked.

The candidates function, the fire-once claim log, the C1 service-role
hardening, and the third cron job are all verified against the
migration text. Runtime behavior (Postgres) is not exercised here.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase/migrations/0041_p2_date_reminders.sql").read_text()
low = SQL.lower()

failures = []


def check(name, ok):
    if not ok:
        failures.append(name)
    print(("ok   " if ok else "FAIL ") + name)


# 1. Candidates function posture (C1: service-role-only from birth).
check("due_date_reminders exists", "create or replace function due_date_reminders(" in low)
check("candidates fn is SECURITY DEFINER", "security definer" in low)
check(
    "candidates fn EXECUTE revoked from public/anon/authenticated",
    "revoke execute on function public.due_date_reminders() from public, anon, authenticated;" in low,
)
check(
    "candidates fn EXECUTE granted to service_role",
    "grant execute on function public.due_date_reminders() to service_role;" in low,
)
check(
    "safe-date helper born service-role-only too",
    "revoke execute on function public.ctc_safe_date(text) from public, anon, authenticated;" in low
    and "grant execute on function public.ctc_safe_date(text) to service_role;" in low,
)
check("safe date returns null on garbage (exception guard)", "exception when others" in low)

# 2. Candidate semantics: per-token timezone math + thresholds + audiences.
check("days computed via the guarded zone helper", "now() at time zone ctc_push_zone(pt.timezone)" in low)
check("zone helper exists (pg_timezone_names validity)", "create or replace function ctc_push_zone(" in low and "pg_timezone_names" in low)
check(
    "zone helper born service-role-only",
    "revoke execute on function public.ctc_push_zone(text) from public, anon, authenticated;" in low
    and "grant execute on function public.ctc_push_zone(text) to service_role;" in low,
)
check("no raw coalesce timezone remains in the migration", "coalesce(pt.timezone" not in low)
check("closing thresholds are 7/3/1", "in (7, 3, 1)" in low)
check("deadline candidates restricted to buyer+tc", "cl.role in ('buyer', 'tc')" in low)
check("possession candidates restricted to seller", "cl.role = 'seller'" in low)
check("possession date read from buyer_intakes data", "ctc_safe_date(bi.data->>'possession')" in low)
check("realtor candidates join user-bound tokens", "join push_tokens pt on pt.user_id = e.user_id" in low)
check("only open escrows", "e.status = 'open'" in low)
check("live links only (revocation respected)", "cl.revoked_at is null" in low and "i.revoked_at is null" in low)

# 3. Fire-once claim log.
check("push_reminder_log exists", "create table if not exists push_reminder_log" in low)
check(
    "claim unique key = escrow/event/threshold/date/token",
    re.search(
        r"unique index if not exists push_reminder_log_claim_idx\s+on push_reminder_log \(escrow_id, event, threshold, date_value, expo_push_token\)",
        low,
    )
    is not None,
)
check("reminder log RLS enabled", "alter table push_reminder_log enable row level security" in low)
check(
    "reminder log has no table grants/policies (service-role only)",
    "grant" not in low.split("push_reminder_log enable row level security")[0].split("create table if not exists push_reminder_log")[1]
    and "create policy" not in low,
)

# 4. Queue kind + cron.
check("push_queue kind gains 'reminder'", "'reminder'" in low and "push_queue_kind_check" in low)
check("third cron job scheduled", "cron.schedule('ctc_date_reminders', '23 * * * *'" in low)
check("cron pings via push_cron_ping", "push_cron_ping('date_reminder_sweep')" in low)

if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print("\nall p2_date_reminders_migration checks passed")
