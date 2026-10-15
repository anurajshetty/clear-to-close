"""client_home_celebration — at 100% the share + review cards sit at the
TOP of the client home, on solid completion gold (Anuraj, Oct 14, 2026).

Rendered-outcome guard: seeds a local client escrow and asserts, in the
real DOM at phone size —
  * order: share-profile-card above review-links-card above
    latest-from-card above the bottom triumph section;
  * treatment: BOTH cards compute to the solid gold background (#E3B95C,
    the 100% ring / timeline gold); the share action reads
    "Refer {First} to friends & family";
  * the "or" appears between the review tiles only when BOTH links are
    set (one tile = no "or");
  * gates: at 100% with no review links, the review card is absent but
    the share card is present; below 100% both are absent.

Usage: APP_ROOT=<repo> python3 tests/rendered/client_home_celebration.py
Serves APP_ROOT/dist under /clear-to-close/.
"""
import functools
import http.server
import json
import os
import sys
import threading
from datetime import date, timedelta

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8933"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "client_home_celebration")
os.makedirs(OUT, exist_ok=True)

FAILS = []
JS_ERRORS = []
GOLD = "rgb(227, 185, 92)"


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
        return super().do_GET()


def stub_rest(pg):
    # No REST stubs: like the other client harnesses, cloud calls fail and
    # the store falls back to the seeded local data. (Fulfilling [] here
    # would poison get_client_view and the view would never load.)
    pass


def iso(delta_days):
    return (date.today() + timedelta(days=delta_days)).isoformat()


def seed_js(done_count, total, links):
    # links: 'both' | 'google' | 'none'
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": i < done_count,
         "custom": False, "order": i, "completedAt": None}
        for i in range(total)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": iso(-30), "closeDate": iso(-2),
        "buyerSteps": steps, "sellerSteps": [], "status": "open",
        "createdAt": iso(-30),
    }
    profile = {
        "name": "Maya Sharma", "photoUri": None, "about": "I answer my phone.",
        "yearsExperience": "12", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877", "email": "maya@compass.com",
        "realty_group": "Compass Realty", "banner_image": None,
        "googleReviewLink": "https://g.page/r/abc" if links in ("both", "google") else "",
        "realtorComReviewLink": "https://reviews.example.com/maya" if links == "both" else "",
        "reviews": [], "rating": None,
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": "buyer",
            "partyName": "Priya Nair", "deviceId": "test-device-1"}
    return (
        "localStorage.setItem('ctc:escrows', '" + json.dumps([escrow]).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:clientlink', '" + json.dumps(link).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:deviceid', 'test-device-1');"
        "localStorage.setItem('ctc:profile', '" + json.dumps(profile).replace("'", "\\'") + "');"
    )


PROBE_JS = """() => {
  const probe = (id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bg: cs.backgroundColor };
  };
  const shareBtn = document.querySelector('[data-testid="triumph-share"]');
  return {
    share: probe('share-profile-card'),
    review: probe('review-links-card'),
    latest: probe('latest-from-card'),
    triumph: probe('triumph-section'),
    shareBtnText: shareBtn ? shareBtn.textContent.trim() : null,
    referral: !!document.querySelector('[data-testid="triumph-referral"]'),
    orPresent: !!document.querySelector('[data-testid="review-links-or"]'),
  };
}"""


def load(browser, done, total, links):
    pg = browser.new_page(viewport={"width": 390, "height": 844},
                          has_touch=True, is_mobile=True)
    pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
    stub_rest(pg)
    pg.goto(BASE)
    pg.wait_for_timeout(1500)
    pg.evaluate(seed_js(done, total, links))
    pg.goto(BASE + "client/buyer/seed-1")
    pg.wait_for_timeout(4000)
    return pg


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()

            # 100% with both links: order + solid gold + "or" + new label.
            pg = load(b, 5, 5, "both")
            v = pg.evaluate(PROBE_JS)
            check("100%: share card present", v["share"] is not None)
            check("100%: review card present", v["review"] is not None)
            check("100%: referral line present", v["referral"])
            check("100%: action label is the Refer copy",
                  v["shareBtnText"] == "Refer Maya to friends & family", str(v["shareBtnText"]))
            check("100%: 'or' present between the two tiles", v["orPresent"])
            if v["share"] and v["review"] and v["latest"] and v["triumph"]:
                check("100%: order share < review < latest < triumph",
                      v["share"]["top"] < v["review"]["top"] < v["latest"]["top"] < v["triumph"]["top"],
                      str({k: v[k]["top"] for k in ("share", "review", "latest", "triumph")}))
            if v["share"]:
                check("100%: share card solid gold", v["share"]["bg"] == GOLD, v["share"]["bg"])
            if v["review"]:
                check("100%: review card solid gold", v["review"]["bg"] == GOLD, v["review"]["bg"])
            pg.screenshot(path=os.path.join(OUT, "closed-with-links.png"), full_page=True)
            pg.close()

            # 100% with ONE link: review card present, no "or".
            pg = load(b, 5, 5, "google")
            v = pg.evaluate(PROBE_JS)
            check("100% one link: review card present", v["review"] is not None)
            check("100% one link: no 'or'", not v["orPresent"])
            pg.close()

            # 100% without links: share present, review absent.
            pg = load(b, 5, 5, "none")
            v = pg.evaluate(PROBE_JS)
            check("100% no links: share card present", v["share"] is not None)
            check("100% no links: review card absent", v["review"] is None)
            pg.close()

            # Below 100%: both absent.
            pg = load(b, 3, 5, "both")
            v = pg.evaluate(PROBE_JS)
            check("60%: share card absent", v["share"] is None)
            check("60%: review card absent", v["review"] is None)
            check("60%: latest-from still present", v["latest"] is not None)
            pg.close()
            b.close()
    finally:
        srv.shutdown()

    print("\n----- client_home_celebration:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", str(e)[:200])
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
