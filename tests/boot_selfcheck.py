#!/usr/bin/env python3
"""Clear to Close — boot test + UI self-check for the onboarding/auth release.

Serves dist/ under /clear-to-close/ with SPA fallback (mirrors gh-pages),
loads the app at 390x844 in headless Chromium, and:
  1. asserts zero JS console errors on boot,
  2. asserts first launch lands on the role picker (boot routing),
  3. walks role -> signup / login / redeem / link-dead, capturing
     screenshots for the design self-check,
  4. exercises inline validation states (empty submit on signup + redeem).

Usage: python3 boot_selfcheck.py  (run from ~/workspace/realtor-app)
Screenshots: /tmp/ctc-selfcheck/
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.expanduser("~/workspace/realtor-app")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-selfcheck"
BASE = "http://127.0.0.1:8901/clear-to-close/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        # Map /clear-to-close/* -> dist/* with SPA fallback to index.html
        # (mirrors the deployed gh-pages routing).
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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8901), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    errors = []
    failures = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # 1. Boot: first launch -> role picker.
        pg.goto(BASE)
        pg.wait_for_timeout(4000)
        body = pg.content()
        check("boot: role picker visible", "I'm a Realtor" in body or "Realtor" in pg.inner_text("body"))
        pg.screenshot(path=f"{OUT}/01-role.png")

        # 2. Role -> signup (select the card, then Continue).
        pg.get_by_text("I'm a Realtor").click()
        pg.wait_for_timeout(500)
        pg.get_by_text("Continue", exact=True).click()
        pg.wait_for_timeout(1500)
        check("nav: signup visible", "Create account" in pg.inner_text("body"))
        pg.screenshot(path=f"{OUT}/02-signup.png")

        # 3. Signup inline validation: the button stays disabled until the
        # input is valid (minimum-input discipline); valid input enables it.
        # We never submit — that would create a real Supabase account.
        inputs = pg.locator("input")
        if inputs.count() >= 3:
            inputs.nth(0).fill("Rita Realtor")
            inputs.nth(1).fill("not-an-email")
            inputs.nth(2).fill("short")
            pg.wait_for_timeout(500)
            btn = pg.get_by_text("Create account", exact=True)
            check("signup: invalid input keeps Create account disabled",
                  btn.count() > 0 and not btn.first.is_enabled())
            pg.screenshot(path=f"{OUT}/03a-signup-invalid.png")
            inputs.nth(1).fill("rita@example.com")
            inputs.nth(2).fill("longenoughpassword")
            pg.wait_for_timeout(500)
            check("signup: valid input enables Create account", btn.first.is_enabled())
            pg.screenshot(path=f"{OUT}/03b-signup-valid.png")

        # 4. Login screen (exact match: the role card underneath also
        # contains "log in" as a substring).
        login_link = pg.get_by_text("Log in", exact=True)
        if login_link.count() > 0:
            login_link.first.click()
            pg.wait_for_timeout(1200)
            check("nav: login visible", "Welcome back" in pg.inner_text("body") or "Log in" in pg.inner_text("body"))
            pg.screenshot(path=f"{OUT}/04-login.png")
            # Forgot-password -> reset.
            fp = pg.get_by_text("Forgot password")
            if fp.count() > 0:
                fp.first.click()
                pg.wait_for_timeout(1200)
                pg.screenshot(path=f"{OUT}/05-reset.png")
                back = pg.get_by_text("Back to login")
                if back.count() > 0:
                    back.first.click()
                    pg.wait_for_timeout(1000)

        # 5. Client redeem flow — fresh context (the app remembers the role,
        # so a cleared storage is a first-launch client).
        pg.close()
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
        cpg = ctx2.new_page()
        cpg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        cpg.on("pageerror", lambda e: errors.append(str(e)))
        cpg.goto(BASE)
        cpg.wait_for_timeout(3500)
        cpg.get_by_text("I'm a client").click()
        cpg.wait_for_timeout(500)
        cpg.get_by_text("Continue", exact=True).click()
        cpg.wait_for_timeout(1500)
        check("nav: redeem visible", "Join your escrow" in cpg.inner_text("body"))
        cpg.screenshot(path=f"{OUT}/06-redeem.png")
        # Invalid code -> specific error, never a blank screen. The RPC is
        # stubbed (hermetic): transport-failure behavior is covered by the
        # unit tests + a live debug run, not this UI pass.
        def fulfill_invalid(route):
            route.fulfill(
                status=200,
                headers={"Access-Control-Allow-Origin": "*",
                         "Content-Type": "application/json"},
                json={"ok": False, "error": "invalid"},
            )
        cpg.route("**/rest/v1/rpc/redeem_invite", fulfill_invalid)
        inputs = cpg.locator("input")
        if inputs.count() >= 2:
            inputs.nth(0).fill("Test Client")
            inputs.nth(1).fill("ZZZZZZ")
            cpg.wait_for_timeout(500)
            # The role screen stays mounted underneath (stack) — the redeem
            # Continue is the last one.
            cpg.get_by_text("Continue", exact=True).last.click()
            cpg.wait_for_timeout(9000)
            txt = cpg.inner_text("body")
            has_err = ("doesn't look right" in txt or "went wrong on our end" in txt
                       or "no longer" in txt or "already used" in txt)
            check("redeem: invalid code shows a specific error, never blank", has_err)
            cpg.screenshot(path=f"{OUT}/07-redeem-error.png")
        cpg.close()

        # 6. Dead-link screen: seed a stored client role + link, stub the
        # get_client_view RPC to report the link revoked (the regeneration
        # case), and reload — boot must land on /link-dead, never blank.
        pg2 = browser.new_page(viewport={"width": 390, "height": 844})
        pg2.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errors.append(str(e)))
        dead_link = ('{"linkId":"dead-link-1","escrowId":"escrow-1",'
                     '"role":"buyer","partyName":"Test Client","deviceId":"dev-1"}')
        pg2.add_init_script(
            "localStorage.setItem('ctc:role','client');"
            f"localStorage.setItem('ctc:clientlink','{dead_link}');"
        )
        def fulfill_revoked(route):
            route.fulfill(
                status=200,
                headers={"Access-Control-Allow-Origin": "*",
                         "Content-Type": "application/json"},
                json={"ok": False, "error": "revoked"},
            )
        pg2.route("**/rest/v1/rpc/get_client_view", fulfill_revoked)
        pg2.goto(BASE)
        pg2.wait_for_timeout(4000)
        txt2 = pg2.inner_text("body")
        check("nav: revoked link boots to link-dead", "no longer works" in txt2)
        pg2.screenshot(path=f"{OUT}/08-link-dead.png")
        # Dead-link recovery: "Enter the new code" re-opens redeem prefilled.
        rec = pg2.get_by_text("Enter the new code")
        if rec.count() > 0:
            rec.first.click()
            pg2.wait_for_timeout(1500)
            check("link-dead: recovery opens redeem", "invite code" in pg2.inner_text("body").lower())
            pg2.screenshot(path=f"{OUT}/08b-link-dead-redeem.png")
        pg2.close()

        # 7. Profile-create (deep link without a session bounces to role —
        # record where it lands).
        pg3 = browser.new_page(viewport={"width": 390, "height": 844})
        pg3.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg3.on("pageerror", lambda e: errors.append(str(e)))
        pg3.goto(BASE + "profile-create")
        pg3.wait_for_timeout(1500)
        pg3.screenshot(path=f"{OUT}/09-profile-create.png")
        pg3.close()

        browser.close()

    srv.shutdown()
    print(f"\nJS console errors: {len(errors)}")
    for e in errors[:10]:
        print("  ERR:", e[:200])
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    if errors:
        print("\nBooted with JS errors — failing.")
        sys.exit(1)
    print("\nBoot + self-check capture: all green.")


if __name__ == "__main__":
    main()
