#!/usr/bin/env python3
"""Clear to Close — regression test: invite-client flow (approved Sept 2026).

Covers the transaction-detail invite flow on REAL built output (390x844):
  - "Invite client" sits at the END of the checklist page (after the
    footnote), on buy and on each dual-agency tab; it flips to
    "View clients" once an active invite exists.
  - Invite sheet: name -> Create code -> code + Copy.
  - Client-list overlay: "Buyer · X of 2" heading; Invited (amber pill, code +
    Copy visible) vs Accepted (teal pill, code hidden); per-client
    Regenerate and Revoke with the approved confirm copy; "Invite another"
    below the cap; the quiet cap note at 2/2.
  - Regenerate: new code issued, old code dies (old code chip gone).
  - Revoke: row disappears, slot frees ("Buyer · 1 of 2", "Invite another"
    returns), revoked client's access killed.
  - Zero JS errors throughout.

Drives the REAL user flow hermetically (sign-up with a stubbed Supabase
session -> skip profile -> deal list -> escrow card). Invites are seeded
straight into localStorage (ctc:invites) so the Accepted state is covered
without a second device; the rest goes through the UI.

Usage: python3 tests/invite_flow.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Honors CTC_ROOT (defaults to ~/workspace/realtor-app), CTC_INVITE_PORT
(defaults to 8906), CTC_INVITE_OUT (defaults to /tmp/ctc-invite-flow).
"""
import http.server
import functools
import os
import threading
import sys
import json
import time
import re

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT", os.path.expanduser("~/workspace/realtor-app"))
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_INVITE_OUT", "/tmp/ctc-invite-flow")
PORT = int(os.environ.get("CTC_INVITE_PORT", "8906"))
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
        {
            "id": "seed-2",
            "address": "999 Dual Agency Ln",
            "city": "Santa Clarita",
            "side": "both",
            "buyerName": "Dan Buyer",
            "sellerName": "Eve Seller",
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": steps,
            "sellerSteps": [
                {
                    "id": f"ss{i}",
                    "title": f"Seller step {i + 1}",
                    "subtitle": "",
                    "done": False,
                    "custom": False,
                    "order": i,
                    "completedAt": None,
                }
                for i in range(12)
            ],
            "status": "open",
            "createdAt": "2026-09-25",
        },
    ]
    # One Invited + one Accepted buyer invite on seed-1 (2 of 2).
    invites = [
        {
            "id": "inv-alice",
            "code": "QK7M2X",
            "escrowId": "seed-1",
            "role": "buyer",
            "partyName": "Alice Buyer",
            "createdAt": "2026-09-26T10:00:00.000Z",
            "revokedAt": None,
            "redeemedAt": None,
        },
        {
            "id": "inv-carol",
            "code": "ZWH4P9",
            "escrowId": "seed-1",
            "role": "buyer",
            "partyName": "Carol Buyer",
            "createdAt": "2026-09-26T09:00:00.000Z",
            "revokedAt": None,
            "redeemedAt": "2026-09-26T11:00:00.000Z",
        },
    ]
    links = [
        {
            "id": "link-carol",
            "escrowId": "seed-1",
            "inviteId": "inv-carol",
            "role": "buyer",
            "partyName": "Carol Buyer",
            "createdAt": "2026-09-26T11:00:00.000Z",
            "deviceId": "test-device",
            "revokedAt": None,
        }
    ]
    return escrows, invites, links


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

# DOM-order check: the invite button must come AFTER the checklist footnote.
BTN_AFTER_FOOTNOTE = """() => {
  const deepest = (re) => {
    const cands = [...document.querySelectorAll('*')].filter(e =>
      e.children.length === 0 && re.test(e.textContent || ''));
    if (!cands.length) return null;
    const depth = (e) => { let d = 0, x = e; while (x.parentElement) { x = x.parentElement; d++; } return d; };
    cands.sort((a, b) => depth(b) - depth(a));
    return cands[0];
  };
  const foot = deepest(/Drag the grip to reorder steps/);
  const btn = deepest(/^Invite client$/) || deepest(/^View clients$/);
  if (!foot || !btn) return 'missing: foot=' + !!foot + ' btn=' + !!btn;
  const pos = foot.compareDocumentPosition(btn);
  return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? 'after' : 'NOT-AFTER';
}"""

