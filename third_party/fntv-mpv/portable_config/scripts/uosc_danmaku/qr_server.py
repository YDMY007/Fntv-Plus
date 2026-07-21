#!/usr/bin/env python3
# 本地扫码登录代理服务器（仅供本机使用）
# 作用：
#   1) 静态托管同目录的 get_bili_cookie.html
#   2) 把 /qr/generate、/qr/poll、/qr/img 代理到 B站 passport（服务端转发，无浏览器 CORS 限制）
# 关键：B站 generate 需要匿名 buvid3 cookie，启动时先访问 www.bilibili.com 取到并复用。
# 用法：python qr_server.py  ->  浏览器打开 http://127.0.0.1:8777
import http.server, urllib.request, os, http.cookiejar

PORT = 8777
DIR = os.path.dirname(os.path.abspath(__file__))
PASSPORT = "https://passport.bilibili.com/x/passport-login/web/qrcode"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com"}

# 共享 cookiejar：先拿匿名 buvid3，后续 generate/poll/img 复用
_cj = http.cookiejar.CookieJar()
_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))
try:
    _op.open(urllib.request.Request("https://www.bilibili.com/", headers=UA), timeout=10)
except Exception:
    pass


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, target, ctype="application/json"):
        try:
            r = _op.open(urllib.request.Request(target, headers=UA), timeout=10)
            self._send(200, r.read(), ctype)
        except Exception as e:
            self._send(502, '{"code":-1,"message":"%s"}' % str(e))

    def do_GET(self):
        if self.path.startswith("/qr/poll"):
            key = self.path.split("qrcode_key=")[-1].split("&")[0]
            self._proxy(PASSPORT + "/poll?qrcode_key=" + key)
        elif self.path.startswith("/qr/img"):
            key = self.path.split("key=")[-1].split("&")[0]
            self._proxy("https://passport.bilibili.com/qrcode/" + key, "image/png")
        else:
            f = self.path.split("?")[0].lstrip("/")
            if f in ("", "index.html"):
                f = "get_bili_cookie.html"
            fp = os.path.join(DIR, f)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    ct = "text/html; charset=utf-8" if f.endswith(".html") else "application/octet-stream"
                    self._send(200, fh.read(), ct)
            else:
                self._send(404, b"not found")

    def do_POST(self):
        if self.path.startswith("/qr/generate"):
            self._proxy(PASSPORT + "/generate")
        else:
            self._send(404, b"not found")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("扫码服务已启动: http://127.0.0.1:%d  (Ctrl+C 退出)" % PORT)
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
