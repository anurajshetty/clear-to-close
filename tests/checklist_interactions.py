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
   The drag follows the product's long-press-to-arm interaction (700ms dwell
   before moving, mirroring tests/drag_reorder.py): an immediate press-and-move
   never arms the drag by design.

Usage: python3 tests/checklist_interactions.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).

Environment (so parallel streams do not collide):
  CTC_ROOT  project root (default: the repo containing this test file)
  CTC_PORT  http port for the test server (default: 8926)
  CTC_OUT   screenshot/output dir (default: /tmp/ctc-checklist-interactions)
"""
import http.server
import functools
import os
import threading
import sys
import json
import time

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT") or "/tmp/ctc-checklist-interactions"
PORT = int(os.environ.get("CTC_PORT") or "8926")
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
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

        def fulfill_rest_empty(route):
            # Dormant cloud sync: reads return no rows so local state is
            # untouched; writes succeed silently. Without this, the app's
            # background sync hits the real Supabase host and the sandbox
            # records failed-resource console errors (ERR_EMPTY_RESPONSE).
            if route.request.method == "OPTIONS":
                route.fulfill(
                    status=200,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization, Prefer",
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

        # Specific stubs for the dormant cloud-sync endpoints the app hits
        # (escrow reads/upserts, invite reads, step upserts). Reads return no rows so local
        # state is untouched; writes succeed silently. Without these, the
        # app's background sync hits the real Supabase host and the sandbox
        # records failed-resource console errors (ERR_EMPTY_RESPONSE).
        # NOTE: a broad "**/rest/v1/*" catch-all is NOT used here — it
        # interferes with the signup flow in this harness (verified).
        pg.route("**/rest/v1/escrows*", fulfill_rest_empty)
        pg.route("**/rest/v1/invites*", fulfill_rest_empty)
        pg.route("**/rest/v1/steps*", fulfill_rest_empty)

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
        # The list is at the tail after the swipe above. Long-press the tail
        # grip to arm the drag (the product requires a ~500ms hold; an
        # immediate press-and-move never arms it by design), then drag upward
        # in small steps — the technique proven in tests/drag_reorder.py.
        # The reorder is verified in persisted storage.
        order_before = pg.evaluate("() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
        grips = pg.locator('[aria-label^="Drag to reorder"]')
        n_grips = grips.count()
        check("drag: grip handle found", n_grips > 0, f"count={n_grips}")
        if n_grips:
            grip = grips.nth(n_grips - 1)  # tail row
            # Ensure the tail grip is inside the viewport: the swipe above
            # may leave it mounted but off-screen, where a mouse press cannot
            # reach it.
            try:
                grip.scroll_into_view_if_needed(timeout=5000)
            except Exception:
                pass
            pg.wait_for_timeout(600)  # let scroll settle + measurements update
            box = grip.bounding_box()
            visible = box is not None and 0 <= box["y"] <= 844 and 0 <= box["x"] <= 390
            check("drag: tail grip is visible", visible, f"box={box}")
            if visible:
                cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                tail_title = order_before[-1]
                ARMED_JS = "() => [...document.querySelectorAll('*')].some(e => e.style && e.style.zIndex === '999')"
                # Long-press to arm: the product requires a ~500ms hold. The
                # arming can be flaky in this harness right after the CDP
                # touch swipe (pre-existing Playwright/RNGH input quirk, also
                # noted in tests/drag_reorder.py), so retry the press until the
                # row arms or we run out of attempts.
                armed = False
                for attempt in range(3):
                    pg.mouse.move(cx, cy)
                    pg.mouse.down()
                    pg.wait_for_timeout(700)
                    armed = pg.evaluate(ARMED_JS)
                    if armed:
                        break
                    pg.mouse.up()
                    pg.wait_for_timeout(500)
                check("drag: long-press armed the row", armed)
                if armed:
                    # Slow, stepped drag: RNGH web tracks pointermove for the pan.
                    for i in range(1, 21):
                        pg.mouse.move(cx, cy + (-200 * i / 20), steps=2)
                        pg.wait_for_timeout(40)
                    pg.wait_for_timeout(400)
                    pg.mouse.up()
                    pg.wait_for_timeout(1200)  # let the reorder commit + persist

                    order_after = pg.evaluate("() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
                    moved = order_after != order_before
                    detail = ""
                    if moved:
                        detail = f"'{tail_title}' {order_before.index(tail_title)} -> {order_after.index(tail_title)}"
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
