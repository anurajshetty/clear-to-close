#!/usr/bin/env python3
"""Clear to Close — regression guard: no realtor-profile city field (Sept 2026).

Anuraj approved removing the city field from the realtor profile. The
realtor profile never had a city field in the current codebase (city exists
only on escrows — required deal addresses — which must NOT be touched), so
this guard pins that: it fails if a city field/label is ever added to the
realtor profile form screens, the profile draft, or the RealtorProfile
interface, while asserting the separate "Areas served" concept stays intact.

Usage: python3 tests/profile_city_guard.py  (run from the repo root)
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


def main():
    profile_screens = [
        "src/components/ProfileForm.tsx",
        "app/profile-setup.tsx",
        "app/profile-create.tsx",
        "app/profile-update.tsx",
    ]
    for rel in profile_screens:
        src = read(rel)
        # A "City" form label on the realtor profile (the removed field).
        check(f"{rel}: no City field label",
              not re.search(r'label\s*=\s*["\']City', src),
              "found a City label")
        # A city key in the draft / save payload (e.g. `city:` or `city ?`).
        check(f"{rel}: no city form key",
              not re.search(r'(?m)^\s*city\s*[:?]', src),
              "found a city key")

    # The RealtorProfile interface itself must not grow a city field.
    types_src = read("src/lib/types.ts")
    m = re.search(r"export interface RealtorProfile \{(.+?)\n\}", types_src, re.S)
    check("RealtorProfile interface block found", bool(m))
    if m:
        check("RealtorProfile has no city field",
              not re.search(r"(?i)\bcity\b", m.group(1)),
              "city inside RealtorProfile")

    # The separate "Areas served" concept must remain intact (not confused
    # with the removed city field).
    form_src = read("src/components/ProfileForm.tsx")
    check("Areas served field label still present",
          'label="Areas served"' in form_src)
    check("areasServed draft key still present",
          "areasServed" in form_src)
    check("RealtorProfile.areasServed still present",
          "areasServed: string;" in types_src)

    # Escrow city (the required deal address) must NOT have been touched by
    # this guard's subject: sanity that escrow city still exists.
    store_src = read("src/lib/store.ts")
    check("escrow city untouched (still required on escrows)",
          "createEscrow: city is required" in store_src)

    print("\n----- profile_city_guard:", "FAIL" if FAILS else "PASS", "-----")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
