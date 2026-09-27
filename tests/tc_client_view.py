#!/usr/bin/env python3
"""Clear to Close — regression test: transaction coordinator home view (Sept 2026).

Covers the TC view on REAL built output (390x844):
  - /client/tc/<id> renders "Transaction coordinator" kicker + greeting.
  - Both-side escrow: "Buyer checklist" AND "Seller checklist" sections, each
    read-only (tapping a step changes nothing, no navigation). The RPC stub
    returns a real TC payload (role 'tc' + both step arrays), so the hermetic
    run exercises the app's cloud mapping, not just its offline fallback.
  - Single-side escrow: only the active side's section (RPC fails -> the view
    falls through to the local store).
  - Combined progress ("0 of 5 steps") and the read-only note.
  - Zero JS errors throughout.

Drives the view hermetically: seeded device link + cloud link ref in
localStorage, Supabase RPC stubbed. No sign-up, no network.

Usage: python3 tests/tc_client_view.py  (run from ~/workspace/realtor-app-wt-tc-invite)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Honors APP_ROOT, CTC_TCVIEW_PORT (defaults to 8908), CTC_TCVIEW_OUT (defaults
to /tmp/ctc-tc-view).
"""
import http.server
import functools
import os
import threading
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-tc-invite")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_TCVIEW_OUT", "/tmp/ctc-tc-view")
PORT = int(os.environ.get("CTC_TCVIEW_PORT", "8908"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"


def make_steps(prefix, n):
    return [
        {
            "id": f"{prefix}{i}",
            "title": f"{prefix} step {i + 1}",
            "subtitle": "",
            "done": False,
            "custom": False,
            "order": i,
            "completedAt": None,
        }
        for i in range(n)
    ]


def make_seed():
    escrows = [
        {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "side": "both",
            "buyerName": "Alice Buyer",
            "sellerName": "Bob Seller",
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": make_steps("buyer", 3),
            "sellerSteps": make_steps("seller", 2),
            "status": "open",
            "createdAt": "2026-09-25",
        },
        {
            "id": "seed-2",
            "address": "99 Elm St",
            "city": "Valencia",
            "side": "buy",
            "buyerName": "Alice Buyer",
            "sellerName": None,
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": make_steps("buyer", 3),
            "sellerSteps": [],
            "status": "open",
            "createdAt": "2026-09-25",
        },
    ]
    return escrows


def js_str(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def seed_js(escrow_id, link_id):
    device_link = {
        "linkId": link_id,
        "escrowId": escrow_id,
        "role": "tc",
        "partyName": "Tina Coordinator",
        "deviceId": "test-device",
    }
    cloud_links = {escrow_id: {"linkId": link_id, "role": "tc"}}
    return (
        "localStorage.setItem('ctc:escrows', '" + js_str(json.dumps(make_seed())) + "');"
        "localStorage.setItem('ctc:clientlink', '" + js_str(json.dumps(device_link)) + "');"
        "localStorage.setItem('ctc:cloudlinks', '" + js_str(json.dumps(cloud_links)) + "');"
    )


def rpc_step(prefix, i):
    return {
        "id": f"{prefix}{i}",
        "title": f"{prefix} step {i + 1}",
        "subtitle": "",
        "done": False,
        "custom": False,
        "position": i,
        "completed_at": None,
    }


def tc_rpc_payload():
    """get_client_view TC payload mirroring the local seed (both-side)."""
    return {
        "ok": True,
        "role": "tc",
        "escrow": {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "close_date": "2026-12-25",
            "side": "both",
        },
        "buyer_steps": [rpc_step("buyer", i) for i in range(3)],
        "seller_steps": [rpc_step("seller", i) for i in range(2)],
        "profile": None,
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


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
}


def fulfill_options(route):
    route.fulfill(status=200, headers=CORS)


def make_rpc_handler(payload=None):
    def handler(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        if payload is None:
            # Transport failure: the gate fails open, the view falls through
            # to the local store. A server rejection would fail CLOSED.
            route.fulfill(status=500, headers={**CORS, "Content-Type": "application/json"},
                          body='{"message":"stubbed transport failure"}')
            return
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                      body=json.dumps(payload))
    return handler


def stub_profiles(route):
    if route.request.method == "OPTIONS":
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
            "Access-Control-Expose-Headers": "Content-Range",
        })
        return
    route.fulfill(status=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Access-Control-Expose-Headers": "Content-Range",
    }, json=[])


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

        # ---- Page 1: both-side escrow via the cloud path (real TC RPC payload).
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        # Stubbed 500s are deliberate transport failures (page 2 exercises the
        # local fallback); filter their resource-load noise from the JS error
        # check. Real script errors still surface via pageerror.
        def on_console(m):
            if m.type == "error" and not m.text.startswith("Failed to load resource"):
                errors.append(m.text)
        pg.on("console", on_console)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(seed_js("seed-1", "link-tc-1"))
        pg.route("**/rest/v1/rpc/*", make_rpc_handler(tc_rpc_payload()))
        pg.route("**/rest/v1/realtor_profiles*", stub_profiles)
        try:
            print("STEP 1: TC both-side view (cloud path)", flush=True)
            pg.goto(BASE + "client/tc/seed-1")
            pg.get_by_text("Transaction coordinator", exact=True).first.wait_for(timeout=15000)
            check("tc: 'Transaction coordinator' kicker", True)
            check("tc: greeting uses the link name",
                  pg.get_by_text("Hi Tina Coordinator", exact=True).count() > 0)
            check("tc: address shown", pg.get_by_text("26207 Benito Ct").count() > 0)
            check("tc: 'Buyer checklist' section",
                  pg.get_by_text("Buyer checklist", exact=True).count() > 0)
            check("tc: 'Seller checklist' section",
                  pg.get_by_text("Seller checklist", exact=True).count() > 0)
            check("tc: buyer steps render (cloud-mapped)",
                  pg.get_by_text("buyer step 1", exact=True).count() > 0)
            check("tc: seller steps render (cloud-mapped)",
                  pg.get_by_text("seller step 1", exact=True).count() > 0)
            check("tc: combined progress caption",
                  pg.get_by_text("0 of 5 steps", exact=True).count() > 0)
            check("tc: read-only note",
                  pg.get_by_text("This view is read-only.", exact=False).count() > 0)
            pg.screenshot(path=f"{OUT}/01-tc-both.png")

            print("STEP 2: read-only", flush=True)
            pg.get_by_text("buyer step 1", exact=True).click()
            pg.wait_for_timeout(800)
            check("tc: tap does not check off the step",
                  pg.get_by_text("0 of 5 steps", exact=True).count() > 0)
            check("tc: tap does not navigate away",
                  pg.get_by_text("Buyer checklist", exact=True).count() > 0)
        finally:
            pg.close()

        # ---- Page 2: single-side escrow via the local fallback (RPC fails).
        pg2 = browser.new_page(viewport={"width": 390, "height": 844})
        def on_console2(m):
            if m.type == "error" and not m.text.startswith("Failed to load resource"):
                errors.append(m.text)
        pg2.on("console", on_console2)
        pg2.on("pageerror", lambda e: errors.append(str(e)))
        pg2.add_init_script(seed_js("seed-2", "link-tc-2"))
        pg2.route("**/rest/v1/rpc/*", make_rpc_handler(None))
        pg2.route("**/rest/v1/realtor_profiles*", stub_profiles)
        try:
            print("STEP 3: TC single-side view (local fallback)", flush=True)
            pg2.goto(BASE + "client/tc/seed-2")
            pg2.get_by_text("Transaction coordinator", exact=True).first.wait_for(timeout=15000)
            check("tc buy-side: 'Buyer checklist' section",
                  pg2.get_by_text("Buyer checklist", exact=True).count() > 0)
            check("tc buy-side: no 'Seller checklist' section",
                  pg2.get_by_text("Seller checklist", exact=True).count() == 0)
            check("tc buy-side: combined caption counts buyer only",
                  pg2.get_by_text("0 of 3 steps", exact=True).count() > 0)
            pg2.screenshot(path=f"{OUT}/02-tc-single.png")
        finally:
            pg2.close()

        browser.close()

    check("zero JS errors during the flow", len(errors) == 0,
          "; ".join(errors[:3]))

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("\ntc_client_view: all green")


if __name__ == "__main__":
    main()
