#!/usr/bin/env python3
"""Clear to Close — regression test: transaction coordinator invite flow (Sept 2026).

Covers the TC invite type on REAL built output (390x844):
  - Escrow detail footer gains "Invite transaction coordinator" under the
    side's invite button; it flips to "View transaction coordinator" once the
    TC invite exists.
  - Invite sheet: "Invite the transaction coordinator" title,
    "Coordinator's name" field, Create code -> big code + Copy.
  - Client-list overlay: "Transaction coordinator · 1 of 1" heading, the
    one-per-escrow cap note, no "Invite another" at the cap.
  - Regenerate: confirm copy, new code issued, old code dies.
  - Zero JS errors throughout.

Drives the REAL user flow hermetically (sign-up with a stubbed Supabase
session -> skip profile -> deal list -> escrow card). No invites are seeded;
the TC invite is created through the UI.

Usage: python3 tests/tc_invite_flow.py  (run from ~/workspace/realtor-app-wt-tc-invite)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Honors APP_ROOT, CTC_TC_PORT (defaults to 8907), CTC_TC_OUT (defaults to
/tmp/ctc-tc-flow).
"""
import http.server
import functools
import os
import threading
import sys
import json
import re

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-tc-invite")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_TC_OUT", "/tmp/ctc-tc-flow")
PORT = int(os.environ.get("CTC_TC_PORT", "8907"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

CODE_RE = re.compile(r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$")


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
    return escrows, [], []


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


# Find the checklist scroll container (same approach as the checklist test).
SCROLL_TO_BOTTOM = """() => {
  const anchor = [...document.querySelectorAll('*')].find(e =>
    e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
    /Buyer step 1/.test(e.textContent.trim()));
  if (!anchor) return 'no anchor';
  let sc = anchor;
  while (sc && sc.parentElement) {
    sc = sc.parentElement;
    const oy = getComputedStyle(sc).overflowY;
    if (oy === 'auto' || oy === 'scroll') break;
  }
  if (!sc || !sc.parentElement) return 'no scroll container';
  sc.scrollTop = sc.scrollHeight;
  return 'scrolled to ' + sc.scrollTop;
}"""

# Leaf code chips currently rendered (the 6-char invite codes).
CODE_CHIPS = """() =>
  [...document.querySelectorAll('*')]
    .filter(e => e.children.length === 0 &&
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test((e.textContent || '').trim()))
    .map(e => e.textContent.trim())"""


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

        def fulfill_signup(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                })
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            }, json={
                "access_token": "fake-jwt", "token_type": "bearer",
                "expires_in": 3600, "refresh_token": "fake-refresh",
                "user": {"id": "test-user-1", "email": "rita@example.com",
                         "user_metadata": {"name": "Rita Realtor"}},
            })

        pg.route("**/auth/v1/signup*", fulfill_signup)

        def fulfill_profiles(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                    "Access-Control-Expose-Headers": "Content-Range",
                })
                return
            # Hermetic sync isolation (same as invite_flow.py): the
            # read probe gets a malformed 200 so cloud sync stays dormant
            # and the seeded localStorage is the authoritative fixture.
            if "select=user_id" in route.request.url:
                route.fulfill(status=200, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json",
                }, body="hermetic-test: sync dormant {{{")
                return
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "Content-Range",
            }, json=[])

        pg.route("**/rest/v1/realtor_profiles*", fulfill_profiles)

        try:
            # 1. Sign up -> skip profile -> deal list -> open escrow.
            print("STEP 1: sign up", flush=True)
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
            pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
            pg.get_by_text("26207 Benito Ct").first.click()
            pg.get_by_text("of 13 steps").wait_for(timeout=12000)
            scroll_res = pg.evaluate(SCROLL_TO_BOTTOM)
            check("tc: scrolled to checklist bottom", str(scroll_res).startswith("scrolled"), scroll_res)

            # 2. The TC entry sits in the footer under the side's invite button.
            print("STEP 2: TC entry button", flush=True)
            btn = pg.get_by_text("Invite transaction coordinator", exact=True)
            check("tc: 'Invite transaction coordinator' in the footer", btn.count() > 0)
            pg.screenshot(path=f"{OUT}/01-tc-entry.png")

            # 3. Invite sheet: TC labels, name -> Create code -> code + Copy.
            print("STEP 3: TC invite sheet", flush=True)
            btn.click()
            pg.wait_for_timeout(800)
            check("sheet: 'Invite the transaction coordinator' title",
                  pg.get_by_text("Invite the transaction coordinator", exact=True).count() > 0)
            check("sheet: \"Coordinator's name\" field",
                  pg.get_by_text("Coordinator's name", exact=True).count() > 0)
            pg.locator("input").fill("Tina Coordinator")
            pg.wait_for_timeout(300)
            pg.get_by_text("Create code", exact=True).click()
            pg.wait_for_timeout(900)
            chips = pg.evaluate(CODE_CHIPS)
            created = [c for c in chips if CODE_RE.match(c)]
            check("sheet: TC code issued", len(created) == 1, f"chips={chips}")
            pg.screenshot(path=f"{OUT}/02-tc-code.png")
            pg.get_by_text("Copy", exact=True).click()
            pg.wait_for_timeout(900)

            # 4. The entry flips to "View transaction coordinator".
            print("STEP 4: view TC", flush=True)
            view_btn = pg.get_by_text("View transaction coordinator", exact=True)
            check("tc: entry flips to 'View transaction coordinator'", view_btn.count() > 0)
            view_btn.click()
            pg.wait_for_timeout(800)
            check("overlay: 'Transaction coordinator · 1 of 1'",
                  pg.get_by_text("Transaction coordinator · 1 of 1").count() > 0)
            check("overlay: 'View transaction coordinator' title",
                  pg.get_by_text("View transaction coordinator", exact=True).count() > 0)
            check("overlay: TC listed by name",
                  pg.get_by_text("Tina Coordinator").count() > 0)
            check("overlay: one-per-escrow cap note",
                  pg.get_by_text("One transaction coordinator per escrow.", exact=False).count() > 0)
            check("overlay: no 'Invite another' at the TC cap",
                  pg.get_by_text("Invite another", exact=False).count() == 0)
            tc_chips = [c for c in pg.evaluate(CODE_CHIPS) if CODE_RE.match(c)]
            check("overlay: TC code chip visible", len(tc_chips) == 1, f"chips={tc_chips}")
            pg.screenshot(path=f"{OUT}/03-tc-list.png")

            # 5. Regenerate: confirm copy, new code, old code dies.
            print("STEP 5: TC regenerate", flush=True)
            pg.get_by_text("Regenerate", exact=True).click()
            pg.wait_for_timeout(500)
            check("regen: confirm title",
                  pg.get_by_text("New code for Tina Coordinator?", exact=True).count() > 0)
            pg.get_by_text("Create new code", exact=True).click()
            pg.wait_for_timeout(900)
            check("regen: success toast",
                  pg.get_by_text("New code issued. The old code no longer works.").count() > 0)
            chips2 = [c for c in pg.evaluate(CODE_CHIPS) if CODE_RE.match(c)]
            check("regen: TC has a fresh code, old code gone",
                  len(chips2) == 1 and chips2[0] != tc_chips[0], f"chips={chips2}")
            pg.screenshot(path=f"{OUT}/04-tc-regen.png")

            check("zero JS errors during the flow", len(errors) == 0,
                  "; ".join(errors[:3]))
        finally:
            pg.close()
            browser.close()

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("\ntc_invite_flow: all green")


if __name__ == "__main__":
    main()
