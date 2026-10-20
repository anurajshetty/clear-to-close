#!/usr/bin/env python3
"""Android backup-exclusion invariants (static).

The plugin source is pinned here; the AUTHORITATIVE check is the
prebuild-generated output (see the plugin header): after any change,
run a scratch `npx expo prebuild` and confirm the generated manifest
carries both attributes and both XML files list every domain.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = (ROOT / "plugins/withAndroidBackupRules.js").read_text()
APPJSON = json.loads((ROOT / "app.json").read_text())

failures = []


def check(name, ok):
    if not ok:
        failures.append(name)
    print(("ok   " if ok else "FAIL ") + name)


DOMAINS = [
    "root",
    "file",
    "database",
    "sharedpref",
    "external",
    "device_root",
    "device_file",
    "device_database",
    "device_sharedpref",
]

check("plugin registered in app.json", "./plugins/withAndroidBackupRules.js" in APPJSON["expo"]["plugins"])
check("manifest sets fullBackupContent", "android:fullBackupContent" in PLUGIN and "@xml/backup_rules" in PLUGIN)
check("manifest sets dataExtractionRules", "android:dataExtractionRules" in PLUGIN and "@xml/data_extraction_rules" in PLUGIN)
check("API 31+ rules cover cloud-backup AND device-transfer", "<cloud-backup>" in PLUGIN and "<device-transfer>" in PLUGIN)
for d in DOMAINS:
    check(f"domain excluded: {d}", f"'{d}'" in PLUGIN)
check("exclusion path is the whole domain", 'path="." ' in PLUGIN or 'path="."' in PLUGIN)

if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print("\nall android_backup_rules checks passed")
