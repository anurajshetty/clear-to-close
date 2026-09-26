#!/usr/bin/env python3
"""em_dash_sweep — no em/en dashes in user-facing copy (Anuraj, Sept 26, 2026).

Anuraj: the copy must read professionally and human — no AI-generated feel.
Scans every .ts/.tsx file under app/ and src/ (the sources feeding UI
text) for em dashes (—) and en dashes (–) OUTSIDE comments, and fails if
any remain.

What stays allowed:
  - code comments (//, /* */, {/* */}) — not user-facing;
  - ordinary hyphens in compound words (check-in) and minus signs;
  - the middle dot (·) used as a quiet separator/placeholder.

Usage: python3 tests/em_dash_sweep.py   (also wired into tests/run.sh)
Exit 1 with the offending locations if any dash is found.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_DIRS = [os.path.join(ROOT, "app"), os.path.join(ROOT, "src")]


def strip_comments(src):
    """Remove //, /* */, and {/* */} comments, keeping string literals and
    JSX text intact. The codebase uses &apos; in JSX text (no raw
    apostrophes), so ' and " always open real string literals here."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    break
                j += 1
            out.append(src[i:j + 1])
            i = j + 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def main():
    offenders = []
    files = 0
    for d in SCAN_DIRS:
        for root, _dirs, names in os.walk(d):
            for name in names:
                if not (name.endswith(".tsx") or name.endswith(".ts")):
                    continue
                path = os.path.join(root, name)
                files += 1
                with open(path, encoding="utf-8") as fh:
                    stripped = strip_comments(fh.read())
                for ln, line in enumerate(stripped.split("\n"), 1):
                    for ch in ("—", "–"):
                        if ch in line:
                            offenders.append(
                                f"{os.path.relpath(path, ROOT)}:{ln}: "
                                f"{'em dash' if ch == '—' else 'en dash'}: {line.strip()[:100]}"
                            )
    if offenders:
        print(f"em_dash_sweep: FAIL — {len(offenders)} dash(es) in user-facing copy:")
        for o in offenders:
            print("  " + o)
        return 1
    print(f"em_dash_sweep: PASS — {files} files scanned, no em/en dashes outside comments.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
