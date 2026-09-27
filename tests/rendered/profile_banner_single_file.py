#!/usr/bin/env python3
"""Clear to Close — regression test: single managed banner-image file (Sept 2026).

Anuraj's storage rule: both the profile picture and the banner image must
use single-file overwrite. A new upload replaces the old file at the same
fixed key/path — no versioned copies, no orphaned files accumulating.

On web the managed locations are the single localStorage keys
`ctc:profile-photo` (photo slot) and `ctc:profile-banner` (banner slot),
each overwritten per pick (the manipulator's session-scoped blob: URI is
converted to a data URI first).

On REAL built output (390x844), signup profile-creation step:
  - pick banner A -> exactly one banner key holds A's bytes;
  - pick banner B -> still exactly one banner key (no pile-up), A bytes gone;
  - the banner img src points at the B bytes;
  - the photo slot is untouched: still exactly one photo key (the slots are
    separate files — the banner never shares the photo's file);
  - after saving the profile, the persisted banner_image is the B bytes.
  - Zero JS errors.

Usage: python3 tests/rendered/profile_banner_single_file.py  (run from the repo root)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
Env overrides: APP_ROOT (repo root), CTC_PORT (default 8927),
CTC_OUT (output dir, default /tmp/ctc-banner-single-file).
"""
import http.server
import functools
import os
import threading
import sys

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("APP_ROOT", "/home/hatch/workspace/realtor-app-wt-realty-group")
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-banner-single-file")
PORT = int(os.environ.get("CTC_PORT", "8927"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []
PHOTO_KEY = "ctc:profile-photo"
BANNER_KEY = "ctc:profile-banner"


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


def make_png(path, rgb):
    from PIL import Image
    Image.new("RGB", (400, 200), rgb).save(path, "PNG")


def pick_image(pg, label, path):
    with pg.expect_file_chooser() as fc:
        pg.get_by_label(label).click()
    fc.value.set_files(path)
    pg.wait_for_timeout(2000)


def slot_keys(pg, key):
    return pg.evaluate(
        f"() => Object.keys(localStorage).filter((k) => k === '{key}')")


def slot_value(pg, key):
    return pg.evaluate(f"() => localStorage.getItem('{key}')")


def img_src_for(pg, *labels):
    sel = ", ".join(f'[aria-label="{lb}"]' for lb in labels)
    return pg.evaluate(
        """() => {
          const btn = document.querySelector('%s');
          if (!btn) return null;
          const img = btn.querySelector('img');
          return img ? img.src : null;
        }""" % sel.replace("'", "\\'"))


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    banner_a = os.path.join(OUT, "banner_a.png")
    banner_b = os.path.join(OUT, "banner_b.png")
    photo_a = os.path.join(OUT, "photo_a.png")
    make_png(banner_a, (200, 30, 30))
    make_png(banner_b, (30, 30, 200))
    make_png(photo_a, (30, 200, 30))

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

            # ---- Pick banner A: exactly one banner file ----
            pick_image(pg, "Add banner image", banner_a)
            val_a = slot_value(pg, BANNER_KEY)
            check("pick A: single managed banner key holds the image",
                  slot_keys(pg, BANNER_KEY) == [BANNER_KEY] and bool(val_a)
                  and val_a.startswith("data:image/"),
                  f"keys={slot_keys(pg, BANNER_KEY)}, len={len(val_a) if val_a else 0}")

            # ---- Pick banner B: still exactly one file, A is gone ----
            pick_image(pg, "Change banner image", banner_b)
            val_b = slot_value(pg, BANNER_KEY)
            check("pick B: still exactly one managed banner file (no pile-up)",
                  slot_keys(pg, BANNER_KEY) == [BANNER_KEY],
                  f"keys={slot_keys(pg, BANNER_KEY)}")
            check("pick B: the A bytes are gone, replaced by B",
                  bool(val_b) and val_b != val_a
                  and val_b.startswith("data:image/"),
                  f"len_b={len(val_b) if val_b else 0}, same_as_a={val_b == val_a}")
            src = img_src_for(pg, "Add banner image", "Change banner image")
            check("pick B: stored banner_image points at the B file",
                  src == val_b,
                  f"src_len={len(src) if src else 0}")

            # ---- Photo slot: separate file, also single-overwrite ----
            pick_image(pg, "Add profile photo", photo_a)
            photo_val = slot_value(pg, PHOTO_KEY)
            check("photo slot: still its own single managed file",
                  slot_keys(pg, PHOTO_KEY) == [PHOTO_KEY] and bool(photo_val)
                  and photo_val.startswith("data:image/"),
                  f"keys={slot_keys(pg, PHOTO_KEY)}")
            check("slots are separate: banner bytes != photo bytes",
                  bool(val_b) and bool(photo_val) and val_b != photo_val)

            # ---- Save the profile: persisted banner_image is the B bytes ----
            pg.get_by_role("button", name="Continue").last.click()
            pg.get_by_text("No escrows yet").wait_for(timeout=12000)
            pg.wait_for_timeout(800)
            persisted = pg.evaluate(
                "() => { try { return JSON.parse(localStorage.getItem('ctc:profile') || '{}'); }"
                " catch (e) { return {}; } }")
            check("persisted profile banner_image is the B file",
                  persisted.get("banner_image") == val_b,
                  f"persisted_len={len(persisted.get('banner_image') or '')}")
            check("no banner pile-up keys after save",
                  slot_keys(pg, BANNER_KEY) == [BANNER_KEY],
                  f"keys={slot_keys(pg, BANNER_KEY)}")
            check("no photo pile-up keys after save",
                  slot_keys(pg, PHOTO_KEY) == [PHOTO_KEY],
                  f"keys={slot_keys(pg, PHOTO_KEY)}")
            pg.screenshot(path=os.path.join(OUT, "single-banner-file.png"))

            b.close()
    finally:
        srv.shutdown()

    print("\n----- profile_banner_single_file:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
