#!/usr/bin/env python3
"""
Zarnegar v61 Personal MT5 + AI Bridge (READ-ONLY)

Endpoints used by the Android app:
  GET /v1/health
  GET /v1/market?symbol=XAUUSD
  GET /v1/bars?symbol=XAUUSD&timeframe=M5&count=300
  GET /v1/ai?symbol=XAUUSD

This bridge intentionally contains NO order_send / trade execution path.
Run it on the Windows PC where MetaTrader 5 is installed and logged in.
"""
from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import MetaTrader5 as mt5
except Exception as exc:
    print("MetaTrader5 package is required: pip install MetaTrader5", file=sys.stderr)
    raise

HOST = os.getenv("ZARNEGAR_HOST", "0.0.0.0")
PORT = int(os.getenv("ZARNEGAR_PORT", "8765"))
TOKEN = os.getenv("ZARNEGAR_TOKEN", "").strip()
ALLOW_NO_TOKEN = os.getenv("ZARNEGAR_ALLOW_NO_TOKEN", "0") == "1"
TERMINAL_PATH = os.getenv("ZARNEGAR_MT5_PATH", "").strip()
DEFAULT_SYMBOL = os.getenv("ZARNEGAR_SYMBOL", "XAUUSD").strip() or "XAUUSD"

from ai_engine import AdvancedAIEngine
AI = AdvancedAIEngine(mt5)

TF = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
}


def ensure_mt5() -> tuple[bool, str | None]:
    if mt5.terminal_info() is not None:
        return True, None
    ok = mt5.initialize(TERMINAL_PATH) if TERMINAL_PATH else mt5.initialize()
    if not ok:
        return False, f"MT5_INIT_FAILED:{mt5.last_error()}"
    return True, None


def resolve_symbol(requested: str) -> str | None:
    requested = (requested or DEFAULT_SYMBOL).strip()
    info = mt5.symbol_info(requested)
    if info is not None:
        if not info.visible:
            mt5.symbol_select(requested, True)
        return requested

    target = requested.upper().replace("/", "")
    try:
        symbols = mt5.symbols_get() or ()
    except Exception:
        symbols = ()
    candidates = []
    for s in symbols:
        name = getattr(s, "name", "")
        normalized = name.upper().replace("/", "")
        if normalized == target:
            candidates.insert(0, name)
        elif target in normalized:
            candidates.append(name)
    if not candidates:
        return None
    chosen = sorted(candidates, key=lambda n: (len(n), n))[0]
    mt5.symbol_select(chosen, True)
    return chosen


def account_summary() -> dict:
    a = mt5.account_info()
    if a is None:
        return {}
    # No password, token, or other credential is ever returned.
    return {
        "login": getattr(a, "login", None),
        "server": getattr(a, "server", None),
        "company": getattr(a, "company", None),
        "currency": getattr(a, "currency", None),
        "trade_mode": getattr(a, "trade_mode", None),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "ZarnegarMT5Bridge/61"

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, code: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if ALLOW_NO_TOKEN:
            return True
        if not TOKEN:
            self._json(503, {"ok": False, "error": "BRIDGE_TOKEN_NOT_SET"})
            return False
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {TOKEN}":
            self._json(401, {"ok": False, "error": "UNAUTHORIZED"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._authorized():
            return
        ok, err = ensure_mt5()
        if not ok:
            self._json(503, {"ok": False, "error": err})
            return

        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/v1/health":
                symbol = resolve_symbol(q.get("symbol", [DEFAULT_SYMBOL])[0])
                term = mt5.terminal_info()
                self._json(200, {
                    "ok": True,
                    "mode": "READ_ONLY",
                    "symbol": symbol,
                    "terminal_connected": bool(getattr(term, "connected", False)) if term else False,
                    "account": account_summary(),
                    "time": int(time.time()),
                })
                return

            if u.path == "/v1/market":
                symbol = resolve_symbol(q.get("symbol", [DEFAULT_SYMBOL])[0])
                if not symbol:
                    self._json(404, {"ok": False, "error": "SYMBOL_NOT_FOUND"})
                    return
                tick = mt5.symbol_info_tick(symbol)
                if tick is None:
                    self._json(503, {"ok": False, "error": "NO_TICK", "symbol": symbol})
                    return
                self._json(200, {
                    "ok": True,
                    "symbol": symbol,
                    "bid": float(tick.bid),
                    "ask": float(tick.ask),
                    "last": float(getattr(tick, "last", 0.0) or 0.0),
                    "time": int(tick.time),
                    "time_msc": int(getattr(tick, "time_msc", int(tick.time) * 1000)),
                })
                return

            if u.path == "/v1/ai":
                symbol = resolve_symbol(q.get("symbol", [DEFAULT_SYMBOL])[0])
                if not symbol:
                    self._json(404, {"ok": False, "error": "SYMBOL_NOT_FOUND"})
                    return
                result = AI.forecast(symbol)
                result["symbol"] = symbol
                self._json(200 if result.get("ok") else 503, result)
                return

            if u.path == "/v1/bars":
                requested = q.get("symbol", [DEFAULT_SYMBOL])[0]
                tf_name = q.get("timeframe", ["M5"])[0].upper()
                try:
                    count = max(60, min(500, int(q.get("count", ["300"])[0])))
                except ValueError:
                    count = 300
                if tf_name not in TF:
                    self._json(400, {"ok": False, "error": "BAD_TIMEFRAME"})
                    return
                symbol = resolve_symbol(requested)
                if not symbol:
                    self._json(404, {"ok": False, "error": "SYMBOL_NOT_FOUND"})
                    return
                rates = mt5.copy_rates_from_pos(symbol, TF[tf_name], 0, count)
                if rates is None:
                    self._json(503, {"ok": False, "error": "NO_BARS", "detail": str(mt5.last_error())})
                    return
                bars = [{
                    "time": int(r["time"]),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "tick_volume": int(r["tick_volume"]),
                } for r in rates]
                self._json(200, {"ok": True, "symbol": symbol, "timeframe": tf_name, "bars": bars})
                return

            self._json(404, {"ok": False, "error": "NOT_FOUND"})
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._json(500, {"ok": False, "error": "INTERNAL_ERROR", "detail": type(exc).__name__})


def main() -> int:
    if not TOKEN and not ALLOW_NO_TOKEN:
        print("ERROR: set ZARNEGAR_TOKEN before starting the bridge.", file=sys.stderr)
        print("Example (PowerShell): $env:ZARNEGAR_TOKEN='change-this-long-token'", file=sys.stderr)
        return 2
    ok, err = ensure_mt5()
    if not ok:
        print(err, file=sys.stderr)
        return 3
    print(f"Zarnegar MT5 + AI Bridge READ-ONLY listening on http://{HOST}:{PORT}")
    print(f"Default symbol: {DEFAULT_SYMBOL}")
    print("No trade execution endpoint is present in this build. AI is prediction-only.")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        mt5.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
