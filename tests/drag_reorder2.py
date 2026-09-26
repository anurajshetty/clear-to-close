#!/usr/bin/env python3
"""Clear to Close — drag-reorder ROUND 2 regression test (Sept 2026).

Root cause (reproduced with real gestures before the fix): on web,
react-native-draggable-flatlist measured each cell's offset relative to the
list's outer container, which sits OUTSIDE the scrolling FlatList — so every
measurement was missing the current scrollTop. The library already corrected
this for horizontal lists (`if (isWeb && horizontal) x += scrollOffset.value`)
but never for vertical ones. A row mounted while the list was scrolled (e.g.
a newly added custom row at the bottom of a long checklist) cached an offset
~scrollTop px too small; long-pressing its grip armed the drag from the wrong
anchor and the row visibly jumped DOWN (up to ~500px on a long list),
painting over the rows below it ("test step CUSTOM" over "Schedule
utilities"). Top rows were unaffected (scrollTop ~ 0 there).
Fix: patches/react-native-draggable-flatlist+4.0.3.patch applies the same
scroll-offset correction to the vertical axis (durable via patch-package +
postinstall in package.json).

Guards, all with real touch gestures against the real built output at
390x844 mobile viewport:
 1. tap: a quick tap on a lower row's grip arms nothing, moves no row, and
    does not scroll the list.
 2. dwell: a 750ms zero-movement long-press on the bottom row — after adding a
    custom row via the UI, the exact reported repro — leaves the armed row at
    translateY ~ 0: the row stays under the pointer. (Pre-fix: ~490px jump.)
 3. overlap: no two row titles' boxes overlap at any sampled stage.
 4. consecutive reorders: down/up/down/up drags each commit movement in the
    intended direction (the old "upward drag fails after a reorder" quirk was
    the same stale-measurement family).
 5. dynamic row: a custom row added via the UI drags upward successfully.
 6. persistence: the final order survives a full page reload.
 7. zero JS errors.

Usage: python3 tests/drag_reorder2.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/.
Honors APP_ROOT (defaults to the wt-dragrow worktree).
"""
import http.server
import functools
import os
import re
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-drag-reorder2"
BASE = "http://127.0.0.1:8908/clear-to-close/"

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
CUSTOMS = ["Order termite report", "Verify HOA docs", "Lock rate extension"]


def make_escrow():
    steps = [
        {"id": f"s{i}", "title": t, "subtitle": "", "done": i < 4,
         "custom": False, "order": i, "completedAt": None}
        for i, t in enumerate(BUY_STEPS)
    ]
    for j, t in enumerate(CUSTOMS):
        steps.append({"id": f"c{j}", "title": t, "subtitle": "", "done": False,
                      "custom": True, "order": len(steps), "completedAt": None})
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
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8908), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SCROLL_CONTAINER_JS = """() => {
  const els = [...document.querySelectorAll('*')];
  let best = null;
  for (const el of els) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  return best;
}"""

# Any cell the drag library has armed carries inline z-index 999.
DRAG_ARMED_JS = """() => {
  return [...document.querySelectorAll('*')].some(e => e.style && e.style.zIndex === '999');
}"""

# translateY of the armed (active) cell — ~0 means the row stayed under the
# pointer during a zero-movement long-press; a large value is the jump bug.
ARMED_TRANSLATE_Y_JS = """() => {
  const cell = [...document.querySelectorAll('*')].find(e => e.style && e.style.zIndex === '999');
  if (!cell) return null;
  const t = getComputedStyle(cell).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  if (!m) return 0;
  const parts = m[1].split(',').map(Number);
  return parts.length === 16 ? parts[13] : parts[5];
}"""

# Deepest element per step title -> bounding box (for overlap checks).
TITLE_BOXES_JS = """(titles) => {
  const els = [...document.querySelectorAll('*')];
  const out = {};
  for (const t of titles) {
    let best = null;
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      if (txt === t || txt.startsWith(t + '  ')) {
        if (!best || (best !== el && best.contains(el))) best = el;
      }
    }
    if (best) {
      const r = best.getBoundingClientRect();
      out[t] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
  }
  return out;
}"""

