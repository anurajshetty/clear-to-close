#!/usr/bin/env python3
"""Clear to Close — login routing regression (real built output).

Reproduces the hotfix bug: logging in with an existing realtor account whose
profile is set must land on the deal list, not profile creation. The routing
decision previously read the profile from the local KV only; this test drives
the REAL login flow against the built web bundle with a stubbed Supabase
session + stubbed realtor_profiles REST endpoint:

  case A: cloud profile exists, local store empty -> deal list ("Escrows")
  case B: no cloud profile (brand-new account)   -> "Create your profile"
  case C: "Skip for now" on profile creation     -> deal list (no trap)

Also asserts zero JS console errors / page errors throughout.

Usage: python3 tests/login_routing.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/.
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
OUT = "/tmp/ctc-login-routing"
BASE = "http://127.0.0.1:8905/clear-to-close/"
LOGIN = BASE + "login"

UID = "test-uid-1"
PROFILE_ROW = {
    "name": "Rita Realtor",
    "photo_url": None,
    "about": "About Rita",
    "years_experience": "8",
    "deals_closed": "42",
    "areas_served": "Valencia",
    "phone": "555-0100",
    "dre_license": "DRE-123",
}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization, Prefer",
}


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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8905), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SESSION_JSON = {
    "access_token": "fake-jwt",
    "token_type": "bearer",
    "expires_in": 3600,
    "refresh_token": "fake-refresh",
    "user": {"id": UID, "email": "rita@example.com", "user_metadata": {}},
}


def make_stubs(pg, profile_rows):
    def fulfill_token(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                      json=SESSION_JSON)

    def fulfill_profiles(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        if route.request.method == "GET":
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                          json=profile_rows)
        else:
            # upsert probe (ping) / pushProfileNow — accept
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, json={})

    pg.route("**/auth/v1/token*", fulfill_token)
    pg.route("**/rest/v1/realtor_profiles*", fulfill_profiles)


def run_case(pg, errors, name, profile_rows, expect):
    pg.goto(LOGIN)
    pg.wait_for_timeout(2500)
    inputs = pg.locator("input")
    inputs.nth(0).fill("rita@example.com")
    inputs.nth(1).fill("longenoughpassword")
    pg.get_by_role("button", name="Log in").click()
    pg.get_by_text(expect, exact=True).wait_for(timeout=15000)
    body = pg.inner_text("body")
    ok = expect in body
    print(("PASS " if ok else "FAIL ") + f"{name}: landed on '{expect}'")
    pg.screenshot(path=f"{OUT}/{name}.png")
    return ok


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    failures = []
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script("localStorage.setItem('ctc:role', 'realtor');")

        # Case A: existing account, completed cloud profile, empty local store.
        make_stubs(pg, [PROFILE_ROW])
        if not run_case(pg, errors, "A-existing-profile", [PROFILE_ROW], "Escrows"):
            failures.append("A")

        # Case B: brand-new account, no cloud profile -> profile creation.
        pg.unroute("**/rest/v1/realtor_profiles*")
        make_stubs(pg, [])
        # fresh context state: clear local storage so the pulled profile is gone
        pg.evaluate("localStorage.clear(); localStorage.setItem('ctc:role', 'realtor');")
        if not run_case(pg, errors, "B-new-account", [], "Create your profile"):
            failures.append("B")

        # Case C: "Skip for now" -> deal list, no trap.
        pg.get_by_text("Skip for now", exact=True).click()
        try:
            pg.get_by_text("Escrows", exact=True).wait_for(timeout=15000)
            print("PASS C-skip-for-now: landed on deal list")
        except Exception:
            print("FAIL C-skip-for-now: did not land on deal list")
            failures.append("C")
        pg.screenshot(path=f"{OUT}/C-skip-for-now.png")

        browser.close()

    srv.shutdown()
    js_errors = [e for e in errors if "favicon" not in e.lower()]
    if js_errors:
        print(f"FAIL js-errors ({len(js_errors)}):")
        for e in js_errors[:10]:
            print("   ", e[:200])
        failures.append("js-errors")
    else:
        print("PASS js-errors: zero JS console/page errors")
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll login routing checks passed.")


main()
