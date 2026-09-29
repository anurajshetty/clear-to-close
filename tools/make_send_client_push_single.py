#!/usr/bin/env python3
"""Clear to Close — regenerate the dashboard-paste single file for the
send-client-push Edge Function.

Canonical sources: supabase/functions/send-client-push/{index,push}.ts.
The dashboard-paste artifact is GENERATED — never hand-edit it. Fix the
sources and re-run this script.

Usage: python3 tools/make_send_client_push_single.py
Writes: ~/workspace/your_files/send-client-push-single.ts
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FN_DIR = os.path.join(ROOT, "supabase", "functions", "send-client-push")
OUT = os.path.expanduser("~/workspace/your_files/send-client-push-single.ts")

# Markers that MUST be present in the generated file (known-fix guards).
REQUIRED_MARKERS = [
    "PUSH_TRIGGER_SECRET",          # trigger shared-secret validation
    "X-Trigger-Secret",             # header the trigger sends
    "exp.host/--/api/v2/push/send",  # Expo Push API endpoint
    "DeviceNotRegistered",          # dead-token cleanup
    "EXPO_ACCESS_TOKEN",            # read from env, never hardcoded
    "checked off",                  # approved copy line 1
    "added a new step to your escrow",  # approved copy line 2
    "Your closing date is now",   # approved copy line 3 (Sept 28, 2026)
    "updated your key dates",     # approved copy line 4 (Sept 28, 2026)
]

# Strings that must NEVER appear (secret hygiene).
FORBIDDEN = [
    "service_role",  # the key name is fine in code comments? no — keep the
]
# The service_role KEY VALUE must never be pasted; the env var name is fine.
# We check for anything that looks like a JWT instead (below).


def strip_exports(src: str) -> str:
    src = re.sub(r"^export default ", "", src, flags=re.M)
    src = re.sub(r"^export (async function|function|const|let|var|type|interface|class|enum) ",
                 r"\1 ", src, flags=re.M)
    src = re.sub(r"^export \{[^}]*\};?\s*$", "", src, flags=re.M)
    src = re.sub(r"^export \*[^;]*;\s*$", "", src, flags=re.M)
    return src


def main() -> int:
    with open(os.path.join(FN_DIR, "push.ts")) as f:
        push_src = f.read()
    with open(os.path.join(FN_DIR, "index.ts")) as f:
        index_src = f.read()

    import_re = re.compile(r"^import \{[^}]*\} from '\./push\.ts';\s*$", re.M)
    if not import_re.search(index_src):
        print("FAIL: expected ./push.ts import not found in index.ts")
        return 1

    inlined = strip_exports(push_src)
    replacement = (
        "// ---- inlined from push.ts (generated; do not edit) ----\n" + inlined.rstrip()
    )
    single = import_re.sub(lambda _m: replacement, index_src)
    # Drop the inline marker comment's job: keep the file honest.
    single = single.replace(
        "// PUSH_INLINE_MARKER — the generator replaces the './push.ts' import above\n"
        "// with the contents of push.ts. Do not remove this comment.\n",
        "// (push.ts inlined above by make_send_client_push_single.py)\n",
    )

    header = (
        "// GENERATED — do not hand-edit. Regenerate with:\n"
        "//   python3 tools/make_send_client_push_single.py\n"
        "// Sources: supabase/functions/send-client-push/{index,push}.ts\n\n"
    )
    out = header + single

    for marker in REQUIRED_MARKERS:
        if marker not in out:
            print(f"FAIL: required marker missing: {marker}")
            return 1
    # No JWT-shaped values may be baked in.
    if re.search(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", out):
        print("FAIL: JWT-shaped value found in generated file")
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        f.write(out)
    print(f"wrote {OUT} ({len(out)} bytes)")
    print("markers OK; no embedded secrets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
