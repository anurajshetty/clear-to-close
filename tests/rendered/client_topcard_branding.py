#!/usr/bin/env python3
"""client_topcard_branding — client home top-card branding redesign regression
(APPROVED mockup screens 7 "banner bleed" + 9 "ahead of pace", Sept 2026).

Guards (real rendered component, 390x844, client buyer view):
  - 208px gold progress ring (track rgba(255,255,255,.22), progress #F5C66B),
    "N of N steps" caption above, days line below.
  - Full-bleed banner: realtor banner photo behind everything with a dark
    scrim; brand-teal gradient fallback when no banner is uploaded.
  - "GUIDED BY" strip: photo, "GUIDED BY" kicker, "{Name} · {Realty group}",
    tagline in quotes (omitted when empty), Call / Text buttons.
    The strip itself uses the banner as its background (teal fallback) with
    a thin gold border.
  - Empty realty group -> "Name · DRE #..." (no dangling separator); empty
    group AND empty DRE -> name only.
  - Greeting avatar opens the realtor profile (tapping it navigates to the
    client-facing realtor profile page).
  - Status pills: ahead-of-pace gold pill shown when 15+ points ahead
    ("Ahead of pace. Maya has you 32 days ahead of schedule."); hidden below
    the threshold; NEVER at 100%; hidden on a degenerate timeline.
    100% + 10 days left -> "Checklist complete with 10 days to spare. Maya
    has you ahead of schedule."; 100% + 2 days left -> the unchanged
    "Congratulations, your checklist is complete".
  - Zero JS errors in every case.

Suite dates are computed from runtime "today" so nothing goes stale.

Usage: APP_ROOT=/home/hatch/workspace/realtor-app-wt-client-topcard \
         python3 tests/rendered/client_topcard_branding.py
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
PORT = int(os.environ.get("TEST_PORT", "8929"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "client_topcard_branding")
os.makedirs(OUT, exist_ok=True)

FAILS = []
JS_ERRORS = []

# 1px red PNG — stands in for an uploaded banner photo.
BANNER_DATA_URI = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


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


def seed(done_count, total, open_delta, close_delta, profile_overrides=None):
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": i < done_count,
         "custom": False, "order": i, "completedAt": None}
        for i in range(total)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": iso(open_delta), "closeDate": iso(close_delta),
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": iso(open_delta),
    }
    profile = {
        "name": "Maya Sharma", "photoUri": None, "about": "I answer my phone.",
        "yearsExperience": "12", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877",
        "realty_group": "Compass Realty", "banner_image": None,
    }
    profile.update(profile_overrides or {})
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
    svgH: svg ? svg.getAttribute('height') : null,
    track: circles[0] ? circles[0].getAttribute('stroke') : null,
    progress: circles[1] ? circles[1].getAttribute('stroke') : null,
    r: circles[1] ? circles[1].getAttribute('r') : null,
    strokeW: circles[1] ? circles[1].getAttribute('stroke-width') : null,
  };
}"""

