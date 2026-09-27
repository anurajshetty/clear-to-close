#!/usr/bin/env python3
"""client_triumph — client home 100% state regression
(APPROVED mockup screen 10 "Home at 100% · realtor triumph", Sept 2026).

Guards (real rendered component, 390x844, client buyer view at 10/10):
  - The top card becomes the realtor triumph: confetti layer (16 pieces),
    the realtor's name as the gold kicker, "Just closed!" headline, realtor photo,
    "Congratulations, checklist done. The property is yours.", property address,
    the 100% gold ring (150px display), teal gradient + gold glows, and the
    ahead-of-schedule pill per the 100% rule. No greeting, no guided-by
    strip, no pace pill.
  - Spare pill (10+ days left) AND congratulations pill (<5 days) variants.
  - Below the card: the checklist collapses to one tappable row
    ("{N} of {N} steps complete · View") that expands inline to the full
    read-only list and collapses again.
  - "Leave {Name} a review" (gold) and "Share {Name}'s profile" buttons,
    plus "Know someone buying or selling? Send them your realtor."
  - The review button is a clearly-marked wiring point: it renders, and
    clicking it (unwired) navigates nowhere and throws nothing.
  - The share button's graceful fallback: with no navigator.share, the
    approved message copy is copied to the clipboard and the button
    confirms — never a dead button, never a throw.
  - A 9/10 escrow still renders the mid-escrow card (no triumph).
  - Zero JS errors in every case.

Suite dates are computed from runtime "today" so nothing goes stale.

Usage: APP_ROOT=/home/hatch/workspace/realtor-app-wt-client-topcard \
         python3 tests/rendered/client_triumph.py
Requires: a fresh `npm run export:web` build in <APP_ROOT>/dist.
"""
import datetime
import functools
import http.server
import json
import os
import threading

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-client-topcard")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8930"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "client_triumph")
os.makedirs(OUT, exist_ok=True)

FAILS = []


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
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def iso(delta_days):
    return (datetime.date.today() + datetime.timedelta(days=delta_days)).isoformat()


def seed(done_count, close_delta):
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": i < done_count,
         "custom": False, "order": i, "completedAt": None}
        for i in range(10)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": iso(-60), "closeDate": iso(close_delta),
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": iso(-60),
    }
    profile = {
        "name": "Maya Sharma", "photoUri": None, "about": "I answer my phone.",
        "yearsExperience": "9", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877",
        "realty_group": "Compass Realty", "banner_image": None,
        "rating": 5, "avgDaysToClose": 21,
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": "buyer",
            "partyName": "Priya Nair", "deviceId": "test-device-1"}
    js = (
        "localStorage.setItem('ctc:escrows', '" + json.dumps([escrow]).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:clientlink', '" + json.dumps(link).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:deviceid', 'test-device-1');"
        "localStorage.setItem('ctc:profile', '" + json.dumps(profile).replace("'", "\\'") + "');"
    )
    return js


RING_JS = """() => {
  const wrap = document.querySelector('[data-testid="progress-ring"]');
  if (!wrap) return { found: false };
  const svg = wrap.querySelector('svg');
  const circles = svg ? [...svg.querySelectorAll('circle')] : [];
  return {
    found: true,
    svgW: svg ? svg.getAttribute('width') : null,
    progress: circles[1] ? circles[1].getAttribute('stroke') : null,
    label: (wrap.innerText || '').trim(),
  };
}"""


