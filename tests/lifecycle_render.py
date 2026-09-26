#!/usr/bin/env python3
"""Clear to Close — escrow lifecycle + realtor profile rendered regression test.

Drives the REAL built web output at 390x844 against the real signup flow.
Guards the approved escrow lifecycle (Sept 2026):

Deal list
  - "Hi {first name}" greeting + "Escrows" title kept.
  - "+ New escrow" sits ABOVE the Active/Closed sections.
  - Bordered collapsible "Active escrows" (expanded by default) and
    "Closed escrows" (collapsed by default) section headers.
  - Deal cards: address, city on its own line, buyer/seller name on its own
    line below; closed rows carry the "Closed" tag.

Transaction detail
  - Pencil buttons beside Opened / Target close open the "Edit dates" sheet,
    which uses plain text-box date inputs (YYYY-MM-DD) — no picker popup
    (the calendar picker was dropped Sept 2026).
  - "N days left to close" is centered.
  - All-steps-done -> sage "Close escrow" banner; tapping it -> sage
    "Closed" indicator + "Closed {date}." and the escrow moves to Closed.
  - Unchecking a step moves the escrow back to Active.
  - Dual agency: per-side "Close buyer side" / "Close seller side" buttons
    and indicators; closing one side leaves the other active.

Client profile
  - Hero card: photo, name, license line (only when entered), tap-to-call
    Phone row (tel: link); About/stats/areas cards; "Back to my escrow".

Usage: python3 tests/lifecycle_render.py  (run from the worktree root)
Requires: a fresh `npm run export:web` build in dist/.
"""
import http.server
import functools
import os
import re
import threading
import sys
import json
import datetime

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT", os.path.expanduser("~/workspace/realtor-app"))
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-lifecycle-render"
BASE = "http://127.0.0.1:8913/clear-to-close/"
TODAY = datetime.date.today()
TODAY_ISO = TODAY.isoformat()
TOMORROW_ISO = (TODAY + datetime.timedelta(days=1)).isoformat()
CLOSED_LABEL = TODAY.strftime("%b %-d, %Y")


def step(i, title, done, custom=False):
    return {
        "id": f"s{i}",
        "title": title,
        "subtitle": "",
        "done": done,
        "custom": custom,
        "order": i,
        "completedAt": "2026-09-25T10:00:00.000Z" if done else None,
    }


BUY_TITLES = [f"Buyer step {i+1}" for i in range(13)]
SELL_TITLES = [f"Seller step {i+1}" for i in range(12)]


def make_escrows():
    open_iso = (TODAY - datetime.timedelta(days=20)).isoformat()
    close_iso = (TODAY + datetime.timedelta(days=40)).isoformat()
    base = {
        "openDate": open_iso,
        "closeDate": close_iso,
        "status": "open",
        "createdAt": open_iso,
        "buyerClosedAt": None,
        "sellerClosedAt": None,
    }
    # A: buy-side, every step done -> "Close escrow" banner on load.
    a = dict(base)
    a.update(
        id="seed-a",
        address="4187 Oakmont Dr",
        city="Valencia",
        side="buy",
        buyerName="Priya Nair",
        sellerName=None,
        buyerSteps=[step(i, t, True) for i, t in enumerate(BUY_TITLES)],
        sellerSteps=[],
    )
    # B: dual agency; buyer side all done, seller side partial.
    b = dict(base)
    b.update(
        id="seed-b",
        address="99 Dual Agency Way",
        city="Santa Clarita",
        side="both",
        buyerName="Alex Buyer",
        sellerName="Sam Seller",
        buyerSteps=[step(i, t, True) for i, t in enumerate(BUY_TITLES)],
        sellerSteps=[step(i, t, i < 5) for i, t in enumerate(SELL_TITLES)],
    )
    # C: already closed (per-side close date stamped).
    c = dict(base)
    c.update(
        id="seed-c",
        address="7 Closed Ct",
        city="Newhall",
        side="sell",
        buyerName=None,
        sellerName="Tom Becker",
        buyerSteps=[],
        sellerSteps=[step(i, t, True) for i, t in enumerate(SELL_TITLES)],
        status="closed",
        sellerClosedAt=TODAY_ISO,
    )
    return [a, b, c]


