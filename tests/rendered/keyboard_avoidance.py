#!/usr/bin/env python3
"""Clear to Close — regression test: shared Sheet keyboard avoidance (Sept 2026).

Anuraj's screenshot showed the New escrow "Open escrow" button half-covered
by the iOS keyboard. The fix lives in the SHARED Sheet (src/components/ui):
when the keyboard opens, the whole sheet lifts above it AND the scroll
region shrinks to the visible area — the focused field stays reachable and
the save button is never buried.

Simulates the keyboard via window.visualViewport (the same signal the app
reads on web; iOS Safari never resizes the layout viewport for the
keyboard). On REAL built output, at 375x667 and 390x844, for BOTH the New
escrow and the Update escrow sheets, with the bottom field focused and the
keyboard up:
  - the sheet-scroll region shrinks to (visible height - chrome);
  - the save button's bounding box sits fully above the keyboard top edge;
  - the focused field is visible (browser scrolls it into view).
  - Zero JS errors.

Usage: python3 tests/rendered/keyboard_avoidance.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: APP_ROOT (repo root), CTC_PORT (default 8925),
CTC_OUT (output dir, default /tmp/ctc-keyboard-avoidance).
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-keyboard-avoidance")
PORT = int(os.environ.get("CTC_PORT", "8925"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []

# (viewport width, height, simulated keyboard height)
CASES = [
    (375, 667, 293),
    (390, 844, 346),
]

FAKE_VV = """() => {
  window.__vvHeight = window.innerHeight;
  const listeners = {};
  const fake = {
    get width() { return window.innerWidth; },
    get height() { return window.__vvHeight; },
    get offsetTop() { return 0; },
    get offsetLeft() { return 0; },
    get scale() { return 1; },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
  window.__vvSetHeight = (h) => {
    window.__vvHeight = h;
    (listeners['resize'] || []).forEach((fn) => { try { fn(); } catch (e) {} });
    (listeners['scroll'] || []).forEach((fn) => { try { fn(); } catch (e) {} });
  };
}"""


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


def scroll_max_height(pg):
    return pg.evaluate(
        "() => { const el = document.querySelector('[data-testid=\"sheet-scroll\"]');"
        " return el ? getComputedStyle(el).maxHeight : 'missing'; }")


def scroll_to_bottom(pg):
    # RNW overrides ScrollView.scrollTo with the native (y, x) signature —
    # drive the DOM setter directly.
    pg.evaluate(
        "() => { const el = document.querySelector('[data-testid=\"sheet-scroll\"]');"
        " if (el) el.scrollTop = el.scrollHeight; }")
    pg.wait_for_timeout(400)


def button_bottom(pg, label):
    box = pg.get_by_text(label, exact=True).last.bounding_box()
    return box["y"] + box["height"] if box else None


def field_bottom(pg, testid):
    box = pg.evaluate(
        "(id) => { const el = document.querySelector(`[data-testid='${id}']`);"
        " if (!el) return null; const r = el.getBoundingClientRect();"
        " return { y: r.y, h: r.height }; }".replace("${id}", testid))
    return box["y"] + box["h"] if box else None


def focus_field(pg, testid):
    # Focus without clicking: clicking a date input would open the browser's
    # native calendar popup and steal geometry.
    pg.evaluate(
        "(id) => { const el = document.querySelector(`[data-testid='${id}']`);"
        " if (el) el.focus(); }".replace("${id}", testid))
    pg.wait_for_timeout(300)


def keyboard_up(pg, height, kb):
    pg.evaluate(f"() => window.__vvSetHeight({height - kb})")
    pg.wait_for_timeout(600)


def keyboard_down(pg, height):
    pg.evaluate(f"() => window.__vvSetHeight({height})")
    pg.wait_for_timeout(500)


def boot(pg):
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
    pg.get_by_text("No escrows yet").wait_for(timeout=12000)
    pg.wait_for_timeout(600)


def check_sheet_with_keyboard(pg, tag, width, height, kb, save_label):
    visible = height - kb
    expected_max = f"{visible - 80}px"
    mh = scroll_max_height(pg)
    check(f"[{tag}] {width}x{height}: scroll region shrinks to visible-chrome ({expected_max})",
          mh == expected_max, f"got {mh}")
    scroll_to_bottom(pg)
    bb = button_bottom(pg, save_label)
    check(f"[{tag}] {width}x{height}: save button fully above the keyboard",
          bb is not None and bb <= visible + 1,
          f"button bottom={bb}, keyboard top={visible}")
    fb = field_bottom(pg, "escrow-close-date")
    check(f"[{tag}] {width}x{height}: focused bottom field visible",
          fb is not None and fb <= visible + 1,
          f"field bottom={fb}, keyboard top={visible}")
    pg.screenshot(path=os.path.join(OUT, f"keyboard-{tag}-{width}x{height}.png"))


def run_case(p, width, height, kb):
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": width, "height": height},
                    has_touch=True, is_mobile=True)
    pg.on("pageerror", lambda e: JS_ERRORS.append(f"{width}x{height}: {e}"))
    pg.add_init_script(f"({FAKE_VV})()")
    stub_auth_and_db(pg)
    try:
        boot(pg)

        # ---- New escrow sheet ----
        pg.get_by_text("+ New escrow", exact=True).first.click()
        pg.get_by_role("button", name="Open escrow").wait_for(timeout=8000)
        pg.wait_for_timeout(800)
        check(f"[new] {width}x{height}: no keyboard -> scroll region is full height (480px)",
              scroll_max_height(pg) == "480px", scroll_max_height(pg))
        focus_field(pg, "escrow-close-date")
        keyboard_up(pg, height, kb)
        check_sheet_with_keyboard(pg, "new", width, height, kb, "Open escrow")

        # ---- Create the escrow (keyboard down), then Update escrow ----
        keyboard_down(pg, height)
        pg.get_by_test_id("escrow-address").fill("26207 Benito Ct")
        pg.get_by_test_id("escrow-city").fill("Santa Clarita")
        pg.get_by_test_id("escrow-client-name").fill("Alice Buyer")
        pg.get_by_test_id("escrow-open-date").fill("2026-10-01")
        pg.get_by_test_id("escrow-close-date").fill("2026-12-01")
        pg.get_by_text("Open escrow", exact=True).last.click()
        pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)

        # Creating an escrow lands on its detail screen; the Update escrow
        # flow lives on the home deal card.
        pg.get_by_label("Back to escrows").click()
        pg.get_by_label("Edit escrow").first.wait_for(timeout=8000)
        pg.get_by_label("Edit escrow").first.click()
        pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)
        pg.wait_for_timeout(800)
        focus_field(pg, "escrow-close-date")
        keyboard_up(pg, height, kb)
        check_sheet_with_keyboard(pg, "update", width, height, kb, "Update escrow")

        b.close()
    finally:
        try:
            pg.close()
        except Exception:
            pass


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            for width, height, kb in CASES:
                print(f"--- viewport {width}x{height}, keyboard {kb}px ---", flush=True)
                run_case(p, width, height, kb)
    finally:
        srv.shutdown()

    print("\n----- keyboard_avoidance:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", str(e)[:200])
    if JS_ERRORS:
        check("zero JS errors", False, f"{len(JS_ERRORS)} errors")
    else:
        check("zero JS errors", True)
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
