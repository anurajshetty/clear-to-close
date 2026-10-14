"""profile_photo_circle — the profile photo must render as a CIRCLE on web
(Anuraj, Oct 14, 2026: his annotated screenshot showed the in-app profile
photo rendering as a rectangle on web Safari, despite borderRadius +
overflow hidden on the Image style — RNW Image does not visually clip).

Rendered-outcome guard (standing visual-fix rule: assert what the user
SEES, not the implementation): a solid-red photo is rendered on both
profile variants; the test screenshots the page at phone size and samples
pixels — the photo CENTER must be red, the four CORNERS of the photo's
bounding box must NOT be red (the background shows through the circular
clip). A rectangular render fails the corner checks.

Also asserts the Oct 14 display change: no "Years of experience" section
on the in-app profile, no "Years in" stat on the public profile, and the
"Client rating" stat still present on the public profile.

Usage: APP_ROOT=<repo> python3 tests/rendered/profile_photo_circle.py
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
PORT = int(os.environ.get("TEST_PORT", "8931"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "profile_photo_circle")
os.makedirs(OUT, exist_ok=True)
RED_URL = f"http://127.0.0.1:{PORT}/red.png"

FAILS = []
JS_ERRORS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name + (f" [{detail}]" if detail else ""))


def _ensure_red_png():
    from PIL import Image
    Image.new("RGB", (400, 400), (226, 32, 32)).save("/tmp/ctc_red.png", "PNG")


_ensure_red_png()


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        raw = self.path
        path = raw.split("?", 1)[0]
        qs = raw[len(path):]
        if path == "/red.png":
            with open("/tmp/ctc_red.png", "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
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
    # Catch-all FIRST (Playwright: the last registered matching route wins).
    def fempty(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                "Access-Control-Expose-Headers": "Content-Range"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
            "Access-Control-Expose-Headers": "Content-Range"}, json=[])

    pg.route("**/rest/v1/**", fempty)

    def fprofile(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization"})
            return
        route.fulfill(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"}, json={
                "ok": True,
                "profile": {
                    "name": "Maya Sharma",
                    "photo_url": RED_URL,
                    "about": "I answer my phone.",
                    "years_experience": "12",
                    "areas_served": "Santa Clarita",
                    "phone": "555-0100",
                    "dre_license": "01998877",
                    "realty_group": "Compass Realty",
                    "reviews": [{"id": "r1", "clientName": "Priya N.",
                                 "stars": 5, "text": "Wonderful."}],
                    "rating": 4.9,
                }})

    pg.route("**/rest/v1/rpc/get_public_profile*", fprofile)


def iso(delta_days):
    return (date.today() + timedelta(days=delta_days)).isoformat()


def seed_js():
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy", "buyerName": "Priya Nair", "sellerName": None,
        "openDate": iso(-10), "closeDate": iso(20),
        "buyerSteps": [], "sellerSteps": [], "status": "open",
        "createdAt": iso(-10),
    }
    profile = {
        "name": "Maya Sharma", "photoUri": RED_URL, "about": "I answer my phone.",
        "yearsExperience": "12", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877",
        "realty_group": "Compass Realty", "banner_image": None,
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": "buyer",
            "partyName": "Priya Nair", "deviceId": "test-device-1"}
    return (
        "localStorage.setItem('ctc:escrows', '" + json.dumps([escrow]).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:clientlink', '" + json.dumps(link).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:deviceid', 'test-device-1');"
        "localStorage.setItem('ctc:profile', '" + json.dumps(profile).replace("'", "\\'") + "');"
    )


def is_red(px):
    r, g, b = px[:3]
    return r > 150 and g < 110 and b < 110


def circle_verdict(pg, tag):
    """Screenshot, sample the photo box: center red + corners not red."""
    from PIL import Image
    loc = pg.locator('[data-testid="realtor-profile-photo"]')
    loc.wait_for(state="visible", timeout=15000)
    pg.wait_for_timeout(1200)  # let the <img> actually paint
    box = loc.bounding_box()
    shot = os.path.join(OUT, f"{tag}.png")
    pg.screenshot(path=shot)
    img = Image.open(shot).convert("RGB")
    x, y, w, h = box["x"], box["y"], box["width"], box["height"]
    cx, cy = int(x + w / 2), int(y + h / 2)
    inset = 5
    corners = [
        (int(x + inset), int(y + inset)),
        (int(x + w - inset), int(y + inset)),
        (int(x + inset), int(y + h - inset)),
        (int(x + w - inset), int(y + h - inset)),
    ]
    center_red = is_red(img.getpixel((cx, cy)))
    corner_reds = [is_red(img.getpixel(c)) for c in corners]
    return {"w": w, "h": h, "center_red": center_red, "corner_reds": corner_reds,
            "box": (x, y, w, h)}


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()

            # ---------- in-app variant (140px, the reported surface) ----------
            pg = b.new_page(viewport={"width": 390, "height": 844},
                            has_touch=True, is_mobile=True)
            pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
            stub_rest(pg)
            pg.goto(BASE)
            pg.wait_for_timeout(1500)
            pg.evaluate(seed_js())
            pg.goto(BASE + "realtor-profile?escrowId=seed-1")
            v = circle_verdict(pg, "inapp")
            check("in-app: photo box is 140x140", abs(v["w"] - 140) < 2 and abs(v["h"] - 140) < 2,
                  str(v["box"]))
            check("in-app: photo center is the photo color", v["center_red"])
            check("in-app: photo corners are clipped (circle, not rectangle)",
                  not any(v["corner_reds"]), f"corners red: {v['corner_reds']}")
            body = pg.inner_text("body").lower()
            check("in-app: 'Years of experience' section is gone",
                  "years of experience" not in body)
            pg.close()

            # ---------- public variant (96px) ----------
            pg = b.new_page(viewport={"width": 390, "height": 844},
                            has_touch=True, is_mobile=True)
            pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
            stub_rest(pg)
            pg.goto(BASE + "realtor/u1")
            v = circle_verdict(pg, "public")
            check("public: photo box is 96x96", abs(v["w"] - 96) < 2 and abs(v["h"] - 96) < 2,
                  str(v["box"]))
            check("public: photo center is the photo color", v["center_red"])
            check("public: photo corners are clipped (circle, not rectangle)",
                  not any(v["corner_reds"]), f"corners red: {v['corner_reds']}")
            body = pg.inner_text("body").lower()
            check("public: 'Years in' stat is gone", "years in" not in body)
            check("public: 'Client rating' stat is kept", "client rating" in body)
            pg.close()
            b.close()
    finally:
        srv.shutdown()

    print("\n----- profile_photo_circle:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", str(e)[:200])
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
