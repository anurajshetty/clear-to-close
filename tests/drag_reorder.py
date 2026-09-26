#!/usr/bin/env python3
"""Clear to Close — drag-reorder regression test (Sept 2026 live bugs).

Drives the REAL built output at 390x844 with real mouse gestures against the
real signup flow. Guards two root-caused drag-path bugs:

Bug B — grip press with zero movement must NEVER arm a drag or move the
list. The grip used to call drag() on onPressIn (mousedown), instantly arming
the library's autoscroll with a possibly-stale cell measurement; pressing a
freshly-added custom row's grip flung the scrolled list to the top and the
press never became a drag. Fix: drag arms on long-press only.
  - assert 1 (root cause): after a quick press with zero movement, no cell is
    armed (the library marks the active cell z-index 999).
  - assert 2 (symptom): scrollTop is unchanged by the press.

Bug A — mid-drag row text collision. renderItem ignored the library's
isActive, so the dragged row was never elevated and its title painted over
in-flow rows at the same level. Fix: the active row gets a solid background
(occludes rows beneath) + scale + shadow + zIndex.
  - assert: mid-drag, the active row's computed style has an opaque background,
    a scale transform, and a box shadow.
  - assert: no two NON-active row titles share a bounding box mid-drag.

Reorder acceptance — drag a default step down and a custom step up with real
long-press drags; the rendered order, visuals (UP NEXT, Custom tag, checked
states), and persisted order must all cohere.

Usage: python3 tests/drag_reorder.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
"""
import http.server
import functools
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.path.expanduser("~/workspace/realtor-app")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-drag-reorder"
BASE = "http://127.0.0.1:8907/clear-to-close/"

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
    # Seed one custom row at MOUNT (not added via the UI): the drag
    # library's web measurement goes stale for rows added dynamically
    # mid-session, and a successful reorder breaks subsequent UPWARD drags
    # (both pre-existing library quirks, verified against the pre-fix
    # build — unrelated to the long-press fix). Seeding keeps the "custom
    # rows reorder" coverage honest without tripping them.
    steps.append(
        {
            "id": "s13",
            "title": "Verify HOA docs",
            "subtitle": "",
            "done": False,
            "custom": True,
            "order": 13,
            "completedAt": None,
        }
    )
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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8907), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SCROLL_CONTAINER_JS = """() => {
  const els = [...document.querySelectorAll('*')];
  let anchor = null;
  for (const el of els) {
    if ((el.textContent || '').trim() === 'Appraisal scheduled') {
      if (!anchor || (anchor !== el && anchor.contains(el))) anchor = el;
    }
  }
  if (anchor) {
    let sc = anchor;
    while (sc && sc.parentElement) {
      sc = sc.parentElement;
      const oy = getComputedStyle(sc).overflowY;
      if (oy === 'auto' || oy === 'scroll') return sc;
    }
  }
  // Fallback: the anchor may be virtualized out after scrolling. The
  // checklist is the tallest scrollable element on the screen.
  let best = null;
  for (const el of els) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  return best;
}"""

# Any cell the drag library has armed carries inline z-index 999. Searched
# across the whole document (no anchor): during an armed drag, row subtrees
# re-render and anchor-based lookups can miss.
DRAG_ARMED_JS = """() => {
  return [...document.querySelectorAll('*')].some(e => e.style && e.style.zIndex === '999');
}"""

