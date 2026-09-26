"""drag_row_ux — Anuraj's iPhone drag-row refinement (Sept 26, 2026).

Directives:
  1. A dragged item must reach the VERY TOP and VERY BOTTOM of the checklist —
     the list scrolls beneath the finger during the drag; a middle row must be
     droppable at position 1 and at the final position.
  2. Long-press arms the drag on the ENTIRE row including the step text — not
     only the grip dots. The checkbox is excluded: tap still checks/unchecks,
     long-press on the checkbox never arms a drag and never breaks tapping.
     Quick tap on row text is inert.

Suites: 375x667 and 390x844.
"""
import http.server
import functools
import os
import sys
import json
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8921"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "drag_row_ux")
os.makedirs(OUT, exist_ok=True)

FAILS = []
JS_ERRORS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name + (f" [{detail}]" if detail else ""))


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
            if not os.path.isfile(os.path.join(DIST, rest.lstrip("/"))):
                rest = "/index.html"
            self.path = rest + qs
        return super().do_GET()


def seed_escrows():
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": False,
         "custom": False, "order": i, "completedAt": None}
        for i in range(10)
    ]
    return [{
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": "2026-09-25", "closeDate": "2026-12-25",
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": "2026-09-25",
    }]


def stub_auth_and_db(pg):
    def fauth(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
            json={"access_token": "x", "token_type": "bearer", "expires_in": 3600,
                  "refresh_token": "y",
                  "user": {"id": "u1", "email": "rita@example.com",
                           "user_metadata": {"name": "Rita"}}})

    pg.route("**/auth/v1/signup*", fauth)
    pg.route("**/auth/v1/token*", fauth)

    def fempty(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                "Access-Control-Expose-Headers": "Content-Range"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
            "Access-Control-Expose-Headers": "Content-Range"}, json=[])

    pg.route("**/rest/v1/*", fempty)


def boot(pg):
    pg.add_init_script(
        "localStorage.setItem('ctc:escrows', '"
        + json.dumps(seed_escrows()).replace("'", "\\'") + "');")
    stub_auth_and_db(pg)
    pg.goto(BASE)
    pg.wait_for_timeout(3000)
    pg.get_by_text("I'm a Realtor").click()
    pg.wait_for_timeout(400)
    pg.get_by_text("Continue", exact=True).click()
    pg.wait_for_timeout(1200)
    ins = pg.locator("input")
    ins.nth(0).fill("Rita Realtor")
    ins.nth(1).fill("rita@example.com")
    ins.nth(2).fill("longenoughpassword")
    pg.get_by_text("Create account", exact=True).click()
    pg.get_by_text("Skip for now").wait_for(timeout=12000)
    pg.get_by_text("Skip for now").click()
    pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
    pg.get_by_text("26207 Benito Ct").first.click()
    pg.get_by_text("Step 05").wait_for(timeout=12000)
    pg.wait_for_timeout(1000)


# ---- DOM helpers -----------------------------------------------------------

CENTER_JS = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}"""

# Center of the step TEXT (not the checkbox, not the grip).
TEXT_CENTER_JS = """(title) => {
  const cands = [...document.querySelectorAll('*')].filter(e =>
    e.children.length === 0 && (e.textContent || '').trim() === title);
  if (!cands.length) return null;
  // The title text node lives inside the row body; pick the deepest match
  // whose ancestor row is a realtor row (has a checkbox testid sibling).
  cands.sort((a, b) => {
    const d = (e) => { let n = 0, x = e; while (x.parentElement) { x = x.parentElement; n++; } return n; };
    return d(b) - d(a);
  });
  const b = cands[0].getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}"""

ORDER_JS = """() => {
  const rows = [...document.querySelectorAll('[data-testid="step-row"]')];
  return rows.map(r => {
    const t = [...r.querySelectorAll('*')].find(e =>
      e.children.length === 0 && /^Step \\d\\d$/.test((e.textContent || '').trim()));
    return t ? t.textContent.trim() : '?';
  });
}"""

ARMED_JS = """() => [...document.querySelectorAll('*')]
  .some(e => e.style && e.style.zIndex === '999')"""

LIST_EL_JS = """() => {
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 4 && el.scrollHeight > 200) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  return best;
}"""


def stored_done(pg, title):
    """Read the step's done flag from the app's localStorage copy."""
    for _ in range(20):
        raw = pg.evaluate("() => localStorage.getItem('ctc:escrows')")
        try:
            escrows = json.loads(raw)
            for s in escrows[0]["buyerSteps"]:
                if s["title"] == title:
                    return s["done"]
        except Exception:
            pass
        pg.wait_for_timeout(200)
    return None


def park_row_mid(pg, title, vh):
    """Scroll the list so the row's TEXT sits near mid-viewport."""
    for _ in range(10):
        c = pg.evaluate(TEXT_CENTER_JS, title)
        if not c:
            return None
        if abs(c["y"] - vh / 2) <= 20:
            return c
        pg.evaluate("""({gy, vh}) => {
          const els = [...document.querySelectorAll('*')];
          let best = null;
          for (const el of els) {
            if (el.scrollHeight > el.clientHeight + 4 && el.scrollHeight > 200) {
              if (!best || el.scrollHeight > best.scrollHeight) best = el;
            }
          }
          if (best) best.scrollTop += (gy - vh / 2);
        }""", {"gy": c["y"], "vh": vh})
        pg.wait_for_timeout(400)
    return pg.evaluate(TEXT_CENTER_JS, title)


