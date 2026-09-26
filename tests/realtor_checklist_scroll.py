#!/usr/bin/env python3
"""Clear to Close — regression test: realtor transaction-detail checklist.

Covers the Sept 2026 cutoff bug AND the single-list redesign (mockup 01):
  - geometric scroll safety: the list's outer container is bounded, scrolling
    reaches the LAST step (visible in the viewport), scrolling back shows the
    first step. Without the container fix the inner ScrollView is
    content-sized, the scroll is a no-op, and the last step stays below the
    fold. (RNW virtualizes: initialNumToRender=10 — the test scrolls before
    asserting tail rows, and uses the native scrollTop setter because RNW
    overrides scrollTo with the native (y,x) signature.)
  - single ordered list: step titles appear in DOM order matching the
    realtor's order; no "Completed"/"Remaining" grouping headers.
  - no full-height spine: every connector segment is short (no rail spanning
    the list).
  - realtor interactions: rows are tap targets, drag grips on all mounted
    rows, UP NEXT on the first remaining step.

Drives the REAL user flow hermetically (role -> sign-up with a stubbed
Supabase session -> skip profile -> deal list -> tap the escrow card).

Usage: python3 tests/realtor_checklist_scroll.py  (run from ~/workspace/realtor-app)
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
OUT = "/tmp/ctc-checklist-scroll"
BASE = "http://127.0.0.1:8904/clear-to-close/"

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


# DOM-order helper: RNW sometimes concatenates a step title with an adjacent
# tag ("JUST NOW"/"UP NEXT") into one text node and sometimes keeps them as
# siblings, so exact-match finders are fragile. Strip the known tag words,
# then take the DEEPEST element whose stripped text equals the title (the
# title's own container — never a higher ancestor carrying extra text).
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


def make_escrow():
    now_ms = int(time.time() * 1000)
    steps = []
    for i, t in enumerate(BUY_STEPS):
        done = i < 3
        # s1 checked off 30 min ago (recent), s0 5h ago (expired) — the
        # realtor view never shows JUST NOW tags; the client view does.
        completed_at = None
        if i == 0:
            completed_at = time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime((now_ms - 5 * 3600_000) / 1000)
            )
        elif i == 1:
            completed_at = time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime((now_ms - 30 * 60_000) / 1000)
            )
        steps.append(
            {
                "id": f"s{i}",
                "title": t,
                "subtitle": "",
                "done": done,
                "custom": False,
                "order": i,
                "completedAt": completed_at,
            }
        )
    return [
        {
            "id": "seed-1",
            "address": "26207 Benito Ct",
            "city": "Santa Clarita",
            "side": "buy",
            "buyerName": "sushmitha",
            "sellerName": None,
            "openDate": "2026-09-25",
            "closeDate": "2026-12-25",
            "buyerSteps": steps,
            "sellerSteps": [],
            "status": "open",
            "createdAt": "2026-09-25",
        }
    ]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        # Map /clear-to-close/* -> dist/* with SPA fallback to index.html
        # (mirrors the deployed gh-pages routing).
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
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8904), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


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
        pg = browser.new_page(viewport={"width": 390, "height": 844})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(
            "window.__seed = " + json.dumps(make_escrow()) + ";"
            "localStorage.setItem('ctc:escrows', JSON.stringify(window.__seed));"
        )

        # Stub the Supabase sign-up endpoint: return a session so the app
        # proceeds exactly as it does with email confirmation disabled.
        def fulfill_signup(route):
            if route.request.method == "OPTIONS":
                route.fulfill(
                    status=200,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                    },
                )
                return
            route.fulfill(
                status=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json",
                },
                json={
                    "access_token": "fake-jwt",
                    "token_type": "bearer",
                    "expires_in": 3600,
                    "refresh_token": "fake-refresh",
                    "user": {
                        "id": "test-user-1",
                        "email": "rita@example.com",
                        "user_metadata": {"name": "Rita Realtor"},
                    },
                },
            )

        pg.route("**/auth/v1/signup*", fulfill_signup)

        # The app probes the cloud profile after sign-in; the sandbox has no
        # route to the real project, so stub it hermetically (empty = no
        # cloud profile yet, which is the expected post-signup state).
        def fulfill_profiles(route):
            if route.request.method == "OPTIONS":
                route.fulfill(
                    status=200,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "apikey, Content-Type, Authorization",
                        "Access-Control-Expose-Headers": "Content-Range",
                    },
                )
                return
            route.fulfill(
                status=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json",
                    "Access-Control-Expose-Headers": "Content-Range",
                },
                json=[],
            )

        pg.route("**/rest/v1/realtor_profiles*", fulfill_profiles)

        # 1. Boot -> role picker -> realtor sign-up.
        pg.goto(BASE)
        pg.wait_for_timeout(3500)
        pg.get_by_text("I'm a Realtor").click()
        pg.wait_for_timeout(400)
        pg.get_by_text("Continue", exact=True).click()
        pg.wait_for_timeout(1500)
        check("nav: signup visible", "Create account" in pg.inner_text("body"))

        # 2. Fill the form and create the account (stubbed session).
        inputs = pg.locator("input")
        inputs.nth(0).fill("Rita Realtor")
        inputs.nth(1).fill("rita@example.com")
        inputs.nth(2).fill("longenoughpassword")
        pg.wait_for_timeout(400)
        pg.get_by_text("Create account", exact=True).click()
        try:
            pg.get_by_text("Skip for now").wait_for(timeout=12000)
            arrived_profile = True
        except Exception:
            arrived_profile = False
        check("nav: profile-create after signup", arrived_profile)
        pg.screenshot(path=f"{OUT}/01-profile-create.png")

        # 3. Skip profile -> deal list.
        pg.get_by_text("Skip for now").click()
        pg.get_by_text("26207 Benito Ct").first.wait_for(timeout=12000)
        check("nav: deal list visible", "26207 Benito Ct" in pg.inner_text("body"))
        pg.screenshot(path=f"{OUT}/02-deal-list.png")

        # 4. Tap the escrow card -> transaction detail.
        pg.get_by_text("26207 Benito Ct").first.click()
        pg.get_by_text("3 of 13 steps").wait_for(timeout=12000)
        body = pg.inner_text("body")
        check("nav: transaction detail visible", "3 of 13 steps" in body)
        # RNW virtualizes the list (initialNumToRender=10): the head rows mount
        # immediately, the tail rows mount on scroll (asserted below).
        found = sum(1 for t in BUY_STEPS if t in body)
        check("checklist: head rows rendered", found >= 10, f"found {found}/13")
        pg.screenshot(path=f"{OUT}/03-detail-top.png")

        # --- Redesign assertions on the rendered list ---
        # Single ordered list: no Completed/Remaining grouping headers.
        check(
            "checklist: no Completed/Remaining grouping",
            "Completed" not in body and "Remaining" not in body,
        )
        # UP NEXT tag on the first remaining step (step index 3).
        check("checklist: UP NEXT tag present", "UP NEXT" in body)
        # Realtor rows are tap targets with drag grips; no JUST NOW tags here.
        grips = pg.evaluate(
            "(sel) => document.querySelectorAll(sel).length",
            '[aria-label^="Drag to reorder"]',
        )
        check("checklist: drag grips on mounted rows", grips >= 10, f"grips={grips}")
        check("checklist: no JUST NOW tags on realtor view", "Just now" not in body)

        # 5. Visible-outcome geometry assertions on the real rendered list.
        geom = pg.evaluate(
            """(TITLES) => {
              // The scroll container: nearest ancestor of a mounted step row
              // with a real vertical scroll context.
              const anchor = [...document.querySelectorAll('*')].find(e =>
                e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                e.textContent.trim() === TITLES[9]);
              if (!anchor) return { ok: false, why: 'anchor row not mounted' };
              let sc = anchor;
              while (sc && sc.parentElement) {
                sc = sc.parentElement;
                const oy = getComputedStyle(sc).overflowY;
                if (oy === 'auto' || oy === 'scroll') break;
              }
              if (!sc || !sc.parentElement) return { ok: false, why: 'no scroll container' };
              const r = sc.getBoundingClientRect();
              const res = {
                ok: true,
                container: { top: r.top, bottom: r.bottom, clientH: sc.clientHeight, scrollH: sc.scrollHeight },
              };
              // Scroll to the bottom with the native setter (RNW ScrollViews
              // override scrollTo with the native (y,x) signature).
              sc.scrollTop = sc.scrollHeight;
              res.scrollTopAfter = sc.scrollTop;
              res.maxScroll = sc.scrollHeight - sc.clientHeight;
              return res;
            }""",
            BUY_STEPS,
        )
        check("geom: measured", bool(geom.get("ok")), geom.get("why", ""))
        if geom.get("ok"):
            c = geom["container"]
            print(f"    container: clientH={c['clientH']} scrollH={c['scrollH']}")
            check(
                "checklist: content overflows the list container (scroll is meaningful)",
                c["scrollH"] > c["clientH"] + 100,
                f"clientH={c['clientH']} scrollH={c['scrollH']} — list never became scrollable",
            )
            check(
                "checklist: list actually scrolled",
                geom["scrollTopAfter"] > 0 and geom["scrollTopAfter"] == geom["maxScroll"],
                f"scrollTop={geom['scrollTopAfter']} maxScroll={geom['maxScroll']}",
            )
            # Virtualization mounts the tail rows on scroll — wait for the
            # very last step, then assert it is actually VISIBLE on screen
            # (inside the viewport): reachable by the user, no clipped seam.
            # Without the fix the last step sits below the fold (~y=1350 in an
            # 844px viewport) and no scroll is possible, so this fails.
            try:
                pg.get_by_text("Get keys", exact=True).wait_for(timeout=8000)
                tail_mounted = True
            except Exception:
                tail_mounted = False
            check("checklist: last step mounted after scrolling", tail_mounted)
            if tail_mounted:
                after = pg.evaluate(
                    """() => {
                      const cand = [...document.querySelectorAll('*')].find(e =>
                        e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                        e.textContent.trim() === 'Get keys');
                      const r = cand.getBoundingClientRect();
                      return { top: r.top, bottom: r.bottom, viewportH: window.innerHeight };
                    }"""
                )
                visible_after = after["top"] >= -1 and after["bottom"] <= after["viewportH"] + 1
                check(
                    "checklist: last step visible on screen after scrolling (no clipped seam)",
                    visible_after,
                    f"last box=({after['top']},{after['bottom']}) viewportH={after['viewportH']}",
                )
            pg.screenshot(path=f"{OUT}/04-detail-bottom.png")

            # No full-height spine: every connector segment is short. A
            # continuous rail would be one tall element; the redesign only
            # draws short segments between consecutive circles.
            conns = pg.evaluate(
                """() => [...document.querySelectorAll('[data-testid="step-connector"]')]
                        .map(e => e.getBoundingClientRect().height)"""
            )
            check("checklist: connectors rendered", len(conns) > 0, "none found")
            if conns:
                check(
                    "checklist: no full-height spine (all connectors short)",
                    all(h < 100 for h in conns),
                    f"max connector height={max(conns):.0f}px",
                )

            # Single ordered list: titles appear in DOM order matching the
            # realtor's order (checked steps stay in place).
            order = pg.evaluate(ORDER_JS, BUY_STEPS)
            check(
                "checklist: single list in the realtor's order",
                order == BUY_STEPS,
                f"dom order={order}",
            )

            # Scroll back to the top: the first step must be visible again.
            pg.evaluate(
                """(TITLES) => {
                  const el = [...document.querySelectorAll('*')].find(e =>
                    e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                    e.textContent.trim() === TITLES[0]);
                  let p = el;
                  while (p && p.parentElement) {
                    p = p.parentElement;
                    const oy = getComputedStyle(p).overflowY;
                    if (oy === 'auto' || oy === 'scroll') { p.scrollTop = 0; break; }
                  }
                }""",
                BUY_STEPS,
            )
            pg.wait_for_timeout(600)
            top = pg.evaluate(
                """(TITLES) => {
                  const cand = [...document.querySelectorAll('*')].find(e =>
                    e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                    e.textContent.trim() === TITLES[0]);
                  const r = cand.getBoundingClientRect();
                  return { top: r.top, bottom: r.bottom, viewportH: window.innerHeight };
                }""",
                BUY_STEPS,
            )
            check(
                "checklist: first step visible on screen after scrolling back to top",
                top["top"] >= -1 and top["bottom"] <= top["viewportH"] + 1,
                f"first box={top}",
            )
            pg.screenshot(path=f"{OUT}/05-detail-top-again.png")

        # 6. Tap-to-check in place: tap an unchecked step, ring recounts,
        # the step stays in position (no regrouping).
        pg.evaluate(
            """(TITLES) => {
              const el = [...document.querySelectorAll('*')].find(e =>
                e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 &&
                e.textContent.trim() === TITLES[3]);
              let p = el;
              while (p && p.parentElement) {
                p = p.parentElement;
                const oy = getComputedStyle(p).overflowY;
                if (oy === 'auto' || oy === 'scroll') { p.scrollTop = 0; break; }
              }
            }""",
            BUY_STEPS,
        )
        pg.wait_for_timeout(400)
        pg.get_by_text("Appraisal scheduled", exact=True).click()
        pg.wait_for_timeout(800)
        body2 = pg.inner_text("body")
        check("checklist: tap checks off in place, ring recounts", "4 of 13 steps" in body2)
        order2 = pg.evaluate(ORDER_JS, BUY_STEPS)
        check(
            "checklist: checked step stays in position",
            order2 == BUY_STEPS,
            f"dom order={order2}",
        )
        pg.screenshot(path=f"{OUT}/06-after-check.png")

        browser.close()

    srv.shutdown()
    check("zero JS errors during the flow", len(errors) == 0, "; ".join(errors[:3]))
    if failures:
        print(f"\n{len(failures)} FAILURES: {failures}")
        sys.exit(1)
    print("\nAll checklist regression checks passed.")


main()
