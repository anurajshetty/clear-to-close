#!/usr/bin/env python3
"""Clear to Close — small-screen drag-reorder regression test (Sept 2026).

Anuraj found checklist drag-reorder doesn't work on smaller screens (works on
larger ones). Root cause (reproduced with real touch gestures before the fix):
react-native-draggable-flatlist's edge-autoscroll fires whenever the armed
row is within `autoscrollThreshold` (30px) of the list container's bottom
edge — even with ZERO finger movement. On short viewports (375x667) the last
visible row sits at the container's bottom edge, so the moment the long-press
armed the drag, the list spuriously scrolled down under the stationary finger
(the armed row jumped +147px with no movement in the repro). The autoscroll
then fought the user's upward drag and the placeholder never crossed a row
boundary, so the up-drag silently failed. Down-drags worked (same direction
as the spurious scroll); larger viewports worked (row not at the edge).

Fix: patches/react-native-draggable-flatlist+4.0.3.patch now gates the
library's edge-autoscroll on real finger movement TOWARD that edge
(|touchTranslate| > 8px in the edge's direction). A stationary long-press no
longer autoscrolls; "drag to the edge and hold to keep scrolling" still works
because touchTranslate stays past the minimum while held.

Guards, all with real CDP touch gestures against the real built output, at
375x667, 390x844, AND tablet 768x1024:
 1. dwell: a 750ms zero-movement long-press on a row parked at the list's
    bottom edge arms the drag with no spurious scroll (scrollTop unchanged)
    and no row jump (pre-fix: +147px jump and the list scrolled itself).
 2. up-drag: dragging that row upward reorders (index decreases).
 3. down-drag: dragging downward reorders (index increases).
 4. tap: a quick tap on a grip is inert (arms nothing, moves no row,
    scrolls nothing).
 5. zero JS errors.

Usage: python3 tests/drag_reorder_small.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/.
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8921).
"""
import http.server
import functools
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("CTC_PORT", "8921"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

VIEWPORTS = [(375, 667), (390, 844), (768, 1024)]
TITLES = ["Alpha step", "Bravo step", "Charlie step", "Delta step", "Echo step"]


def make_escrow():
    steps = [
        {"id": f"s{i}", "title": t, "subtitle": "", "done": False,
         "custom": False, "order": i, "completedAt": None}
        for i, t in enumerate(TITLES)
    ]
    return [{
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": "2026-09-25", "closeDate": "2026-12-25",
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": "2026-09-25",
    }]


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
                rest = "/index.html"
            self.path = rest + qs
        return super().do_GET()


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


GRIP_CENTER_JS = """(title) => {
  const g = document.querySelector('[aria-label="Drag to reorder ' + title + '"]');
  if (!g) return null;
  const b = g.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}"""

ARMED_TRANSLATE_Y_JS = """() => {
  const cell = [...document.querySelectorAll('*')].find(e => e.style && e.style.zIndex === '999');
  if (!cell) return null;
  const t = getComputedStyle(cell).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  if (!m) return 0;
  const p = m[1].split(',').map(Number);
  return p.length === 16 ? p[13] : p[5];
}"""

DRAG_ARMED_JS = """() => {
  return [...document.querySelectorAll('*')].some(e => e.style && e.style.zIndex === '999');
}"""

SCROLL_TOP_JS = """() => {
  const els = [...document.querySelectorAll('*')];
  let best = null;
  for (const el of els) {
    const sh = el.scrollHeight, ch = el.clientHeight;
    if (sh > ch + 4 && (el === document.scrollingElement || sh > 200)) {
      if (!best || sh > best.scrollHeight) best = el;
    }
  }
  return best ? best.scrollTop : 0;
}"""

SCROLL_TO_JS = """({gy, targetY}) => {
  const els = [...document.querySelectorAll('*')];
  let best = null;
  for (const el of els) {
    const sh = el.scrollHeight, ch = el.clientHeight;
    if (sh > ch + 4 && (el === document.scrollingElement || sh > 200)) {
      if (!best || sh > best.scrollHeight) best = el;
    }
  }
  if (best) best.scrollTop += (gy - targetY);
}"""


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    srv = serve()
    failures = []
    errors = []

    def check(name, cond, detail=""):
        tag = "PASS " if cond else "FAIL "
        print(tag + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vw, vh in VIEWPORTS:
            pg = browser.new_page(viewport={"width": vw, "height": vh},
                                  has_touch=True, is_mobile=(vw < 768))
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script(
                "localStorage.setItem('ctc:escrows', '"
                + json.dumps(make_escrow()).replace("'", "\\'") + "');"
            )

            def fulfill_auth(route):
                if route.request.method == "OPTIONS":
                    route.fulfill(status=200, headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
                    return
                route.fulfill(status=200,
                    headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                    json={"access_token": "fake-jwt", "token_type": "bearer", "expires_in": 3600,
                          "refresh_token": "fake-refresh",
                          "user": {"id": "test-user-1", "email": "rita@example.com",
                                   "user_metadata": {"name": "Rita Realtor"}}})
            pg.route("**/auth/v1/signup*", fulfill_auth)
            pg.route("**/auth/v1/token*", fulfill_auth)

            def fulfill_empty(route):
                if route.request.method == "OPTIONS":
                    route.fulfill(status=200, headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                        "Access-Control-Expose-Headers": "Content-Range"})
                    return
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
                    "Access-Control-Expose-Headers": "Content-Range"}, json=[])
            pg.route("**/rest/v1/*", fulfill_empty)

            # Boot to the escrow detail checklist.
            pg.goto(BASE)
            pg.wait_for_timeout(3000)
            pg.get_by_text("I'm a Realtor").click()
            pg.wait_for_timeout(400)
            pg.get_by_text("Continue", exact=True).click()
            pg.wait_for_timeout(1200)
            inputs = pg.locator("input")
            inputs.nth(0).fill("Rita Realtor")
            inputs.nth(1).fill("rita@example.com")
            inputs.nth(2).fill("longenoughpassword")
            pg.get_by_text("Create account", exact=True).click()
            pg.get_by_text("Skip for now").wait_for(timeout=12000)
            pg.get_by_text("Skip for now").click()
            pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
            pg.get_by_text("26207 Benito Ct").first.click()
            pg.get_by_text("Charlie step").wait_for(timeout=12000)
            pg.wait_for_timeout(1000)

            def stored():
                return pg.evaluate(
                    "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")

            cdp = pg.context.new_cdp_session(pg)

            def park_charlie_at_bottom_edge():
                # Scroll so Charlie's grip sits ~25px above the viewport
                # bottom: inside the library's 30px edge-autoscroll threshold
                # zone — the exact configuration that misfired pre-fix.
                for _ in range(6):
                    g = pg.evaluate(GRIP_CENTER_JS, "Charlie step")
                    if not g:
                        return None
                    if abs(g["y"] - (vh - 25)) <= 12:
                        return g
                    pg.evaluate(SCROLL_TO_JS, {"gy": g["y"], "targetY": vh - 25})
                    pg.wait_for_timeout(400)
                return pg.evaluate(GRIP_CENTER_JS, "Charlie step")

            def dwell(x, y, hold_ms=750):
                before = pg.evaluate(SCROLL_TOP_JS)
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
                pg.wait_for_timeout(hold_ms)
                ty = pg.evaluate(ARMED_TRANSLATE_Y_JS)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(600)
                return ty, pg.evaluate(SCROLL_TOP_JS) - before

            def drag_dy(title, dy):
                g = park_charlie_at_bottom_edge() if title == "Charlie step" \
                    else pg.evaluate(GRIP_CENTER_JS, title)
                assert g, f"grip not found for {title}"
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": g["x"], "y": g["y"]}]})
                pg.wait_for_timeout(750)
                cx, cy = g["x"], g["y"]
                for i in range(1, 17):
                    cdp.send("Input.dispatchTouchEvent",
                             {"type": "touchMove",
                              "touchPoints": [{"x": cx, "y": cy + (dy * i / 16)}]})
                    pg.wait_for_timeout(45)
                pg.wait_for_timeout(400)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(1300)

            tag = f"{vw}x{vh}"

            # 1. dwell: stationary long-press at the bottom edge must not
            #    scroll the list or jump the row (the pre-fix misfire).
            g = park_charlie_at_bottom_edge()
            check(f"[{tag}] dwell: Charlie parked at bottom edge", g is not None)
            if g:
                ty, dscroll = dwell(g["x"], g["y"])
                check(f"[{tag}] dwell: drag armed", ty is not None)
                if ty is not None:
                    check(f"[{tag}] dwell: no row jump on stationary long-press",
                          abs(ty) <= 40, f"translateY={ty}px (pre-fix: +147)")
                check(f"[{tag}] dwell: list does not self-scroll",
                      abs(dscroll) <= 4, f"scrollTop delta={dscroll}")

            # 2. up-drag from the bottom edge reorders upward.
            before = stored()
            drag_dy("Charlie step", -160)
            after = stored()
            check(f"[{tag}] drag-up: Charlie moves up",
                  after.index("Charlie step") < before.index("Charlie step"),
                  f"{before.index('Charlie step')} -> {after.index('Charlie step')}")

            # 3. down-drag reorders downward.
            before = stored()
            drag_dy("Charlie step", 160)
            after = stored()
            check(f"[{tag}] drag-down: Charlie moves down",
                  after.index("Charlie step") > before.index("Charlie step"),
                  f"{before.index('Charlie step')} -> {after.index('Charlie step')}")

            # 4. quick tap is inert.
            g = pg.evaluate(GRIP_CENTER_JS, "Bravo step")
            if g:
                c0 = pg.evaluate(SCROLL_TOP_JS)
                o0 = stored()
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": g["x"], "y": g["y"]}]})
                pg.wait_for_timeout(120)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(500)
                check(f"[{tag}] tap: quick tap arms nothing", not pg.evaluate(DRAG_ARMED_JS))
                check(f"[{tag}] tap: quick tap preserves order", stored() == o0)
                check(f"[{tag}] tap: quick tap does not scroll",
                      abs(pg.evaluate(SCROLL_TOP_JS) - c0) <= 4)

            pg.close()

        browser.close()

    srv.shutdown()
    check("zero JS errors across all viewports", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll small-screen drag-reorder checks passed.")


main()
