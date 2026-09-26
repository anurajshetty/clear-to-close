#!/usr/bin/env python3
"""Clear to Close — redesign render test: client home top card + profile.

Drives the REAL built output at 390x844 (deep-linked client views with a
seeded device link) and asserts the visible outcomes of the Sept 2026
redesign (mockup 01):
  - buyer home: bold "Hi {name}" greeting, "Your purchase" + non-bold address,
    realtor photo circle above the progress ring -> opens the realtor profile,
    standalone realtor card removed.
  - seller home: "Hi {name}" + "Your sale".
  - realtor profile: prominent "Back to my escrow" button -> returns to the
    client's own home view; NO Call / Message buttons; license line shown
    (seeded).
  - client checklist: single ordered list (realtor's order), no
    Completed/Remaining grouping, no full-height spine, UP NEXT on the first
    remaining step, JUST NOW tag only while inside the 4h recency window
    (expired checkoff shows no tag; the step stays in place), "checked off
    just now" pill while recent, rows fully read-only (no tap targets, no
    drag grips, no Custom tag), last step reachable by scrolling.

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

from playwright.sync_api import sync_playwright

ROOT = os.path.expanduser("~/workspace/realtor-app")
DIST = os.path.join(ROOT, "dist")
OUT = "/tmp/ctc-redesign-client"
BASE = "http://127.0.0.1:8905/clear-to-close/"

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


def seed_data(role):
    now_ms = int(time.time() * 1000)

    def iso(delta_ms):
        return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime((now_ms - delta_ms) / 1000))

    steps = []
    for i, t in enumerate(BUY_STEPS):
        done = i < 3
        completed_at = None
        if i == 0:
            completed_at = iso(5 * 3600_000)  # 5h ago -> JUST NOW expired
        elif i == 1:
            completed_at = iso(30 * 60_000)  # 30 min ago -> JUST NOW visible
        steps.append(
            {
                "id": f"s{i}",
                "title": t,
                "subtitle": "",
                "done": done,
                "custom": i == 5,  # a custom step: client view must NOT tag it
                "order": i,
                "completedAt": completed_at,
            }
        )
    escrow = {
        "id": "seed-1",
        "address": "26207 Benito Ct",
        "city": "Santa Clarita",
        "side": "buy" if role == "buyer" else "sell",
        "buyerName": "Priya Nair" if role == "buyer" else None,
        "sellerName": "Priya Nair" if role == "seller" else None,
        "openDate": "2026-09-25",
        "closeDate": "2026-12-25",
        "buyerSteps": steps if role == "buyer" else [],
        "sellerSteps": steps if role == "seller" else [],
        "status": "open",
        "createdAt": "2026-09-25",
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


def seed_js(role):
    escrow, _steps, profile, link = seed_data(role)
    return (
        "localStorage.setItem('ctc:escrows', '" + js_str(json.dumps([escrow])) + "');"
        "localStorage.setItem('ctc:profile', '" + js_str(json.dumps(profile)) + "');"
        "localStorage.setItem('ctc:clientlink', '" + js_str(json.dumps(link)) + "');"
    )


def rpc_payload(role):
    """get_client_view RPC payload mirroring the local seed, so the hermetic
    stub exercises the app's cloud path instead of its offline fallback."""
    escrow, steps, profile, _link = seed_data(role)
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
# step title with an adjacent tag ("JUST NOW"/"UP NEXT") into one text node
# and sometimes keeps them as siblings, so exact-match finders are fragile.
# Strip the known tag words, then take the DEEPEST element whose stripped
# text equals the title (the title's own container — never the pill, whose
# stripped text keeps the surrounding sentence, and never a higher ancestor
# that carries extra text like a subtitle).
ORDER_JS = """(TITLES) => {
  const strip = (t) => t.replace(/Just now|Up next/gi, '').replace(/\\s+/g, ' ').trim();
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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8905), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def text_of(pg, title):
    return pg.evaluate(
        """(t) => [...document.querySelectorAll('*')].find(e =>
              e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
              e.textContent.trim() === t) || null""",
        title,
    )


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

        for role, route, kicker in (("buyer", "buyer", "YOUR PURCHASE"), ("seller", "seller", "YOUR SALE")):
            pg = browser.new_page(viewport={"width": 390, "height": 844})
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script(seed_js(role))

            # Hermetic cloud path: the client view calls the get_client_view
            # RPC first; stub it with a payload mirroring the local seed so
            # the test exercises the cloud path (the sandbox has no route to
            # the real project).
            payload_json = json.dumps(rpc_payload(role))

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
            pg.goto(f"{BASE}client/{route}/seed-1")
            pg.wait_for_timeout(3000)

            body = pg.inner_text("body")
            check(f"{role}: greeting headline", "Hi Priya Nair" in body)
            check(f"{role}: kicker '{kicker}'", kicker in body)
            check(f"{role}: non-bold address line", "26207 Benito Ct · Santa Clarita" in body)
            check(f"{role}: ring caption", "3 of 13 steps" in body)
            check(
                f"{role}: standalone realtor card removed",
                "View your realtor" not in body or "aria-label" in body,
            )
            # The realtor photo entry point: a button above the ring.
            photo_btn = pg.evaluate(
                """() => !!document.querySelector('[aria-label^="View your realtor"]')"""
            )
            check(f"{role}: realtor photo button present", photo_btn)
            # No Completed/Remaining grouping anywhere.
            check(
                f"{role}: no Completed/Remaining grouping",
                "Completed" not in body and "Remaining" not in body,
            )
            # UP NEXT on the first remaining step.
            check(f"{role}: UP NEXT tag present", "UP NEXT" in body)
            # JUST NOW: only the 30-min-old checkoff carries it; the 5h-old
            # one expired (the step itself stays in place).
            justnow_count = body.count("JUST NOW")
            check(f"{role}: JUST NOW on recent checkoff only", justnow_count == 1, f"count={justnow_count}")
            # "checked off just now" pill while recent.
            check(f"{role}: recent-update pill present", "checked off" in body and "just now" in body)
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
            check(
                f"{role}: no full-height spine",
                len(conns) > 0 and all(h < 100 for h in conns),
                f"connectors={len(conns)}",
            )
            # Single ordered list in the realtor's order.
            order = pg.evaluate(ORDER_JS, BUY_STEPS)
            check(f"{role}: single list in realtor's order", order == BUY_STEPS, f"order={order}")
            pg.screenshot(path=f"{OUT}/{route}-home.png")

            # Scroll the client list to the bottom: the last step must be
            # visible on screen (reachable, no clipped seam).
            pg.evaluate(
                """() => {
                  const sc = document.querySelector('[data-testid="client-step-row"]')
                    ?.closest('div');
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
            if tail:
                box = pg.evaluate(
                    """() => {
                      const cand = [...document.querySelectorAll('*')].find(e =>
                        e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                        e.textContent.trim() === 'Get keys');
                      const r = cand.getBoundingClientRect();
                      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
                    }"""
                )
                check(
                    f"{role}: last step visible after scroll",
                    box["top"] >= -1 and box["bottom"] <= box["vh"] + 1,
                    f"box={box}",
                )
            pg.screenshot(path=f"{OUT}/{route}-home-bottom.png")

            # Photo -> realtor profile.
            pg.evaluate("window.scrollTo(0, 0)")
            pg.wait_for_timeout(400)
            pg.locator('[aria-label^="View your realtor"]').first.click()
            pg.wait_for_timeout(1200)
            pbody = pg.inner_text("body")
            check(f"{role}: profile opens", "Maya Chen" in pbody)
            check(f"{role}: Back to my escrow button", "Back to my escrow" in pbody)
            check(
                f"{role}: license line shown",
                "DRE / license number: 01998877" in pbody,
            )
            check(f"{role}: no Call button", "Call" not in pbody)
            check(f"{role}: no Message button", "Message" not in pbody)
            pg.screenshot(path=f"{OUT}/{route}-profile.png")

            # Back to my escrow -> the client's own home view.
            pg.get_by_text("Back to my escrow", exact=True).click()
            pg.wait_for_timeout(1500)
            back_body = pg.inner_text("body")
            check(f"{role}: back returns to escrow home", "Hi Priya Nair" in back_body)
            pg.close()

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll redesign client checks passed.")


main()
