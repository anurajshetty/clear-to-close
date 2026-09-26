#!/usr/bin/env python3
"""Clear to Close — client top-card render test (reworked top card, Sept 26).

Drives the REAL built output at 390x844 (deep-linked client views with a
seeded device link) and asserts the visible outcomes of the reworked client
top card (mockup 01, devices 4/5/11/14):
  - top row: bold "Hi {name}" + "Your purchase"/"Your sale" + non-bold
    address, with the realtor photo button top-right AT THE GREETING LEVEL
    (48px tap target -> opens the realtor profile).
  - centered below: "N of N steps" above the bigger 96px ring, then the
    single centered days line: "days left: N" / "due today" / red
    "overdue by N day(s)" (singular handled).
  - completion banner "Congratulations, your checklist is complete" when
    every step is checked (and absent otherwise).
  - no JUST NOW markers anywhere (tags, banners, recency logic removed).
  - the rest of the client home unchanged: single ordered list in the
    realtor's order, UP NEXT, read-only rows, no Custom tag, profile flow.

Close dates are computed relative to the local date at runtime — never
hardcoded "today".

Usage: python3 tests/redesign_client_check.py  (run from ~/workspace/realtor-app)
Requires: a fresh `npm run export:web` build in dist/ (uses the built output).
"""
import http.server
import functools
import os
import threading
import sys
import json
import time
import datetime

from playwright.sync_api import sync_playwright

ROOT = os.environ.get("CTC_ROOT", os.path.expanduser("~/workspace/realtor-app"))
DIST = os.path.join(ROOT, "dist")
OUT = os.environ.get("CTC_OUT", "/tmp/ctc-redesign-client")
PORT = int(os.environ.get("CTC_PORT", "8905"))
BASE = f"http://127.0.0.1:{PORT}/clear-to-close/"

BUY_STEPS = [
    "Escrow open",
    "Earnest money wired",
    "Property inspection scheduled",
    "Appraisal scheduled",
    "Homeowners insurance quote",
    "Seller's disclosure / HOA docs received",
    "Signed loan docs",
    "Release contingencies",
    "Review closing disclosure",
    "Schedule final walkthrough",
    "Close escrow",
    "Record deal",
    "Get keys",
]


def seed_data(role, done_count=3, close_delta_days=91):
    close_date = (datetime.date.today() + datetime.timedelta(days=close_delta_days)).isoformat()
    steps = []
    for i, t in enumerate(BUY_STEPS):
        steps.append(
            {
                "id": f"s{i}",
                "title": t,
                "subtitle": "",
                "done": i < done_count,
                "custom": i == 5,  # a custom step: client view must NOT tag it
                "order": i,
                "completedAt": None,
            }
        )
    escrow = {
        "id": "seed-1",
        "address": "26207 Benito Ct",
        "city": "Santa Clarita",
        "side": "buy" if role == "buyer" else "sell",
        "buyerName": "Priya Nair" if role == "buyer" else None,
        "sellerName": "Priya Nair" if role == "seller" else None,
        "openDate": "2026-09-01",
        "closeDate": close_date,
        "buyerSteps": steps if role == "buyer" else [],
        "sellerSteps": steps if role == "seller" else [],
        "status": "open",
        "createdAt": "2026-09-01",
    }
    profile = {
        "name": "Maya Chen",
        "photoUri": None,
        "about": "12 years helping families buy and sell across the Santa Clarita Valley.",
        "yearsExperience": "12",
        "dealsClosed": "240",
        "areasServed": "Santa Clarita",
        "phone": "555-0100",
        "dreLicense": "01998877",
    }
    link = {
        "linkId": "link-1",
        "escrowId": "seed-1",
        "role": role,
        "partyName": "Priya Nair",
        "deviceId": "dev-1",
    }
    return escrow, steps, profile, link


