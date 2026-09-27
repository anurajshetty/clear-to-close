#!/usr/bin/env python3
"""client_latest — "LATEST FROM {NAME}" card regression
(APPROVED mockup screen 7 updated, Sept 2026).

Guards (real rendered component, 390x844, client buyer view):
  - The card sits directly below the top card and above the checklist.
  - Kicker "LATEST FROM MAYA" (first name, uppercased).
  - Stamped forward action: green check + "Checked off {step} · {time}".
  - Stamped backward action: neutral icon + "Reopened {step} · {time}"
    (honest, no blame).
  - Fallback with no checkoffs: "{Name} opened your escrow · {time}".
  - Old timestamps render as calendar dates; the card is always visible.
  - Zero JS errors in every case.

The relative-time buckets themselves are unit-tested in tests/latest.test.ts.

Usage: APP_ROOT=/home/hatch/workspace/realtor-app-wt-client-topcard \
         python3 tests/rendered/client_latest.py
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
PORT = int(os.environ.get("TEST_PORT", "8931"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"
OUT = os.path.join(ROOT, "tests", "out", "client_latest")
os.makedirs(OUT, exist_ok=True)

FAILS = []

TEAL = "rgb(23, 94, 84)"    # colors.accent #175E54
MUTED = "rgb(138, 129, 117)"  # colors.muted #8A8175


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


def iso_ago(**kwargs):
    return (datetime.datetime.now(datetime.timezone.utc) -
            datetime.timedelta(**kwargs)).isoformat()


def iso_yesterday():
    """Deterministically in the 'Yesterday' bucket at any time of day.

    Exactly 24h old is always on the previous calendar day (and the render
    happens a beat later, so the age is 24h + epsilon, past the <24h
    'hours' bucket). A fixed 'yesterday at noon' seed is NOT deterministic:
    near midnight it is under 24h old and correctly renders as 'Xh ago'.
    """
    return iso_ago(hours=24)


def seed(last_action=None, completed_at=None, created_ago_days=5, role="buyer"):
    steps = [
        {"id": f"s{i}", "title": f"Step {i + 1:02d}", "subtitle": "", "done": i < 3,
         "custom": False, "order": i,
         "completedAt": completed_at if (completed_at and i == 2) else None}
        for i in range(10)
    ]
    escrow = {
        "id": "seed-1", "address": "26207 Benito Ct", "city": "Santa Clarita",
        "side": "buy" if role == "buyer" else "sell", "buyerName": "Priya Nair",
        "sellerName": None,
        "openDate": "2026-09-01",
        "closeDate": (datetime.date.today() +
                      datetime.timedelta(days=60)).isoformat(),
        "buyerSteps": steps if role == "buyer" else [],
        "sellerSteps": steps if role == "seller" else [],
        "status": "open",
        "createdAt": iso_ago(days=created_ago_days),
    }
    if last_action is not None:
        escrow["lastAction"] = last_action
    profile = {
        "name": "Maya Sharma", "photoUri": None, "about": "I answer my phone.",
        "yearsExperience": "9", "dealsClosed": "240", "areasServed": "Santa Clarita",
        "phone": "555-0100", "dreLicense": "01998877",
    }
    link = {"linkId": "link-1", "escrowId": "seed-1", "role": role,
            "partyName": "Priya Nair", "deviceId": "test-device-1"}
    js = (
        "localStorage.setItem('ctc:escrows', '" + json.dumps([escrow]).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:clientlink', '" + json.dumps(link).replace("'", "\\'") + "');"
        "localStorage.setItem('ctc:deviceid', 'test-device-1');"
        "localStorage.setItem('ctc:profile', '" + json.dumps(profile).replace("'", "\\'") + "');"
    )
    return js


GEOMETRY_JS = """() => {
  const r = (t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom };
  };
  return { card: r('latest-from-card'), top: r('client-topcard'),
           row: r('client-step-row') };
}"""

ICON_JS = """() => {
  const el = document.querySelector('[data-testid="latest-from-icon"]');
  if (!el) return null;
  return { bg: getComputedStyle(el).backgroundColor,
           glyph: el.innerText.trim(),
           label: el.getAttribute('aria-label') };
}"""


def load(browser, seed_js, role="buyer"):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(1500)
    pg.evaluate(seed_js)
    pg.goto(BASE + f"client/{role}/seed-1")
    pg.wait_for_timeout(4000)
    return pg, errs


def main():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # --- Case 1: stamped forward action -------------------------
            pg, errs = load(browser, seed(
                last_action={"kind": "checked", "stepTitle": "Home inspection",
                             "at": iso_ago(hours=2)}))
            body = pg.inner_text('[data-testid="latest-from-body"]')
            kicker = pg.inner_text('[data-testid="latest-from-kicker"]')
            check("kicker", kicker.strip() == "LATEST FROM MAYA", repr(kicker))
            check("checked-off body",
                  "Checked off" in body and "Home inspection" in body and "2h ago" in body,
                  repr(body))
            icon = pg.evaluate(ICON_JS)
            check("forward icon is the teal check",
                  icon and icon["bg"] == TEAL and icon["glyph"] == "\u2713",
                  str(icon))
            geo = pg.evaluate(GEOMETRY_JS)
            check("card below the top card",
                  geo["card"] and geo["top"] and geo["card"]["top"] >= geo["top"]["bottom"] - 1,
                  str(geo))
            check("card above the checklist",
                  geo["card"] and geo["row"] and geo["card"]["bottom"] <= geo["row"]["top"] + 1,
                  str(geo))
            pg.screenshot(path=os.path.join(OUT, "latest-checked.png"))
            check("case 1: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 2: stamped backward action ------------------------
            pg, errs = load(browser, seed(
                last_action={"kind": "reopened", "stepTitle": "Appraisal",
                             "at": iso_ago(minutes=25)}))
            body = pg.inner_text('[data-testid="latest-from-body"]')
            check("reopened body is neutral",
                  "Reopened" in body and "Appraisal" in body and "25m ago" in body
                  and "Checked off" not in body,
                  repr(body))
            icon = pg.evaluate(ICON_JS)
            check("backward icon is neutral, not the teal check",
                  icon and icon["bg"] == MUTED and icon["glyph"] == "\u21ba",
                  str(icon))
            check("case 2: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 3: fallback — no checkoffs yet --------------------
            pg, errs = load(browser, seed(created_ago_days=5))
            body = pg.inner_text('[data-testid="latest-from-body"]')
            check("fallback body",
                  "Maya opened your escrow" in body and "5d ago" in body,
                  repr(body))
            check("case 3: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 4: derived from completed_at (pre-stamp escrow) ---
            pg, errs = load(browser, seed(completed_at=iso_yesterday()))
            body = pg.inner_text('[data-testid="latest-from-body"]')
            check("derived checkoff body",
                  "Checked off" in body and "Step 03" in body and "Yesterday" in body,
                  repr(body))
            check("case 4: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            # --- Case 5: seller screen smoke ----------------------------
            pg, errs = load(browser, seed(
                last_action={"kind": "checked", "stepTitle": "Home inspection",
                             "at": iso_ago(hours=2)}), role="seller")
            check("seller card renders",
                  pg.query_selector('[data-testid="latest-from-card"]') is not None)
            check("seller kicker",
                  pg.inner_text('[data-testid="latest-from-kicker"]').strip() == "LATEST FROM MAYA")
            check("case 5: zero JS errors", not errs, "; ".join(errs[:3]))
            pg.close()

            browser.close()
    finally:
        srv.shutdown()

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        raise SystemExit(1)
    print("All client latest-from checks passed.")


if __name__ == "__main__":
    main()
