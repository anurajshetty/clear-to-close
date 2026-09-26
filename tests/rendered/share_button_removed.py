"""share_button_removed — "Share this escrow" removal regression (Anuraj, Sept 26, 2026).

On the escrow detail screen (single-side view):
  - NO "Share this escrow" button exists anywhere.
  - "Invite client" is present, exactly as before.
  - The quiet reorder hint ("Long-press any checklist item to reorder it.")
    renders in the removed button's spot — between the Escrow Time Tracker
    card and the checklist — realtor view only.
  - Invite create-code -> copy flow still works end to end.
  - The hint does NOT render on the buyer/seller client views (read-only
    checklists).
The /share/<id> route itself stays functional (covered by the route test).

Suite: 390x844. Zero JS errors.
"""
import http.server
import functools
import os
import sys
import json
import threading
import re

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8923"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "share_button_removed")
os.makedirs(OUT, exist_ok=True)

FAILS = []
JS_ERRORS = []
CODE_RE = re.compile(r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$")


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name + (f" [{detail}]" if detail else ""))


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
            if not os.path.isfile(os.path.join(DIST, rest.lstrip("/"))):
                rest = "/index.html"
            self.path = rest + qs
        return super().do_GET()


def seed_escrows():
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": False,
         "custom": False, "order": i, "completedAt": None}
        for i in range(10)
    ]
    return [{
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": "2026-09-25", "closeDate": "2026-12-25",
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": "2026-09-25",
    }]


def stub_auth_and_db(pg):
    def fauth(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
            json={"access_token": "x", "token_type": "bearer", "expires_in": 3600,
                  "refresh_token": "y",
                  "user": {"id": "u1", "email": "rita@example.com",
                           "user_metadata": {"name": "Rita"}}})

    pg.route("**/auth/v1/signup*", fauth)
    pg.route("**/auth/v1/token*", fauth)

    def fempty(route):
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

    pg.route("**/rest/v1/*", fempty)


HINT_TEXT = "Long-press any checklist item to reorder it."

HINT_POS_JS = """() => {
  const hint = document.querySelector('[data-testid="reorder-hint"]');
  if (!hint) return { found: false };
  const firstRow = document.querySelector('[data-testid="step-row"]');
  return { found: true,
           text: (hint.textContent || '').trim(),
           yHint: hint.getBoundingClientRect().y,
           yFirstRow: firstRow ? firstRow.getBoundingClientRect().y : -1 };
}"""


def client_seed_js(role):
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": False,
         "custom": False, "order": i, "completedAt": None}
        for i in range(10)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "both", "buyerName": "Priya Nair", "sellerName": "Sam Seller",
        "openDate": "2026-09-25", "closeDate": "2026-12-25",
        "buyerSteps": steps, "sellerSteps": steps, "status": "open",
        "createdAt": "2026-09-25",
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": role,
            "partyName": "Priya Nair", "deviceId": "dev-1"}
    profile = {"name": "Maya Chen", "photoUri": None, "about": "",
               "yearsExperience": "", "dealsClosed": "", "areasServed": "",
               "phone": "", "dreLicense": ""}
    js = ("localStorage.setItem('ctc:escrows', '" + json.dumps([escrow]).replace("'", "\\'") + "');"
          "localStorage.setItem('ctc:clientlink', '" + json.dumps(link).replace("'", "\\'") + "');"
          "localStorage.setItem('ctc:profile', '" + json.dumps(profile).replace("'", "\\'") + "');")
    return js


