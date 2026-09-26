#!/usr/bin/env python3
"""Clear to Close — deal-list edit/cancel round regression test (Sept 2026).

Drives the REAL built output at 390x844 through the real signup flow and
asserts the edit/cancel acceptance criteria on the live deal list:

1. Pencil opens the "Update escrow" sheet with every field pre-populated
   from the card (address, city, client name, dates, side toggle).
2. Saving an edit updates the card in place and shows an "Escrow updated."
   toast, returning to the deal list.
3. The X button opens the cancel confirm ("Cancel this escrow?" /
   "Cancel escrow" danger + "Keep it"); confirming moves the card to a new
   "Cancelled escrows" dropdown section (greyed, Cancelled tag), auto-expands
   the section, and updates the counts to "N open · N closed · N cancelled"
   (cancelled segment only when > 0).
4. Closed cards show the pencil only (no X); cancelled cards keep the pencil
   but lose the X; the update sheet's "Cancel this escrow" danger action is
   present for open escrows only.
5. Cancel persists across reload; the Cancelled section starts collapsed.

Usage: python3 tests/editcancel_ui.py  (run from the repo root)
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8909),
CTC_OUT (output dir, default /tmp/ctc-editcancel-ui).
Requires: a fresh `npm run export:web` build in dist/ (uses the built output),
and the repo's .env (Supabase URL/key) present at build time so the auth
stubs below are reached instead of the "unconfigured" path.
"""
import http.server
import functools
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-editcancel-ui")
PORT = int(os.environ.get("CTC_PORT", "8909"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"


def make_escrows():
    def esc(eid, address, city, side, buyer, seller, status):
        return {
            "id": eid,
            "address": address,
            "city": city,
            "side": side,
            "buyerName": buyer,
            "sellerName": seller,
            "openDate": "2026-09-01",
            "closeDate": "2026-12-01",
            "buyerSteps": [],
            "sellerSteps": [],
            "status": status,
            "createdAt": "2026-09-01T00:00:00.000Z",
        }

    return [
        esc("esc-open-1", "4187 Oakmont Dr", "Valencia, CA 91355",
            "buy", "Priya Nair", None, "open"),
        esc("esc-open-2", "99 Sell St", "Santa Clarita, CA 91355",
            "sell", None, "Marco Diaz", "open"),
        esc("esc-closed", "1 Closed Way", "Valencia, CA 91355",
            "buy", "Old Buyer", None, "closed"),
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
        # Seed only when absent: later navigations (reload persistence check)
        # must keep the app's own mutated localStorage state.
        pg.add_init_script(
            "if (!localStorage.getItem('ctc:escrows')) "
            "localStorage.setItem('ctc:escrows', '" + json.dumps(make_escrows()).replace("'", "\\'") + "');"
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
        # Web sign-in always returns to the login screen after a reload
        # (native persists the session; web does not). The login endpoint
        # returns the same stubbed session so the reload leg can sign back in.
        pg.route("**/auth/v1/token?grant_type=password*", fulfill_signup)

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

        # The deal-list boot and post-signup cloud sync also pull the
        # realtor's escrows/invites. Stub them as empty tables: the sync
        # layer merges (never deletes local-only rows), so the localStorage
        # seed below stays the source of truth for this test. Without these
        # stubs the requests hit the real backend and fail in CI sandboxes
        # (net::ERR_EMPTY_RESPONSE), tripping the zero-JS-errors check.
        def fulfill_empty_table(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                    "Access-Control-Expose-Headers": "Content-Range"})
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "Content-Range"}, json=[])

        pg.route("**/rest/v1/escrows*", fulfill_empty_table)
        pg.route("**/rest/v1/invites*", fulfill_empty_table)

        # Real flow: role -> signup -> skip -> deal list.
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
        pg.get_by_text("4187 Oakmont Dr").first.wait_for(timeout=12000)
        pg.wait_for_timeout(800)

        # --- 1. counts line: no cancelled segment yet ---------------------
        check("counts: 2 open, 1 closed, no cancelled segment",
              pg.get_by_text("2 open · 1 closed", exact=True).count() == 1)
        check("counts: no cancelled text before any cancel",
              pg.get_by_text("cancelled", exact=False).count() == 0)

        # --- 2. pencil opens pre-populated update sheet -------------------
        pg.get_by_test_id("edit-esc-open-1").click()
        pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)

        def input_with(value):
            return pg.locator(f'input[value="{value}"]')

        check("edit sheet: address pre-populated",
              input_with("4187 Oakmont Dr").count() >= 1)
        check("edit sheet: city pre-populated",
              input_with("Valencia, CA 91355").count() >= 1)
        check("edit sheet: client name pre-populated",
              input_with("Priya Nair").count() >= 1)
        check("edit sheet: open date pre-populated",
              input_with("2026-09-01").count() >= 1)
        check("edit sheet: close date pre-populated",
              input_with("2026-12-01").count() >= 1)
        buy_toggle = pg.get_by_test_id("side-buy")
        sell_toggle = pg.get_by_test_id("side-sell")
        buy_border = buy_toggle.evaluate("e => getComputedStyle(e).borderColor")
        sell_border = sell_toggle.evaluate("e => getComputedStyle(e).borderColor")
        check("edit sheet: buy-side toggle pre-selected",
              buy_border != sell_border,
              f"buy border {buy_border} vs sell border {sell_border}")

        # --- 3. save an edit -> toast + card updates in place -------------
        input_with("4187 Oakmont Dr").first.fill("4187 Oakmont Dr Updated")
        pg.get_by_text("Update escrow", exact=True).last.click()
        pg.get_by_test_id("toast").wait_for(timeout=8000)
        check("edit save: 'Escrow updated.' toast shown",
              "Escrow updated." in (pg.get_by_test_id("toast").inner_text() or ""))
        pg.wait_for_timeout(600)
        check("edit save: card address updated in place",
              pg.get_by_text("4187 Oakmont Dr Updated").count() >= 1)

        # --- 4. danger action inside the sheet: cancel -> keep ------------
        pg.get_by_test_id("edit-esc-open-1").click()
        pg.get_by_text("Cancel this escrow").wait_for(timeout=8000)
        pg.get_by_text("Cancel this escrow").click()
        pg.get_by_text("Cancel this escrow?", exact=True).wait_for(timeout=8000)
        check("cancel confirm: explainer copy shown",
              pg.get_by_text("The escrow moves to the Cancelled section on your deal list.").count() >= 1)
        pg.get_by_test_id("keep-escrow").click()
        pg.wait_for_timeout(600)
        check("cancel keep: still on deal list, nothing cancelled",
              pg.get_by_text("2 open · 1 closed", exact=True).count() == 1)
        # Dismiss the update sheet (still open behind the confirm) via its
        # overlay before touching the cards again.
        pg.get_by_label("Dismiss sheet").first.click()
        pg.wait_for_timeout(600)

        # --- 5. X on card -> confirm -> moved to Cancelled ---------------
        pg.get_by_test_id("cancel-esc-open-2").click()
        pg.get_by_text("Cancel this escrow?", exact=True).wait_for(timeout=8000)
        pg.get_by_test_id("confirm-cancel-escrow").click()
        pg.get_by_test_id("section-cancelled").wait_for(timeout=8000)
        check("cancel: Cancelled section appears and auto-expands",
              pg.get_by_test_id("section-cancelled").count() == 1)
        check("cancel: Cancelled tag on the moved card",
              pg.get_by_text("Cancelled", exact=True).count() >= 1)
        check("cancel: moved card address visible in section",
              pg.get_by_text("99 Sell St").count() >= 1)
        check("cancel: counts gain the cancelled segment",
              pg.get_by_text("1 open · 1 closed · 1 cancelled", exact=True).count() == 1)

        # --- 6. affordance rules: pencil-only on closed/cancelled ---------
        # The merged deal list nests closed cards in the collapsed "Closed
        # escrows" section (escrow lifecycle) — expand it first.
        pg.get_by_test_id("section-closed").click()
        pg.get_by_test_id("edit-esc-closed").wait_for(timeout=8000)
        check("closed card: pencil present",
              pg.get_by_test_id("edit-esc-closed").count() == 1)
        check("closed card: no X button",
              pg.get_by_test_id("cancel-esc-closed").count() == 0)
        check("cancelled card: pencil kept",
              pg.get_by_test_id("edit-esc-open-2").count() == 1)
        check("cancelled card: X removed",
              pg.get_by_test_id("cancel-esc-open-2").count() == 0)

        # The update sheet on a cancelled escrow has no danger action.
        pg.get_by_test_id("edit-esc-open-2").click()
        pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)
        check("cancelled edit sheet: no 'Cancel this escrow' action",
              pg.get_by_text("Cancel this escrow", exact=True).count() == 0)
        pg.get_by_label("Dismiss sheet").first.click()
        pg.wait_for_timeout(500)

        # --- 7. persistence across reload --------------------------------
        pg.goto(BASE)
        pg.wait_for_timeout(2500)
        # Web drops the session on reload (native persists it) — sign back in.
        login_inputs = pg.locator("input")
        login_inputs.nth(0).fill("rita@example.com")
        login_inputs.nth(1).fill("longenoughpassword")
        pg.get_by_text("Log in", exact=True).last.click()
        pg.get_by_text("1 open · 1 closed · 1 cancelled", exact=True).wait_for(timeout=12000)
        check("reload: counts persist",
              pg.get_by_text("1 open · 1 closed · 1 cancelled", exact=True).count() == 1)
        check("reload: cancelled card hidden while section collapsed",
              pg.get_by_text("99 Sell St").count() == 0)
        pg.get_by_test_id("section-cancelled").click()
        pg.wait_for_timeout(500)
        check("reload: expanding reveals the cancelled card",
              pg.get_by_text("99 Sell St").count() >= 1)
        check("reload: edited address persisted",
              pg.get_by_text("4187 Oakmont Dr Updated").count() >= 1)

        check("zero JS errors", len(errors) == 0,
              "; ".join(errors[:3]))
        browser.close()

    srv.shutdown()
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\neditcancel_ui: all green")


if __name__ == "__main__":
    main()
