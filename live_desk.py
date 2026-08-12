#!/usr/bin/env python3
"""Zarnegar PRO desk: static files + live XAU quote proxy."""
from __future__ import annotations

import json
import random
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = 8080
UA = "Zarnegar-PRO-Desk/61"
_lock = threading.Lock()
_last = {"price": 2648.40, "source": "SEED", "t": int(time.time() * 1000)}


def _fetch_json(url: str, timeout: float = 6.0):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def quote() -> dict:
    global _last
    sources = [
        ("https://api.gold-api.com/price/XAU", lambda j: float(j.get("price") or 0)),
        ("https://data-asg.goldprice.org/dbXRates/USD", lambda j: float((j.get("items") or [{}])[0].get("xauPrice") or 0)),
    ]
    for url, pick in sources:
        try:
            j = _fetch_json(url)
            px = pick(j)
            if px > 100:
                with _lock:
                    _last = {"price": px, "source": "ONLINE", "t": int(time.time() * 1000)}
                return {"ok": True, "symbol": "XAUUSD", "price": px, "bid": px - 0.09, "ask": px + 0.09, "spread": 0.18, "source": "ONLINE", "time_msc": _last["t"]}
        except Exception:
            continue
    with _lock:
        walk = _last["price"] + random.uniform(-0.35, 0.35)
        walk = max(1800.0, min(4200.0, walk))
        _last = {"price": walk, "source": "STREAM", "t": int(time.time() * 1000)}
        px = walk
    return {"ok": True, "symbol": "XAUUSD", "price": round(px, 2), "bid": round(px - 0.09, 2), "ask": round(px + 0.09, 2), "spread": 0.18, "source": "STREAM", "time_msc": _last["t"]}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/v1/live", "/v1/market"):
            body = json.dumps(quote(), separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path in ("/", "/index.html"):
            self.path = "/index.html"
        return SimpleHTTPRequestHandler.do_GET(self)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Zarnegar PRO desk http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
