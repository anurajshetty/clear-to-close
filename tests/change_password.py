#!/usr/bin/env python3
"""Clear to Close — change-password rendered regression test (Sept 2026).

Drives the REAL built web output at 390x844 through the real signup flow and
asserts the approved change-password feature (spec section 2.8):

1. The profile page shows a quiet "Change password" row below Save.
2. Tapping it opens the "Change password" sheet: Current / New / Confirm
   password, each masked with a show/hide eye toggle (44pt targets).
3. "Update password" stays disabled until all three are filled, the new
   password is 8+, and the confirmation matches. Inline errors:
   "Password needs 8+ characters." / "Passwords don't match."
   (revalidate-on-input hides them).
4. Eye toggles flip the field between masked and shown.
5. Dismissal is exactly two paths: drag the sheet down via the grabber, or
   tap outside the sheet (scrim). No close (x) button exists on the sheet.
   Reopening starts with cleared fields.
6. Success: the current password is verified server-side (re-auth), the new
   password goes through updateUser, the sheet closes, and the profile page
   shows a "Password updated." toast (~2.4s auto-dismiss).
7. Wrong current password: the server rejects the re-auth and the sheet
   shows "Current password is incorrect - try again." inline; the sheet
   stays open and updateUser is never called.

Usage: python3 tests/change_password.py  (run from the worktree root)
Requires: a fresh `npm run export:web` build in dist/.
"""
import http.server
import functools
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-change-password"
BASE = "http://127.0.0.1:8917/clear-to-close/"

SIGNUP_PASSWORD = "longenoughpassword"
CURRENT_PASSWORD = "old-correct-pw"
NEW_PASSWORD = "brand-new-password"


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
    prof = json.dumps(make_profile()).replace("'", "\\'")
    return "localStorage.setItem('ctc:profile', '" + prof + "');"


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