# Y-centers of all step titles, in persisted order (for movement checks).
ROW_CENTERS_JS = """(titles) => {
  const els = [...document.querySelectorAll('*')];
  const out = {};
  for (const t of titles) {
    let best = null;
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      if (txt === t || txt.startsWith(t + '  ')) {
        if (!best || (best !== el && best.contains(el))) best = el;
      }
    }
    if (best) {
      const r = best.getBoundingClientRect();
      out[t] = r.y + r.height / 2;
    }
  }
  return out;
}"""

GRIP_CENTER_JS = """(title) => {
  const g = document.querySelector('[aria-label="Drag to reorder ' + title + '"]');
  if (!g) return null;
  const b = g.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}"""


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    failures = []
    errors = []
    failed_reqs = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844},
                              has_touch=True, is_mobile=True)
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("requestfailed",
              lambda r: failed_reqs.append(f"{r.method} {r.url[:100]} :: {(r.failure or '')[:60]}"))
        # Guarded seed: applies on first boot only, never clobbers state on
        # reload (the persistence check depends on this).
        pg.add_init_script(
            "if (!localStorage.getItem('ctc:escrows')) { localStorage.setItem('ctc:escrows', '"
            + json.dumps(make_escrow()).replace("'", "\\'") + "'); }"
        )

        def fulfill_signup(route):
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
        pg.route("**/auth/v1/signup*", fulfill_signup)

        def fulfill_token(route):
            # signInWithPassword: same session shape as the signup stub.
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
        pg.route("**/auth/v1/token*", fulfill_token)

        def fulfill_rest_empty(route):
            # Cloud sync (dormant backend in tests): every REST read returns
            # no rows so local state is untouched; writes succeed silently.
            # Without this, the app's background sync hits the real Supabase
            # host and the sandbox records failed-resource console errors.
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization, Prefer",
                    "Access-Control-Expose-Headers": "Content-Range"})
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "Content-Range"}, json=[])
        pg.route("**/rest/v1/*", fulfill_rest_empty)

        def boot_to_escrow_detail():
            # Real flow: role -> signup -> skip -> deal list -> escrow detail.
            # After a reload the session restores and we land on the deal list.
            pg.goto(BASE)
            pg.wait_for_timeout(3500)
            if pg.get_by_text("I'm a Realtor").count():
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
            pg.get_by_text(re.compile(r"4 of 1[67] steps")).wait_for(timeout=12000)
            pg.wait_for_timeout(800)

        boot_to_escrow_detail()

        scroll_top = lambda: pg.evaluate(f"({SCROLL_CONTAINER_JS})().scrollTop")

        def wheel_to_bottom():
            pg.mouse.move(195, 500)
            for _ in range(20):
                pg.mouse.wheel(0, 300)
                pg.wait_for_timeout(60)
            pg.wait_for_timeout(900)

        def stored_titles():
            return pg.evaluate(
                "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")

        cdp = None
        def touch():
            nonlocal cdp
            if cdp is None:
                cdp = pg.context.new_cdp_session(pg)
            return cdp

        def touch_tap(x, y, hold_ms=120):
            c = touch()
            c.send("Input.dispatchTouchEvent",
                   {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            pg.wait_for_timeout(hold_ms)
            c.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(400)

        def touch_dwell(x, y, hold_ms=750):
            # Long-press with ZERO movement; returns (armed_translateY, scroll_delta).
            c = touch()
            before = scroll_top()
            c.send("Input.dispatchTouchEvent",
                   {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            pg.wait_for_timeout(hold_ms)
            ty = pg.evaluate(ARMED_TRANSLATE_Y_JS)
            c.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(600)
            return ty, scroll_top() - before

        def touch_drag(title, dy):
            # Center the row in the viewport first so there is room to drag
            # in either direction.
            g = None
            for _ in range(4):
                g = pg.evaluate(GRIP_CENTER_JS, title)
                assert g, f"grip not found for {title}"
                if 250 <= g["y"] <= 594:
                    break
                pg.evaluate(
                    "(gy) => { const sc = (" + SCROLL_CONTAINER_JS + ")();"
                    " if (sc) sc.scrollTop += (gy - 422); }", g["y"])
                pg.wait_for_timeout(400)
            assert g, f"grip not found for {title}"
            c = touch()
            c.send("Input.dispatchTouchEvent",
                   {"type": "touchStart",
                    "touchPoints": [{"x": g["x"], "y": g["y"]}]})
            pg.wait_for_timeout(750)  # long-press arms the drag
            cx, cy = g["x"], g["y"]
            steps = 16
            for i in range(1, steps + 1):
                c.send("Input.dispatchTouchEvent",
                       {"type": "touchMove",
                        "touchPoints": [{"x": cx, "y": cy + (dy * i / steps)}]})
                pg.wait_for_timeout(45)
            pg.wait_for_timeout(400)
            c.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(1300)

        def assert_no_overlap(stage, titles):
            boxes = pg.evaluate(TITLE_BOXES_JS, titles)
            collision = None
            ts = [t for t in titles if t in boxes]
            for i in range(len(ts)):
                for j in range(i + 1, len(ts)):
                    a, b = boxes[ts[i]], boxes[ts[j]]
                    ox = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
                    oy = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
                    area = ox * oy
                    smaller = min(a["w"] * a["h"], b["w"] * b["h"])
                    if smaller > 0 and area / smaller > 0.25:
                        collision = (ts[i], ts[j])
                        break
                if collision:
                    break
            check(f"overlap: no title collision ({stage})", collision is None,
                  f"overlap: {collision}")

        def assert_rendered_matches_persisted(stage):
            order = stored_titles()
            boxes = pg.evaluate(TITLE_BOXES_JS, order)
            rendered = [t for t in order if t in boxes]
            ys = [boxes[t]["y"] + boxes[t]["h"] / 2 for t in rendered]
            in_order = all(ys[i] <= ys[i + 1] + 2 for i in range(len(ys) - 1))
            check(f"order: rendered matches persisted ({stage})",
                  in_order and len(rendered) == len(order),
                  f"rendered={len(rendered)} persisted={len(order)}")

        # --- 1. quick tap on a lower row's grip: inert --------------------
        wheel_to_bottom()
        grip = pg.evaluate(GRIP_CENTER_JS, "Lock rate extension")
        check("tap: lower grip found", grip is not None)
        if grip:
            titles = stored_titles()
            centers_before = pg.evaluate(ROW_CENTERS_JS, titles)
            st_before = scroll_top()
            touch_tap(grip["x"], grip["y"], hold_ms=120)
            armed = pg.evaluate(DRAG_ARMED_JS)
            centers_after = pg.evaluate(ROW_CENTERS_JS, titles)
            moved = max(abs(centers_after[t] - centers_before.get(t, 0))
                        for t in centers_after) if centers_after else 999
            check("tap: quick tap does not arm a drag", not armed)
            check("tap: quick tap moves no row", moved <= 3, f"max row shift {moved:.1f}px")
            check("tap: quick tap does not scroll the list",
                  abs(scroll_top() - st_before) <= 4,
                  f"scrollTop {st_before} -> {scroll_top()}")

        # --- 2. dwell on the bottom row: no jump --------------------------
        grip = pg.evaluate(GRIP_CENTER_JS, "Lock rate extension")
        check("dwell: bottom grip found", grip is not None)
        if grip:
            ty, dscroll = touch_dwell(grip["x"], grip["y"], hold_ms=750)
            check("dwell: drag armed on long-press", ty is not None, "no cell armed")
            if ty is not None:
                check("dwell: bottom row stays under the pointer",
                      abs(ty) <= 8, f"armed translateY={ty}px (the jump bug)")
            check("dwell: list does not scroll during the press",
                  abs(dscroll) <= 4, f"scrollTop delta {dscroll}")
        assert_no_overlap("after dwell", stored_titles())

        # --- 3. add a custom row via the UI, dwell on it (exact repro) ----
        pg.mouse.move(195, 500)
        for _ in range(10):
            pg.mouse.wheel(0, 200)
            pg.wait_for_timeout(100)
            try:
                if pg.get_by_text("Add a custom step").first.is_visible():
                    break
            except Exception:
                pass
        pg.wait_for_timeout(500)
        pg.get_by_text("Add a custom step").first.click()
        pg.get_by_placeholder("Step name").fill("test step")
        pg.get_by_text("Add step", exact=True).click()
        pg.get_by_text("test step").wait_for(timeout=8000)
        pg.wait_for_timeout(1200)
        check("add: custom row added via UI", "test step" in stored_titles())
        wheel_to_bottom()
        grip = pg.evaluate(GRIP_CENTER_JS, "test step")
        check("dwell: new row grip found", grip is not None)
        if grip:
            ty, dscroll = touch_dwell(grip["x"], grip["y"], hold_ms=750)
            if ty is not None:
                check("dwell: newly added bottom row stays under the pointer",
                      abs(ty) <= 8,
                      f"armed translateY={ty}px — the reported jump is back")
            else:
                check("dwell: newly added bottom row arms on long-press", False,
                      "no cell armed")
            check("dwell: list does not scroll during the press",
                  abs(dscroll) <= 4, f"scrollTop delta {dscroll}")
        pg.screenshot(path=f"{OUT}/after-add.png")
        assert_no_overlap("after add", stored_titles())

        # --- 4. consecutive upward/downward reorders ----------------------
        drags = [("Get keys", 150, "down"), ("Record deal", -200, "up"),
                 ("Close escrow", 150, "down"), ("Schedule final walkthrough", -200, "up")]
        for title, dy, direction in drags:
            before = stored_titles()
            touch_drag(title, dy)
            after = stored_titles()
            ok = (after.index(title) > before.index(title)) if direction == "down" \
                else (after.index(title) < before.index(title))
            check(f"reorder: '{title}' dragged {direction}",
                  ok, f"{before.index(title)} -> {after.index(title)}")
            assert_rendered_matches_persisted(f"after dragging {title}")
        assert_no_overlap("after consecutive reorders", stored_titles())
        pg.screenshot(path=f"{OUT}/after-reorders.png")

        # --- 5. dynamically added row moves upward ------------------------
        before = stored_titles()
        assert "test step" in before
        touch_drag("test step", -220)
        after = stored_titles()
        check("reorder: UI-added custom row dragged up",
              after.index("test step") < before.index("test step"),
              f"{before.index('test step')} -> {after.index('test step')}")
        assert_rendered_matches_persisted("after moving added row")
        assert_no_overlap("after moving added row", stored_titles())

        # --- 6. order survives a full reload ------------------------------
        # Web now restores the realtor session (Sept 2026: session persists in
        # localStorage, ends only on Log out or browser-session end): after a
        # reload the app stays signed in on the escrow with the reordered
        # checklist intact — no re-login needed.
        expected = stored_titles()
        pg.goto(BASE)
        pg.wait_for_timeout(3500)
        pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
        check("reload: session survives reload (still signed in)",
              pg.get_by_text("Log in to pick up where you left off.").count() == 0)
        pg.get_by_text("26207 Benito Ct").first.click()
        pg.get_by_text(re.compile(r"4 of 1[67] steps")).wait_for(timeout=12000)
        pg.wait_for_timeout(800)
        check("reload: order survives reload", stored_titles() == expected,
              f"\nexpected={expected}\nactual  ={stored_titles()}")
        assert_rendered_matches_persisted("after reload")
        assert_no_overlap("after reload", stored_titles())
        pg.screenshot(path=f"{OUT}/after-reload.png")

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0,
          "; ".join(errors[:3]) + (" | failed requests: " + "; ".join(failed_reqs[:5]) if failed_reqs else ""))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll drag-reorder round-2 checks passed.")


main()
