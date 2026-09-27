#!/usr/bin/env python3
"""Clear to Close — regression guard: deals-closed count is gone (Sept 2026).

Anuraj removed "deals closed" from the realtor profile, the share copy, and
everywhere else. The DB column (realtor_profiles.deals_closed) still exists
(migrations are append-only), but the app must never read, write, select, or
display it. This guard fails if the deals-closed count resurfaces in app/src
code or tests, while asserting the replacement stat set (Years in / Avg days
to close / Client rating) stays intact.

Usage: python3 tests/profile_dealsclosed_guard.py  (run from the repo root)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def scan_tree(subdirs, exts):
    hits = []
    for sub in subdirs:
        base = os.path.join(ROOT, sub)
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                if not any(fn.endswith(e) for e in exts):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
                with open(os.path.join(dirpath, fn), encoding="utf-8") as f:
                    src = f.read()
                for pat in (r"dealsClosed", r"deals_closed", r"Deals closed", r"deals-closed"):
                    for m in re.finditer(pat, src):
                        # Allow: the guard/test files asserting its absence,
                        # comments documenting the removal, and the backfill
                        # line that actively deletes the legacy key.
                        line = src[max(0, m.start() - 80):m.end() + 80]
                        if "never surfaces" in line or "removed" in line.lower():
                            continue
                        if re.search(r"\bdelete\b", line) and "dealsClosed" in line:
                            continue
                        hits.append(f"{rel}: {pat}")
    return hits


def main():
    # 1. No deals-closed references in shipped app code.
    hits = scan_tree(["app", "src"], [".ts", ".tsx"])
    # Filter the known-OK migration docs: 0001_init.sql is not scanned (only
    # app/src). cloudSync must not SELECT the column anymore.
    check("no deals-closed in app/src", not hits, "; ".join(hits[:5]))

    # 2. The sync layer never selects or writes the column.
    cloud = read("src/lib/cloudSync.ts")
    check("cloudSync never selects deals_closed",
          "deals_closed" not in cloud)
    check("cloudSync never writes deals_closed",
          "deals_closed" not in cloud)

    # 3. The profile interface has no dealsClosed field.
    types_src = read("src/lib/types.ts")
    m = re.search(r"export interface RealtorProfile \{(.+?)\n\}", types_src, re.S)
    check("RealtorProfile interface block found", bool(m))
    if m:
        check("RealtorProfile has no dealsClosed field",
              "dealsClosed" not in m.group(1))

    # 4. The replacement stat set stays intact on the PUBLIC profile surface.
    # Scope discipline (Anuraj, Sept 26): the authenticated client profile
    # screen (app/client/profile.tsx) is an adjacent screen that must NOT
    # change — it only loses Deals closed and keeps its existing
    # "Years experience" stat. The new three-stat set belongs only to the
    # public profile page.
    client_profile = read("app/client/profile.tsx")
    check("client profile keeps existing 'Years experience' stat",
          '"Years experience"' in client_profile)
    check("client profile has no Deals closed stat",
          "Deals closed" not in client_profile)
    public_page = read("app/realtor/[id].tsx")
    for label in ("Years in", "Avg days to close", "Client rating"):
        check(f"public profile keeps stat '{label}'", label in public_page)

    # 5. The new avg-days-to-close field is editable in profile settings.
    form = read("src/components/ProfileForm.tsx")
    check("ProfileForm has Avg days to close field",
          'label="Avg days to close"' in form)
    check("ProfileForm has no Deals closed field",
          'label="Deals closed"' not in form)

    print("\n----- profile_dealsclosed_guard:", "FAIL" if FAILS else "PASS", "-----")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