def make_profile():
    return {
        "name": "Rita Realtor",
        "photoUri": None,
        "about": "Helping families find home since 2012.",
        "yearsExperience": "12",
        "dealsClosed": "140",
        "areasServed": "Santa Clarita Valley",
        "dreLicense": "01998877",
        "phone": "5551234567",
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
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def serve(port):
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def seed_js():
    esc = json.dumps(make_escrows()).replace("'", "\\'")
    prof = json.dumps(make_profile()).replace("'", "\\'")
    return (
        "localStorage.setItem('ctc:escrows', '" + esc + "');"
        "localStorage.setItem('ctc:profile', '" + prof + "');"
    )


def fulfill_signup(route):
    if route.request.method == "OPTIONS":
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
        return
    route.fulfill(status=200,
        headers={"Access-Control-Allow-Origin": "*",
                 "Content-Type": "application/json"},
        json={"access_token": "fake-jwt", "token_type": "bearer",
              "expires_in": 3600, "refresh_token": "fake-refresh",
              "user": {"id": "test-user-1", "email": "rita@example.com",
                       "user_metadata": {"name": "Rita Realtor"}}})


def fulfill_profiles(route):
    if route.request.method == "OPTIONS":
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
            "Access-Control-Expose-Headers": "Content-Range"})
        return
    route.fulfill(status=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Access-Control-Expose-Headers": "Content-Range"}, json=[])


def fulfill_empty_table(route):
    # Background cloud sync probes these tables after sign-in. Stub them as
    # empty: the sync layer merges (never deletes local-only rows), so the
    # localStorage seed stays the source of truth. Without these stubs the
    # requests hit the real backend and fail in CI sandboxes
    # (net::ERR_EMPTY_RESPONSE), tripping the zero-JS-errors check.
    # NOTE: keep these endpoint-specific — a broad **/rest/v1/* catch-all
    # interferes with the signup flow in this harness.
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


def stub_cloud(page):
    page.route("**/auth/v1/signup*", fulfill_signup)
    page.route("**/rest/v1/realtor_profiles*", fulfill_profiles)
    page.route("**/rest/v1/escrows*", fulfill_empty_table)
    page.route("**/rest/v1/invites*", fulfill_empty_table)
    page.route("**/rest/v1/steps*", fulfill_empty_table)


def signup_and_land(pg):
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
    # The seeded profile completes onboarding, so the app may land straight
    # on the deal list; without a profile it shows the skippable step 2.
    try:
        pg.get_by_text("Skip for now").wait_for(timeout=8000)
        pg.get_by_text("Skip for now").click()
    except Exception:
        pass
    pg.get_by_text("Active escrows").wait_for(timeout=12000)


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve(8913)
    failures = []
    errors = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---- Realtor flow -------------------------------------------------
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(seed_js())
        stub_cloud(pg)
        signup_and_land(pg)

        # Greeting + title kept.
        check("greeting 'Hi Rita'", pg.get_by_text("Hi Rita").count() > 0)
        check("'Escrows' title kept", pg.get_by_text("Escrows", exact=True).count() > 0)

        # "+ New escrow" sits above the sections.
        new_btn = pg.get_by_text("+ New escrow")
        active_head = pg.get_by_text("Active escrows")
        check("+ New escrow above Active section",
              new_btn.bounding_box()["y"] < active_head.bounding_box()["y"])

        # Sections: Active expanded, Closed collapsed by default.
        check("Active header visible", active_head.count() > 0)
        closed_head = pg.get_by_text("Closed escrows")
        check("Closed header visible", closed_head.count() > 0)
        check("active card visible (expanded)",
              pg.get_by_text("4187 Oakmont Dr").count() > 0)
        check("closed card hidden (collapsed)",
              pg.get_by_text("7 Closed Ct").count() == 0)
        closed_head.click()
        pg.wait_for_timeout(500)
        check("expanding Closed reveals the closed card",
              pg.get_by_text("7 Closed Ct").count() > 0)
        check("closed card carries the Closed tag",
              pg.get_by_text(re.compile(r"^Closed")).count() > 0)
        closed_head.click()  # collapse again
        pg.wait_for_timeout(500)

        # Deal card layout: address, then city on its own line, then the
        # buyer/seller name on its own line below (mockup 01 · ①).
        card_text = pg.get_by_text("4187 Oakmont Dr").first.evaluate(
            "el => el.parentElement.parentElement.parentElement.innerText")
        ai = card_text.find("4187 Oakmont Dr")
        ci = card_text.find("Valencia")
        pi = card_text.find("Priya Nair")
        check("party name on the card", pi > 0)
        check("card order: address, city, party name", ai < ci < pi,
              repr(card_text[:120]))

        # ---- Transaction detail: close flow (escrow A) -------------------
        pg.get_by_text("4187 Oakmont Dr").first.click()
        pg.get_by_test_id("days-left").wait_for(timeout=12000)

        # Pencil buttons open the Edit-dates sheet with plain text-box date
        # inputs (YYYY-MM-DD) — the calendar picker popup was dropped Sept 2026.
        check("pencil: Edit opened date", pg.get_by_label("Edit opened date").count() > 0)
        check("pencil: Edit target close date",
              pg.get_by_label("Edit target close date").count() > 0)
        pg.get_by_label("Edit opened date").click()
        pg.get_by_text("Edit dates", exact=True).wait_for(timeout=5000)
        check("Edit-dates sheet has NO picker popup",
              pg.locator('input[type="date"]').count() == 0)
        target_input = pg.get_by_test_id("edit-target-date")
        check("Edit-dates sheet has text date inputs",
              pg.get_by_test_id("edit-open-date").count() > 0 and target_input.count() > 0)
        pg.screenshot(path=os.path.join(OUT, "edit-dates-sheet.png"))
        # Move the target close to tomorrow; the tracker recomputes on Save.
        target_input.fill(TOMORROW_ISO)
        pg.wait_for_timeout(400)
        pg.get_by_text("Save", exact=True).click()
        pg.get_by_test_id("days-left").wait_for(timeout=5000)
        check("tracker recomputes after date edit",
              "1 day left to close" in pg.get_by_test_id("days-left").inner_text())

        # Days-left line is centered.
        align = pg.get_by_test_id("days-left").evaluate(
            "el => getComputedStyle(el).textAlign")
        check("days-left centered", align == "center", f"got {align}")

        # Close banner -> Closed indicator -> deal moves to Closed.
        check("Close escrow banner visible",
              pg.get_by_test_id("close-escrow-banner-buyer").count() > 0)
        pg.get_by_test_id("close-escrow-banner-buyer").click()
        pg.get_by_test_id("closed-indicator-buyer").wait_for(timeout=5000)
        ind_text = pg.get_by_test_id("closed-indicator-buyer").inner_text()
        check("Closed indicator shows today's date",
              f"Closed {CLOSED_LABEL}." in ind_text, ind_text)
        check("banner gone after close",
              pg.get_by_test_id("close-escrow-banner-buyer").count() == 0)
        pg.screenshot(path=os.path.join(OUT, "closed-indicator.png"))
        pg.get_by_label("Back to escrows").click()
        pg.get_by_text("Active escrows").wait_for(timeout=8000)
        check("closed escrow left Active",
              pg.get_by_text("4187 Oakmont Dr").count() == 0)
        pg.get_by_text("Closed escrows").click()
        pg.wait_for_timeout(500)
        check("closed escrow under Closed escrows",
              pg.get_by_text("4187 Oakmont Dr").count() > 0)

        # Unchecking a step moves it back to Active.
        pg.get_by_text("4187 Oakmont Dr").first.click()
        pg.get_by_test_id("closed-indicator-buyer").wait_for(timeout=12000)
        pg.get_by_label("Step: Buyer step 1").first.click()
        pg.wait_for_timeout(800)
        check("uncheck hides the Closed indicator",
              pg.get_by_test_id("closed-indicator-buyer").count() == 0)
        check("uncheck keeps the Close escrow banner hidden (steps incomplete)",
              pg.get_by_test_id("close-escrow-banner-buyer").count() == 0)
        pg.get_by_label("Back to escrows").click()
        pg.get_by_text("Active escrows").wait_for(timeout=8000)
        check("reopened escrow back under Active",
              pg.get_by_text("4187 Oakmont Dr").count() > 0)
        pg.close()

        # ---- Dual agency: per-side close (escrow B) ----------------------
        pg2 = browser.new_page(viewport={"width": 390, "height": 844})
        pg2.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errors.append(str(e)))
        pg2.add_init_script(seed_js())
        stub_cloud(pg2)
        signup_and_land(pg2)
        pg2.get_by_text("99 Dual Agency Way").first.click()
        pg2.get_by_test_id("days-left").wait_for(timeout=12000)
        check("dual: Close buyer side button",
              pg2.get_by_test_id("close-escrow-banner-buyer").count() > 0)
        check("dual: per-side label",
              pg2.get_by_text("Close buyer side", exact=True).count() > 0)
        pg2.get_by_test_id("close-escrow-banner-buyer").click()
        pg2.get_by_test_id("closed-indicator-buyer").wait_for(timeout=5000)
        check("dual: buyer side closed", True)
        # Seller tab stays active — no Close seller side banner yet (steps
        # incomplete) and no seller indicator.
        pg2.get_by_text("Seller", exact=True).click()
        pg2.wait_for_timeout(600)
        check("dual: seller side still active",
              pg2.get_by_test_id("closed-indicator-seller").count() == 0)
        check("dual: seller banner absent (steps incomplete)",
              pg2.get_by_test_id("close-escrow-banner-seller").count() == 0)
        # Back to the list: the escrow is still under Active (one side open).
        pg2.get_by_label("Back to escrows").click()
        pg2.get_by_text("Active escrows").wait_for(timeout=8000)
        check("dual: escrow stays Active with one side open",
              pg2.get_by_text("99 Dual Agency Way").count() > 0)
        # Unchecking a buyer step reopens only the buyer side.
        pg2.get_by_text("99 Dual Agency Way").first.click()
        pg2.get_by_test_id("closed-indicator-buyer").wait_for(timeout=12000)
        pg2.get_by_label("Step: Buyer step 1").first.click()
        pg2.wait_for_timeout(800)
        check("dual: buyer side reopens on uncheck",
              pg2.get_by_test_id("closed-indicator-buyer").count() == 0)
        pg2.screenshot(path=os.path.join(OUT, "dual-agency.png"))
        pg2.close()

        # ---- Client profile ----------------------------------------------
        pg3 = browser.new_page(viewport={"width": 390, "height": 844})
        pg3.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg3.on("pageerror", lambda e: errors.append(str(e)))
        link = {"linkId": "link-1", "escrowId": "seed-a", "role": "buyer",
                "partyName": "Priya Nair", "deviceId": "test-device"}
        pg3.add_init_script(
            seed_js()
            + "localStorage.setItem('ctc:clientlink', '"
            + json.dumps(link).replace("'", "\\'") + "');")
        # The client view validates its link via get_client_view; stub it as
        # unavailable so the app exercises its offline fail-open path with
        # zero failed network requests.
        pg3.route("**/rest/v1/rpc/get_client_view*",
                  lambda r: r.fulfill(status=200,
                                      content_type="application/json",
                                      body='{"ok":false,"error":"stubbed offline"}'))
        pg3.route("**/rest/v1/escrows*", fulfill_empty_table)
        pg3.route("**/rest/v1/invites*", fulfill_empty_table)
        pg3.route("**/rest/v1/steps*", fulfill_empty_table)
        pg3.goto(BASE)
        pg3.get_by_text("Hi Priya").wait_for(timeout=12000)
        # Realtor photo circle -> profile.
        pg3.get_by_label("View your realtor Rita Realtor's full profile").click()
        pg3.get_by_text("Back to my escrow").wait_for(timeout=8000)
        check("profile: name", pg3.get_by_text("Rita Realtor").count() > 0)
        check("profile: license line (entered)",
              pg3.get_by_text("DRE / license number: 01998877").count() > 0)
        tel = pg3.locator('a[href^="tel:"]')
        check("profile: tap-to-call phone row", tel.count() > 0)
        if tel.count() > 0:
            check("profile: tel href", tel.first.get_attribute("href") == "tel:5551234567",
                  tel.first.get_attribute("href"))
        check("profile: About card", pg3.get_by_text("About").count() > 0)
        check("profile: Areas served card",
              pg3.get_by_text("Areas served").count() > 0)
        pg3.screenshot(path=os.path.join(OUT, "client-profile.png"))
        pg3.close()

        browser.close()

    print()
    if errors:
        print(f"JS ERRORS ({len(errors)}):")
        for e in errors[:10]:
            print("  " + e[:300])
        failures.append("zero JS errors on boot")
    else:
        print("PASS zero JS errors across all flows")

    print()
    if failures:
        print(f"lifecycle_render: {len(failures)} failure(s)")
        sys.exit(1)
    print("lifecycle_render: all green")


if __name__ == "__main__":
    main()
