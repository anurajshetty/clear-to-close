#!/usr/bin/env python3
"""Clear to Close — push client-boot rendered test.

Push delivery is native-only; the web client must be a safe no-op. Drives
the REAL built output at 390x844 with a seeded device link and asserts:

  1. Client home boots cleanly with PushGate mounted (zero JS errors).
  2. No permission pre-prompt ever renders on web
     ([data-testid="push-preprompt"] absent).
  3. The client profile screen shows no "Notifications are off" hint on web.
  4. Zero JS errors on both screens.

The pre-prompt's ask-once logic, exact copy, and deep-link routing are
covered by tests/push.test.ts (node); the trigger's forward-only rules by
tests/push_migration.py.

Usage: python3 tests/rendered/push_client_boot.py  (run from the worktree root)
Requires: a fresh `npm run export:web` build in dist/.
"""
import http.server
import functools
import os
import threading
import sys
import json
import datetime

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-push")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-push-client")
PORT = int(os.environ.get("CTC_PORT", "8907"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

BUY_STEPS = [
    "Escrow open",
    "Earnest money wired",
    "Property inspection scheduled",
    "Appraisal scheduled",
    "Homeowners insurance quote",
    "Signed loan docs",
    "Release contingencies",
    "Review closing disclosure",
    "Schedule final walkthrough",
    "Close escrow",
    "Record deal",
    "Get keys",
]


def seed_data():
    close_date = (datetime.date.today() + datetime.timedelta(days=91)).isoformat()
    steps = [
        {"id": f"s{i}", "title": t, "subtitle": "", "done": i < 3,
         "custom": False, "order": i, "completedAt": None}
        for i, t in enumerate(BUY_STEPS)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": "2026-09-01", "closeDate": close_date,
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": "2026-09-01",
    }
    profile = {
        "name": "Maya Chen", "photoUri": None,
        "about": "12 years helping families buy and sell across the Santa Clarita Valley.",
        "yearsExperience": "12", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877",
    }
    link = {
        "linkId": "link-1", "escrowId": "seed-1", "role": "buyer",
        "partyName": "Priya Nair", "deviceId": "dev-1",
    }
    return escrow, steps, profile, link


def js_str(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def seed_js():
    escrow, _steps, profile, link = seed_data()
    return (
        "localStorage.setItem('ctc:escrows', '" + js_str(json.dumps([escrow])) + "');"
        "localStorage.setItem('ctc:profile', '" + js_str(json.dumps(profile)) + "');"
        "localStorage.setItem('ctc:clientlink', '" + js_str(json.dumps(link)) + "');"
        "localStorage.setItem('ctc:role', 'client');"
    )


def rpc_payload():
    escrow, steps, profile, _link = seed_data()
    return {
        "ok": True,
        "escrow": {
            "id": escrow["id"], "address": escrow["address"], "city": escrow["city"],
            "open_date": escrow["openDate"], "close_date": escrow["closeDate"],
            "side": "buy", "status": "open",
        },
        "steps": [
            {"id": s["id"], "title": s["title"], "subtitle": s["subtitle"],
             "done": s["done"], "custom": s["custom"], "position": s["order"],
             "completed_at": s["completedAt"]}
            for s in steps
        ],
        "realtor": {"name": profile["name"], "photo_url": None},
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
            candidate = os.path.join(DIST, rest.lstrip("/"))
            if rest.endswith("/"):
                rest += "index.html"
            if not os.path.isfile(os.path.join(DIST, rest.lstrip("/"))):
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    failures = []
    errors = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(seed_js())

        payload_json = json.dumps(rpc_payload())

        def fulfill_rpc(rt):
            if rt.request.method == "OPTIONS":
                rt.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                })
                return
            rt.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            }, body=payload_json)

        pg.route("**/rest/v1/rpc/get_client_view*", fulfill_rpc)

        # 1) Client home boots with PushGate mounted.
        pg.goto(f"{BASE}client/buyer/seed-1")
        pg.wait_for_timeout(3500)
        body = pg.inner_text("body")
        check("client home boots", "Hi Priya Nair" in body)
        check("no permission pre-prompt on web",
              pg.query_selector('[data-testid="push-preprompt"]') is None)
        check("no pre-prompt copy on web", "Stay in the loop" not in body)
        pg.screenshot(path=f"{OUT}/1-client-home.png")

        # 2) Client profile via the Guided-by Profile button (merged top-card
        # redesign, Sept 2026): no notifications hint on web.
        photo_btn = pg.query_selector('[data-testid="guided-profile"]')
        check("guided-by profile button present", photo_btn is not None)
        if photo_btn:
            photo_btn.click()
            pg.wait_for_timeout(2500)
            body2 = pg.inner_text("body")
            check("profile screen renders", "Back to my escrow" in body2)
            check("no notifications-off hint on web", "Notifications are off" not in body2)
            pg.screenshot(path=f"{OUT}/2-client-profile.png")

        check("zero JS errors", len(errors) == 0, "; ".join(errors[:3]))
        browser.close()

    srv.shutdown()
    if failures:
        print(f"\n{len(failures)} failure(s): {failures}")
        sys.exit(1)
    print("\npush_client_boot: all green")


if __name__ == "__main__":
    main()