def touch_long_press(cdp, x, y, hold_ms=750):
    cdp.send("Input.dispatchTouchEvent",
             {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    return time.time()


def touch_end(cdp):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def drag_text_to_edge(pg, cdp, title, vh, edge_y, hold_s=3.0):
    """Long-press the step TEXT, drag to a screen edge, hold, release."""
    c = park_row_mid(pg, title, vh)
    assert c, f"text center not found for {title}"
    touch_long_press(cdp, c["x"], c["y"])
    pg.wait_for_timeout(750)
    armed = pg.evaluate(ARMED_JS)
    cx, cy = c["x"], c["y"]
    steps = 16
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": cx, "y": cy + (edge_y - cy) * i / steps}]})
        pg.wait_for_timeout(45)
    # Hold at the edge with slight wiggle so the list keeps autoscrolling.
    t0 = time.time()
    j = 0
    while time.time() - t0 < hold_s:
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": cx, "y": edge_y + (5 if j % 2 == 0 else -5)}]})
        pg.wait_for_timeout(250)
        j += 1
    touch_end(cdp)
    pg.wait_for_timeout(1200)
    return armed


def run_viewport(vw, vh, tag):
    print(f"\n===== viewport {vw}x{vh} ({tag}) =====")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": vw, "height": vh},
                        has_touch=True, is_mobile=True)
        pg.on("pageerror", lambda e: JS_ERRORS.append(f"{tag}: {e}"))
        boot(pg)
        cdp = pg.context.new_cdp_session(pg)

        # 1) Middle row -> FIRST position via text long-press + drag to top.
        armed = drag_text_to_edge(pg, cdp, "Step 05", vh, edge_y=44, hold_s=3.0)
        order = pg.evaluate(ORDER_JS)
        check(f"[{tag}] text long-press arms the drag", armed is True)
        check(f"[{tag}] Step 05 reaches position 1 (top edge drag)",
              order[0] == "Step 05", f"order={order[:3]}")

        # 2) Grip long-press still arms the drag (no visual/behavior change).
        #    (No reload: Step 05 now sits at index 0; arming needs no order.)
        g = pg.evaluate(CENTER_JS, '[aria-label="Drag to reorder Step 05"]')
        assert g, "grip not found"
        touch_long_press(cdp, g["x"], g["y"])
        pg.wait_for_timeout(750)
        check(f"[{tag}] grip long-press arms the drag",
              pg.evaluate(ARMED_JS) is True)
        touch_end(cdp)
        pg.wait_for_timeout(600)

        # 3) Checkbox tap toggles; long-press does not arm or toggle.
        #    (No reload: Step 05 is untouched except its new position.)
        before = stored_done(pg, "Step 05")
        pg.get_by_test_id("step-checkbox-Step 05").click()
        after = stored_done(pg, "Step 05")
        check(f"[{tag}] checkbox tap toggles the step",
              before is False and after is True, f"before={before} after={after}")

        c = pg.evaluate(CENTER_JS, '[data-testid="step-checkbox-Step 05"]')
        assert c, "checkbox center not found"
        touch_long_press(cdp, c["x"], c["y"], hold_ms=900)
        pg.wait_for_timeout(900)
        check(f"[{tag}] checkbox long-press does NOT arm a drag",
              pg.evaluate(ARMED_JS) is not True)
        touch_end(cdp)
        pg.wait_for_timeout(600)
        still = stored_done(pg, "Step 05")
        check(f"[{tag}] checkbox long-press does NOT toggle",
              still is True, f"done={still}")

        # 4) Quick tap on row text is inert (no toggle, no drag).
        t = pg.evaluate(TEXT_CENTER_JS, "Step 06")
        assert t, "text center not found"
        cdp.send("Input.dispatchTouchEvent",
                 {"type": "touchStart", "touchPoints": [{"x": t["x"], "y": t["y"]}]})
        pg.wait_for_timeout(120)
        touch_end(cdp)
        pg.wait_for_timeout(600)
        check(f"[{tag}] quick row-text tap does NOT toggle",
              stored_done(pg, "Step 06") is False)
        check(f"[{tag}] quick row-text tap does NOT arm a drag",
              pg.evaluate(ARMED_JS) is not True)

        # 5) Middle row -> FINAL position via text long-press + drag to bottom.
        armed = drag_text_to_edge(pg, cdp, "Step 06", vh, edge_y=vh - 12, hold_s=4.0)
        order = pg.evaluate(ORDER_JS)
        check(f"[{tag}] Step 06 reaches the final position (bottom edge drag)",
              order[-1] == "Step 06", f"order={order[-3:]}")

        pg.screenshot(path=os.path.join(OUT, f"{tag}-final.png"))
        b.close()


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        run_viewport(375, 667, "375x667")
        run_viewport(390, 844, "390x844")
    finally:
        srv.shutdown()

    print("\n----- drag_row_ux:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", e)
    if JS_ERRORS:
        check("zero JS errors", False, f"{len(JS_ERRORS)} errors")
    else:
        check("zero JS errors", True)
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
