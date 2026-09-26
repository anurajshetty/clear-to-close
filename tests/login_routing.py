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
  case D: cloud escrows hydrate onto the deal list on login
  case E: existing profiled account -> profile screen pre-populates
          every field with the saved values (not an empty form)

Also asserts zero JS console errors / page errors throughout.

Note on the photo field: profile photos are device-local by design
(accepted constraint — no cloud photo sync), so case E covers the seven
text fields; there is no cloud photo to pre-populate on a fresh device.

Usage: python3 tests/login_routing.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/.
"""
import http.server
import functools
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright, expect

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


ESCROW_ROWS = [
    {"id": "esc-buy", "user_id": UID, "address": "26207 Benito Ct",
     "city": "Santa Clarita, CA 91355", "side": "buy",
     "buyer_name": "Anuraj", "seller_name": None,
     "open_date": "2026-08-01", "close_date": "2026-10-15",
     "status": "open", "created_at": "2026-08-01T00:00:00Z"},
    {"id": "esc-sell", "user_id": UID, "address": "26203 Mc bean",
     "city": "santa clarita, CA 91355", "side": "sell",
     "buyer_name": None, "seller_name": "Anuraj",
     "open_date": "2026-09-01", "close_date": "2026-11-20",
     "status": "open", "created_at": "2026-09-01T00:00:00Z"},
]
STEP_ROWS = [
    {"id": "s0", "escrow_id": "esc-buy", "role": "buyer", "title": "Offer accepted",
     "subtitle": "", "done": True, "custom": False, "position": 0,
     "completed_at": "2026-08-05T00:00:00Z"},
    {"id": "s1", "escrow_id": "esc-buy", "role": "buyer", "title": "Appraisal",
     "subtitle": "", "done": False, "custom": False, "position": 1, "completed_at": None},
]


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


def make_escrow_stubs(pg, escrow_rows=ESCROW_ROWS, step_rows=STEP_ROWS):
    """Stub the escrow/step pull (case D). Accepts background push upserts."""

    def fulfill_escrows(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        if route.request.method == "GET":
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                          json=escrow_rows)
        else:
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, json={})

    def fulfill_steps(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        if route.request.method == "GET":
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                          json=step_rows)
        else:
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, json={})

    pg.route("**/rest/v1/escrows*", fulfill_escrows)
    pg.route("**/rest/v1/steps*", fulfill_steps)


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
        make_escrow_stubs(pg, [], [])  # no cloud escrows in this routing case
        if not run_case(pg, errors, "A-existing-profile", [PROFILE_ROW], "Escrows"):
            failures.append("A")

        # Case D: existing account whose escrows live only in the cloud —
        # the deal list hydrates them on login (the realtoranu@gmail.com bug).
        # (Re-registering: the last matching route wins.)
        make_escrow_stubs(pg)
        pg.evaluate("localStorage.clear(); localStorage.setItem('ctc:role', 'realtor');")
        pg.goto(LOGIN)
        pg.wait_for_timeout(2500)
        inputs = pg.locator("input")
        inputs.nth(0).fill("rita@example.com")
        inputs.nth(1).fill("longenoughpassword")
        pg.get_by_role("button", name="Log in").click()
        try:
            pg.get_by_text("26207 Benito Ct", exact=True).wait_for(timeout=15000)
            pg.get_by_text("26203 Mc bean", exact=True).wait_for(timeout=15000)
            print("PASS D-escrow-hydration: cloud escrows appear on the deal list")
        except Exception:
            print("FAIL D-escrow-hydration: cloud escrows missing from the deal list")
            failures.append("D")
        pg.screenshot(path=f"{OUT}/D-escrow-hydration.png")
        # Cases B/C: brand-new account — cloud has no escrows.
        make_escrow_stubs(pg, [], [])

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

        # Case E: existing profiled account -> tapping the avatar opens the
        # profile with every field pre-populated (not an empty form).
        pg.unroute("**/rest/v1/realtor_profiles*")
        make_stubs(pg, [PROFILE_ROW])
        make_escrow_stubs(pg, [], [])
        pg.evaluate("localStorage.clear(); localStorage.setItem('ctc:role', 'realtor');")
        pg.goto(LOGIN)
        pg.wait_for_timeout(2500)
        inputs = pg.locator("input")
        inputs.nth(0).fill("rita@example.com")
        inputs.nth(1).fill("longenoughpassword")
        pg.get_by_role("button", name="Log in").click()
        try:
            pg.get_by_text("Escrows", exact=True).wait_for(timeout=15000)
            pg.get_by_role("button", name="Your profile").click()
            pg.get_by_text("Update your profile", exact=True).wait_for(timeout=15000)
            expected = {
                "e.g. Maya Chen": "Rita Realtor",
                "Tell clients about yourself": "About Rita",
                "e.g. 12": "8",
                "e.g. 240": "42",
                "e.g. Santa Clarita, Valencia": "Valencia",
                "e.g. 01992736": "DRE-123",
                "For Call / Message buttons": "555-0100",
            }
            missing = []
            for placeholder, value in expected.items():
                field = pg.locator(f"[placeholder='{placeholder}']")
                try:
                    expect(field).to_have_value(value, timeout=10000)
                except Exception:
                    missing.append(f"{placeholder!r} (expected {value!r})")
            if missing:
                print(f"FAIL E-profile-prefill: empty/wrong fields: {'; '.join(missing)}")
                failures.append("E")
            else:
                print("PASS E-profile-prefill: all 7 fields pre-populated with saved values")
        except Exception as ex:
            print(f"FAIL E-profile-prefill: did not reach the profile screen ({str(ex)[:100]})")
            failures.append("E")
        pg.screenshot(path=f"{OUT}/E-profile-prefill.png")

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
