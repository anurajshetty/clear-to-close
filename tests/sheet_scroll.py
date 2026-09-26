#!/usr/bin/env python3
"""Clear to Close — bottom-sheet scroll regression test (Sept 2026).

Anuraj found on iPhone Safari that the Update/New escrow sheets don't scroll:
on small screens the lower fields and the save button are unreachable and the
sheet can't be dismissed. The shared `Sheet` component now wraps its content in
a height-bounded ScrollView (maxHeight 480 — the pre-existing "View clients"
sheet pattern); the grabber stays outside the scroll region so it remains the
drag-to-dismiss handle.

Covers EVERY sheet in the app at 390x844, 375x667, AND tablet 768x1024:
  1. New escrow sheet ("+ New escrow" button)
  2. Update escrow sheet (pencil on a card)
  3. Cancel escrow confirm (danger action inside the update sheet)
  4. Edit dates sheet (escrow detail, "Edit target close date") — includes the
     Sept 2026 picker-drop coverage: text date inputs shown (no picker popup),
     typing updates the value, opened <= target validation still rejects an
     invalid range
  5. Invite sheet (escrow detail, "Invite client")
  6. View clients sheet (escrow detail, "View clients")

Per sheet, by rendered geometry:
  - the sheet-scroll region exists (testID "sheet-scroll");
  - long content actually scrolls (scrollHeight > clientHeight);
  - after scrolling to the bottom, the last button is fully inside the
    visible sheet area and is clickable;
  - the sheet's approved dismiss path works (scrim tap, or "Keep it" for the
    cancel confirm).
Zero JavaScript errors.

Usage: python3 tests/sheet_scroll.py  (run from the repo root)
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8915),
CTC_OUT (output dir, default /tmp/ctc-sheet-scroll).
Requires: a fresh `npm run export:web` build in dist/ (uses the built output),
and the repo's .env (Supabase URL/key) present at build time so the auth
stubs below are reached instead of the "unconfigured" path.
"""
import http.server
import functools
import os
import re
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-sheet-scroll")
PORT = int(os.environ.get("CTC_PORT", "8915"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

VIEWPORTS = [(390, 844), (375, 667), (768, 1024)]


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

    for vw, vh in VIEWPORTS:
        tag = f"{vw}x{vh}"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            pg = browser.new_page(viewport={"width": vw, "height": vh})
            pg.on("console", lambda m: errors.append(f"[{tag}] {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(f"[{tag}] {e}"))
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
            pg.route("**/rest/v1/steps*", fulfill_empty_table)

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

            # --- helpers -------------------------------------------------
            def top_scroller():
                # The topmost open sheet's scroll region (sheets stack).
                return pg.get_by_test_id("sheet-scroll").last

            def scroll_region_scrolls(scroller):
                return scroller.evaluate("e => e.scrollHeight > e.clientHeight + 1")

            def scroll_to_bottom(scroller):
                # react-native-web overrides scrollTo on ScrollView hosts with
                # the native (y, x) signature — drive the setter directly.
                scroller.evaluate("e => { e.scrollTop = e.scrollHeight; }")
                pg.wait_for_timeout(400)

            def within_scrollport(btn, scroller):
                bb = btn.bounding_box()
                sb = scroller.bounding_box()
                if bb is None or sb is None:
                    return False
                return (bb["y"] >= sb["y"] - 2 and
                        bb["y"] + bb["height"] <= sb["y"] + sb["height"] + 2)

            def dismiss_top_sheet():
                pg.get_by_label("Dismiss sheet").last.click()
                pg.wait_for_timeout(600)

            def check_sheet(name, last_btn, expect_scroll, click_proof):
                """Shared per-sheet assertions. click_proof: callable run after
                clicking the last button, returning (ok, detail)."""
                sc = top_scroller()
                # At least one scroll region; stacked sheets (cancel confirm
                # over the update sheet) legitimately render two.
                check(f"[{tag}] {name}: sheet-scroll region exists", sc.count() >= 1)
                if expect_scroll:
                    check(f"[{tag}] {name}: content actually scrolls",
                          scroll_region_scrolls(sc),
                          "scrollHeight <= clientHeight — sheet content not scrollable")
                scroll_to_bottom(sc)
                check(f"[{tag}] {name}: last button inside visible sheet area after scroll",
                      within_scrollport(last_btn, sc))
                last_btn.click()
                pg.wait_for_timeout(600)
                ok, detail = click_proof()
                check(f"[{tag}] {name}: last button clickable", ok, detail)

            # --- 1. New escrow sheet --------------------------------------
            pg.get_by_text("+ New escrow", exact=True).first.click()
            pg.get_by_text("Open escrow", exact=True).first.wait_for(timeout=8000)
            pg.wait_for_timeout(700)  # let the modal slide-in finish

            def new_escrow_proof():
                # Empty form submit -> inline validation error, sheet stays open.
                return (pg.get_by_text("Enter the property address.").count() >= 1,
                        "no validation error after tapping Open escrow")

            check_sheet("new escrow", pg.get_by_text("Open escrow", exact=True).last,
                        True, new_escrow_proof)
            dismiss_top_sheet()
            check(f"[{tag}] new escrow: scrim tap dismisses",
                  pg.get_by_text("Open escrow", exact=True).count() == 0)

            # --- 2. Update escrow sheet -----------------------------------
            pg.get_by_test_id("edit-esc-open-1").click()
            pg.get_by_text("Update escrow", exact=True).first.wait_for(timeout=8000)
            pg.wait_for_timeout(700)

            def update_proof():
                # The danger footer is BELOW the submit: tapping it opens the
                # cancel confirm — which chains into sheet 3's test.
                return (pg.get_by_text("Cancel this escrow?", exact=True).count() >= 1,
                        "cancel confirm did not open after tapping danger action")

            check_sheet("update escrow", pg.get_by_test_id("cancel-this-escrow"),
                        True, update_proof)

            # --- 3. Cancel escrow confirm ---------------------------------
            def keep_proof():
                # "Keep it" is this popup's approved dismiss path.
                return (pg.get_by_text("Cancel this escrow?", exact=True).count() == 0,
                        "confirm still open after Keep it")

            check_sheet("cancel escrow", pg.get_by_test_id("keep-escrow"),
                        False, keep_proof)
            # The update sheet is still open behind the dismissed confirm.
            dismiss_top_sheet()
            check(f"[{tag}] update escrow: scrim tap dismisses",
                  pg.get_by_test_id("cancel-this-escrow").count() == 0)

            # --- escrow detail sheets --------------------------------------
            pg.get_by_text("4187 Oakmont Dr").first.click()
            pg.get_by_label("Edit target close date").wait_for(timeout=12000)
            pg.wait_for_timeout(800)

            # --- 4. Edit dates sheet ---------------------------------------
            # Text-box date inputs like the create-escrow form (the calendar
            # picker popup was dropped) — plus the scroll regression checks.
            pg.get_by_label("Edit target close date").click()
            pg.get_by_text("Edit dates", exact=True).wait_for(timeout=8000)
            pg.wait_for_timeout(700)
            sc = top_scroller()
            check(f"[{tag}] edit dates: sheet-scroll region exists", sc.count() == 1)
            open_input = pg.get_by_test_id("edit-open-date")
            target_input = pg.get_by_test_id("edit-target-date")
            check(f"[{tag}] edit dates: text date inputs shown",
                  open_input.count() == 1 and target_input.count() == 1)
            check(f"[{tag}] edit dates: no picker rows or date popup",
                  pg.get_by_label(re.compile(r"Change .*currently")).count() == 0
                  and pg.locator('input[type="date"]').count() == 0)
            # Typing a valid date updates the value in place.
            target_input.fill("2026-12-15")
            pg.wait_for_timeout(300)
            check(f"[{tag}] edit dates: typing updates the date value",
                  target_input.input_value() == "2026-12-15")
            # opened <= target validation still rejects an invalid range.
            target_input.fill("2026-01-15")
            pg.get_by_text("Save", exact=True).click()
            pg.wait_for_timeout(600)
            check(f"[{tag}] edit dates: invalid range rejected",
                  pg.get_by_text("The target close can't be before the opened date.").count() >= 1
                  and pg.get_by_text("Edit dates", exact=True).count() == 1,
                  "no range error after saving target before opened")
            # Restore a valid range, then save for real.
            target_input.fill("2026-12-15")
            pg.wait_for_timeout(300)
            scroll_to_bottom(sc)
            save_btn = pg.get_by_text("Save", exact=True)
            check(f"[{tag}] edit dates: Save inside visible sheet area after scroll",
                  within_scrollport(save_btn, sc))
            save_btn.click()
            pg.wait_for_timeout(1200)
            check(f"[{tag}] edit dates: Save clickable — sheet closed after save",
                  pg.get_by_text("Edit dates", exact=True).count() == 0)

            # --- 5. Invite sheet --------------------------------------------
            pg.get_by_text("Invite client").first.scroll_into_view_if_needed()
            pg.wait_for_timeout(400)
            pg.get_by_text("Invite client").first.click()
            pg.get_by_text("Create code").wait_for(timeout=8000)
            pg.wait_for_timeout(700)
            pg.locator("input").last.fill("Test Buyer")
            pg.wait_for_timeout(400)

            def invite_proof():
                # Creating a code flips the sheet to the code phase.
                return (pg.get_by_text("Copy", exact=True).count() >= 1,
                        "code phase did not appear after tapping Create code")

            check_sheet("invite", pg.get_by_text("Create code", exact=True),
                        False, invite_proof)
            # Code phase: the Copy button is the last element — reachable?
            sc = top_scroller()
            scroll_to_bottom(sc)
            copy_btn = pg.get_by_text("Copy", exact=True)
            check(f"[{tag}] invite code phase: Copy inside visible sheet area",
                  within_scrollport(copy_btn, sc))
            dismiss_top_sheet()
            check(f"[{tag}] invite: scrim tap dismisses",
                  pg.get_by_text("Copy", exact=True).count() == 0)

            # --- 6. View clients sheet ---------------------------------------
            # The invite just created flips the button to "View clients".
            pg.get_by_text("View clients").first.scroll_into_view_if_needed()
            pg.wait_for_timeout(400)
            pg.get_by_text("View clients").first.click()
            pg.get_by_text("Invite another buyer").wait_for(timeout=8000)
            pg.wait_for_timeout(700)
            sc = top_scroller()
            check(f"[{tag}] view clients: sheet-scroll region exists", sc.count() == 1)
            scroll_to_bottom(sc)
            another_btn = pg.get_by_text("Invite another buyer")
            check(f"[{tag}] view clients: last button inside visible sheet area",
                  within_scrollport(another_btn, sc))
            another_btn.click()
            pg.wait_for_timeout(600)
            # Tapping it opens the invite sheet stacked above — dismiss both.
            check(f"[{tag}] view clients: Invite another opens invite sheet",
                  pg.get_by_text("Create code").count() >= 1)
            dismiss_top_sheet()
            dismiss_top_sheet()
            check(f"[{tag}] view clients: scrim tap dismisses",
                  pg.get_by_text("Invite another buyer").count() == 0)

            browser.close()

    srv.shutdown()
    # Zero JS errors across both viewports.
    real_errors = [e for e in errors if "ERR_EMPTY_RESPONSE" not in e]
    check("zero JS errors", len(real_errors) == 0,
          "; ".join(real_errors[:5]))

    if failures:
        print(f"\n{len(failures)} FAILURES")
        sys.exit(1)
    print("\nAll sheet-scroll regression checks passed")


if __name__ == "__main__":
    main()
