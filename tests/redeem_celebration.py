#!/usr/bin/env python3
"""Clear to Close — regression test: client redeem celebration (Sept 2026).

Approved design "Redeem celebration B" (realtor-branding mockup v1):
the plain redeem-success screen is now a brand-teal celebration card with a
gold "WELCOME ABOARD" kicker, "Your escrow is open!" headline, the realtor's
photo (initials avatar fallback), "<name> has got this.", reassuring body
copy, and the DRE line — followed by "View my escrow" and
"Not your escrow? Start over".

Runs the REAL client redeem flow on built output (390x844):
  - role picker -> "I'm a client" -> name + code -> Continue;
  - celebration card shows the seeded realtor's name/photo fallback/DRE;
  - the old "Hooray! Your escrow is open." headline and the old
    "This device is now linked to your escrow" subtext are gone;
  - confetti pieces render (16) and visibly fall (motion case);
  - with prefers-reduced-motion, pieces render settled and never move;
  - "View my escrow" routes into the client escrow home;
  - Zero JS errors.

Usage: python3 tests/redeem_celebration.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: CTC_ROOT (repo root), CTC_PORT (default 8924),
CTC_OUT (output dir, default /tmp/ctc-redeem-celebration).
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
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-redeem-celebration")
PORT = int(os.environ.get("CTC_PORT", "8924"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

PROFILE = {
    "name": "Maya Sharma",
    "photoUri": None,
    "about": "",
    "yearsExperience": "",
    "dealsClosed": "",
    "areasServed": "",
    "phone": "",
    "dreLicense": "01998877",
}


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


def seed_script(escrows, invites, profile):
    # The AsyncStorage web backend JSON-encodes values once more on write,
    # so seeds go in double-encoded.
    return (
        "localStorage.setItem('ctc:escrows', %s);"
        "localStorage.setItem('ctc:invites', %s);"
        "localStorage.setItem('ctc:links', %s);"
        "localStorage.setItem('ctc:profile', %s);"
        % (
            json.dumps(json.dumps(escrows)),
            json.dumps(json.dumps(invites)),
            json.dumps(json.dumps([])),
            json.dumps(json.dumps(profile)),
        )
    )


def profile_with(group):
    p = dict(PROFILE)
    if group is None:
        p.pop("realtyGroup", None)
    else:
        p["realtyGroup"] = group
    return p


def stub_rpc(pg):
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

    # The stepped redeem flow resolves the invite's realtor (branded
    # welcome) before the name step; stub the resolve RPC the same way.
    def fresolve(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
            json={"ok": True, "realtor": {
                "name": "Maya Sharma", "photo_url": None,
                "realty_group": "Compass Realty", "dre_license": "01998877",
                "realtor_id": "user-maya-1"}})
    pg.route("**/rest/v1/rpc/resolve_invite_realtor*", fresolve)

    # The configured bundle's background cloud sync fires on boot; in the
    # sandbox the real Supabase host is unreachable, so stub the dormant
    # sync endpoints with empty reads (writes succeed silently). Without
    # these, the console records ERR_EMPTY_RESPONSE resource errors.
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

    # The client home calls the get_client_view RPC after "View my escrow".
    # Answer with the RPC's own not-ok shape so the app takes its designed
    # offline fallback (local data) instead of hitting the real host.
    pg.route("**/rest/v1/rpc/get_client_view*", lambda route: route.fulfill(
        status=200,
        headers={"Access-Control-Allow-Origin": "*",
                 "Content-Type": "application/json"},
        json={"ok": False, "error": "stubbed"}))


def redeem_to_celebration(pg):
    """Drive the real redeem flow; return when the celebration card appears."""
    pg.goto(BASE)
    pg.wait_for_timeout(3000)
    # Role picker -> client path.
    pg.get_by_text("I'm a client").click()
    pg.get_by_text("Continue", exact=True).click()
    # Stepped flow (Sept 2026): the code validates first.
    pg.locator("[placeholder='6-character code']").fill("QK7M2X")
    pg.wait_for_timeout(400)
    # The role screen's Continue is still in the stack; the redeem
    # screen's is the topmost.
    pg.get_by_role("button", name="Continue").last.click()
    # Branded invite welcome -> Continue to the name step.
    pg.get_by_text("Maya Sharma", exact=True).wait_for(timeout=15000)
    pg.wait_for_timeout(400)
    pg.get_by_role("button", name="Continue").last.click()
    pg.get_by_text("Almost there", exact=True).wait_for(timeout=12000)
    pg.locator("[placeholder='e.g. Jordan Lee']").fill("Alice Buyer")
    pg.wait_for_timeout(400)
    pg.get_by_role("button", name="Join your escrow").click()
    pg.get_by_text("WELCOME ABOARD", exact=True).wait_for(timeout=15000)


def piece_boxes(pg):
    boxes = []
    for el in pg.locator('[data-testid="confetti-piece"]').all():
        b = el.bounding_box()
        if b:
            boxes.append((round(b["x"], 1), round(b["y"], 1)))
    return boxes


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

        # ---- Motion case: confetti falls on mount ----
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        pg = ctx.new_page()
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(seed_script(escrows, invites, profile_with("Compass Realty")))
        stub_rpc(pg)
        try:
            redeem_to_celebration(pg)

            # Sample confetti positions while the ~2.5s fall is in flight.
            pg.locator('[data-testid="confetti-piece"]').first.wait_for(timeout=8000)
            t0 = piece_boxes(pg)
            check("confetti renders 16 pieces", len(t0) == 16, f"got {len(t0)}")
            pg.wait_for_timeout(900)
            t1 = piece_boxes(pg)
            moved = any(
                abs(a[0] - b[0]) >= 2 or abs(a[1] - b[1]) >= 2
                for a, b in zip(t0, t1)
            ) if len(t0) == len(t1) == 16 else False
            check("confetti falls on mount (pieces move)", moved)

            check("kicker is WELCOME ABOARD",
                  pg.get_by_text("WELCOME ABOARD", exact=True).count() > 0)
            check("headline is the new copy",
                  pg.get_by_text("Your escrow is open!").count() > 0)
            check("realtor name reassures",
                  pg.get_by_text("Maya Sharma has got this.", exact=True).count() > 0)
            # The body copy spans JSX expression boundaries, which defeats
            # Playwright's text-node matcher; assert on the card's text.
            card_text = pg.locator('[data-testid="redeem-celebration-card"]'
                                   ).inner_text().replace("\n", " ")
            check("body copy is the approved reassurance",
                  "Every inspection, signature, and deadline, handled for you. "
                  "Maya Sharma will keep you posted at every step." in card_text)
            check("byline shows name / group / DRE",
                  pg.get_by_text("Maya Sharma / Compass Realty · DRE #01998877", exact=True).count() > 0)
            check("old Hooray headline is gone",
                  pg.get_by_text("Hooray! Your escrow is open.", exact=True).count() == 0)
            check("old device-link subtext is gone",
                  pg.get_by_text("This device is now linked to your escrow", exact=True).count() == 0)
            check("'View my escrow' action present",
                  pg.get_by_text("View my escrow", exact=True).count() > 0)
            check("'Not your escrow? Start over' action present",
                  pg.get_by_text("Not your escrow? Start over", exact=True).count() > 0)
            pg.screenshot(path=os.path.join(OUT, "redeem-celebration.png"))

            pg.get_by_text("View my escrow", exact=True).click()
            pg.wait_for_timeout(2500)
            check("'View my escrow' routes into the client escrow home",
                  "/client/buyer/seed-1" in pg.url, pg.url)
            pg.screenshot(path=os.path.join(OUT, "redeem-celebration-client-home.png"))

            check("zero JS errors during the flow", len(errors) == 0,
                  "; ".join(errors[:3]))
        finally:
            pg.close()
            ctx.close()

        # ---- Reduced-motion case: confetti renders settled, never moves ----
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
        pg2 = ctx2.new_page()
        errs2 = []
        pg2.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        pg2.add_init_script(seed_script(escrows, invites, profile_with(None)))
        stub_rpc(pg2)
        try:
            redeem_to_celebration(pg2)
            pg2.locator('[data-testid="confetti-piece"]').first.wait_for(timeout=8000)
            # Past the fall window: with reduced motion nothing should move.
            pg2.wait_for_timeout(3000)
            r0 = piece_boxes(pg2)
            pg2.wait_for_timeout(1000)
            r1 = piece_boxes(pg2)
            check("reduced motion: 16 pieces still render", len(r0) == 16, f"got {len(r0)}")
            still = len(r0) == len(r1) == 16 and all(a == b for a, b in zip(r0, r1))
            check("reduced motion: confetti never moves", still)
            check("reduced motion: copy still renders",
                  pg2.get_by_text("Maya Sharma has got this.", exact=True).count() > 0)
            check("no group: byline is name and DRE only, no dangling separator",
                  pg2.get_by_text("Maya Sharma · DRE #01998877", exact=True).count() > 0
                  and pg2.get_by_text("Maya Sharma /", exact=True).count() == 0)
            pg2.screenshot(path=os.path.join(OUT, "redeem-celebration-reduced-motion.png"))
            check("reduced motion: zero JS errors", len(errs2) == 0, "; ".join(errs2[:3]))
        finally:
            pg2.close()
            ctx2.close()

        browser.close()

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nAll redeem-celebration regression checks passed.")


if __name__ == "__main__":
    main()