def load(browser, seed_js):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(1500)
    pg.evaluate(seed_js)
    pg.goto(BASE + "client/buyer/seed-1")
    pg.wait_for_timeout(4000)
    return pg, errs


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # --- Case 1: 100% + 27 days left -> triumph + spare pill ---------
            pg, errs = load(browser, seed(10, 27))
            body = pg.inner_text("body")
            check("triumph headline", "Just closed!" in body)
            check("triumph kicker", "Maya Sharma" in body)
            check("triumph text",
                  "Congratulations, checklist done. The property is yours." in body)
            check("triumph address", "26207 Benito Ct, Santa Clarita" in body)
            check("triumph gradient bg", pg.query_selector('[data-testid="triumph-gradient"]') is not None)
            check("triumph gold glows", pg.query_selector('[data-testid="triumph-glows"]') is not None)
            confetti = pg.query_selector('[data-testid="triumph-confetti"]')
            check("triumph confetti layer", confetti is not None)
            if confetti:
                pieces = pg.query_selector_all('[data-testid="confetti-piece"]')
                check("16 confetti pieces", len(pieces) == 16, f"got {len(pieces)}")
            ring = pg.evaluate(RING_JS)
            check("triumph ring is 150px display", ring.get("svgW") == "150", str(ring))
            check("triumph ring gold at 100%",
                  (ring.get("progress") or "").lower() == "#f5c66b" and ring.get("label") == "100%",
                  str(ring))
            banner = pg.query_selector('[data-testid="completion-banner"]')
            check("spare pill shown",
                  banner is not None and
                  "Checklist complete with 27 days to spare. Maya has you ahead of schedule." in
                  banner.inner_text().replace("\n", " ").replace("  ", " "),
                  banner.inner_text()[:120] if banner else "missing")
            check("no greeting on triumph", "Hi Priya" not in body)
            check("no guided-by on triumph", pg.query_selector('[data-testid="guided-by"]') is None)
            check("no pace pill at 100%", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("no read-only note on triumph", "This view is read-only." not in body)

            # Collapsed checklist.
            check("collapsed row label", "10 of 10 steps complete" in body)
            check("collapsed row toggle", "View ∨" in body)
            check("list collapsed initially", pg.query_selector('[data-testid="triumph-checklist-expanded"]') is None)
            pg.get_by_test_id("triumph-checklist-toggle").click()
            pg.wait_for_timeout(600)
            check("expands inline", pg.query_selector('[data-testid="triumph-checklist-expanded"]') is not None)
            check("expanded shows all steps", pg.get_by_text("Step 10", exact=True).count() >= 1)
            check("toggle flips to Hide", "Hide ∧" in pg.inner_text("body"))
            pg.get_by_test_id("triumph-checklist-toggle").click()
            pg.wait_for_timeout(600)
            check("collapses again", pg.query_selector('[data-testid="triumph-checklist-expanded"]') is None)

            # Review button: renders, gold, and (merge-lead wired, Sept 2026)
            # opens the review sheet instead of navigating.
            check("review button", pg.get_by_text("Leave Maya a review", exact=True).count() == 1)
            url_before = pg.url
            pg.get_by_test_id("triumph-review").click()
            pg.get_by_placeholder("One line about your experience").wait_for(timeout=12000)
            check("review button opens the review sheet, no navigation", pg.url == url_before)
            # Dismiss the sheet via its backdrop before continuing.
            pg.get_by_label("Dismiss sheet").click()
            pg.wait_for_timeout(600)
            check("review sheet dismisses",
                  pg.get_by_placeholder("One line about your experience").count() == 0)

            # Share button + referral line.
            check("share button", pg.get_by_text("Share Maya's profile", exact=True).count() == 1)
            check("referral line", "Know someone buying or selling?" in body and "Send them your realtor." in body)

            # Share fallback: no navigator.share on desktop Chromium, so the
            # approved message copy lands on the clipboard instead.
            pg.evaluate("""() => {
              window.__copied = null;
              Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
                configurable: true,
              });
            }""")
            pg.get_by_test_id("triumph-share").click()
            pg.wait_for_timeout(1200)
            copied = pg.evaluate("() => window.__copied")
            check("share fallback copies the message",
                  copied is not None and "My realtor Maya Sharma just got us closed, 27 days early!" in copied,
                  str(copied)[:100] if copied else "nothing copied")
            check("share fallback confirms",
                  pg.query_selector('[data-testid="triumph-share-note"]') is not None)
            check("no deals-closed in share copy", copied is None or "deal" not in copied.lower())
            pg.screenshot(path=os.path.join(OUT, "triumph-100.png"))
            check("case 1: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 2: 100% + 2 days left -> congratulations pill ---------
            pg, errs = load(browser, seed(10, 2))
            banner = pg.query_selector('[data-testid="completion-banner"]')
            check("congratulations pill variant",
                  banner is not None and banner.inner_text().strip() == "Congratulations, your checklist is complete",
                  banner.inner_text()[:80] if banner else "missing")
            check("triumph still renders", pg.get_by_text("Just closed!", exact=True).count() == 1)
            check("case 2: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 3: 9/10 -> mid-escrow card, no triumph ----------------
            pg, errs = load(browser, seed(9, 27))
            body = pg.inner_text("body")
            check("no triumph below 100%", "Just closed!" not in body)
            check("mid-escrow card intact", "Hi Priya Nair" in body)
            check("no triumph section below 100%", pg.query_selector('[data-testid="triumph-section"]') is None)
            check("case 3: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            browser.close()
    finally:
        srv.shutdown()

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        raise SystemExit(1)
    print("All client triumph checks passed.")


if __name__ == "__main__":
    main()