def client_rpc_payload(role):
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "",
         "done": False, "custom": False, "position": i, "completed_at": None}
        for i in range(10)
    ]
    payload = {
        "ok": True,
        "escrow": {"id": "seed-1", "address": "26207 Benito Ct",
                   "city": "Santa Clarita", "close_date": "2026-12-25"},
        "profile": {"name": "Maya Chen", "photo_url": None, "about": "",
                    "years_experience": "", "deals_closed": "",
                    "areas_served": "", "phone": "", "dre_license": ""},
    }
    payload["buyer_steps" if role == "buyer" else "seller_steps"] = steps
    return payload


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 390, "height": 844},
                            has_touch=True, is_mobile=True)
            pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
            pg.add_init_script(
                "localStorage.setItem('ctc:escrows', '"
                + json.dumps(seed_escrows()).replace("'", "\\'") + "');")
            stub_auth_and_db(pg)
            pg.goto(BASE)
            pg.wait_for_timeout(3000)
            pg.get_by_text("I'm a Realtor").click()
            pg.wait_for_timeout(400)
            pg.get_by_text("Continue", exact=True).click()
            pg.wait_for_timeout(1200)
            ins = pg.locator("input")
            ins.nth(0).fill("Rita Realtor")
            ins.nth(1).fill("rita@example.com")
            ins.nth(2).fill("longenoughpassword")
            pg.get_by_text("Create account", exact=True).click()
            pg.get_by_text("Skip for now").wait_for(timeout=12000)
            pg.get_by_text("Skip for now").click()
            pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
            pg.get_by_text("26207 Benito Ct").first.click()
            pg.get_by_text("Step 01").wait_for(timeout=12000)
            pg.wait_for_timeout(800)

            # 1) No "Share this escrow" button on the detail screen.
            check("no 'Share this escrow' button on the escrow detail screen",
                  pg.get_by_text("Share this escrow", exact=True).count() == 0)

            # 2) "Invite client" present, exactly as before.
            check("'Invite client' button still present",
                  pg.get_by_text("Invite client", exact=True).count() == 1)

            # 3) Reorder hint in the removed button's spot (realtor only).
            hp = pg.evaluate(HINT_POS_JS)
            check("reorder hint renders on the realtor detail",
                  hp["found"] and hp["text"] == HINT_TEXT, str(hp))
            check("reorder hint sits between the time tracker and the checklist",
                  hp["found"] and 0 < hp["yHint"] < hp["yFirstRow"], str(hp))
            pg.screenshot(path=os.path.join(OUT, "realtor-detail-hint.png"))

            # 4) Invite create-code -> copy flow still works.
            pg.get_by_text("Invite client", exact=True).click()
            pg.get_by_text("Invite the buyer").wait_for(timeout=8000)
            pg.locator("input").fill("Dan Buyer")
            pg.wait_for_timeout(300)
            pg.get_by_text("Create code", exact=True).click()
            pg.wait_for_timeout(900)
            chips = pg.evaluate("""() => [...document.querySelectorAll('*')]
              .map(e => (e.textContent || '').trim()).filter(t => t.length === 6)""")
            codes = [c for c in chips if CODE_RE.match(c)]
            check("invite: code issued", len(codes) >= 1, f"chips={chips[:8]}")
            pg.screenshot(path=os.path.join(OUT, "invite-sheet-code.png"))
            pg.get_by_text("Copy", exact=True).last.click()
            pg.wait_for_timeout(900)
            # Copy closes the sheet; the button flips to "View clients".
            pg.get_by_text("View clients", exact=True).first.click()
            pg.get_by_text("Buyer · 1 of 2").wait_for(timeout=8000)
            check("invite: client listed after copy",
                  pg.get_by_text("Dan Buyer").count() > 0)
            check("invite: heading shows 1 of 2",
                  pg.get_by_text("Buyer · 1 of 2").count() > 0)

            # 5) The hint does NOT render on the buyer/seller client views
            #    (read-only checklists). Fresh contexts: client device state.
            for role in ["buyer", "seller"]:
                ctx = b.new_context(viewport={"width": 390, "height": 844},
                                    has_touch=True, is_mobile=True)
                cpg = ctx.new_page()
                cpg.on("pageerror", lambda e: JS_ERRORS.append(f"client-{role}: {e}"))
                cpg.add_init_script(client_seed_js(role))
                payload_json = json.dumps(client_rpc_payload(role))

                def fulfill_rpc(rt, req, _payload=payload_json):
                    if rt.request.method == "OPTIONS":
                        rt.fulfill(status=200, headers={
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Methods": "POST, OPTIONS",
                            "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
                        return
                    rt.fulfill(status=200, headers={
                        "Access-Control-Allow-Origin": "*",
                        "Content-Type": "application/json"}, body=_payload)

                cpg.route("**/rest/v1/rpc/get_client_view*", fulfill_rpc)
                cpg.goto(f"{BASE}client/{role}/seed-1")
                cpg.wait_for_timeout(3500)
                check(f"client {role} view: no reorder hint (read-only checklist)",
                      cpg.evaluate(HINT_POS_JS)["found"] is False)
                check(f"client {role} view: checklist still renders",
                      cpg.get_by_text("Step 01").count() > 0)
                ctx.close()

            b.close()
    finally:
        srv.shutdown()

    print("\n----- share_button_removed:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", str(e)[:200])
    if JS_ERRORS:
        check("zero JS errors", False, f"{len(JS_ERRORS)} errors")
    else:
        check("zero JS errors", True)
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
