#!/usr/bin/env python3
"""Clear to Close — regression test: branded invite deep link (Sept 2026).

The realtor's "Copy invite link" shares
  https://anurajshetty.github.io/clear-to-close/invite/<CODE>
Opening it (no login, fresh browser) must show the identical branded welcome
as manual redeem — the realtor's name, photo fallback, and realty-group/DRE
subline (never a dangling separator) — BEFORE name entry. Continue goes to
redeem with the code pre-filled; the code is never redeemed by the link.

Covers on REAL built output (390x844):
  - /invite/<code> -> branded welcome (name, realty group, DRE subline) ->
    Continue -> redeem welcome -> Continue -> name step -> Join your escrow
    -> "Hooray! Your escrow is open."
  - /invite/<dead-code> -> "This invite didn't work" with the specific
    error copy and a working "Start over" back to the role picker.
  - Zero JS errors throughout.

The resolve_invite_realtor cloud RPC is stubbed (the built bundle carries the
real Supabase config, so resolution takes the cloud path).

Usage: python3 tests/branded_invite.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8927),
CTC_OUT (output dir, default /tmp/ctc-branded-invite).
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-branded-invite")
PORT = int(os.environ.get("CTC_PORT", "8927"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_GET(self):
        # SPA fallback: expo-router routes like /clear-to-close/invite/ABC123
        # have no static file; serve dist/index.html for unknown paths
        # (mirrors the deployed 404.html behavior).
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


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def cors_ok(route):
    route.fulfill(status=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
    return True


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

        # The configured bundle's background cloud sync fires on boot; in
        # the sandbox the real Supabase host is unreachable, so stub the
        # dormant sync endpoints with empty reads (writes succeed
        # silently). Without these, the console records ERR_EMPTY_RESPONSE
        # resource errors.
        def fempty(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization, Prefer",
                    "Access-Control-Expose-Headers": "Content-Range"})
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "Content-Range"},
                json=[])
        pg.route("**/rest/v1/escrows*", fempty)
        pg.route("**/rest/v1/invites*", fempty)
        pg.route("**/rest/v1/steps*", fempty)
        pg.route("**/rest/v1/realtor_profiles*", fempty)
        pg.route("**/rest/v1/client_links*", fempty)
        pg.route("**/rest/v1/rpc/get_client_view*",
                 lambda route: route.fulfill(
                     status=200,
                     headers={"Access-Control-Allow-Origin": "*",
                              "Content-Type": "application/json"},
                     json={"ok": False, "error": "stubbed"}))

        def rresolve(route):
            if route.request.method == "OPTIONS":
                cors_ok(route)
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                json={"ok": True, "realtor": {
                    "name": "Maya Sharma", "photo_url": None,
                    "realty_group": "Compass Realty", "dre_license": "01998877",
                    "realtor_id": "user-maya-1"}})
        pg.route("**/rest/v1/rpc/resolve_invite_realtor*", rresolve)

        def frpc(route):
            if route.request.method == "OPTIONS":
                cors_ok(route)
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                json={"ok": True, "escrow_id": "seed-1", "role": "buyer",
                      "party_name": "Jordan Lee", "link_id": "link-test-1"})
        pg.route("**/rest/v1/rpc/redeem_invite*", frpc)

        try:
            # 1. Deep link with a live code -> branded welcome, no login.
            print("STEP 1: /invite/<code> branded welcome", flush=True)
            pg.goto(BASE + "invite/QK7M2X")
            pg.get_by_text("Maya Sharma", exact=True).wait_for(timeout=15000)
            check("welcome: realtor name", pg.get_by_text("Maya Sharma", exact=True).count() > 0)
            check("welcome: realty group and DRE subline",
                  pg.get_by_text("Compass Realty · DRE #01998877", exact=True).count() > 0)
            check("welcome: no dangling separator",
                  pg.get_by_text("·", exact=True).count() == 0)
            check("welcome: kicker", pg.get_by_text("You’re invited", exact=True).count() > 0)
            check("welcome: initials fallback (no photo)",
                  pg.get_by_text("MS", exact=True).count() > 0)
            pg.screenshot(path=f"{OUT}/01-invite-welcome.png")

            # 2. Continue -> redeem with the code pre-filled -> same welcome.
            # (The invite screen stays mounted under the stack, so the
            # topmost welcome is the last match.)
            print("STEP 2: continue to redeem", flush=True)
            pg.get_by_role("button", name="Continue").click()
            pg.get_by_text("Maya Sharma", exact=True).last.wait_for(timeout=15000)
            check("redeem: welcome shows the resolved realtor again",
                  pg.get_by_text("Maya Sharma", exact=True).last.count() > 0)
            check("redeem: URL carries the code", "code=QK7M2X" in pg.url, pg.url)
            pg.screenshot(path=f"{OUT}/02-redeem-welcome.png")
            pg.get_by_role("button", name="Continue").last.click()

            # 3. Name step -> Join -> confirmation.
            print("STEP 3: name entry and join", flush=True)
            pg.get_by_text("Almost there", exact=True).wait_for(timeout=12000)
            pg.locator("[placeholder='e.g. Jordan Lee']").fill("Jordan Lee")
            pg.wait_for_timeout(400)
            pg.get_by_role("button", name="Join your escrow").click()
            # The merged release lands on the redeem celebration card
            # (Sept 2026 branding), not the old plain confirmation.
            pg.get_by_text("Your escrow is open!", exact=True).wait_for(timeout=15000)
            check("redeem lands on the celebration card",
                  pg.get_by_text("WELCOME ABOARD", exact=True).is_visible())
            check("celebration headline",
                  pg.get_by_text("Your escrow is open!", exact=True).count() > 0)
            pg.screenshot(path=f"{OUT}/03-joined.png")
        finally:
            pg.close()

        # 4. Deep link with a dead code -> specific error + start over.
        print("STEP 4: /invite/<dead-code> error state", flush=True)
        pg2 = browser.new_page(viewport={"width": 390, "height": 844})
        pg2.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errors.append(str(e)))

        def rdead(route):
            if route.request.method == "OPTIONS":
                cors_ok(route)
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                json={"ok": False, "error": "invalid"})
        pg2.route("**/rest/v1/rpc/resolve_invite_realtor*", rdead)

        try:
            pg2.goto(BASE + "invite/ZZZZZZ")
            pg2.get_by_text("This invite didn’t work", exact=True).wait_for(timeout=15000)
            check("error: headline",
                  pg2.get_by_text("This invite didn’t work", exact=True).count() > 0)
            check("error: invalid-code copy",
                  pg2.get_by_text("This code doesn't look right. Ask your realtor for a new invite link.").count() > 0)
            pg2.screenshot(path=f"{OUT}/04-invite-dead.png")
            pg2.get_by_role("button", name="Start over").click()
            pg2.get_by_text("I'm a Realtor").wait_for(timeout=12000)
            check("start over: back at the role picker",
                  pg2.get_by_text("I'm a Realtor").count() > 0)
        finally:
            pg2.close()

        browser.close()

    check("zero JS errors during the flow", len(errors) == 0,
          "; ".join(errors[:3]))

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nAll branded-invite regression checks passed.")


if __name__ == "__main__":
    main()