def fulfill_rest_empty(route):
    """Catch-all for unstubbed REST reads (e.g. escrows on landing)."""
    if route.request.method == "OPTIONS":
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
            "Access-Control-Expose-Headers": "Content-Range"})
        return
    route.fulfill(status=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Access-Control-Expose-Headers": "Content-Range"}, json=[])


def make_token_stub():
    """Re-auth stub: only CURRENT_PASSWORD passes, everything else 400."""
    def stub(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        try:
            body = json.loads(route.request.post_data or "{}")
        except Exception:
            body = {}
        if body.get("password") == CURRENT_PASSWORD:
            route.fulfill(status=200,
                headers={"Access-Control-Allow-Origin": "*",
                         "Content-Type": "application/json"},
                json={"access_token": "fake-jwt-2", "token_type": "bearer",
                      "expires_in": 3600, "refresh_token": "fake-refresh-2",
                      "user": {"id": "test-user-1", "email": "rita@example.com"}})
        else:
            route.fulfill(status=400,
                headers={"Access-Control-Allow-Origin": "*",
                         "Content-Type": "application/json"},
                json={"error": "invalid_grant",
                      "msg": "Invalid login credentials"})
    return stub


def make_user_stub(state):
    """updateUser stub: records the new password it received."""
    def stub(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "PATCH, PUT, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        try:
            body = json.loads(route.request.post_data or "{}")
        except Exception:
            body = {}
        state["update_calls"].append(body.get("password"))
        route.fulfill(status=200,
            headers={"Access-Control-Allow-Origin": "*",
                     "Content-Type": "application/json"},
            json={"id": "test-user-1", "email": "rita@example.com"})
    return stub


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
    inputs.nth(2).fill(SIGNUP_PASSWORD)
    pg.wait_for_timeout(400)
    pg.get_by_text("Create account", exact=True).click()
    try:
        pg.get_by_text("Skip for now").wait_for(timeout=8000)
        pg.get_by_text("Skip for now").click()
    except Exception:
        pass
    pg.get_by_text("Escrows", exact=True).wait_for(timeout=12000)


def open_sheet(pg):
    pg.get_by_test_id("change-password-open").click()
    pg.get_by_text("Change password", exact=True).last.wait_for(timeout=8000)
    pg.wait_for_timeout(900)  # let the slide-up animation finish


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing - run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve(8917)
    failures = []
    errors = []
    state = {"update_calls": []}

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" - {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(seed_js())
        pg.route("**/auth/v1/signup*", fulfill_signup)
        pg.route("**/auth/v1/token*", make_token_stub())
        pg.route("**/auth/v1/user*", make_user_stub(state))
        # Catch-all first; the specific profile stub (registered last) wins.
        pg.route("**/rest/v1/*", fulfill_rest_empty)
        pg.route("**/rest/v1/realtor_profiles*", fulfill_profiles)
        signup_and_land(pg)

        # Deal list -> profile page via the header avatar.
        pg.get_by_label("Your profile").click()
        pg.get_by_text("Update your profile").wait_for(timeout=8000)
        row = pg.get_by_test_id("change-password-open")
        check("quiet 'Change password' row below Save", row.count() > 0)
        save_btn = pg.get_by_text("Save", exact=True)
        check("row sits below Save",
              row.bounding_box()["y"] > save_btn.bounding_box()["y"])

        # Sheet opens with three masked fields; Update disabled.
        open_sheet(pg)
        cur = pg.get_by_test_id("pw-current")
        new = pg.get_by_test_id("pw-new")
        conf = pg.get_by_test_id("pw-confirm")
        check("three password fields", cur.count() == 1 and new.count() == 1 and conf.count() == 1)
        check("fields masked by default",
              cur.get_attribute("type") == "password"
              and new.get_attribute("type") == "password"
              and conf.get_attribute("type") == "password")
        update = pg.get_by_text("Update password", exact=True)
        check("Update disabled when empty", update.is_disabled())

        # Eye toggle flips masked <-> shown (44pt target). RNW removes the
        # DOM `type` attribute when unmasking, so read the IDL property.
        eye = pg.get_by_test_id("pw-new-eye")
        box = eye.bounding_box()
        check("eye toggle is 44pt", box["width"] >= 44 and box["height"] >= 44,
              f"{box['width']}x{box['height']}")
        eye.click()
        pg.wait_for_timeout(300)
        check("eye shows the password", new.evaluate("el => el.type") == "text")
        eye.click()
        pg.wait_for_timeout(300)
        check("eye re-masks the password", new.evaluate("el => el.type") == "password")

        # Inline validation: short new password.
        new.fill("short")
        pg.wait_for_timeout(300)
        check("short-new inline error",
              pg.get_by_text("Password needs 8+ characters.").count() > 0)
        check("Update still disabled on short new", update.is_disabled())
        # Mismatch.
        new.fill(NEW_PASSWORD)
        conf.fill("something-else!!")
        pg.wait_for_timeout(300)
        check("mismatch inline error",
              pg.get_by_text("Passwords don't match.").count() > 0)
        # Revalidate-on-input hides the error.
        conf.fill(NEW_PASSWORD)
        pg.wait_for_timeout(300)
        check("mismatch error clears on fix",
              pg.get_by_text("Passwords don't match.").count() == 0)
        check("short error cleared", pg.get_by_text("Password needs 8+ characters.").count() == 0)

        # No x close button anywhere on this sheet.
        check("no close (x) button on the sheet",
              pg.get_by_label("Close", exact=True).count() == 0)

        # Dismissal path 1: drag down via the grabber. Use fine-grained
        # steps like a real browser fires: mousemove targets the element
        # under the cursor, so the first moves must stay inside the
        # grabber zone for the responder to engage (touch retargets to
        # the touchstart element, mouse does not).
        gz = pg.get_by_test_id("sheet-grabber-zone").bounding_box()
        gcx = gz["x"] + gz["width"] / 2
        gcy = gz["y"] + gz["height"] / 2
        pg.mouse.move(gcx, gcy)
        pg.mouse.down()
        for i in range(1, 53):
            pg.mouse.move(gcx, gcy + i * 5)
            pg.wait_for_timeout(16)
        pg.wait_for_timeout(60)
        pg.mouse.up()
        pg.wait_for_timeout(800)
        check("drag-down via grabber dismisses",
              pg.get_by_test_id("pw-new").count() == 0)

        # Reopen: fields start cleared.
        open_sheet(pg)
        check("reopen clears fields",
              cur.input_value() == "" and new.input_value() == "" and conf.input_value() == "")

        # Dismissal path 2: tap outside the sheet (scrim).
        pg.mouse.click(40, 60)
        pg.wait_for_timeout(800)
        check("scrim tap dismisses",
              pg.get_by_test_id("pw-new").count() == 0)

        # Wrong current password -> inline error, sheet stays open,
        # updateUser never called.
        open_sheet(pg)
        calls_before = len(state["update_calls"])
        cur.fill("wrong-pw")
        new.fill(NEW_PASSWORD)
        conf.fill(NEW_PASSWORD)
        pg.wait_for_timeout(300)
        check("Update enabled on valid triple", not update.is_disabled())
        update.click()
        pg.get_by_text("Current password is incorrect", exact=False).wait_for(timeout=8000)
        check("wrong-current inline error shown", True)
        check("sheet stays open on wrong current",
              pg.get_by_test_id("pw-new").count() == 1)
        check("updateUser not called on wrong current",
              len(state["update_calls"]) == calls_before)

        # Success path: correct current -> updateUser called with the new
        # password, sheet closes, "Password updated." toast shows and
        # auto-dismisses.
        cur.fill(CURRENT_PASSWORD)
        pg.wait_for_timeout(300)
        update.click()
        pg.wait_for_timeout(1200)
        check("sheet closes on success",
              pg.get_by_test_id("pw-new").count() == 0)
        check("updateUser received the new password",
              len(state["update_calls"]) > calls_before
              and state["update_calls"][-1] == NEW_PASSWORD,
              str(state["update_calls"]))
        toast = pg.get_by_text("Password updated.", exact=True)
        check("success toast shown", toast.count() > 0)
        pg.wait_for_timeout(2800)
        check("toast auto-dismisses (~2.4s)",
              pg.get_by_text("Password updated.", exact=True).count() == 0)

        pg.screenshot(path=os.path.join(OUT, "change-password.png"))
        pg.close()
        browser.close()

    srv.shutdown()
    # The wrong-password step intentionally stubs a 400 from the token
    # endpoint; the browser's resource-load log for it is expected.
    errors = [e for e in errors
              if "status of 400 (Bad Request)" not in e]
    check("zero JS errors", len(errors) == 0, "; ".join(errors[:5]))
    if failures:
        print(f"\n{len(failures)} FAILURES")
        sys.exit(1)
    print("\nAll change-password rendered checks passed.")


if __name__ == "__main__":
    main()
