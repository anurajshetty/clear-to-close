#!/usr/bin/env python3
"""Clear to Close — client top-card polish regression (Sept 2026).

Branding redesign round on the buyer/seller top card (approved mockup):
  1. City on its own line below the address (no "address · city" duplication).
  2. Top-card margins: 14px top / 18px bottom.
  3. Ring 208px with mockup geometry (r=88, stroke=24, dasharray=553.0,
     pct text 44px) and trimmed center-stack margins (.by-center 14,
     .ringcap 10, .by-big 8); banner card over a photo (teal fallback).

Guards (real rendered component, 390x844, client buyer view):
  - address and city render as two separate lines; neither contains "·".
  - hero card computed margin-bottom == 18px, margin-top == 14px.
  - ring svg is 208x208, circle r=88, stroke-width=24, dasharray == 2*pi*88,
    % text font-size == 44px, and the visible arc fraction matches the text
    percentage at 0% and 50% (the arc/text agreement from the ring fix).
  - center stack margins: 14 / 10 / 8.
  - card height within tolerance of the spec'd banner-card height.
  - zero JS errors.

Usage: APP_ROOT=/home/hatch/workspace/realtor-app-wt-dragrow python3 tests/topcard_polish.py
Requires: a fresh `npm run export:web` build in <APP_ROOT>/dist.
"""
import http.server
import functools
import math
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import progress_ring  # noqa: E402  (reuses make_escrow / make_clientlink / ring_state)

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-topcard-polish"
BASE = "http://127.0.0.1:8916/clear-to-close/"
PORT = 8916

CHECKS = []

