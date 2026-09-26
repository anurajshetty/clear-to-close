"""profile_photo — photo-refresh + signup + size-cap regression (Anuraj, Sept 26, 2026).

1. Signup profile-creation step (step 2): pick a photo -> the photo shows
   IMMEDIATELY in the form (asserted by the actual <img> source, not an
   initial) -> Continue -> the deal-list avatar shows the picked photo URI.
2. Edit-profile "Change photo": pick a new photo -> the form shows the new
   image immediately -> Save -> the deal-list avatar shows the LATEST photo
   URI (replaces the previous one), never a stale initial.
3. Size cap: picking a 4000px image is automatically downscaled at pick time
   (long edge <= 1024px, JPEG ~0.8, <= ~1MB) with no user-facing error.

Suite: 390x844. Zero JS errors.
"""
import http.server
import functools
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
PORT = int(os.environ.get("TEST_PORT", "8922"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "profile_photo")
os.makedirs(OUT, exist_ok=True)

# Self-contained photo fixtures: regenerate if /tmp was wiped between runs.
def _ensure_fixtures():
    from PIL import Image
    fixtures = {
        "/tmp/photo_red.png": ("red", (800, 600)),
        "/tmp/photo_blue.png": ("blue", (800, 600)),
        "/tmp/photo_large.png": ("green", (4000, 3000)),
    }
    for path, (color, size) in fixtures.items():
        if not os.path.isfile(path):
            Image.new("RGB", size, color).save(path, "PNG")

_ensure_fixtures()

FAILS = []
JS_ERRORS = []


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


PHOTO_BTN_JS = """() => {
  const btn = document.querySelector(
    '[aria-label="Add profile photo"], [aria-label="Change profile photo"]');
  if (!btn) return { found: false };
  const img = btn.querySelector('img');
  return { found: true, hasImg: !!img, src: img ? img.src : null,
           text: (btn.textContent || '').trim().slice(0, 12) };
}"""

AVATAR_JS = """() => {
  const btn = document.querySelector('[aria-label="Your profile"]');
  if (!btn) return { found: false };
  const img = btn.querySelector('img');
  return { found: true, hasImg: !!img, src: img ? img.src : null,
           text: (btn.textContent || '').trim().slice(0, 10) };
}"""

IMG_INFO_JS = """(src) => new Promise((resolve) => {
  const im = new Image();
  im.onload = async () => {
    let bytes = -1;
    try {
      const r = await fetch(src);
      const b = await r.blob();
      bytes = b.size;
    } catch (e) { /* ignore */ }
    resolve({ w: im.naturalWidth, h: im.naturalHeight, bytes });
  };
  im.onerror = () => resolve({ error: true });
  im.src = src;
})"""


def pick_photo(pg, label, path):
    with pg.expect_file_chooser() as fc:
        pg.get_by_label(label).click()
    fc.value.set_files(path)
    pg.wait_for_timeout(1500)


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
            stub_auth_and_db(pg)
            pg.goto(BASE)
            pg.wait_for_timeout(3000)

            # ---- 1. Signup -> profile-creation step (do NOT skip) ----
            pg.get_by_text("I'm a Realtor").click()
            pg.wait_for_timeout(400)
            pg.get_by_role("button", name="Continue").click()
            pg.wait_for_timeout(1200)
            ins = pg.locator("input")
            ins.nth(0).fill("Rita Realtor")
            ins.nth(1).fill("rita@example.com")
            ins.nth(2).fill("longenoughpassword")
            pg.get_by_text("Create account", exact=True).click()
            pg.get_by_text("Create your profile").wait_for(timeout=12000)
            pg.wait_for_timeout(600)

            pick_photo(pg, "Add profile photo", "/tmp/photo_red.png")
            st = pg.evaluate(PHOTO_BTN_JS)
            check("signup: photo shows IMMEDIATELY in the profile-creation step",
                  st["found"] and st["hasImg"] and bool(st["src"]),
                  str({k: (str(v)[:40] if k == "src" else v) for k, v in st.items()}))
            red_src = st.get("src")

            pg.get_by_placeholder("e.g. Maya Chen").fill("Rita Realtor")
            pg.get_by_role("button", name="Continue").click()
            pg.get_by_text("No escrows yet").wait_for(timeout=12000)
            pg.wait_for_timeout(800)

            av = pg.evaluate(AVATAR_JS)
            check("signup: deal-list avatar shows the picked photo (by image source)",
                  av["found"] and av["hasImg"] and bool(av["src"]),
                  str({k: (str(v)[:40] if k == "src" else v) for k, v in av.items()}))
            stored = pg.evaluate(
                "() => (JSON.parse(localStorage.getItem('ctc:profile') || '{}').photoUri || '')")
            check("signup: stored photoUri persisted through signup completion",
                  bool(stored), stored[:40])

            # ---- 2. Edit profile: change to BLUE -> latest wins ----
            pg.get_by_label("Your profile").click()
            pg.get_by_text("Update your profile").wait_for(timeout=8000)
            pg.wait_for_timeout(600)
            st2 = pg.evaluate(PHOTO_BTN_JS)
            check("edit: reopened form shows the saved photo (not initials)",
                  st2["found"] and st2["hasImg"] and bool(st2["src"]))

            pick_photo(pg, "Change profile photo", "/tmp/photo_blue.png")
            st3 = pg.evaluate(PHOTO_BTN_JS)
            check("edit: changed photo shows IMMEDIATELY in the form",
                  st3["found"] and st3["hasImg"] and bool(st3["src"]))
            blue_src = st3.get("src")
            check("edit: new pick replaced the previous photo",
                  blue_src and blue_src != red_src,
                  f"red={str(red_src)[:30]} blue={str(blue_src)[:30]}")

            pg.get_by_text("Save", exact=True).click()
            pg.get_by_text("No escrows yet").wait_for(timeout=8000)
            pg.wait_for_timeout(800)
            av2 = pg.evaluate(AVATAR_JS)
            check("edit: deal-list avatar shows the LATEST photo after save",
                  av2["found"] and av2["hasImg"] and av2["src"] == blue_src,
                  f"avatar={str(av2.get('src'))[:30]} expected={str(blue_src)[:30]}")

            # ---- 3. Size cap: 4000px image -> <= 1024 long edge, <= ~1MB ----
            pg.get_by_label("Your profile").click()
            pg.get_by_text("Update your profile").wait_for(timeout=8000)
            pg.wait_for_timeout(600)
            pick_photo(pg, "Change profile photo", "/tmp/photo_large.png")
            pg.wait_for_timeout(3000)
            st4 = pg.evaluate(PHOTO_BTN_JS)
            check("size cap: large photo still picked with no user-facing error",
                  st4["found"] and st4["hasImg"] and bool(st4["src"]))
            if st4.get("src"):
                info = pg.evaluate(IMG_INFO_JS, st4["src"])
                long_edge = max(info.get("w", 0), info.get("h", 0))
                check("size cap: long edge <= 1024px",
                      0 < long_edge <= 1024, str(info))
                check("size cap: result <= ~1MB",
                      0 < info.get("bytes", 0) <= 1048576, str(info))
                pg.screenshot(path=os.path.join(OUT, "large-photo-capped.png"))
            else:
                check("size cap: long edge <= 1024px", False, "no image rendered")
                check("size cap: result <= ~1MB", False, "no image rendered")

            # No quiet inline error should be showing for a processable image.
            check("size cap: no inline photo error shown",
                  pg.get_by_text("Couldn’t use that photo. Try a different one.").count() == 0)

            b.close()
    finally:
        srv.shutdown()

    print("\n----- profile_photo:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
