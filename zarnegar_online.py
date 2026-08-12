#!/usr/bin/env python3
"""Zarnegar Apex Online — live gold desk + Apex AI (no MT5 required).

Serves the professional terminal and the same /v1 API the Android app uses.
Prediction-only. No order execution.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
HOST = os.getenv("ZARNEGAR_HOST", "0.0.0.0")
PORT = int(os.getenv("ZARNEGAR_PORT", "8080"))
TOKEN = os.getenv("ZARNEGAR_TOKEN", "").strip()
ALLOW_NO_TOKEN = os.getenv("ZARNEGAR_ALLOW_NO_TOKEN", "1") == "1"

from ai_engine import AdvancedAIEngine
from market_feed import frames_as_lists, live_tick, load_frames

AI = AdvancedAIEngine(None)
CACHE_LOCK = threading.Lock()
FRAME_CACHE: dict[str, object] = {"at": 0.0, "pack": None}
TICK_CACHE: dict[str, object] = {"at": 0.0, "tick": None}
FRAME_TTL = 45.0
TICK_TTL = 2.5


def _cached_frames() -> dict:
    now = time.time()
    with CACHE_LOCK:
        pack = FRAME_CACHE.get("pack")
        if pack and now - float(FRAME_CACHE.get("at") or 0) <= FRAME_TTL:
            return pack  # type: ignore[return-value]
    pack = load_frames()
    with CACHE_LOCK:
        FRAME_CACHE["at"] = time.time()
        FRAME_CACHE["pack"] = pack
    return pack


def _cached_tick() -> dict:
    now = time.time()
    with CACHE_LOCK:
        tick = TICK_CACHE.get("tick")
        if tick and now - float(TICK_CACHE.get("at") or 0) <= TICK_TTL:
            return tick  # type: ignore[return-value]
    tick = live_tick()
    with CACHE_LOCK:
        TICK_CACHE["at"] = time.time()
        TICK_CACHE["tick"] = tick
    return tick


class Handler(SimpleHTTPRequestHandler):
    server_version = "ZarnegarApex/61"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))
        sys.stdout.flush()

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def _json(self, code: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if ALLOW_NO_TOKEN:
            return True
        if not TOKEN:
            self._json(503, {"ok": False, "error": "BRIDGE_TOKEN_NOT_SET"})
            return False
        if self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            self._json(401, {"ok": False, "error": "UNAUTHORIZED"})
            return False
        return True

    def do_GET(self) -> None:
        u = urlparse(self.path)
        path = u.path
        if path == "/":
            self.path = "/index-v61.html"
            return SimpleHTTPRequestHandler.do_GET(self)
        if not path.startswith("/v1/"):
            return SimpleHTTPRequestHandler.do_GET(self)
        if not self._authorized():
            return
        q = parse_qs(u.query)
        try:
            if path == "/v1/health":
                tick = _cached_tick()
                self._json(200, {
                    "ok": True,
                    "mode": "ONLINE_AI",
                    "engine": "APEX_QUANT_FUSION",
                    "symbol": "XAUUSD",
                    "terminal_connected": bool(tick.get("ok")),
                    "feed": tick.get("source") if tick.get("ok") else None,
                    "time": int(time.time()),
                    "read_only": True,
                })
                return
            if path == "/v1/market":
                tick = _cached_tick()
                if not tick.get("ok"):
                    self._json(503, tick)
                    return
                self._json(200, tick)
                return
            if path == "/v1/bars":
                tf = (q.get("timeframe", ["M5"])[0] or "M5").upper()
                try:
                    count = max(60, min(500, int(q.get("count", ["300"])[0])))
                except ValueError:
                    count = 300
                pack = _cached_frames()
                frames = pack.get("frames") or {}
                bars = frames.get(tf) or []
                if tf == "M15" and len(bars) < 40:
                    bars = frames.get("M5") or []
                if not bars:
                    self._json(503, {"ok": False, "error": "NO_BARS", "detail": pack.get("errors")})
                    return
                self._json(200, {
                    "ok": True,
                    "symbol": "XAUUSD",
                    "timeframe": tf,
                    "source": pack.get("source"),
                    "bars": bars[-count:],
                })
                return
            if path == "/v1/ai":
                pack = _cached_frames()
                frames = frames_as_lists(pack)
                result = AI.forecast_bars(frames, "XAUUSD")
                result["symbol"] = "XAUUSD"
                result["feed_source"] = pack.get("source")
                self._json(200 if result.get("ok") else 503, result)
                return
            self._json(404, {"ok": False, "error": "NOT_FOUND"})
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._json(500, {"ok": False, "error": "INTERNAL_ERROR", "detail": type(exc).__name__})


def main() -> int:
    os.chdir(ROOT)
    print(f"Zarnegar Apex Online listening on http://{HOST}:{PORT}")
    print("Live gold desk + Apex Fusion AI. READ-ONLY / no order_send.")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