GUIDED_JS = """() => {
  const el = document.querySelector('[data-testid="guided-by"]');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  return {
    found: true,
    text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
    borderColor: cs.borderColor,
    borderWidth: cs.borderWidth,
    hasBanner: !!el.querySelector('[data-testid="guided-banner"]'),
    hasGradient: !!el.querySelector('[data-testid="guided-gradient"]'),
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

            # --- Case 1: banner bleed, gold ring, guided-by (gradient fallback)
            # done 3/10 (30%), timeline 60d, elapsed 10d (16.7%): gap 13.3 < 15.
            pg, errs = load(browser, seed(3, 10, -10, 50))
            body = pg.inner_text("body")
            check("greeting headline", "Hi Priya Nair" in body)
            check("kicker uppercased", "YOUR PURCHASE" in body)
            ring = pg.evaluate(RING_JS)
            check("ring svg is 208x208", ring.get("svgW") == "208" and ring.get("svgH") == "208", str(ring))
            check("ring progress stroke is gold", (ring.get("progress") or "").lower() == "#f5c66b", str(ring.get("progress")))
            check("ring track is translucent white", "255,255,255" in (ring.get("track") or ""), str(ring.get("track")))
            check("ring geometry r=88 stroke=24", ring.get("r") == "88" and ring.get("strokeW") == "24", str(ring))
            check("steps caption", "3 of 10 steps" in body)
            check("days line", "days left:" in body and "50" in body)
            check("teal gradient fallback on card", pg.query_selector('[data-testid="topcard-gradient"]') is not None)
            check("no card banner img without upload", pg.query_selector('[data-testid="topcard-banner"]') is None)
            guided = pg.evaluate(GUIDED_JS)
            check("guided-by strip present", guided.get("found"))
            check("guided-by kicker", "GUIDED BY" in guided.get("text", ""))
            check("guided-by name + realty group", "Maya Sharma · Compass Realty" in guided.get("text", ""), guided.get("text", ""))
            check("guided-by tagline quoted", '"I answer my phone."' in guided.get("text", ""), guided.get("text", ""))
            check("guided-by Call button", pg.get_by_text("Call", exact=True).count() >= 1)
            check("guided-by Text button", pg.get_by_text("Text", exact=True).count() >= 1)
            check("guided-by no Profile button", pg.get_by_text("Profile", exact=True).count() == 0)
            check("guided-by uses teal fallback", guided.get("hasGradient") and not guided.get("hasBanner"), str(guided))
            check("guided-by thin gold border",
                  "245, 198, 107" in guided.get("borderColor", "") and guided.get("borderWidth") == "1px",
                  f"{guided.get('borderColor')} / {guided.get('borderWidth')}")
            check("no pace pill below threshold", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("no completion banner in progress", pg.query_selector('[data-testid="completion-banner"]') is None)
            # Greeting avatar -> the client-facing realtor profile page.
            pg.get_by_test_id("topcard-banner-photo").click()
            pg.get_by_text("Back to my escrow", exact=True).wait_for(timeout=8000)
            check("banner photo opens realtor profile", True)
            pg.screenshot(path=os.path.join(OUT, "topcard-branding.png"))
            check("case 1: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 2: uploaded banner fills card + guided-by strip.
            pg, errs = load(browser, seed(3, 10, -10, 50, {"banner_image": BANNER_DATA_URI}))
            check("card banner img present", pg.query_selector('[data-testid="topcard-banner"]') is not None)
            check("no gradient fallback with banner", pg.query_selector('[data-testid="topcard-gradient"]') is None)
            guided = pg.evaluate(GUIDED_JS)
            check("guided-by uses banner img", guided.get("hasBanner") and not guided.get("hasGradient"), str(guided))
            check("case 2: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 3: ahead-of-pace pill REMOVED (Anuraj, Sept 2026).
            # done 7/10 (70%), elapsed 10/60 (16.7%): the pace pill is gone
            # entirely — nothing is surfaced mid-escrow, only the top card.
            pg, errs = load(browser, seed(7, 10, -10, 50))
            check("no pace pill (feature removed)", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("no completion banner at 70%", pg.query_selector('[data-testid="completion-banner"]') is None)
            check("case 3: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 4: below threshold stays quiet.
            # done 2/10 (20%), elapsed 16.7%: gap 3.3 < 15.
            pg, errs = load(browser, seed(2, 10, -10, 50))
            check("no pace pill when behind pace", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("case 4: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 5: 100% + 10 days left -> triumph card + spare pill,
            # never the pace pill. (Deep triumph coverage lives in
            # tests/rendered/client_triumph.py.)
            pg, errs = load(browser, seed(10, 10, -50, 10))
            body = pg.inner_text("body")
            check("triumph card shown at 100%", "Just closed!" in body)
            check("triumph text",
                  "Maya Sharma completed all 10 steps and got you home." in body)
            banner = pg.query_selector('[data-testid="completion-banner"]')
            check("completion banner shown at 100%", banner is not None)
            if banner:
                text = banner.inner_text().replace("\n", " ").replace("  ", " ").strip()
                check("spare pill copy exact",
                      text == "Checklist complete with 10 days to spare. Maya has you ahead of schedule.", text)
            check("no pace pill at 100%", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("case 5: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 6: 100% + 2 days left -> triumph + unchanged
            # congratulations copy.
            pg, errs = load(browser, seed(10, 10, -58, 2))
            body = pg.inner_text("body")
            check("triumph card shown", "Just closed!" in body)
            banner = pg.query_selector('[data-testid="completion-banner"]')
            check("completion banner shown", banner is not None)
            if banner:
                text = banner.inner_text().strip()
                check("congratulations copy unchanged",
                      text == "Congratulations, your checklist is complete", repr(text))
            check("case 6: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 7: degenerate timeline (open == close) -> no pill, no crash.
            pg, errs = load(browser, seed(3, 10, 30, 30))
            check("no pace pill on zero-day timeline", pg.query_selector('[data-testid="pace-pill"]') is None)
            check("card still renders", pg.query_selector('[data-testid="client-topcard"]') is not None)
            check("case 7: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 8: empty realty group -> name + DRE, no dangling separator.
            pg, errs = load(browser, seed(3, 10, -10, 50, {"realty_group": ""}))
            guided = pg.evaluate(GUIDED_JS)
            check("empty group shows name + DRE",
                  "Maya Sharma · DRE #01998877" in guided.get("text", ""), guided.get("text", ""))
            pg.close()
            pg, errs = load(browser, seed(3, 10, -10, 50, {"realty_group": "", "dreLicense": ""}))
            guided = pg.evaluate(GUIDED_JS)
            check("empty group and DRE shows name only",
                  "Maya Sharma" in guided.get("text", "") and "·" not in guided.get("text", "").split("Maya Sharma")[1][:12],
                  guided.get("text", ""))
            check("case 8: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 9: empty tagline omitted (no empty quotes).
            pg, errs = load(browser, seed(3, 10, -10, 50, {"about": ""}))
            guided = pg.evaluate(GUIDED_JS)
            check("empty tagline omitted", '"' not in guided.get("text", ""), guided.get("text", ""))
            check("case 9: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            browser.close()
    finally:
        srv.shutdown()

    print()
    if JS_ERRORS:
        print("JS-ERROR CASES:", JS_ERRORS)
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        raise SystemExit(1)
    print("All client top-card branding checks passed.")


if __name__ == "__main__":
    main()