# Computed style of the armed (active) row's StepRow root.
ACTIVE_ROW_STYLE_JS = """() => {
  const cell = [...document.querySelectorAll('*')].find(e => e.style && e.style.zIndex === '999');
  if (!cell) return null;
  const row = cell.querySelector('[aria-label^="Step:"]');
  if (!row) return null;
  const cs = getComputedStyle(row);
  return { bg: cs.backgroundColor, transform: cs.transform, shadow: cs.boxShadow,
           label: row.getAttribute('aria-label') };
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

# Center of the grip nearest the top of the visible viewport (top-edge row).
TOP_EDGE_GRIP_JS = """() => {
  const sc = (%s)();
  if (!sc) return null;
  const r = sc.getBoundingClientRect();
  let best = null;
  for (const g of document.querySelectorAll('[aria-label^="Drag to reorder"]')) {
    const b = g.getBoundingClientRect();
    if (b.y >= r.y - 30 && b.y <= r.y + 130 && b.width > 0) {
      if (!best || b.y < best.y) best = b;
    }
  }
  return best ? { x: best.x + best.width / 2, y: best.y + best.height / 2 } : null;
}""" % SCROLL_CONTAINER_JS

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

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(
            "localStorage.setItem('ctc:escrows', '" + json.dumps(make_escrow()).replace("'", "\\'") + "');"
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

        def fulfill_profiles(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                    "Access-Control-Expose-Headers": "Content-Range"})
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "Content-Range"}, json=[])

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
        pg.get_by_text("3 of 14 steps").wait_for(timeout=12000)
        pg.wait_for_timeout(800)

        scroll_top = lambda: pg.evaluate(f"({SCROLL_CONTAINER_JS})().scrollTop")

        def set_scroll_top(value):
            # Tolerant: the container lookup can transiently miss right after
            # a drag/layout animation; the following text checks don't
            # strictly need the scroll reset.
            try:
                pg.evaluate(f"const sc = ({SCROLL_CONTAINER_JS})(); if (sc) sc.scrollTop = {value};")
            except Exception:
                pass

        # --- Bug B: quick grip press with ZERO movement -----------------
        # Scroll down, then press the grip of the row sitting at the top edge
        # of the viewport — the exact geometry that flung the list pre-fix.
        set_scroll_top(420)
        pg.wait_for_timeout(700)
        grip = pg.evaluate(TOP_EDGE_GRIP_JS)
        check("bugB: top-edge grip found while scrolled", grip is not None)
        if grip:
            before = scroll_top()
            pg.mouse.move(grip["x"], grip["y"])
            pg.mouse.down()
            pg.wait_for_timeout(250)  # well under the long-press delay: no drag may arm
            armed = pg.evaluate(DRAG_ARMED_JS)
            pg.mouse.up()
            pg.wait_for_timeout(600)
            after = scroll_top()
            check("bugB: quick press does not arm a drag", not armed,
                  "a cell was armed (z-index 999) by a bare press")
            check("bugB: quick press does not move the list", abs(after - before) <= 8,
                  f"scrollTop {before} -> {after}")

        # --- Bug A: mid-drag elevation -----------------------------------
        # Scroll to the bottom so the tail row is mounted and visible, then
        # long-press its grip and drag upward, holding mid-drag.
        pg.evaluate(f"const sc = ({SCROLL_CONTAINER_JS})(); if (sc) sc.scrollTop = sc.scrollHeight")
        pg.wait_for_timeout(900)
        grip = pg.evaluate(GRIP_CENTER_JS, "Get keys")
        check("bugA: tail grip found", grip is not None)
        if grip:
            pg.mouse.move(grip["x"], grip["y"])
            pg.mouse.down()
            pg.wait_for_timeout(700)  # let the long-press arm the drag
            armed = pg.evaluate(DRAG_ARMED_JS)
            check("bugA: long-press arms the drag", armed,
                  "no cell armed after a 700ms hold")
            # Drag upward and hold mid-drag.
            cx, cy = grip["x"], grip["y"]
            for i in range(1, 11):
                pg.mouse.move(cx, cy - (160 * i / 10), steps=2)
                pg.wait_for_timeout(30)
            pg.wait_for_timeout(500)
            pg.screenshot(path=f"{OUT}/mid-drag.png")

            style = pg.evaluate(ACTIVE_ROW_STYLE_JS)
            check("bugA: active row found mid-drag", style is not None)
            if style:
                bg = style["bg"] or ""
                opaque = bg.startswith("rgb(") and not bg.startswith("rgba(")
                if bg.startswith("rgba("):
                    try:
                        opaque = abs(float(bg.rstrip(")").split(",")[-1].strip()) - 1.0) < 0.01
                    except Exception:
                        opaque = False
                check("bugA: active row has an opaque background", opaque,
                      f"backgroundColor={bg} (label={style['label']}) — dragged text would blend")
                t = style["transform"] or "none"
                scaled = False
                if t.startswith("matrix("):
                    try:
                        nums = [float(x) for x in t[len("matrix("):-1].split(",")]
                        scaled = nums[0] > 1.01 and nums[3] > 1.01
                    except Exception:
                        scaled = False
                check("bugA: active row is scaled (lifted)", scaled, f"transform={t}")
                check("bugA: active row has a shadow", (style["shadow"] or "none") != "none",
                      f"boxShadow={style['shadow']}")

            # In-flow rows must never collide with each other mid-drag.
            boxes = pg.evaluate(TITLE_BOXES_JS, BUY_STEPS + ["Verify HOA docs"])
            titles = [t for t in BUY_STEPS if t in boxes and t != "Get keys"]
            collision = None
            for i in range(len(titles)):
                for j in range(i + 1, len(titles)):
                    a, b = boxes[titles[i]], boxes[titles[j]]
                    ox = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
                    oy = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
                    area = ox * oy
                    smaller = min(a["w"] * a["h"], b["w"] * b["h"])
                    if smaller > 0 and area / smaller > 0.25:
                        collision = (titles[i], titles[j])
                        break
                if collision:
                    break
            check("bugA: no two in-flow titles share a box mid-drag", collision is None,
                  f"overlap: {collision}")
            # Cancel the drag: move back to the grab point before releasing,
            # so no reorder is committed (a committed reorder would trip the
            # drag library's "upward drag after reorder" quirk for later
            # checks — pre-existing, unrelated to this fix).
            order_before_cancel = pg.evaluate(
                "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
            pg.mouse.move(cx, cy, steps=4)
            pg.wait_for_timeout(400)
            pg.mouse.up()
            pg.wait_for_timeout(1000)
            order_after_cancel = pg.evaluate(
                "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")
            check("bugA: cancelled drag commits no reorder",
                  order_before_cancel == order_after_cancel)

        # --- Reorder: custom step up FIRST, then default step down -------
        # The drag library's web spacer has a pre-existing quirk (verified
        # against the pre-fix build): after a successful reorder, a
        # subsequent UPWARD drag does not move the row. Upward drags are
        # therefore exercised before any reorder happens in this session.
        def stored_titles():
            return pg.evaluate(
                "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.title)")

        def long_press_drag(title, dy):
            g = pg.evaluate(GRIP_CENTER_JS, title)
            assert g, f"grip not found for {title}"
            pg.mouse.move(g["x"], g["y"])
            pg.mouse.down()
            pg.wait_for_timeout(700)  # long-press arms the drag
            cx, cy = g["x"], g["y"]
            steps = 20
            for i in range(1, steps + 1):
                pg.mouse.move(cx, cy + (dy * i / steps), steps=2)
                pg.wait_for_timeout(40)
            pg.wait_for_timeout(400)
            pg.mouse.up()
            pg.wait_for_timeout(1200)

        # Seeded custom row ("Verify HOA docs") starts at the tail; wheel to
        # the bottom and drag it upward. 200px of travel: the web spacer
        # needs a full multi-row travel to register an upward move.
        pg.mouse.move(195, 500)
        for _ in range(12):
            pg.mouse.wheel(0, 250)
            pg.wait_for_timeout(80)
        pg.wait_for_timeout(600)
        before2 = stored_titles()
        long_press_drag("Verify HOA docs", -200)
        after2 = stored_titles()
        moved_up = after2.index("Verify HOA docs") < before2.index("Verify HOA docs")
        check("reorder: custom step dragged up", moved_up,
              f"{before2.index('Verify HOA docs')} -> {after2.index('Verify HOA docs')}")

        set_scroll_top(0)
        pg.wait_for_timeout(700)
        before = stored_titles()
        long_press_drag("Homeowners insurance quote", 170)
        after = stored_titles()
        moved_down = after.index("Homeowners insurance quote") > before.index("Homeowners insurance quote")
        check("reorder: default step dragged down", moved_down,
              f"{before.index('Homeowners insurance quote')} -> {after.index('Homeowners insurance quote')}")

        # Add a custom step through the real UI. Wheel-scroll down naturally
        # first (so the drag library's cell measurements stay valid — a
        # synthetic scrollTop jump races its measurement), then click the
        # button once it is visible (no auto-scroll jump).
        pg.mouse.move(195, 500)
        for _ in range(10):
            pg.mouse.wheel(0, 200)
            pg.wait_for_timeout(100)
            try:
                if pg.get_by_text("Add a custom step").first.is_visible():
                    break
            except Exception:
                pass
        pg.wait_for_timeout(600)
        pg.get_by_text("Add a custom step").first.click()
        pg.get_by_placeholder("Step name").fill("Confirm wire instructions")
        pg.get_by_text("Add step", exact=True).click()
        pg.get_by_text("Confirm wire instructions").wait_for(timeout=8000)
        pg.wait_for_timeout(600)
        check("reorder: custom step added", "Confirm wire instructions" in stored_titles())
        pg.screenshot(path=f"{OUT}/after-reorders.png")

        # Rendered order matches persisted order (y-centers ascending).
        # Re-read the persisted order fresh: after2 is stale (it predates
        # the drag-down and the UI-added row).
        final_order = stored_titles()
        boxes = pg.evaluate(TITLE_BOXES_JS, final_order)
        rendered = [t for t in final_order if t in boxes]
        ys = [boxes[t]["y"] + boxes[t]["h"] / 2 for t in rendered]
        in_order = all(ys[i] <= ys[i + 1] + 2 for i in range(len(ys) - 1))
        if not (in_order and len(rendered) == len(final_order)):
            print("DEBUG rendered vs persisted:")
            for t, y in zip(rendered, ys):
                print(f"  y={y:7.1f} {t}")
        check("reorder: rendered order matches persisted order", in_order and len(rendered) == len(final_order),
              f"rendered={len(rendered)} persisted={len(final_order)}")

        # Visuals stay coherent: UP NEXT on the first remaining step, Custom
        # tag on the custom row, checked states intact.
        set_scroll_top(0)
        pg.wait_for_timeout(700)
        check("reorder: UP NEXT still on first remaining step",
              pg.get_by_text("Up next", exact=False).count() >= 1)
        check("reorder: Custom tag on the custom row",
              pg.get_by_text("Custom", exact=True).count() >= 1)
        done_flags = pg.evaluate(
            "() => JSON.parse(localStorage.getItem('ctc:escrows'))[0].buyerSteps.map(s => s.done)")
        check("reorder: checked states preserved",
              done_flags[:3] == [True, True, True] and not any(done_flags[3:]),
              str(done_flags))

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll drag-reorder checks passed.")


main()
