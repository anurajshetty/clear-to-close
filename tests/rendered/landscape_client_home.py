#!/usr/bin/env python3
"""Landscape smoke check for the client home (branding redesign).

Boots the client buyer view at a landscape phone viewport (844x390) against
the built web bundle and asserts: the top card renders, the Latest card
renders, and there are zero JS console errors. Portrait coverage lives in
tests/rendered/client_topcard_branding.py etc.

Usage: APP_ROOT=/home/hatch/workspace/realtor-app-wt-client-topcard \
         python3 tests/rendered/landscape_client_home.py
Requires: a fresh `npm run export:web` build in <APP_ROOT>/dist.
"""
import datetime
import http.server
import json
import os
import threading

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-client-topcard")
DIST = os.path.join(ROOT, "dist")
PORT = 8921


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        rest = self.path.split("?")[0]
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        if rest.startswith("/clear-to-close/"):
            rest = rest[len("/clear-to-close"):]
        if not rest or rest.endswith("/"):
            rest += "index.html"
        if not os.path.isfile(os.path.join(DIST, rest.lstrip("/"))):
            rest = "/index.html"  # SPA fallback for router paths
        self.path = rest + ("?" + qs if qs else "")
        return super().do_GET()


def seed_js():
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "",
         "done": i < 4, "custom": False, "order": i,
         "completedAt": None}
        for i in range(12)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": "2026-09-01",
        "closeDate": (datetime.date.today() +
                      datetime.timedelta(days=45)).isoformat(),
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": (datetime.datetime.now(datetime.timezone.utc) -
                      datetime.timedelta(days=3)).isoformat(),
    }
    profile = {
        "name": "Maya Sharma", "photoUri": None, "about": "I answer my phone.",
        "yearsExperience": "9", "dealsClosed": "240",
        "areasServed": "Santa Clarita", "phone": "555-0100",
        "dreLicense": "01998877",
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": "buyer",
            "partyName": "Priya Nair", "deviceId": "test-device-1"}
    return (
        "localStorage.setItem('ctc:escrows', '"
        + json.dumps([escrow]).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:clientlink', '"
        + json.dumps(link).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:deviceid', 'test-device-1');"
        "localStorage.setItem('ctc:profile', '"
        + json.dumps(profile).replace("'", "\\'") + "');"
    )


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    failures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            pg = browser.new_page(viewport={"width": 844, "height": 390})
            errs = []
            pg.on("console", lambda m: errs.append(m.text)
                  if m.type == "error" and "Failed to load resource" not in m.text
                  else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))
            base = f"http://127.0.0.1:{PORT}/clear-to-close/"
            pg.goto(base, wait_until="networkidle")
            pg.wait_for_timeout(1500)
            pg.evaluate(seed_js())
            pg.goto(base + "client/buyer/seed-1")
            pg.wait_for_timeout(4000)
            body = pg.inner_text("body")
            if "Hi Priya Nair" not in body:
                failures.append("top card greeting missing in landscape")
            if "LATEST FROM" not in body.upper():
                failures.append("Latest card missing in landscape")
            if errs:
                failures.append("JS errors: " + "; ".join(errs[:3]))
            os.makedirs(os.path.join(ROOT, "tests/out"), exist_ok=True)
            pg.screenshot(path=os.path.join(ROOT, "tests/out/landscape-client-home.png"))
            pg.close()
            browser.close()
    finally:
        srv.shutdown()
    if failures:
        print("FAILURES:", failures)
        raise SystemExit(1)
    print("landscape client home: top card + Latest card render, zero JS errors. PASS")


if __name__ == "__main__":
    main()
