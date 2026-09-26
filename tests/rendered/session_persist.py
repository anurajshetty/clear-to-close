"""session_persist — web session survives refresh (Anuraj, Sept 26, 2026).

Reverses the Sept 25 "web = sign-in screen on every return" decision: the
Supabase auth session now persists in localStorage on web.

  1. Sign in on web -> the session is written to localStorage (an `sb-` key).
  2. Reload -> still signed in, back on the deal list ("Escrows"), NOT on
     the login screen. No re-login.
  3. Log out (quiet row) -> session cleared from localStorage.
  4. Reload -> the login screen shows ("Welcome back"), never the deal list.

The session ends ONLY on Log out (or the browser/incognito session ending,
which wipes localStorage by itself — not simulated here).

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
OUT = os.environ.get("CTC_SESSION_OUT", "/tmp/ctc-session-persist")
PORT = int(os.environ.get("TEST_PORT", "8927"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
LOGIN = BASE + "login"

FAILS = []
JS_ERRORS = []
LOGOUT_CALLS = []

UID = "test-uid-1"
PROFILE_ROW = {
    "name": "Rita Realtor",
    "photo_url": None,
    "about": "About Rita",
    "years_experience": "8",
    "deals_closed": "42",
    "areas_served": "Valencia",
    "phone": "555-0100",
    "dre_license": "DRE-123",
}
SESSION_JSON = {
    "access_token": "fake-jwt",
    "token_type": "bearer",
    "expires_in": 3600,
    "refresh_token": "fake-refresh",
    "user": {"id": UID, "email": "rita@example.com", "user_metadata": {}},
}
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization, Prefer",
    "Access-Control-Expose-Headers": "Content-Range",
}


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


def stub(pg):
    def ftoken(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        # login AND background token refresh both land here
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                      json=SESSION_JSON)

    def flogout(route):
        LOGOUT_CALLS.append(route.request.url.split("?")[0])
        route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*"})

    def fprofiles(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        if route.request.method == "GET":
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"},
                          json=[PROFILE_ROW])
        else:
            route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, json={})

    def fempty(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=CORS)
            return
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, json=[])

    pg.route("**/auth/v1/token*", ftoken)
    pg.route("**/auth/v1/logout*", flogout)
    # Catch-all first: the LAST matching route wins, so the specific
    # profiles stub must be registered after it.
    pg.route("**/rest/v1/*", fempty)
    pg.route("**/rest/v1/realtor_profiles*", fprofiles)


def sb_keys(pg):
    return pg.evaluate("() => Object.keys(localStorage).filter(k => k.startsWith('sb-'))")


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 390, "height": 844},
                            has_touch=True, is_mobile=True)
            pg.on("pageerror", lambda e: JS_ERRORS.append(str(e)))
            pg.on("console", lambda m: JS_ERRORS.append(m.text) if m.type == "error" else None)
            stub(pg)
            pg.add_init_script("localStorage.setItem('ctc:role', 'realtor');")

            # 1) Sign in.
            pg.goto(LOGIN)
            pg.wait_for_timeout(2500)
            ins = pg.locator("input")
            ins.nth(0).fill("rita@example.com")
            ins.nth(1).fill("longenoughpassword")
            pg.get_by_role("button", name="Log in").click()
            pg.get_by_text("Escrows", exact=True).wait_for(timeout=15000)
            pg.wait_for_timeout(800)
            keys = sb_keys(pg)
            check("session persisted to localStorage on sign-in", len(keys) >= 1, str(keys))
            pg.screenshot(path=f"{OUT}/1-signed-in.png")

            # 2) Reload -> still signed in, back on the deal list.
            pg.reload()
            pg.get_by_text("Escrows", exact=True).wait_for(timeout=15000)
            pg.wait_for_timeout(800)
            check("reload keeps the realtor signed in (deal list, not login)",
                  pg.get_by_text("Escrows", exact=True).count() > 0)
            check("login screen is NOT shown after reload",
                  pg.get_by_text("Welcome back").count() == 0, pg.url)
            pg.screenshot(path=f"{OUT}/2-after-reload.png")

            # 3) Log out via the quiet row -> session cleared.
            pg.get_by_label("Your profile").click()
            pg.get_by_text("Update your profile", exact=True).wait_for(timeout=8000)
            pg.get_by_test_id("logout-row").click()
            pg.get_by_text("Welcome back").wait_for(timeout=10000)
            pg.wait_for_timeout(800)
            check("Supabase sign-out called", len(LOGOUT_CALLS) >= 1, str(LOGOUT_CALLS))
            check("session cleared from localStorage on logout",
                  sb_keys(pg) == [], str(sb_keys(pg)))

            # 4) Reload -> login screen, never the deal list.
            pg.reload()
            pg.get_by_text("Welcome back").wait_for(timeout=15000)
            pg.wait_for_timeout(800)
            check("login screen shown after logout + reload",
                  pg.get_by_text("Log in to pick up where you left off.").count() > 0)
            check("deal list not reachable without signing in",
                  pg.get_by_text("Escrows", exact=True).count() == 0, pg.url)
            pg.screenshot(path=f"{OUT}/4-logged-out-reload.png")

            b.close()
    finally:
        srv.shutdown()

    print("\n----- session_persist:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
    for f in FAILS:
        print("  FAIL:", f)
    for e in JS_ERRORS:
        print("  JSERROR:", str(e)[:200])
    sys.exit(1 if (FAILS or JS_ERRORS) else 0)


if __name__ == "__main__":
    main()
