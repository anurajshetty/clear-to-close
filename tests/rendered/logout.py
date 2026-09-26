"""logout — quiet "Log out" row regression (Anuraj, Sept 26, 2026).

  - The "Log out" row is visible on the realtor profile, directly below
    "Change password", with the same quiet styling (no confirmation).
  - Tapping it signs out: the Supabase sign-out call is made, the session
    is gone, and the login screen appears.
  - Persisted session/onboarding state is cleared (the remembered device
    role stays so the boot router keeps sending a signed-out realtor to
    the login screen — clearing it would funnel them into sign-up).
  - A cold boot at a protected route (the deal list) after logout lands
    on the login screen, never inside the app. The root layout's
    SIGNED_OUT listener does not race the explicit navigation (no
    ?expired=1 redirect on a deliberate logout).

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
PORT = int(os.environ.get("TEST_PORT", "8924"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

FAILS = []
JS_ERRORS = []
LOGOUT_CALLS = []


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

    def flogout(route):
        LOGOUT_CALLS.append(route.request.url.split("?")[0])
        route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*"})

    pg.route("**/auth/v1/logout*", flogout)

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


ORDER_JS = """() => {
  const els = [...document.querySelectorAll('*')];
  const has = (t) => els.some(e =>
    e.children.length === 0 && (e.textContent || '').trim() === t);
  const ys = (t) => {
    const e = els.find(x => x.children.length === 0 && (x.textContent || '').trim() === t);
    return e ? e.getBoundingClientRect().y : -1;
  };
  return { hasPw: has('Change password'), hasLogout: has('Log out'),
           yPw: ys('Change password'), yLogout: ys('Log out') };
}"""


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
            pg.get_by_text("I'm a Realtor").click()
            pg.wait_for_timeout(400)
            pg.get_by_text("Continue", exact=True).click()
            pg.wait_for_timeout(1200)
            ins = pg.locator("input")
            ins.nth(0).fill("Rita Realtor")
            ins.nth(1).fill("rita@example.com")
            ins.nth(2).fill("longenoughpassword")
            pg.get_by_text("Create account", exact=True).click()
            pg.get_by_text("Skip for now").wait_for(timeout=12000)
            pg.get_by_text("Skip for now").click()
            pg.get_by_text("No escrows yet").wait_for(timeout=12000)
            pg.wait_for_timeout(600)

            pg.get_by_label("Your profile").click()
            pg.get_by_text("Update your profile").wait_for(timeout=8000)
            pg.wait_for_timeout(600)

            # 1) Quiet row, directly below "Change password".
            o = pg.evaluate(ORDER_JS)
            check("'Change password' row present", o["hasPw"])
            check("'Log out' row present", o["hasLogout"])
            check("'Log out' sits directly below 'Change password'",
                  o["hasPw"] and o["hasLogout"] and o["yLogout"] > o["yPw"],
                  str(o))

            # 2) Tap -> Supabase sign-out called, login screen appears.
            pg.get_by_test_id("logout-row").click()
            pg.get_by_text("Welcome back").wait_for(timeout=10000)
            pg.wait_for_timeout(800)
            check("Supabase sign-out called", len(LOGOUT_CALLS) >= 1,
                  str(LOGOUT_CALLS))
            check("login screen shown after logout",
                  pg.get_by_text("Log in to pick up where you left off.").count() > 0)
            check("no mid-session-expiry redirect on a deliberate logout",
                  "expired=1" not in pg.url, pg.url)

            # 3) Persisted session/onboarding state cleared; session gone.
            keys = pg.evaluate("() => Object.keys(localStorage)")
            check("no Supabase session left in storage",
                  not any(k.startswith("sb-") for k in keys),
                  str([k for k in keys if k.startswith('sb-')]))
            check("profile-skipped flag cleared",
                  "ctc:profileskipped" not in keys, str(keys))
            check("remembered device role kept (boot -> login, not sign-up)",
                  "ctc:role" in keys, str(keys))

            # 4) Cold boot at the protected deal list -> login, never inside.
            pg.goto(BASE)
            pg.wait_for_timeout(4000)
            check("protected route redirects to login after logout",
                  pg.url.rstrip("/").endswith("/login"), pg.url)
            check("deal list not reachable without signing in",
                  pg.get_by_text("No escrows yet").count() == 0)

            b.close()
    finally:
        srv.shutdown()

    print("\n----- logout:", "FAIL" if FAILS or JS_ERRORS else "PASS", "-----")
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
