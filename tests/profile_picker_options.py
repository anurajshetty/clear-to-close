#!/usr/bin/env python3
"""profile_picker_options — pins the image-picker launch options for the
realtor profile form (Anuraj, Sept 2026).

After the realtor picks a profile photo or banner, the raw image must flow
STRAIGHT into our own crop editor — no native editing UI and no native
preview/confirmation owned by the app. RN components are not importable in
the node suite, so this source-level check pins the launch contract in
src/components/ProfileForm.tsx:

  1. Every launchImageLibraryAsync call passes allowsEditing: false, so the
     legacy UIImagePickerController edit screen never appears.
  2. No allowsMultipleSelection: true anywhere — single-select keeps the
     flow one-photo-at-a-time into the cropper.
  3. Both pickers (photo + banner) hand the picked asset to the crop editor
     (setCropJob) instead of saving directly — the cropper owns the edit.

Known platform limit (verified against the expo-image-picker 57 native
source in node_modules): on iOS every non-editing library pick goes through
PHPickerViewController with selectionLimit=1, and PHPicker only reports the
pick when the user confirms with the system Add button. That single
OS-imposed confirmation cannot be removed by any launch option — it is not
an app screen and there is nothing further to disable here.

Usage: python3 tests/profile_picker_options.py   (also wired into tests/run.sh)
Exit 1 with the offending locations on failure.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures = []


def check(cond, label):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


form = read("src/components/ProfileForm.tsx")

# Find every launchImageLibraryAsync({...}) call and pin its options.
calls = re.findall(
    r"launchImageLibraryAsync\(\{(.*?)\}\);", form, re.DOTALL
)
check(len(calls) >= 2, "photo + banner library pickers both launch via launchImageLibraryAsync")

for i, opts in enumerate(calls):
    label = "picker call %d" % (i + 1)
    check(
        re.search(r"allowsEditing:\s*false", opts) is not None,
        label + " passes allowsEditing: false (no native edit UI)",
    )
    check(
        "allowsEditing: true" not in opts,
        label + " never enables native editing",
    )
    check(
        re.search(r"allowsMultipleSelection:\s*true", opts) is None,
        label + " stays single-select (no multi-select flow)",
    )

# Both pickers hand the raw asset to our crop editor before anything saves.
check(
    form.count("setCropJob({") >= 2,
    "photo + banner picks open the crop editor (setCropJob) instead of saving directly",
)
check(
    "kind: 'photo'" in form and "kind: 'banner'" in form,
    "crop jobs carry the right frame kind for photo and banner",
)

if failures:
    print("\n%d FAILURE(S)" % len(failures))
    sys.exit(1)
print("\nAll profile picker option checks passed.")