# Measured banner-card height in the reference state (done 0 of 14, no pill,
# teal fallback, 390px viewport): 567px. Re-measure from the real render if
# the branded card's layout changes; the assertion allows +/-16px.
TOPCARD_H = 567


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_case(browser, done_count, shot_name=None):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(2000)
    pg.evaluate(
        "(d) => localStorage.setItem('ctc:escrows', d);",
        json.dumps(progress_ring.make_escrow(done_count)),
    )
    pg.evaluate(
        "(d) => localStorage.setItem('ctc:clientlink', d);",
        json.dumps(progress_ring.make_clientlink()),
    )
    pg.evaluate("localStorage.setItem('ctc:deviceid', 'test-device-1');")
    pg.goto(BASE + "client/buyer/seed-1")
    pg.wait_for_timeout(4000)

    # --- address / city on separate lines ---
    addr = pg.evaluate(
        "document.querySelector('[data-testid=\"client-address\"]')?.textContent ?? null"
    )
    city = pg.evaluate(
        "document.querySelector('[data-testid=\"client-city\"]')?.textContent ?? null"
    )
    check("topcard: address rendered", addr is not None, repr(addr))
    check("topcard: city rendered", city is not None, repr(city))
    if addr is not None:
        check("topcard: address is bare (no city duplication)",
              addr.strip() == "26207 Benito Ct" and "·" not in addr, repr(addr))
    if city is not None:
        check("topcard: city is bare", city.strip() == "Santa Clarita", repr(city))
    if addr is not None and city is not None:
        boxes = pg.evaluate(
            """() => {
              const a = document.querySelector('[data-testid="client-address"]').getBoundingClientRect();
              const c = document.querySelector('[data-testid="client-city"]').getBoundingClientRect();
              return {aTop: a.top, aBottom: a.bottom, cTop: c.top, cBottom: c.bottom};
            }"""
        )
        check("topcard: city on its own line below the address",
              boxes["cTop"] >= boxes["aBottom"] - 1,
              f"addr=[{boxes['aTop']:.0f},{boxes['aBottom']:.0f}] city=[{boxes['cTop']:.0f},{boxes['cBottom']:.0f}]")

    # --- hero margin + card height ---
    hero = pg.evaluate(
        """() => {
          const el = document.querySelector('[data-testid="client-topcard"]');
          if (!el) return null;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {mb: cs.marginBottom, mt: cs.marginTop, h: r.height};
        }"""
    )
    check("topcard: hero found", hero is not None)
    if hero is not None:
        check("topcard: bottom margin 18px", hero["mb"] == "18px", f"marginBottom={hero['mb']}")
        check("topcard: top margin still 14px", hero["mt"] == "14px", f"marginTop={hero['mt']}")
        # Spec: the branded banner top card measures ~TOPCARD_H px in the
        # reference state (measured from the real render; see the constant
        # at the top of this file).
        check("topcard: card height ~TOPCARD_Hpx", abs(hero["h"] - TOPCARD_H) <= 16,
              f"height={hero['h']:.1f}px")

    # --- ring geometry (mockup: 208px, r=88, stroke=24, dasharray=553.0) ---
    ring = pg.evaluate(
        """() => {
          const circles = [...document.querySelectorAll('circle')]
            .filter(c => c.getAttribute('stroke-dasharray'));
          if (!circles.length) return null;
          const c = circles[0];
          const svg = c.closest('svg');
          let pctEl = null, el = c;
          for (let i = 0; i < 6 && el && !pctEl; i++) {
            // Deepest match first: outer wrappers share the same textContent
            // but only the innermost text element carries the 20px style.
            const matches = [...el.parentElement?.querySelectorAll('*') ?? []]
              .filter(n => /^\\d+%$/.test((n.textContent || '').trim()));
            if (matches.length) pctEl = matches[matches.length - 1];
            el = el.parentElement;
          }
          return {
            w: parseFloat(svg.getAttribute('width')),
            h: parseFloat(svg.getAttribute('height')),
            r: parseFloat(c.getAttribute('r')),
            sw: parseFloat(c.getAttribute('stroke-width')),
            dasharray: parseFloat(c.getAttribute('stroke-dasharray')),
            dashoffset: parseFloat(c.getAttribute('stroke-dashoffset')),
            pct: pctEl ? pctEl.textContent.trim() : null,
            pctSize: pctEl ? getComputedStyle(pctEl).fontSize : null,
          };
        }"""
    )
    check("topcard: ring found", ring is not None)
    if ring is not None:
        check("topcard: ring is 208x208", ring["w"] == 208 and ring["h"] == 208,
              f"{ring['w']}x{ring['h']}")
        check("topcard: ring r=88", abs(ring["r"] - 88) < 0.01, f"r={ring['r']}")
        check("topcard: ring stroke=24", abs(ring["sw"] - 24) < 0.01, f"stroke={ring['sw']}")
        check("topcard: dasharray == 2*pi*88",
              abs(ring["dasharray"] - 2 * math.pi * 88) < 0.5,
              f"dasharray={ring['dasharray']:.2f}")
        check("topcard: pct text 44px", ring["pctSize"] == "44px",
              f"fontSize={ring['pctSize']}")
        # Arc/text agreement at this case's percentage.
        frac = done_count / 14
        visible = 1 - ring["dashoffset"] / ring["dasharray"]
        check(f"topcard: arc fraction matches text ({done_count}/14)",
              abs(visible - frac) < 0.02,
              f"visible={visible:.3f} expected={frac:.3f}")

    # --- center stack margins: 14 / 10 / 8 ---
    margins = pg.evaluate(
        """() => {
          const q = (t) => document.querySelector(`[data-testid="${t}"]`);
          const cs = (el) => el ? getComputedStyle(el) : null;
          const center = cs(q('topcard-center'));
          const cap = cs(q('steps-caption'));
          const days = cs(q('days-line'));
          return center && cap && days ? {
            centerMt: center.marginTop, capMb: cap.marginBottom, daysMt: days.marginTop,
          } : null;
        }"""
    )
    check("topcard: stack elements found", margins is not None)
    if margins is not None:
        check("topcard: .by-center margin-top 14px", margins["centerMt"] == "14px",
              f"marginTop={margins['centerMt']}")
        check("topcard: .ringcap margin-bottom 10px", margins["capMb"] == "10px",
              f"marginBottom={margins['capMb']}")
        check("topcard: .by-big margin-top 8px", margins["daysMt"] == "8px",
              f"marginTop={margins['daysMt']}")

    if shot_name:
        pg.screenshot(path=os.path.join(OUT, shot_name))
    check("topcard: zero JS errors", not errors, "; ".join(errors[:3]))
    pg.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run_case(browser, 0, shot_name="topcard-0.png")
            run_case(browser, 7, shot_name="topcard-50.png")
            browser.close()
    finally:
        srv.shutdown()

    failed = [c for c in CHECKS if not c[1]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