def js_str(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def seed_js(role, done_count=3, close_delta_days=91):
    escrow, _steps, profile, link = seed_data(role, done_count, close_delta_days)
    return (
        "localStorage.setItem('ctc:escrows', '" + js_str(json.dumps([escrow])) + "');"
        "localStorage.setItem('ctc:profile', '" + js_str(json.dumps(profile)) + "');"
        "localStorage.setItem('ctc:clientlink', '" + js_str(json.dumps(link)) + "');"
    )


def rpc_payload(role, done_count=3, close_delta_days=91):
    """get_client_view RPC payload mirroring the local seed, so the hermetic
    stub exercises the app's cloud path instead of its offline fallback."""
    escrow, steps, profile, _link = seed_data(role, done_count, close_delta_days)
    rpc_steps = [
        {
            "id": s["id"],
            "title": s["title"],
            "subtitle": s["subtitle"],
            "done": s["done"],
            "custom": s["custom"],
            "position": s["order"],
            "completed_at": s["completedAt"],
        }
        for s in steps
    ]
    payload = {
        "ok": True,
        "escrow": {
            "id": escrow["id"],
            "address": escrow["address"],
            "city": escrow["city"],
            "close_date": escrow["closeDate"],
        },
        "profile": {
            "name": profile["name"],
            "photo_url": profile["photoUri"],
            "about": profile["about"],
            "years_experience": profile["yearsExperience"],
            "deals_closed": profile["dealsClosed"],
            "areas_served": profile["areasServed"],
            "phone": profile["phone"],
            "dre_license": profile["dreLicense"],
        },
    }
    payload["buyer_steps" if role == "buyer" else "seller_steps"] = rpc_steps
    return payload


# DOM-order helper shared by the order assertions. RNW sometimes concatenates a
# step title with an adjacent tag ("UP NEXT") into one text node and sometimes
# keeps them as siblings, so exact-match finders are fragile. Strip the known
# tag words, then take the DEEPEST element whose stripped text equals the
# title (the title's own container — never a higher ancestor that carries
# extra text like a subtitle).
ORDER_JS = """(TITLES) => {
  const strip = (t) => t.replace(/Up next/gi, '').replace(/\\s+/g, ' ').trim();
  const depth = (e) => { let d = 0, x = e; while (x.parentElement) { x = x.parentElement; d++; } return d; };
  const els = TITLES.map(t => {
    const cands = [...document.querySelectorAll('*')].filter(e => strip(e.textContent) === t);
    if (!cands.length) return null;
    cands.sort((a, b) => depth(b) - depth(a));
    return cands[0];
  });
  if (els.some(e => !e)) return null;
  const pos = new Map(els.map((e, i) => [e, i]));
  const sorted = [...els].sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  return sorted.map(e => TITLES[pos.get(e)]);
}"""

# Geometry of the reworked top card: photo button (top-right at the greeting
# level), the "N of N steps" caption above the 96px ring, and the centered
# days line.
TOPCARD_JS = """(EXPECTED) => {
  const deepest = (t) => {
    const cands = [...document.querySelectorAll('*')].filter(e =>
      e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
      e.textContent.trim() === t);
    if (!cands.length) return null;
    const depth = (e) => { let d = 0, x = e; while (x.parentElement) { x = x.parentElement; d++; } return d; };
    cands.sort((a, b) => depth(b) - depth(a));
    return cands[0];
  };
  const out = {};
  const photoBtn = document.querySelector('[aria-label^="View your realtor"]');
  out.photoBtn = !!photoBtn;
  if (photoBtn) {
    const r = photoBtn.getBoundingClientRect();
    out.photoW = Math.round(r.width); out.photoH = Math.round(r.height);
    out.photoTop = Math.round(r.top);
    out.photoParentRow = getComputedStyle(photoBtn.parentElement).flexDirection === 'row';
  }
  const ring = document.querySelector('[aria-label$="% complete"]');
  out.ring = !!ring;
  if (ring) {
    const r = ring.getBoundingClientRect();
    out.ringW = Math.round(r.width); out.ringH = Math.round(r.height);
    out.ringTop = Math.round(r.top);
  }
  const cap = deepest(EXPECTED.caption);
  out.caption = !!cap;
  if (cap && ring) {
    out.captionAboveRing =
      (cap.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }
  const days = document.querySelector('[data-testid="days-line"]');
  out.days = !!days;
  if (days) {
    out.daysText = days.textContent.replace(/\\s+/g, ' ').trim();
    out.daysAlign = getComputedStyle(days).textAlign;
    out.daysColor = getComputedStyle(days).color;
  }
  out.banner = !!document.querySelector('[data-testid="completion-banner"]');
  if (out.banner) {
    out.bannerText = document.querySelector('[data-testid="completion-banner"]')
      .textContent.replace(/\\s+/g, ' ').trim();
  }
  return out;
}"""


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
            candidate = os.path.join(DIST, rest.lstrip("/"))
            if not os.path.isfile(candidate):
                rest = "/index.html"  # SPA fallback for router paths
            self.path = rest + qs
        return super().do_GET()


def serve():
    h = functools.partial(Handler, directory=DIST)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def load_page(browser, errors, role, done_count, close_delta_days):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.add_init_script(seed_js(role, done_count, close_delta_days))

    # Hermetic cloud path: the client view calls the get_client_view RPC
    # first; stub it with a payload mirroring the local seed so the test
    # exercises the cloud path (the sandbox has no route to the real project).
    payload_json = json.dumps(rpc_payload(role, done_count, close_delta_days))

    def fulfill_rpc(rt):
        if rt.request.method == "OPTIONS":
            rt.fulfill(
                status=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                },
            )
            return
        rt.fulfill(
            status=200,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            },
            body=payload_json,
        )

    pg.route("**/rest/v1/rpc/get_client_view*", fulfill_rpc)
    pg.goto(f"{BASE}client/{role}/seed-1")
    pg.wait_for_timeout(3000)
    return pg


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("dist/ missing — run `npm run export:web` first")
        sys.exit(2)
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    failures = []
    errors = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # --- base pages: full top-card + checklist + profile assertions ---
        for role, kicker in (("buyer", "YOUR PURCHASE"), ("seller", "YOUR SALE")):
            pg = load_page(browser, errors, role, done_count=3, close_delta_days=91)
            body = pg.inner_text("body")
            check(f"{role}: greeting headline", "Hi Priya Nair" in body)
            check(f"{role}: kicker '{kicker}'", kicker in body)
            # Spec §2.8: street address and city on separate lines (14.5px/400),
            # never "·"-joined.
            addr_weight = pg.evaluate("""() => {
              const els = [...document.querySelectorAll('*')].filter(e =>
                e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                e.textContent.trim() === '26207 Benito Ct');
              return els.length ? getComputedStyle(els[0]).fontWeight : 'missing';
            }""")
            check(f"{role}: non-bold address line",
                  "26207 Benito Ct" in body and "Santa Clarita" in body
                  and "26207 Benito Ct · Santa Clarita" not in body
                  and addr_weight == "400",
                  f"weight={addr_weight}")

            tc = pg.evaluate(TOPCARD_JS, {"caption": "3 of 13 steps"})
            check(f"{role}: photo button present", tc["photoBtn"])
            check(f"{role}: photo 48px tap target",
                  tc.get("photoW", 0) >= 48 and tc.get("photoH", 0) >= 48,
                  f"w={tc.get('photoW')} h={tc.get('photoH')}")
            check(f"{role}: photo beside greeting (flex row, above ring)",
                  tc.get("photoParentRow") and tc.get("photoTop", 1e9) < tc.get("ringTop", 0),
                  f"row={tc.get('photoParentRow')} photoTop={tc.get('photoTop')} ringTop={tc.get('ringTop')}")
            check(f"{role}: ring present and 96px",
                  tc["ring"] and tc.get("ringW") == 96 and tc.get("ringH") == 96,
                  f"w={tc.get('ringW')} h={tc.get('ringH')}")
            check(f"{role}: 'N of N steps' caption above ring",
                  tc["caption"] and tc.get("captionAboveRing"),
                  f"caption={tc.get('caption')} above={tc.get('captionAboveRing')}")
            check(f"{role}: days line 'days left: 91'",
                  tc["days"] and tc.get("daysText") == "days left: 91",
                  f"text={tc.get('daysText')!r}")
            check(f"{role}: days line centered",
                  tc.get("daysAlign") == "center", f"align={tc.get('daysAlign')}")
            check(f"{role}: no completion banner yet (3 of 13)", not tc["banner"])
            # No JUST NOW markers anywhere.
            check(f"{role}: no JUST NOW anywhere", "JUST NOW" not in body and "just now" not in body.lower())
            # No Completed/Remaining grouping anywhere.
            check(f"{role}: no Completed/Remaining grouping",
                  "Completed" not in body and "Remaining" not in body)
            # UP NEXT on the first remaining step.
            check(f"{role}: UP NEXT tag present", "UP NEXT" in body)
            # Read-only: 13 plain rows, no drag grips, no Custom tag.
            rows = pg.evaluate("""() => document.querySelectorAll('[data-testid="client-step-row"]').length""")
            check(f"{role}: 13 read-only rows", rows == 13, f"rows={rows}")
            grips = pg.evaluate(
                """() => [...document.querySelectorAll('[aria-label^="Drag to reorder"]')].length"""
            )
            check(f"{role}: no drag grips", grips == 0, f"grips={grips}")
            check(f"{role}: no Custom tag on client view", "Custom" not in body)
            # No full-height spine: all connectors short.
            conns = pg.evaluate(
                """() => [...document.querySelectorAll('[data-testid="step-connector"]')]
                        .map(e => e.getBoundingClientRect().height)"""
            )
            check(f"{role}: no full-height spine",
                  len(conns) > 0 and all(h < 100 for h in conns),
                  f"connectors={len(conns)}")
            # Single ordered list in the realtor's order.
            order = pg.evaluate(ORDER_JS, BUY_STEPS)
            check(f"{role}: single list in realtor's order", order == BUY_STEPS, f"order={order}")
            pg.screenshot(path=f"{OUT}/{role}-home.png")

            # Scroll the client list to the bottom: the last step must be
            # visible on screen (reachable, no clipped seam).
            pg.evaluate(
                """() => {
                  let p = document.querySelector('[data-testid="client-step-row"]');
                  while (p && p.parentElement) {
                    p = p.parentElement;
                    const oy = getComputedStyle(p).overflowY;
                    if (oy === 'auto' || oy === 'scroll') { p.scrollTop = p.scrollHeight; break; }
                  }
                }"""
            )
            pg.wait_for_timeout(600)
            try:
                pg.get_by_text("Get keys", exact=True).wait_for(timeout=8000)
                tail = True
            except Exception:
                tail = False
            check(f"{role}: last step reachable", tail)
            pg.screenshot(path=f"{OUT}/{role}-home-bottom.png")

            # Photo -> realtor profile.
            pg.evaluate("window.scrollTo(0, 0)")
            pg.wait_for_timeout(400)
            pg.locator('[aria-label^="View your realtor"]').first.click()
            pg.wait_for_timeout(1200)
            pbody = pg.inner_text("body")
            check(f"{role}: profile opens", "Maya Chen" in pbody)
            check(f"{role}: Back to my escrow button", "Back to my escrow" in pbody)
            check(f"{role}: license line shown", "DRE / license number: 01998877" in pbody)
            check(f"{role}: no Call button", "Call" not in pbody)
            check(f"{role}: no Message button", "Message" not in pbody)
            pg.screenshot(path=f"{OUT}/{role}-profile.png")

            # Back to my escrow -> the client's own home view.
            pg.get_by_text("Back to my escrow", exact=True).click()
            pg.wait_for_timeout(1500)
            back_body = pg.inner_text("body")
            check(f"{role}: back returns to escrow home", "Hi Priya Nair" in back_body)
            pg.close()

        # --- completion banner: all steps checked ---
        pg = load_page(browser, errors, "buyer", done_count=13, close_delta_days=91)
        tc = pg.evaluate(TOPCARD_JS, {"caption": "13 of 13 steps"})
        check("complete: ring caption '13 of 13 steps'", "13 of 13 steps" in pg.inner_text("body"))
        check("complete: banner present", tc["banner"])
        check("complete: banner copy",
              tc.get("bannerText") == "Congratulations, your checklist is complete",
              f"text={tc.get('bannerText')!r}")
        check("complete: no UP NEXT when all done", "UP NEXT" not in pg.inner_text("body"))
        pg.screenshot(path=f"{OUT}/buyer-complete.png")
        pg.close()

        # --- overdue states ---
        RED = "rgb(178, 59, 59)"  # theme colors.red #B23B3B
        for delta, expected in ((0, "due today"), (-1, "overdue by 1 day"), (-3, "overdue by 3 days")):
            pg = load_page(browser, errors, "buyer", done_count=3, close_delta_days=delta)
            tc = pg.evaluate(TOPCARD_JS, {"caption": "3 of 13 steps"})
            check(f"overdue({delta}): days line '{expected}'",
                  tc["days"] and tc.get("daysText") == expected,
                  f"text={tc.get('daysText')!r}")
            check(f"overdue({delta}): days line red",
                  tc.get("daysColor") == RED, f"color={tc.get('daysColor')}")
            check(f"overdue({delta}): no banner", not tc["banner"])
            pg.screenshot(path=f"{OUT}/buyer-overdue-{delta}.png")
            pg.close()

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll client top-card checks passed.")


main()
