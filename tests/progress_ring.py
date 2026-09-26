#!/usr/bin/env python3
"""Clear to Close — progress-ring regression test (Sept 2026 live bug).

Anuraj reported from the live app: the client top card's progress ring showed
"100%" text but the arc had a visible gap — text and arc disagreed.

Root cause: ProgressRing hardcoded strokeDasharray=188.5 (2*pi*30, correct
only for size=72). The client top card renders at size=84, where the actual
circle circumference is 2*pi*35 = 219.9. The dash pattern was shorter than
the path, so ~14% of the ring stayed background-colored even at 100%.

Fix: derive the dasharray/dashoffset from the ACTUAL rendered radius
(2*pi*r) so the arc exactly matches the computed percentage at any size.

Guards (real rendered component, 390x844, client buyer view at size=84):
  - 0%: text "0%", arc dasharray == 2*pi*r, dashoffset == dasharray (no arc).
  - 50%: text "50%", visible arc fraction == 0.5.
  - 100%: text "100%", dashoffset == 0 (full circle, no gap).

The arc assertion reads the SVG circle's r, stroke-dasharray, and
stroke-dashoffset attributes and verifies the visible fraction
(1 - offset/dasharray) matches the text percentage, so text and arc can
never diverge again.

Usage: python3 tests/progress_ring.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
"""
import http.server
import functools
import math
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT", os.path.expanduser("~/workspace/realtor-app"))
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-progress-ring"
BASE = "http://127.0.0.1:8915/clear-to-close/"

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


def make_escrow(done_count):
    steps = [
        {
            "id": f"s{i}",
            "title": f"Buyer step {i + 1}",
            "subtitle": "",
            "done": i < done_count,
            "custom": False,
            "order": i,
            "completedAt": "2026-09-20T10:00:00.000Z" if i < done_count else None,
        }
        for i in range(14)
    ]
    return [
        {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "side": "buy",
            "buyerSteps": steps,
            "sellerSteps": [],
            "openDate": "2026-06-28",
            "closeDate": "2026-12-25",
            "status": "open",
        }
    ]


def make_clientlink():
    return {
        "linkId": "link-1",
        "escrowId": "seed-1",
        "role": "buyer",
        "partyName": "Sushmitha",
        "deviceId": "test-device-1",
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        raw = self.path
        path = raw.split("?", 1)[0]
        qs = raw[len(path):]
        if path == "/clear-to-close" or path.startswith("/clear-to-close/"):
            rest = path[len("/clear-to-close"):] or "/"
            if rest.endswith("/"):
                rest += "index.html"
            candidate = os.path.join(DIST, rest.lstrip("/"))
            if not os.path.isfile(candidate):
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8915), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_case(browser, done_count):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    # Seed on the app origin first, then navigate to the client view.
    pg.goto(BASE)
    pg.wait_for_timeout(2000)
    pg.evaluate(
        "(d) => localStorage.setItem('ctc:escrows', d);",
        json.dumps(make_escrow(done_count)),
    )
    pg.evaluate(
        "(d) => localStorage.setItem('ctc:clientlink', d);",
        json.dumps(make_clientlink()),
    )
    pg.evaluate("localStorage.setItem('ctc:deviceid', 'test-device-1');")
    pg.goto(BASE + "client/buyer/seed-1")
    pg.wait_for_timeout(4000)
    assert_ring(pg, done_count)
    if done_count == 14:
        pg.screenshot(path=os.path.join(OUT, "ring-100.png"))
    check("ring: zero JS errors", not errors, "; ".join(errors[:3]))
    pg.close()


def ring_state(pg):
    """Read the rendered progress ring: text %, and the accent arc's
    r / stroke-dasharray / stroke-dashoffset. Returns (pct_text, info)."""
    # The accent arc is the SVG circle carrying a stroke-dasharray.
    # The % text is rendered in the ring container (e.g. "14 of 14 steps"
    # header shows "100%" in the ring).
    info = pg.evaluate(
        """() => {
          const circles = [...document.querySelectorAll('circle')]
            .filter(c => c.getAttribute('stroke-dasharray'));
          if (!circles.length) return null;
          const c = circles[0];
          // Find the ring's % text: walk up to find a container with N%.
          let el = c;
          let pct = null;
          for (let i = 0; i < 6 && el; i++) {
            const m = (el.innerText || '').match(/(\\d+)%/);
            if (m) { pct = parseInt(m[1], 10); break; }
            el = el.parentElement;
          }
          return {
            pct,
            r: parseFloat(c.getAttribute('r')),
            dasharray: parseFloat(c.getAttribute('stroke-dasharray')),
            dashoffset: parseFloat(c.getAttribute('stroke-dashoffset')),
          };
        }"""
    )
    if info is None:
        return None, None
    return info["pct"], info


def assert_ring(pg, done_count, total=14):
    expected_pct = round(done_count / total * 100)
    pg.wait_for_timeout(500)
    pct_text, info = ring_state(pg)
    tag = f"{expected_pct}%"
    check(f"ring {tag}: text shows {expected_pct}%", pct_text == expected_pct,
          f"text={pct_text}%")
    if info is None:
        check(f"ring {tag}: accent arc found", False, "no dashed circle")
        return
    r = info["r"]
    expected_circ = 2 * math.pi * r
    # The dash pattern must match the ACTUAL rendered circumference —
    # this is the regression: a hardcoded 188.5 left a gap at size=84.
    check(
        f"ring {tag}: dasharray equals 2*pi*r (r={r:.2f})",
        abs(info["dasharray"] - expected_circ) < 0.5,
        f"dasharray={info['dasharray']:.2f} expected={expected_circ:.2f}",
    )
    # Visible arc fraction = 1 - offset/dasharray must equal done/total.
    frac = done_count / total
    visible = 1 - info["dashoffset"] / info["dasharray"]
    check(
        f"ring {tag}: arc fraction matches text",
        abs(visible - frac) < 0.02,
        f"visible={visible:.3f} expected={frac:.3f}",
    )
    if expected_pct == 100:
        check(
            f"ring {tag}: full circle, no gap (offset ~ 0)",
            abs(info["dashoffset"]) < 0.5,
            f"dashoffset={info['dashoffset']:.2f}",
        )
    if expected_pct == 0:
        check(
            f"ring {tag}: empty ring (offset ~ dasharray)",
            abs(info["dashoffset"] - info["dasharray"]) < 0.5,
            f"dashoffset={info['dashoffset']:.2f}",
        )


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # 0% — nothing done.
            run_case(browser, 0)

            # 50% — half done.
            run_case(browser, 7)

            # 100% — all done (the reported live bug: gap at 100%).
            run_case(browser, 14)

            browser.close()
    finally:
        srv.shutdown()

    failed = [c for c in CHECKS if not c[1]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
