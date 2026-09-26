#!/usr/bin/env python3
"""Clear to Close — interaction test: real touch scroll + real drag reorder.

Drives the REAL built output at 390x844 through the real signup flow and
asserts two things the geometric test does not:

1. TOUCH SCROLL: a genuine CDP touch sequence (touchStart/touchMove/touchEnd)
   on the checklist pans the list — scrollTop moves and the last step becomes
   visible. This guards the `touch-action: pan-y` contract: with
   `touch-action: none` on the scroll container, a real finger swipe would do
   nothing even though programmatic scrollTop works.

2. DRAG REORDER: a real mouse drag on a drag grip reorders the underlying
   checklist (verified in persisted storage) — the grip is not decorative.

Usage: python3 tests/checklist_interactions.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
"""
import http.server
import functools
import os
import threading
import sys
import json
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.expanduser("~/workspace/realtor-app")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-checklist-interactions"
BASE = "http://127.0.0.1:8906/clear-to-close/"

BUY_STEPS = [
    "Escrow open",
    "Earnest money wired",
    "Property inspection scheduled",
    "Appraisal scheduled",
    "Homeowners insurance quote",
    "Seller's disclosure / HOA docs received",
    "Signed loan docs",
    "Release contingencies",
    "Review closing disclosure",
    "Schedule final walkthrough",
    "Close escrow",
    "Record deal",
    "Get keys",
]


def make_escrow():
    steps = [
        {
            "id": f"s{i}",
            "title": t,
            "subtitle": "",
            "done": i < 3,
            "custom": False,
            "order": i,
            "completedAt": None,
        }
        for i, t in enumerate(BUY_STEPS)
    ]
    return [
        {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "side": "buy",
            "buyerName": "Priya Nair",
            "sellerName": None,
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": steps,
            "sellerSteps": [],
            "status": "open",
            "createdAt": "2026-09-25",
        }
    ]


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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8906), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SCROLL_CONTAINER_JS = """() => {
  const anchor = [...document.querySelectorAll('*')].find(e =>
    e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
    e.textContent.trim() === 'Appraisal scheduled');
  let sc = anchor;
  while (sc && sc.parentElement) {
    sc = sc.parentElement;
    const oy = getComputedStyle(sc).overflowY;
    if (oy === 'auto' || oy === 'scroll') return sc;
  }
  return null;
}"""


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    failures = []
    errors = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        # Touch input must be enabled for CDP touch events to pan.
        pg = browser.new_page(
            viewport={"width": 390, "height": 844},
            has_touch=True,
            is_mobile=True,
        )
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(
            "localStorage.setItem('ctc:escrows', '" + json.dumps(make_escrow()).replace("'", "\\'") + "');"
        )

        def fulfill_signup(route):
            if route.request.method == "OPTIONS":
                route.fulfill(
                    status=200,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                    },
                )
                return
            route.fulfill(
                status=200,
                headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                json={
                    "access_token": "fake-jwt",
                    "token_type": "bearer",
                    "expires_in": 3600,
                    "refresh_token": "fake-refresh",
                    "user": {
                        "id": "test-user-1",
                        "email": "rita@example.com",
                        "user_metadata": {"name": "Rita Realtor"},
                    },
                },
            )

        pg.route("**/auth/v1/signup*", fulfill_signup)

        def fulfill_profiles(route):
            if route.request.method == "OPTIONS":
                route.fulfill(
                    status=200,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                        "Access-Control-Expose-Headers": "Content-Range",
                    },
                )
                return
            route.fulfill(
                status=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json",
                    "Access-Control-Expose-Headers": "Content-Range",
                },
                json=[],
            )

        pg.route("**/rest/v1/realtor_profiles*", fulfill_profiles)

        # Real flow: role -> signup -> skip -> deal list -> escrow detail.
        pg.goto(BASE)
        pg.wait_for_timeout(3500)
        pg.get_by_text("I'm a Realtor").click()
        pg.wait_for_timeout(400)
        pg.get_by_text("Continue", exact=True).click()
        pg.wait_for_timeout(1500)
        inputs = pg.locator("input")
        inputs.nth(0).fill("Rita Realtor")
        inputs.nth(1).fill("rita@example.com")
        inputs.nth(2).fill("longenoughpassword")
        pg.wait_for_timeout(400)
        pg.get_by_text("Create account", exact=True).click()
        pg.get_by_text("Skip for now").wait_for(timeout=12000)
        pg.get_by_text("Skip for now").click()
        pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
        pg.get_by_text("26207 Benito Ct").first.click()
        pg.get_by_text("3 of 13 steps").wait_for(timeout=12000)
        pg.wait_for_timeout(800)

        # --- 1. REAL TOUCH SCROLL -------------------------------------
        # The scroll container must honor a genuine finger swipe. Programmatic
        # scrollTop works even when touch-action kills real panning, so this
        # uses raw CDP touch input on a mobile-emulation page.
        before = pg.evaluate(f"({SCROLL_CONTAINER_JS})() ? (({SCROLL_CONTAINER_JS})().scrollTop) : -1")
        check("touch: scroll container found", before >= 0, f"scrollTop={before}")

        cdp = pg.context.new_cdp_session(pg)
        x, y0, y1 = 195, 620, 320  # swipe up: content should pan up
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y0, "id": 1}]})
        for i in range(1, 11):
            y = y0 + (y1 - y0) * i / 10
            cdp.send(
                "Input.dispatchTouchEvent",
                {"type": "touchMove", "touchPoints": [{"x": x, "y": y, "id": 1}]},
            )
            pg.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        pg.wait_for_timeout(900)  # let momentum settle

        after = pg.evaluate(f"({SCROLL_CONTAINER_JS})() ? (({SCROLL_CONTAINER_JS})().scrollTop) : -1")
        check(
            "touch: real swipe scrolled the list",
            after > before + 50,
            f"scrollTop {before} -> {after} (touch-action may be blocking the pan)",
        )
        try:
            pg.get_by_text("Get keys", exact=True).wait_for(timeout=8000)
            tail = True
        except Exception:
            tail = False
        check("touch: tail rows mounted after the swipe", tail)
        pg.screenshot(path=f"{OUT}/touch-scrolled.png")

        # --- 2. REAL DRAG REORDER --------------------------------------
        # Back to the top, then drag the 5th row's grip down past the 6th row.
        pg.evaluate(f"({SCROLL_CONTAINER_JS})().scrollTop = 0")
        pg.wait_for_timeout(700)

        order_before = pg.evaluate("() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
        grip = pg.locator('[aria-label^="Drag to reorder"]').nth(4)
        box = grip.bounding_box()
        check("drag: grip handle found", box is not None)
        if box:
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            pg.mouse.move(cx, cy)
            pg.mouse.down()
            # Slow, stepped drag: RNGH web tracks pointermove for the pan.
            for i in range(1, 21):
                pg.mouse.move(cx, cy + (170 * i / 20), steps=2)
                pg.wait_for_timeout(30)
            pg.wait_for_timeout(400)
            pg.mouse.up()
            pg.wait_for_timeout(1200)  # let the reorder commit + persist

            order_after = pg.evaluate("() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
            moved = order_after != order_before
            detail = ""
            if moved:
                idx_before = order_before.index("Homeowners insurance quote")
                idx_after = order_after.index("Homeowners insurance quote")
                detail = f"'Homeowners insurance quote' {idx_before} -> {idx_after}"
            check("drag: real grip drag reordered the checklist", moved, detail or f"order unchanged: {order_after[:6]}")
            pg.screenshot(path=f"{OUT}/after-drag.png")

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll interaction checks passed.")


main()
