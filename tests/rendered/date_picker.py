#!/usr/bin/env python3
"""Clear to Close — regression test: simple date picker + the only date rule (Sept 2026).

Anuraj: the YYYY-MM-DD text boxes for open/close dates are replaced by a
VERY SIMPLE picker — web uses the native date input (no popup-overlap
pattern); the selected date fills the field and saves. The ONLY enforced
rule: the target close can't be before the escrow open date (equal is fine).

On REAL built output (390x844), New escrow sheet:
  - both date fields are native `input[type=date]` (no custom popup);
  - choosing a date populates the field (input value reflects it);
  - close < open: the specific inline message appears and save is blocked;
  - close == open: saves fine;
  - close > open: saves fine (via the Update escrow flow);
  - the saved dates round-trip back into the Update escrow form.
  - Zero JS errors.

Usage: python3 tests/rendered/date_picker.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: APP_ROOT (repo root), CTC_PORT (default 8924),
CTC_OUT (output dir, default /tmp/ctc-date-picker).
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-date-picker")
PORT = int(os.environ.get("CTC_PORT", "8924"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []
ORDER_MSG = "The target close can't be before the opened date."


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


def input_type(pg, testid):
    return pg.evaluate(
        "(id) => { const el = document.querySelector(`[data-testid='${id}']`);"
        " return el ? (el.tagName + '#' + el.type) : 'missing'; }".replace("${id}", testid))


def input_value(pg, testid):
    return pg.evaluate(
        "(id) => { const el = document.querySelector(`[data-testid='${id}']`);"
        " return el ? el.value : null; }".replace("${id}", testid))


def fill_valid_text(pg):
    pg.get_by_test_id("escrow-address").fill("26207 Benito Ct")
    pg.get_by_test_id("escrow-city").fill("Santa Clarita")
    pg.get_by_test_id("escrow-client-name").fill("Alice Buyer")


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 390, "height": 844},
                            has_touch=True, is_mobile=True)
            pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
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
            pg.get_by_text("No escrows yet").wait_for(timeout=12000)
            pg.wait_for_timeout(600)

            # ---- 1. Native date inputs, no popup pattern ----
            pg.get_by_text("+ New escrow", exact=True).first.click()
            pg.get_by_role("button", name="Open escrow").wait_for(timeout=8000)
            pg.wait_for_timeout(600)
            check("open date is a native date input",
                  input_type(pg, "escrow-open-date") == "INPUT#date",
                  input_type(pg, "escrow-open-date"))
            check("close date is a native date input",
                  input_type(pg, "escrow-close-date") == "INPUT#date",
                  input_type(pg, "escrow-close-date"))

            # ---- 2. Choosing a date populates the field ----
            pg.get_by_test_id("escrow-open-date").fill("2026-10-01")
            pg.get_by_test_id("escrow-close-date").fill("2026-11-15")
            pg.wait_for_timeout(300)
            check("open date field shows the chosen date",
                  input_value(pg, "escrow-open-date") == "2026-10-01",
                  str(input_value(pg, "escrow-open-date")))
            check("close date field shows the chosen date",
                  input_value(pg, "escrow-close-date") == "2026-11-15",
                  str(input_value(pg, "escrow-close-date")))

            # ---- 3. close < open: specific message, save blocked ----
            pg.get_by_test_id("escrow-close-date").fill("2026-09-15")
            fill_valid_text(pg)
            pg.get_by_text("Open escrow", exact=True).last.click()
            pg.wait_for_timeout(900)
            check("close < open: specific inline message",
                  pg.get_by_text(ORDER_MSG, exact=True).count() >= 1)
            check("close < open: save blocked (still on the form)",
                  pg.get_by_text("Open escrow", exact=True).count() > 0
                  and pg.get_by_text("No escrows yet").count() > 0)

            # ---- 4. close == open: saves fine ----
            pg.get_by_test_id("escrow-close-date").fill("2026-10-01")
            pg.get_by_text("Open escrow", exact=True).last.click()
            pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
            check("close == open: escrow created",
                  pg.get_by_text("26207 Benito Ct").first.count() > 0)
            check("close == open: no order error",
                  pg.get_by_text(ORDER_MSG, exact=True).count() == 0)

            # ---- 5. Saved dates round-trip into Update escrow ----
            # Creating an escrow lands on its detail screen; the Update
            # escrow flow lives on the home deal card.
            pg.get_by_label("Back to escrows").click()
            pg.get_by_label("Edit escrow").first.wait_for(timeout=8000)
            pg.get_by_label("Edit escrow").first.click()
            pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)
            pg.wait_for_timeout(600)
            check("update form: open date round-trips",
                  input_value(pg, "escrow-open-date") == "2026-10-01",
                  str(input_value(pg, "escrow-open-date")))
            check("update form: close date round-trips",
                  input_value(pg, "escrow-close-date") == "2026-10-01",
                  str(input_value(pg, "escrow-close-date")))

            # ---- 6. close > open: saves fine via Update escrow ----
            pg.get_by_test_id("escrow-close-date").fill("2026-12-01")
            pg.get_by_text("Update escrow", exact=True).last.click()
            pg.wait_for_timeout(1200)
            check("close > open: update saved (sheet closed)",
                  pg.get_by_text("Update escrow", exact=True).count() == 0)
            pg.get_by_label("Edit escrow").first.click()
            pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)
            pg.wait_for_timeout(600)
            check("close > open: new close date persisted",
                  input_value(pg, "escrow-close-date") == "2026-12-01",
                  str(input_value(pg, "escrow-close-date")))

            b.close()
    finally:
        srv.shutdown()

    print("\n----- date_picker:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
