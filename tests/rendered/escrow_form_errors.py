"""escrow_form_errors — field-specific validation regression (Anuraj, Sept 26, 2026).

The New escrow form must name the specific field on every validation
failure — never a generic "could not save". Submitting with each required
field missing (one at a time) shows that field's inline message:
  - street address -> "Please enter the property address."
  - city          -> "Please enter the city."
  - client name   -> "Please enter the client's name."
  - open date     -> "Please enter the escrow open date."
  - target close  -> "Please enter the target close date."
(The side picker always keeps one side selected by construction, so it
needs no error.) A fully valid form saves cleanly with no error at all.

Suite: 390x844. Zero JS errors.
"""
import http.server
import functools
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8925"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []

EXPECTED = {
    "address": "Please enter the property address.",
    "city": "Please enter the city.",
    "client": "Please enter the client's name.",
    "open": "Please enter the escrow open date.",
    "close": "Please enter the target close date.",
}

VALID = {
    "address": "26207 Benito Ct",
    "city": "Santa Clarita",
    "client": "Priya Nair",
    "open": "2026-09-25",
    "close": "2026-12-25",
}

TESTIDS = {
    "address": "escrow-address",
    "city": "escrow-city",
    "client": "escrow-client-name",
    "open": "escrow-open-date",
    "close": "escrow-close-date",
}


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


def open_form(pg):
    pg.get_by_text("+ New escrow", exact=True).first.click()
    pg.get_by_role("button", name="Open escrow").wait_for(timeout=8000)
    pg.wait_for_timeout(600)


def close_form(pg):
    # Dismiss via the scrim: click near the top edge above the sheet.
    pg.mouse.click(195, 30)
    pg.wait_for_timeout(600)


def fill_all(pg, skip=None):
    for key, testid in TESTIDS.items():
        if key == skip:
            continue
        pg.get_by_test_id(testid).fill(VALID[key])
    pg.wait_for_timeout(300)


def submit(pg):
    pg.get_by_text("Open escrow", exact=True).last.click()
    pg.wait_for_timeout(900)


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

            # Each required field missing, one at a time.
            for key in ["address", "city", "client", "open", "close"]:
                open_form(pg)
                fill_all(pg, skip=key)
                submit(pg)
                msg = EXPECTED[key]
                check(f"missing {key}: specific inline message shown",
                      pg.get_by_text(msg, exact=True).count() >= 1)
                check(f"missing {key}: no generic 'could not save'",
                      pg.get_by_text("Could not save. Try again.", exact=True).count() == 0)
                # The other fields' messages must NOT appear.
                others = [m for k, m in EXPECTED.items() if k != key]
                check(f"missing {key}: no unrelated field errors",
                      all(pg.get_by_text(m, exact=True).count() == 0 for m in others),
                      f"key={key}")
                close_form(pg)

            # Fully valid form saves cleanly.
            open_form(pg)
            fill_all(pg)
            submit(pg)
            pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
            check("valid form: escrow created and listed",
                  pg.get_by_text("26207 Benito Ct").first.count() > 0)
            check("valid form: no error text left on screen",
                  all(pg.get_by_text(m, exact=True).count() == 0
                      for m in list(EXPECTED.values()) + ["Could not save. Try again."]))

            b.close()
    finally:
        srv.shutdown()

    print("\n----- escrow_form_errors:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
