#!/usr/bin/env python3
"""redeem_copy_check — the redeem error-code copy lands VERBATIM on the
redeem screen (Oct 2026, app batch stream C).

The server's role_mismatch / expired / too_many_attempts codes are mapped to
their approved copy in app/redeem.tsx's ERROR_COPY. This check pins the exact
strings — punctuation included (plain hyphens; Anuraj's standing no-em-dash
rule). Fails if a code is missing from ERROR_COPY or its copy was altered.

Usage: python3 tests/redeem_copy_check.py   (also wired into tests/run.sh)
Exit 1 with the offending detail if any check fails.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REDEEM = os.path.join(ROOT, "app", "redeem.tsx")

EXPECTED = {
    "role_mismatch": "This device is already linked to this escrow in a different role - ask your realtor for help.",
    "expired": "This code has expired - ask your realtor for a new one.",
    "too_many_attempts": "Too many attempts - ask your realtor for a new code.",
}

failures = []

try:
    with open(REDEEM, "r", encoding="utf-8") as f:
        src = f.read()
except OSError as e:
    print(f"FAIL: cannot read {REDEEM}: {e}")
    sys.exit(1)

# Scope the check to the ERROR_COPY literal so a stray occurrence in a
# comment or test does not count as the mapping.
m = re.search(r"const ERROR_COPY[^=]*=\s*\{(.*?)\};", src, re.DOTALL)
if not m:
    print("FAIL: ERROR_COPY literal not found in app/redeem.tsx")
    sys.exit(1)
block = m.group(1)

for code, copy in EXPECTED.items():
    entry = re.search(rf"{re.escape(code)}\s*:\s*(['\"])(.*?)\1", block, re.DOTALL)
    if not entry:
        failures.append(f"'{code}' has no entry in ERROR_COPY")
        continue
    actual = entry.group(2)
    if actual != copy:
        failures.append(
            f"'{code}' copy mismatch:\n  expected: {copy!r}\n  actual:   {actual!r}"
        )
    if "—" in actual or "–" in actual:
        failures.append(f"'{code}' copy contains an em/en dash (must use hyphens)")

if failures:
    print("FAIL: redeem copy check")
    for f_ in failures:
        print(" -", f_)
    sys.exit(1)

print(f"OK: redeem copy check ({len(EXPECTED)} codes verbatim in ERROR_COPY)")
