import http.server, socketserver, threading, time
from playwright.sync_api import sync_playwright

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split('?')[0]
        if p.startswith('/clear-to-close/'):
            self.path = '/dist/' + (p[len('/clear-to-close/'):] or 'index.html')
        return super().do_GET()
    def log_message(self, *a): pass

httpd = socketserver.TCPServer(('127.0.0.1', 8904), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.5)
try:
    with sync_playwright() as pw:
        pg = pw.chromium.launch().new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:100]))
        pg.goto('http://127.0.0.1:8904/clear-to-close/', wait_until='networkidle', timeout=30000)
        pg.wait_for_timeout(4000)
        print("rendered:", pg.evaluate("() => !!document.querySelector('#root > div')"), "pageerrors:", len(errs))
finally:
    httpd.shutdown()
