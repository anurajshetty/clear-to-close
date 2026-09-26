#!/usr/bin/env python3
"""Clear to Close — regression test: single managed profile-photo file (Sept 2026).

Anuraj: every new pick used to leave another file behind in the app's cache.
Now the final downscaled image is copied to ONE fixed managed location,
overwriting the previous photo — exactly one photo file exists at any time.

On web the managed location is the single localStorage key
`ctc:profile-photo` (overwritten per pick; the manipulator's session-scoped
blob: URI is converted to a data URI first).

On REAL built output (390x844), signup profile-creation step:
  - pick photo A -> the single managed key holds A's bytes;
  - pick photo B -> still exactly one managed key (no pile-up);
  - the managed key now holds B's bytes (A is gone);
  - the stored photoUri (avatar img src) points at the B bytes;
  - after saving the profile, the persisted profile photoUri is the B bytes.
  - Zero JS errors.

Usage: python3 tests/rendered/profile_photo_single_file.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: APP_ROOT (repo root), CTC_PORT (default 8926),
CTC_OUT (output dir, default /tmp/ctc-photo-single-file).
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-dragrow")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-photo-single-file")
PORT = int(os.environ.get("CTC_PORT", "8926"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []
PHOTO_KEY = "ctc:profile-photo"


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
            "Access-Control-Allow-Origin": "*", "Content-Type": "application/json",
            "Access-Control-Expose-Headers": "Content-Range"}, json=[])

    pg.route("**/rest/v1/*", fempty)


def make_png(path, rgb):
    from PIL import Image
    Image.new("RGB", (200, 200), rgb).save(path, "PNG")


def pick_photo(pg, label, path):
    with pg.expect_file_chooser() as fc:
        pg.get_by_label(label).click()
    fc.value.set_files(path)
    pg.wait_for_timeout(2000)


def photo_keys(pg):
    return pg.evaluate(
        "() => Object.keys(localStorage).filter("
        "(k) => k.toLowerCase().includes('photo'))")


def managed_value(pg):
    return pg.evaluate(f"() => localStorage.getItem('{PHOTO_KEY}')")


def avatar_src(pg):
    return pg.evaluate(
        """() => {
          const btn = document.querySelector(
            '[aria-label="Add profile photo"], [aria-label="Change profile photo"]');
          if (!btn) return null;
          const img = btn.querySelector('img');
          return img ? img.src : null;
        }""")


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    img_a = os.path.join(OUT, "photo_a.png")
    img_b = os.path.join(OUT, "photo_b.png")
    make_png(img_a, (200, 30, 30))
    make_png(img_b, (30, 30, 200))

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
            pg.get_by_text("I'm a Realtor").click()
            pg.wait_for_timeout(400)
            pg.get_by_text("Continue", exact=True).click()
            pg.wait_for_timeout(1200)
            ins = pg.locator("input")
            ins.nth(0).fill("Rita Realtor")
            ins.nth(1).fill("rita@example.com")
            ins.nth(2).fill("longenoughpassword")
            pg.get_by_text("Create account", exact=True).click()
            pg.get_by_text("Create your profile").wait_for(timeout=12000)
            pg.wait_for_timeout(600)

            # ---- Pick photo A ----
            pick_photo(pg, "Add profile photo", img_a)
            val_a = managed_value(pg)
            check("pick A: single managed key holds the photo",
                  photo_keys(pg) == [PHOTO_KEY] and bool(val_a)
                  and val_a.startswith("data:image/"),
                  f"keys={photo_keys(pg)}, len={len(val_a) if val_a else 0}")

            # ---- Pick photo B: still exactly one file, A is gone ----
            pick_photo(pg, "Change profile photo", img_b)
            val_b = managed_value(pg)
            check("pick B: still exactly one managed photo file (no pile-up)",
                  photo_keys(pg) == [PHOTO_KEY],
                  f"keys={photo_keys(pg)}")
            check("pick B: the A bytes are gone, replaced by B",
                  bool(val_b) and val_b != val_a
                  and val_b.startswith("data:image/"),
                  f"len_b={len(val_b) if val_b else 0}, same_as_a={val_b == val_a}")
            src = avatar_src(pg)
            check("pick B: stored photoUri points at the B file",
                  src == val_b,
                  f"src_len={len(src) if src else 0}")

            # ---- Save the profile: the persisted photoUri is the B bytes ----
            # (the role screen's Continue is still in the stack; the
            # profile-create one is the topmost)
            pg.get_by_role("button", name="Continue").last.click()
            pg.get_by_text("No escrows yet").wait_for(timeout=12000)
            pg.wait_for_timeout(800)
            persisted = pg.evaluate(
                "() => { try { return JSON.parse(localStorage.getItem('ctc:profile') || '{}').photoUri || null; }"
                " catch (e) { return 'unparseable'; } }")
            check("persisted profile photoUri is the B file",
                  persisted == val_b,
                  f"persisted_len={len(persisted) if persisted else 0}")
            check("no photo pile-up keys after save",
                  photo_keys(pg) == [PHOTO_KEY],
                  f"keys={photo_keys(pg)}")
            pg.screenshot(path=os.path.join(OUT, "single-photo-file.png"))

            b.close()
    finally:
        srv.shutdown()

    print("\n----- profile_photo_single_file:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