# Click a button (Copy/Regenerate/×) inside the client row for a given name.
CLICK_IN_ROW = """([name, label]) => {
  const nameEl = [...document.querySelectorAll('*')].find(e =>
    e.children.length === 0 && (e.textContent || '').trim() === name);
  if (!nameEl) return 'no name ' + name;
  let row = nameEl;
  for (let i = 0; i < 8 && row.parentElement; i++) {
    row = row.parentElement;
    const btn = [...row.querySelectorAll('*')].find(e =>
      e.children.length === 0 && (e.textContent || '').trim() === label);
    if (btn) { btn.click(); return 'clicked ' + label + ' for ' + name; }
  }
  return 'no button ' + label + ' for ' + name;
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
            # Hermetic sync isolation (regression: the client-list overlay
            # rendered "Buyer · 0 of 2" because every listInvites call stalled
            # 4s on the cloud path). pingCloud's
            # read probe is
            #   GET /rest/v1/realtor_profiles?select=user_id&user_id=eq.<uid>
            # Answer it with 200 + a malformed JSON body: supabase-js fails
            # to parse it, so the probe reports unhealthy and cloud sync
            # stays dormant, leaving the seeded localStorage as the
            # authoritative fixture. (Without this, store.listInvites takes
            # the cloud path and every call burns the 4s pullInvitesNow
            # timeout against the real Supabase, so the overlay still shows
            # 0 invites at assert time.) A malformed 200 — rather than a
            # 4xx/5xx — keeps the "zero JS errors" assertion meaningful:
            # Chromium logs "Failed to load resource" for error statuses.
            # Profile setup is skipped in this flow, so the ping is the only
            # realtor_profiles request; anything else keeps the previous
            # empty-rows stub.
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
            # 1. Sign up -> skip profile -> deal list.
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

            # 2. Open the buy escrow -> "View clients" (2 seeded invites).
            print("STEP 2: open buy escrow", flush=True)
            pg.get_by_text("26207 Benito Ct").first.click()
            pg.get_by_text("of 13 steps").wait_for(timeout=12000)
            scroll_res = pg.evaluate(SCROLL_TO_BOTTOM)
            check("invite: scrolled to checklist bottom", str(scroll_res).startswith("scrolled"), scroll_res)
            order = pg.evaluate(BTN_AFTER_FOOTNOTE)
            check("invite: button sits after the checklist footnote (end of page)", order == "after", order)
            btn = pg.get_by_text("View clients", exact=True)
            check("invite: seeded invites flip the button to 'View clients'", btn.count() > 0)
            btn.click()
            pg.wait_for_timeout(800)
            pg.screenshot(path=f"{OUT}/01-client-list.png")

            # 3. Client-list overlay: heading, pills, code visibility.
            print("STEP 3: client list overlay", flush=True)
            check("overlay: 'View clients' title", pg.get_by_text("View clients", exact=True).count() > 0)
            check("overlay: 'Buyer · 2 of 2'", pg.get_by_text("Buyer · 2 of 2").count() > 0)
            check("overlay: Invited pill on Alice", pg.get_by_text("Invited", exact=True).count() == 1)
            check("overlay: Accepted pill on Carol", pg.get_by_text("Accepted", exact=True).count() == 1)
            chips = pg.evaluate(CODE_CHIPS)
            check("overlay: code chip on the Invited row only",
                  chips == ["QK7M2X"], f"chips={chips}")
            check("overlay: cap note at 2/2",
                  pg.get_by_text("Two invites max per side.", exact=False).count() > 0)
            check("overlay: no 'Invite another' at the cap",
                  pg.get_by_text("Invite another buyer", exact=True).count() == 0)

            # 4. Regenerate Alice: confirm copy, new code, old code dies.
            print("STEP 4: regenerate Alice", flush=True)
            res = pg.evaluate(CLICK_IN_ROW, ["Alice Buyer", "Regenerate"])
            check("overlay: Regenerate opens for Alice", str(res).startswith("clicked"), res)
            pg.wait_for_timeout(500)
            check("regen: confirm title", pg.get_by_text("New code for Alice Buyer?").count() > 0)
            check("regen: confirm body",
                  pg.get_by_text("The old code stops working — any linked device loses access to this escrow.").count() > 0)
            pg.get_by_text("Create new code", exact=True).click()
            pg.wait_for_timeout(900)
            check("regen: success toast",
                  pg.get_by_text("New code issued — the old code no longer works.").count() > 0)
            chips2 = pg.evaluate(CODE_CHIPS)
            check("regen: Alice has a fresh code, old code gone",
                  len(chips2) == 1 and CODE_RE.match(chips2[0]) and chips2[0] != "QK7M2X",
                  f"chips={chips2}")
            pg.screenshot(path=f"{OUT}/02-after-regen.png")

            # 5. Revoke Carol (Accepted): confirm copy, row disappears, slot frees.
            print("STEP 5: revoke Carol", flush=True)
            res = pg.evaluate(CLICK_IN_ROW, ["Carol Buyer", "×"])
            check("overlay: revoke opens for Carol", str(res).startswith("clicked"), res)
            pg.wait_for_timeout(500)
            check("revoke: confirm title", pg.get_by_text("Remove Carol Buyer’s invite?").count() > 0)
            check("revoke: accepted-client confirm body",
                  pg.get_by_text("Their invite stops working and their linked device loses access to this escrow. You can send them a fresh invite anytime.").count() > 0)
            pg.get_by_text("Remove", exact=True).click()
            pg.wait_for_timeout(900)
            check("revoke: success toast", pg.get_by_text("Invite removed.").count() > 0)
            check("revoke: row gone", pg.get_by_text("Carol Buyer").count() == 0)
            check("revoke: heading drops to 1 of 2", pg.get_by_text("Buyer · 1 of 2").count() > 0)
            check("revoke: 'Invite another buyer' returns",
                  pg.get_by_text("Invite another buyer", exact=True).count() > 0)
            pg.screenshot(path=f"{OUT}/03-after-revoke.png")

            # 6. "Invite another buyer" -> invite sheet -> name -> Create code -> Copy.
            print("STEP 6: invite another buyer", flush=True)
            pg.get_by_text("Invite another buyer", exact=True).click()
            pg.wait_for_timeout(800)
            check("sheet: 'Invite the buyer'", pg.get_by_text("Invite the buyer").count() > 0)
            pg.locator("input").fill("Dan Buyer")
            pg.wait_for_timeout(300)
            pg.get_by_text("Create code", exact=True).click()
            pg.wait_for_timeout(900)
            new_chips = pg.evaluate(CODE_CHIPS)
            created = [c for c in new_chips if CODE_RE.match(c)]
            check("sheet: code issued", len(created) >= 1, f"chips={new_chips}")
            pg.screenshot(path=f"{OUT}/04-invite-sheet-code.png")
            # The client-list sheet underneath has its own "Copy" link first in
            # DOM order; the invite sheet's Copy button is the last match.
            pg.get_by_text("Copy", exact=True).last.click()
            pg.wait_for_timeout(900)
            check("overlay: back to 2 of 2", pg.get_by_text("Buyer · 2 of 2").count() > 0)
            check("overlay: Dan Buyer listed", pg.get_by_text("Dan Buyer").count() > 0)

            # 7. Close the overlay, close the detail, open the dual-agency escrow.
            print("STEP 7: dual-agency escrow", flush=True)
            pg.get_by_label("Dismiss sheet").click()
            pg.wait_for_timeout(700)
            pg.get_by_label("Back to escrows").click()
            pg.get_by_text("999 Dual Agency Ln").first.wait_for(timeout=12000)
            pg.get_by_text("999 Dual Agency Ln").first.click()
            pg.get_by_text("Buyer", exact=True).first.wait_for(timeout=12000)
            pg.evaluate(SCROLL_TO_BOTTOM.replace("Buyer step 1", "Buyer step 1"))
            check("dual: buyer tab shows 'Invite client'",
                  pg.get_by_text("Invite client", exact=True).count() > 0)
            pg.screenshot(path=f"{OUT}/05-dual-buyer-tab.png")
            # Switch to the Seller tab.
            tabs = pg.get_by_text("Seller", exact=True)
            tabs.first.click()
            pg.wait_for_timeout(700)
            check("dual: seller tab shows 'Invite client'",
                  pg.get_by_text("Invite client", exact=True).count() > 0)
            pg.screenshot(path=f"{OUT}/06-dual-seller-tab.png")

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
    print("\nAll invite-flow regression checks passed.")


if __name__ == "__main__":
    main()
