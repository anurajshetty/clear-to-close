#!/usr/bin/env python3
"""Clear to Close — regenerate the dashboard-paste single file for the
client-realtime-token Edge Function.

Canonical source: supabase/functions/client-realtime-token/index.ts
(self-contained — no imports to inline). The dashboard-paste artifact is
GENERATED — never hand-edit it. Fix the source and re-run this script.

Usage: python3 tools/make_client_realtime_token_single.py
Writes: ~/workspace/your_files/client-realtime-token-single.ts
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "supabase", "functions", "client-realtime-token", "index.ts")
OUT = os.path.expanduser("~/workspace/your_files/client-realtime-token-single.ts")

# Markers that MUST be present in the generated file (known-fix guards).
REQUIRED_MARKERS = [
    "client-realtime-token",   # function identity
    "TOKEN_TTL_SECONDS",       # short-lived token constant
    "SUPABASE_JWT_SECRET",     # signs with the project JWT secret, env-only
    "device_link_id",          # claim the 0030 RLS policies read
    "escrow_id",               # claim the 0030 RLS policies read
    "device_mismatch",         # device-binding enforcement
    "revoked",                 # revoked links never mint
    "HS256",                   # signing algorithm
]

# Strings that must NEVER appear (secret hygiene).
FORBIDDEN = [
    "service_role_key_value",
    "eyJhbGciOi",  # no baked-in JWTs
]


def main() -> None:
    with open(SRC, "r", encoding="utf-8") as f:
        src = f.read()
    missing = [m for m in REQUIRED_MARKERS if m not in src]
    if missing:
        raise SystemExit("missing required markers: %s" % ", ".join(missing))
    bad = [b for b in FORBIDDEN if b in src]
    if bad:
        raise SystemExit("forbidden strings present: %s" % ", ".join(bad))
    header = (
        "// GENERATED — do not hand-edit. Source:\n"
        "// supabase/functions/client-realtime-token/index.ts\n"
        "// Regenerate: python3 tools/make_client_realtime_token_single.py\n\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header + src)
    print("wrote %s (%d bytes)" % (OUT, len(header) + len(src)))


if __name__ == "__main__":
    main()
