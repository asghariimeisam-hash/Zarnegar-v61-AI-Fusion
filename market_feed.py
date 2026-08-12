#!/usr/bin/env python3
"""Live XAUUSD market adapters for Zarnegar Apex.

Prediction / research feed only. Tries institutional and public gold
sources in order and normalizes them to the same tick / OHLCV shape.
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from typing import Any

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 "
    "ZarnegarApex/61"
)

SOURCES_TICK = (
    "SWISSQUOTE",
    "GOLD_API",
    "XAUS",
    "COINGECKO",
    "YAHOO_GC",
)

_CTX = ssl.create_default_context()


class FeedError(RuntimeError):
    pass


def _get_json(url: str, timeout: float = 8.0) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as resp:
            raw = resp.read()
    except Exception as exc:  # network / TLS / DNS
        raise FeedError(f"{type(exc).__name__}: {exc}") from exc
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception as exc:
        raise FeedError(f"BAD_JSON: {exc}") from exc


def _swissquote() -> dict[str, Any]:
    data = _get_json(
        "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
        timeout=7,
    )
    if not isinstance(data, list) or not data:
        raise FeedError("SWISSQUOTE_EMPTY")
    best = None
    best_spread = 1e9
    ts = int(time.time() * 1000)
    for venue in data:
        ts = int(venue.get("ts") or ts)
        for row in venue.get("spreadProfilePrices") or []:
            bid = float(row.get("bid") or 0)
            ask = float(row.get("ask") or 0)
            if bid <= 0 or ask <= bid:
                continue
            spread = ask - bid
            # Prefer tighter institutional profiles (elite / prime).
            profile = str(row.get("spreadProfile") or "").lower()
            score = spread - (0.08 if profile in {"elite", "prime"} else 0.0)
            if score < best_spread:
                best_spread = score
                best = {
                    "bid": bid,
                    "ask": ask,
                    "spread": spread,
                    "profile": profile or "standard",
                    "venue": (venue.get("topo") or {}).get("platform") or "Swissquote",
                }
    if not best:
        raise FeedError("SWISSQUOTE_NO_BBO")
    mid = (best["bid"] + best["ask"]) / 2.0
    return {
        "ok": True,
        "source": "SWISSQUOTE",
        "symbol": "XAUUSD",
        "resolvedSymbol": "XAUUSD",
        "bid": best["bid"],
        "ask": best["ask"],
        "last": mid,
        "spread": best["spread"],
        "time": ts // 1000,
        "time_msc": ts,
        "venue": best["venue"],
        "profile": best["profile"],
        "quality": "INSTITUTIONAL",
    }


def _gold_api() -> dict[str, Any]:
    data = _get_json("https://api.gold-api.com/price/XAU", timeout=7)
    px = float(data.get("price") or 0)
    if px < 100:
        raise FeedError("GOLD_API_BAD_PRICE")
    spread = max(0.28, px * 0.00008)
    ts = int(time.time() * 1000)
    return {
        "ok": True,
        "source": "GOLD_API",
        "symbol": "XAUUSD",
        "resolvedSymbol": "XAUUSD",
        "bid": px - spread / 2.0,
        "ask": px + spread / 2.0,
        "last": px,
        "spread": spread,
        "time": ts // 1000,
        "time_msc": ts,
        "venue": "gold-api.com",
        "profile": "spot",
        "quality": "SPOT",
    }


def _xaus() -> dict[str, Any]:
    data = _get_json("https://xaus.com/api/v1/spot", timeout=7)
    px = float((data.get("xau") or {}).get("price") or data.get("spot_usd_oz") or 0)
    if px < 100:
        raise FeedError("XAUS_BAD_PRICE")
    spread = max(0.30, px * 0.00008)
    ts = int(time.time() * 1000)
    return {
        "ok": True,
        "source": "XAUS",
        "symbol": "XAUUSD",
        "resolvedSymbol": "XAUUSD",
        "bid": px - spread / 2.0,
        "ask": px + spread / 2.0,
        "last": px,
        "spread": spread,
        "time": ts // 1000,
        "time_msc": ts,
        "venue": "xaus.com",
        "profile": "spot",
        "quality": "SPOT",
    }


def _coingecko_tick() -> dict[str, Any]:
    data = _get_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold,tether-gold&vs_currencies=usd",
        timeout=8,
    )
    px = float((data.get("pax-gold") or {}).get("usd") or 0)
    if px < 100:
        px = float((data.get("tether-gold") or {}).get("usd") or 0)
    if px < 100:
        raise FeedError("COINGECKO_BAD_PRICE")
    spread = max(0.35, px * 0.0001)
    ts = int(time.time() * 1000)
    return {
        "ok": True,
        "source": "COINGECKO",
        "symbol": "XAUUSD",
        "resolvedSymbol": "PAXG",
        "bid": px - spread / 2.0,
        "ask": px + spread / 2.0,
        "last": px,
        "spread": spread,
        "time": ts // 1000,
        "time_msc": ts,
        "venue": "CoinGecko PAXG/XAUT",
        "profile": "tokenized",
        "quality": "PROXY",
    }


def _yahoo_chart(symbol: str, interval: str, range_: str) -> dict[str, Any]:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{symbol}?interval={interval}&range={range_}&includePrePost=false"
    )
    data = _get_json(url, timeout=10)
    result = ((data.get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise FeedError("YAHOO_EMPTY")
    meta = result.get("meta") or {}
    ts_list = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    vols = quote.get("volume") or []
    bars = []
    for i, ts in enumerate(ts_list):
        if i >= len(closes) or closes[i] is None:
            continue
        c = float(closes[i])
        o = float(opens[i]) if i < len(opens) and opens[i] is not None else c
        h = float(highs[i]) if i < len(highs) and highs[i] is not None else max(o, c)
        l = float(lows[i]) if i < len(lows) and lows[i] is not None else min(o, c)
        v = int(vols[i] or 0) if i < len(vols) else 0
        bars.append({
            "time": int(ts),
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "tick_volume": v,
        })
    if not bars:
        raise FeedError("YAHOO_NO_BARS")
    last = bars[-1]
    px = float(meta.get("regularMarketPrice") or last["close"])
    spread = max(0.32, px * 0.00008)
    ts = int(meta.get("regularMarketTime") or last["time"])
    return {
        "ok": True,
        "source": "YAHOO",
        "symbol": "XAUUSD",
        "resolvedSymbol": str(meta.get("symbol") or symbol),
        "bid": px - spread / 2.0,
        "ask": px + spread / 2.0,
        "last": px,
        "spread": spread,
        "time": ts,
        "time_msc": ts * 1000,
        "venue": str(meta.get("exchangeName") or "Yahoo"),
        "profile": str(meta.get("instrumentType") or "future"),
        "quality": "FUTURES" if "F" in symbol else "SPOT",
        "bars": bars,
        "timeframe_hint": interval,
    }


def _yahoo_tick() -> dict[str, Any]:
    pack = _yahoo_chart("GC=F", "1m", "1d")
    pack["source"] = "YAHOO_GC"
    return pack


def live_tick() -> dict[str, Any]:
    errors: list[str] = []
    for name, fn in (
        ("SWISSQUOTE", _swissquote),
        ("GOLD_API", _gold_api),
        ("XAUS", _xaus),
        ("COINGECKO", _coingecko_tick),
        ("YAHOO_GC", _yahoo_tick),
    ):
        try:
            tick = fn()
            tick["errors"] = errors
            return tick
        except Exception as exc:
            errors.append(f"{name}:{exc}")
    return {"ok": False, "error": "ALL_FEEDS_FAILED", "detail": errors[:6]}


def _points_to_bars(points: list[list[float]], minutes: int) -> list[dict[str, Any]]:
    bucket = minutes * 60
    grouped: dict[int, dict[str, Any]] = {}
    order: list[int] = []
    for row in points:
        if not row or len(row) < 2 or row[1] is None:
            continue
        ts_ms = int(row[0])
        px = float(row[1])
        t = (ts_ms // 1000 // bucket) * bucket
        bar = grouped.get(t)
        if bar is None:
            grouped[t] = {"time": t, "open": px, "high": px, "low": px, "close": px, "tick_volume": 1}
            order.append(t)
        else:
            bar["high"] = max(bar["high"], px)
            bar["low"] = min(bar["low"], px)
            bar["close"] = px
            bar["tick_volume"] += 1
    return [grouped[t] for t in order]


def _coingecko_bars(days: str = "1") -> list[dict[str, Any]]:
    data = _get_json(
        f"https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days={days}",
        timeout=12,
    )
    prices = data.get("prices") or []
    if len(prices) < 20:
        raise FeedError("COINGECKO_FEW_POINTS")
    return prices


def load_frames() -> dict[str, Any]:
    """Return M1/M5/M15/H1 bars plus a live tick if possible."""
    errors: list[str] = []
    frames: dict[str, list[dict[str, Any]]] = {"M1": [], "M5": [], "M15": [], "H1": []}
    source = "NONE"

    try:
        day = _coingecko_bars("1")
        week = _coingecko_bars("14")
        frames["M1"] = _points_to_bars(day, 1)[-500:]
        frames["M5"] = _points_to_bars(day, 5)[-500:]
        frames["M15"] = _points_to_bars(day + week, 15)[-500:]
        frames["H1"] = _points_to_bars(week, 60)[-500:]
        source = "COINGECKO"
    except Exception as exc:
        errors.append(f"COINGECKO_BARS:{exc}")
        try:
            y5 = _yahoo_chart("GC=F", "5m", "5d")
            y1 = _yahoo_chart("GC=F", "1h", "1mo")
            y1m = _yahoo_chart("GC=F", "1m", "1d")
            frames["M1"] = (y1m.get("bars") or [])[-500:]
            frames["M5"] = (y5.get("bars") or [])[-500:]
            frames["M15"] = _aggregate(frames["M5"], 15)[-500:]
            frames["H1"] = (y1.get("bars") or [])[-500:]
            source = "YAHOO_GC"
        except Exception as exc2:
            errors.append(f"YAHOO_BARS:{exc2}")

    tick = live_tick()
    return {
        "ok": any(len(frames[k]) >= 40 for k in frames),
        "source": source,
        "frames": frames,
        "tick": tick if tick.get("ok") else None,
        "errors": errors + list(tick.get("detail") or tick.get("errors") or []),
    }


def _aggregate(bars: list[dict[str, Any]], minutes: int) -> list[dict[str, Any]]:
    bucket = minutes * 60
    grouped: dict[int, dict[str, Any]] = {}
    order: list[int] = []
    for b in bars:
        t = (int(b["time"]) // bucket) * bucket
        cur = grouped.get(t)
        if cur is None:
            grouped[t] = {
                "time": t,
                "open": b["open"],
                "high": b["high"],
                "low": b["low"],
                "close": b["close"],
                "tick_volume": int(b.get("tick_volume") or 0),
            }
            order.append(t)
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
            cur["tick_volume"] += int(b.get("tick_volume") or 0)
    return [grouped[t] for t in order]


def frames_as_lists(pack: dict[str, Any]) -> dict[str, list[dict[str, float]]]:
    out: dict[str, list[dict[str, float]]] = {}
    for tf, bars in (pack.get("frames") or {}).items():
        out[tf] = [
            {
                "time": float(b["time"]),
                "open": float(b["open"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "close": float(b["close"]),
                "tick_volume": float(b.get("tick_volume") or 0),
            }
            for b in bars
        ]
    return out
