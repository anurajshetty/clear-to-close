#!/usr/bin/env python3
"""Clear to Close — regression test: client link-up confirmation headline (Sept 2026).

Anuraj: the confirmation screen a client sees after successfully redeeming
their invite code is headlined "Hooray! Your escrow is open." (celebratory).
Surgical copy change — the subtext and both actions are unchanged.

Runs the REAL client redeem flow on built output (390x844):
  - role picker -> "I'm a client" -> name + code -> Continue;
  - confirmation shows "Hooray! Your escrow is open.";
  - subtext "This device is now linked to your escrow" unchanged;
  - "View my escrow" and "Not your escrow? Start over" unchanged;
  - the old "You're linked up" headline is gone.
  - Zero JS errors.

Usage: python3 tests/redeem_headline.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8923),
CTC_OUT (output dir, default /tmp/ctc-redeem-headline).
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
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-redeem-headline")
PORT = int(os.environ.get("CTC_PORT", "8923"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_GET(self):
        # SPA fallback: expo-router routes like /clear-to-close/ have no
        # static file; serve dist/index.html for unknown paths (mirrors the
        # deployed 404.html behavior).
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


def make_seed():
    steps = [
        {
            "id": f"s{i}",
            "title": f"Buyer step {i + 1}",
            "subtitle": "",
            "done": False,
            "custom": False,
            "order": i,
            "completedAt": None,
        }
        for i in range(13)
    ]
    escrows = [
        {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "side": "buy",
            "buyerName": "Alice Buyer",
            "sellerName": None,
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": steps,
            "sellerSteps": [],
            "status": "open",
            "createdAt": "2026-09-25",
        },
    ]
    invites = [
        {
            "id": "inv-alice",
            "code": "QK7M2X",
            "escrowId": "seed-1",
            "role": "buyer",
            "partyName": "Alice Buyer",
            "createdAt": "2026-09-26T10:00:00.000Z",
            "redeemedAt": None,
            "revokedAt": None,
        },
    ]
    return escrows, invites, []


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

    escrows, invites, links = make_seed()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(
            "localStorage.setItem('ctc:escrows', %s);"
            "localStorage.setItem('ctc:invites', %s);"
            "localStorage.setItem('ctc:links', %s);"
            % (json.dumps(json.dumps(escrows)), json.dumps(json.dumps(invites)), json.dumps(json.dumps(links)))
        )
        # The built bundle carries the real Supabase config, so redeem takes
        # the cloud RPC path. Answer it with the seeded invite's success
        # payload (mirrors the shape of the real redeem_invite RPC).
        def frpc(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                json={"ok": True, "escrow_id": "seed-1", "role": "buyer",
                      "party_name": "Alice Buyer", "link_id": "link-test-1"})
        pg.route("**/rest/v1/rpc/redeem_invite*", frpc)
        try:
            pg.goto(BASE)
            pg.wait_for_timeout(3000)
            # Role picker -> client path.
            pg.get_by_text("I'm a client").click()
            pg.get_by_text("Continue", exact=True).click()
            pg.get_by_text("Join your escrow", exact=True).wait_for(timeout=12000)
            pg.locator("[placeholder='e.g. Jordan Lee']").fill("Alice Buyer")
            pg.locator("[placeholder='6-character code']").fill("QK7M2X")
            pg.wait_for_timeout(400)
            # The role screen's Continue is still in the stack; the redeem
            # screen's is the topmost.
            pg.get_by_role("button", name="Continue").last.click()

            # Confirmation screen.
            pg.get_by_text("Hooray! Your escrow is open.", exact=True).wait_for(timeout=12000)
            check("headline is the celebratory copy",
                  pg.get_by_text("Hooray! Your escrow is open.", exact=True).count() > 0)
            check("old headline is gone",
                  pg.get_by_text("You're linked up", exact=True).count() == 0)
            check("subtext unchanged",
                  pg.get_by_text("This device is now linked to your escrow", exact=True).count() > 0)
            check("'View my escrow' action unchanged",
                  pg.get_by_text("View my escrow", exact=True).count() > 0)
            check("'Not your escrow? Start over' action unchanged",
                  pg.get_by_text("Not your escrow? Start over", exact=True).count() > 0)
            pg.screenshot(path=os.path.join(OUT, "linkup-confirmation.png"))

            check("zero JS errors during the flow", len(errors) == 0,
                  "; ".join(errors[:3]))
        finally:
            pg.close()
            browser.close()

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nAll redeem-headline regression checks passed.")


if __name__ == "__main__":
    main()
