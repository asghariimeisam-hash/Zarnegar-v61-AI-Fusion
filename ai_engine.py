#!/usr/bin/env python3
"""Zarnegar Apex Fusion — institutional multi-specialist trading AI.

Prediction-only. Never sends orders.

Primary engine
  Apex Quant Fusion — 8 specialists + regime + session + consensus vetoes.

Optional boosters (when installed on the MT5 PC)
  Amazon Chronos-2
  Google TimesFM 2.5

``strength_score`` is a confluence / agreement score, NOT a calibrated
win probability. High win-rate behaviour comes from refusing to trade
when specialists disagree.
"""
from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class ProviderForecast:
    name: str
    ready: bool
    direction: str = "WAIT"
    strength: float = 0.0
    move_atr: float = 0.0
    uncertainty_atr: float | None = None
    last_price: float | None = None
    forecast_price: float | None = None
    detail: str = ""
    weight: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ready": self.ready,
            "direction": self.direction,
            "strength": round(float(self.strength), 2),
            "move_atr": round(float(self.move_atr), 4),
            "uncertainty_atr": None if self.uncertainty_atr is None else round(float(self.uncertainty_atr), 4),
            "last_price": self.last_price,
            "forecast_price": self.forecast_price,
            "detail": self.detail,
            "weight": self.weight,
        }


def _ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1.0)
    out = [float(values[0])]
    for v in values[1:]:
        out.append(float(v) * k + out[-1] * (1.0 - k))
    return out


def _ema(values: list[float], period: int) -> float:
    s = _ema_series(values, period)
    return s[-1] if s else float("nan")


def _sma(values: list[float], period: int) -> float:
    if len(values) < period or period <= 0:
        return float("nan")
    return sum(values[-period:]) / period


def _rsi(values: list[float], period: int = 14) -> float:
    if len(values) < period + 1:
        return 50.0
    gains = losses = 0.0
    for i in range(len(values) - period, len(values)):
        d = values[i] - values[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    if losses <= 1e-12:
        return 100.0
    rs = (gains / period) / (losses / period)
    return 100.0 - 100.0 / (1.0 + rs)


def _atr(rates: list[dict[str, float]], period: int = 14) -> float:
    if len(rates) < period + 1:
        return float("nan")
    total = 0.0
    for i in range(len(rates) - period, len(rates)):
        prev = rates[i - 1]["close"]
        cur = rates[i]
        total += max(
            cur["high"] - cur["low"],
            abs(cur["high"] - prev),
            abs(cur["low"] - prev),
        )
    return total / period


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = sum(values) / len(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def _macd(values: list[float]) -> tuple[float, float, float]:
    if len(values) < 35:
        return 0.0, 0.0, 0.0
    e12 = _ema_series(values, 12)
    e26 = _ema_series(values, 26)
    line = [a - b for a, b in zip(e12, e26)]
    signal = _ema_series(line, 9)
    hist = line[-1] - signal[-1]
    return line[-1], signal[-1], hist


def _adx(rates: list[dict[str, float]], period: int = 14) -> float:
    if len(rates) < period * 2 + 2:
        return 0.0
    plus_dm = []
    minus_dm = []
    trs = []
    for i in range(1, len(rates)):
        up = rates[i]["high"] - rates[i - 1]["high"]
        dn = rates[i - 1]["low"] - rates[i]["low"]
        plus_dm.append(up if up > dn and up > 0 else 0.0)
        minus_dm.append(dn if dn > up and dn > 0 else 0.0)
        prev = rates[i - 1]["close"]
        trs.append(max(
            rates[i]["high"] - rates[i]["low"],
            abs(rates[i]["high"] - prev),
            abs(rates[i]["low"] - prev),
        ))
    def wilder(arr: list[float], n: int) -> float:
        if len(arr) < n:
            return 0.0
        s = sum(arr[:n])
        for x in arr[n:]:
            s = s - s / n + x
        return s / n
    atr_w = wilder(trs, period)
    if atr_w <= 1e-12:
        return 0.0
    pdi = 100.0 * wilder(plus_dm, period) / atr_w
    mdi = 100.0 * wilder(minus_dm, period) / atr_w
    denom = pdi + mdi
    dx = 0.0 if denom <= 1e-12 else 100.0 * abs(pdi - mdi) / denom
    return max(0.0, min(100.0, dx))


def _stoch(rates: list[dict[str, float]], period: int = 14) -> float:
    if len(rates) < period:
        return 50.0
    window = rates[-period:]
    hi = max(x["high"] for x in window)
    lo = min(x["low"] for x in window)
    if hi - lo <= 1e-12:
        return 50.0
    return 100.0 * (rates[-1]["close"] - lo) / (hi - lo)


def _swings(rates: list[dict[str, float]], left: int = 2, right: int = 2) -> tuple[list[float], list[float]]:
    highs: list[float] = []
    lows: list[float] = []
    n = len(rates)
    for i in range(left, n - right):
        h = rates[i]["high"]
        l = rates[i]["low"]
        if all(h >= rates[i - j]["high"] for j in range(1, left + 1)) and all(h > rates[i + j]["high"] for j in range(1, right + 1)):
            highs.append(h)
        if all(l <= rates[i - j]["low"] for j in range(1, left + 1)) and all(l < rates[i + j]["low"] for j in range(1, right + 1)):
            lows.append(l)
    return highs, lows


def _session(now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    h = now.hour
    wd = now.weekday()
    if wd == 5 or (wd == 4 and h >= 21) or (wd == 6 and h < 22):
        name, weight, note = "WEEKEND", 0.15, "بازار طلا کم‌عمق است"
    elif 12 <= h < 16:
        name, weight, note = "LONDON_NY", 1.0, "هم‌پوشانی لندن/نیویورک — بهترین نقدشوندگی طلا"
    elif 7 <= h < 12:
        name, weight, note = "LONDON", 0.92, "جلسه لندن"
    elif 16 <= h < 21:
        name, weight, note = "NEW_YORK", 0.84, "جلسه نیویورک"
    elif 0 <= h < 7:
        name, weight, note = "ASIA", 0.52, "جلسه آسیا — بیشتر رنج"
    else:
        name, weight, note = "OFF_HOURS", 0.38, "ساعات کم‌حجم"
    return {"name": name, "weight": weight, "note": note, "hour_utc": h, "weekday": wd}


def _direction_from_move(move_atr: float, threshold: float = 0.18) -> str:
    if move_atr >= threshold:
        return "BUY"
    if move_atr <= -threshold:
        return "SELL"
    return "WAIT"


def _strength(move_atr: float, uncertainty_atr: float | None) -> float:
    effect = min(1.0, abs(move_atr) / 1.10)
    if uncertainty_atr is None or not math.isfinite(uncertainty_atr):
        certainty = 0.55
    else:
        certainty = 1.0 / (1.0 + max(0.0, uncertainty_atr))
    return max(0.0, min(100.0, 100.0 * (0.68 * effect + 0.32 * certainty)))


def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _norm_bars(bars: list[dict[str, Any]]) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    for b in bars or []:
        o = b.get("open", b.get("o"))
        h = b.get("high", b.get("h"))
        l = b.get("low", b.get("l"))
        c = b.get("close", b.get("c"))
        t = b.get("time", b.get("t", 0))
        if None in (o, h, l, c):
            continue
        out.append({
            "time": float(t),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "tick_volume": float(b.get("tick_volume", b.get("v", 0)) or 0),
        })
    return out


def _spec(name: str, direction: str, strength: float, detail: str, weight: float = 1.0) -> ProviderForecast:
    return ProviderForecast(name, True, direction, _clamp(strength), 0.0, None, None, None, detail, weight)


def apex_quant_fusion(frames: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Institutional multi-specialist ensemble. Default decision is WAIT."""
    m5 = _norm_bars(frames.get("M5") or [])
    m15 = _norm_bars(frames.get("M15") or [])
    h1 = _norm_bars(frames.get("H1") or [])
    m1 = _norm_bars(frames.get("M1") or [])
    if min(len(m5), len(m15), len(h1)) < 60:
        return {
            "ok": True,
            "status": "NOT_READY",
            "decision": "WAIT",
            "strength_score": 0.0,
            "agreement": 0.0,
            "regime": {"trend": "RANGE", "strength": 0, "rsi": 50, "atr": None},
            "providers": [],
            "session": _session(),
            "thesis": "داده چندتایم‌فریم برای Apex کافی نیست.",
            "vetoes": ["DATA"],
            "model_note": "Apex Quant needs M5/M15/H1 history.",
            "generated_at": int(time.time()),
        }

    c5 = [x["close"] for x in m5]
    c15 = [x["close"] for x in m15]
    c1h = [x["close"] for x in h1]
    atr5 = _atr(m5, 14)
    atr15 = _atr(m15, 14)
    last = c5[-1]
    session = _session()

    h20, h50, h200 = _ema(c1h[-140:], 20), _ema(c1h[-180:], 50), _ema(c1h, 200) if len(c1h) >= 200 else _ema(c1h, max(20, len(c1h) // 2))
    m9, m21, m50 = _ema(c15[-100:], 9), _ema(c15[-140:], 21), _ema(c15[-180:], 50)
    e5_9 = _ema(c5[-80:], 9)
    e5_21 = _ema(c5[-100:], 21)
    rv15 = _rsi(c15, 14)
    rv5 = _rsi(c5, 14)
    adx15 = _adx(m15, 14)
    macd_l, macd_s, macd_h = _macd(c15)
    stoch15 = _stoch(m15, 14)
    bb_mid = _sma(c15, 20)
    bb_sd = _std(c15[-20:]) if len(c15) >= 20 else 0.0
    bb_up = bb_mid + 2 * bb_sd
    bb_dn = bb_mid - 2 * bb_sd
    slope_h1 = (c1h[-1] - c1h[-5]) / max(atr5, 1e-9) if len(c1h) >= 5 and math.isfinite(atr5) else 0.0
    slope_m15 = (c15[-1] - c15[-5]) / max(atr15 if math.isfinite(atr15) else atr5, 1e-9) if len(c15) >= 5 else 0.0

    if h20 > h50 and c1h[-1] > h20 and m9 > m21:
        regime_trend = "BUY"
    elif h20 < h50 and c1h[-1] < h20 and m9 < m21:
        regime_trend = "SELL"
    else:
        regime_trend = "RANGE"
    if adx15 < 16:
        regime_trend = "RANGE"
    regime_strength = _clamp(28.0 * abs(slope_h1) + 0.85 * abs(rv15 - 50.0) + 0.35 * adx15)

    specialists: list[ProviderForecast] = []

    # 1) Trend desk
    trend_dir = "WAIT"
    trend_s = 35.0
    if h20 > h50 and m9 > m21 > m50 and c1h[-1] > h20:
        trend_dir, trend_s = "BUY", 62 + min(30, adx15)
    elif h20 < h50 and m9 < m21 < m50 and c1h[-1] < h20:
        trend_dir, trend_s = "SELL", 62 + min(30, adx15)
    elif h20 > h50 and c1h[-1] > h50:
        trend_dir, trend_s = "BUY", 48 + min(18, adx15 * 0.5)
    elif h20 < h50 and c1h[-1] < h50:
        trend_dir, trend_s = "SELL", 48 + min(18, adx15 * 0.5)
    specialists.append(_spec(
        "Trend Desk", trend_dir, trend_s,
        f"H1 EMA20/50 {'bull' if h20 > h50 else 'bear'} · ADX {adx15:.1f}",
        1.45,
    ))

    # 2) Momentum desk
    mom_dir = "WAIT"
    mom_s = 30.0
    mom_buy = rv15 >= 52 and rv15 <= 68 and macd_h > 0 and slope_m15 > 0
    mom_sell = rv15 <= 48 and rv15 >= 32 and macd_h < 0 and slope_m15 < 0
    if mom_buy:
        mom_dir, mom_s = "BUY", 58 + min(28, abs(rv15 - 50))
    elif mom_sell:
        mom_dir, mom_s = "SELL", 58 + min(28, abs(rv15 - 50))
    elif macd_h > 0 and rv15 > 50:
        mom_dir, mom_s = "BUY", 44
    elif macd_h < 0 and rv15 < 50:
        mom_dir, mom_s = "SELL", 44
    specialists.append(_spec(
        "Momentum Desk", mom_dir, mom_s,
        f"RSI {rv15:.1f} · MACD hist {macd_h:.3f} · Stoch {stoch15:.0f}",
        1.25,
    ))

    # 3) Structure / SMC-lite
    highs, lows = _swings(m15, 2, 2)
    struct_dir = "WAIT"
    struct_s = 32.0
    hh = len(highs) >= 2 and highs[-1] > highs[-2]
    hl = len(lows) >= 2 and lows[-1] > lows[-2]
    lh = len(highs) >= 2 and highs[-1] < highs[-2]
    ll = len(lows) >= 2 and lows[-1] < lows[-2]
    last5 = m5[-1]
    pullback_buy = last5["close"] > e5_9 and last5["low"] <= e5_9 + max(atr5, 0.2) * 0.45 and last5["close"] > last5["open"]
    pullback_sell = last5["close"] < e5_9 and last5["high"] >= e5_9 - max(atr5, 0.2) * 0.45 and last5["close"] < last5["open"]
    if hh and hl and pullback_buy:
        struct_dir, struct_s = "BUY", 78
    elif lh and ll and pullback_sell:
        struct_dir, struct_s = "SELL", 78
    elif hh and hl:
        struct_dir, struct_s = "BUY", 56
    elif lh and ll:
        struct_dir, struct_s = "SELL", 56
    elif pullback_buy and regime_trend == "BUY":
        struct_dir, struct_s = "BUY", 60
    elif pullback_sell and regime_trend == "SELL":
        struct_dir, struct_s = "SELL", 60
    specialists.append(_spec(
        "Structure Desk", struct_dir, struct_s,
        f"{'HH/HL' if hh and hl else 'LH/LL' if lh and ll else 'mixed'} · M5 pullback {'yes' if pullback_buy or pullback_sell else 'no'}",
        1.35,
    ))

    # 4) Volatility / expansion
    vol_dir = "WAIT"
    vol_s = 28.0
    atr_ok = math.isfinite(atr5) and 0.35 <= atr5 <= 22.0
    expanding = len(m5) >= 20 and _atr(m5[-8:], 5) > _atr(m5[-20:-8], 5) * 1.08
    squeeze = bb_sd > 0 and (bb_up - bb_dn) / max(last, 1) < 0.0045
    if atr_ok and expanding and slope_m15 > 0.15:
        vol_dir, vol_s = "BUY", 64
    elif atr_ok and expanding and slope_m15 < -0.15:
        vol_dir, vol_s = "SELL", 64
    elif squeeze:
        vol_dir, vol_s = "WAIT", 22
    elif atr_ok:
        vol_dir, vol_s = regime_trend if regime_trend in ("BUY", "SELL") else "WAIT", 40
    specialists.append(_spec(
        "Volatility Desk", vol_dir, vol_s,
        f"ATR5 {atr5:.2f} · {'expansion' if expanding else 'squeeze' if squeeze else 'normal'}",
        0.95,
    ))

    # 5) Liquidity sweep + displacement
    liq_dir = "WAIT"
    liq_s = 30.0
    look = m15[-12:] if len(m15) >= 12 else m15
    prior_hi = max(x["high"] for x in look[:-1]) if len(look) > 2 else last
    prior_lo = min(x["low"] for x in look[:-1]) if len(look) > 2 else last
    sweep_high = m15[-1]["high"] > prior_hi and m15[-1]["close"] < prior_hi and m15[-1]["close"] < m15[-1]["open"]
    sweep_low = m15[-1]["low"] < prior_lo and m15[-1]["close"] > prior_lo and m15[-1]["close"] > m15[-1]["open"]
    body = abs(m5[-1]["close"] - m5[-1]["open"])
    displacement = math.isfinite(atr5) and body > atr5 * 0.72
    if sweep_low and (displacement or rv5 < 45):
        liq_dir, liq_s = "BUY", 80
    elif sweep_high and (displacement or rv5 > 55):
        liq_dir, liq_s = "SELL", 80
    elif sweep_low:
        liq_dir, liq_s = "BUY", 58
    elif sweep_high:
        liq_dir, liq_s = "SELL", 58
    specialists.append(_spec(
        "Liquidity Desk", liq_dir, liq_s,
        f"{'sweep low' if sweep_low else 'sweep high' if sweep_high else 'no sweep'} · disp {'yes' if displacement else 'no'}",
        1.15,
    ))

    # 6) Mean-reversion — only meaningful in RANGE
    mr_dir = "WAIT"
    mr_s = 24.0
    if regime_trend == "RANGE":
        if rv15 <= 28 and last <= bb_dn:
            mr_dir, mr_s = "BUY", 70
        elif rv15 >= 72 and last >= bb_up:
            mr_dir, mr_s = "SELL", 70
        elif rv15 <= 34:
            mr_dir, mr_s = "BUY", 48
        elif rv15 >= 66:
            mr_dir, mr_s = "SELL", 48
    specialists.append(_spec(
        "Mean-Revert Desk", mr_dir, mr_s,
        f"BB {'lower' if last <= bb_dn else 'upper' if last >= bb_up else 'mid'} · RSI {rv15:.1f}",
        0.80 if regime_trend == "RANGE" else 0.35,
    ))

    # 7) Session desk
    sess_dir = regime_trend if session["weight"] >= 0.8 and regime_trend in ("BUY", "SELL") else "WAIT"
    sess_s = 20 + 70 * session["weight"] if sess_dir != "WAIT" else 18 + 40 * session["weight"]
    if session["name"] == "ASIA" and regime_trend == "RANGE":
        sess_dir, sess_s = "WAIT", 25
    specialists.append(_spec("Session Desk", sess_dir, sess_s, session["note"], 0.70))

    # 8) Flow / volume proxy (tick volume or range energy)
    flow_dir = "WAIT"
    flow_s = 30.0
    vols = [x.get("tick_volume") or (x["high"] - x["low"]) for x in m5[-30:]]
    avg_v = sum(vols[:-3]) / max(1, len(vols) - 3)
    last_v = sum(vols[-3:]) / 3 if vols else 0
    impulse = avg_v > 0 and last_v > avg_v * 1.15
    if impulse and last5["close"] > last5["open"] and e5_9 > e5_21:
        flow_dir, flow_s = "BUY", 66
    elif impulse and last5["close"] < last5["open"] and e5_9 < e5_21:
        flow_dir, flow_s = "SELL", 66
    elif e5_9 > e5_21:
        flow_dir, flow_s = "BUY", 42
    elif e5_9 < e5_21:
        flow_dir, flow_s = "SELL", 42
    specialists.append(_spec(
        "Flow Desk", flow_dir, flow_s,
        f"{'impulse' if impulse else 'quiet'} · EMA9/21 {'up' if e5_9 > e5_21 else 'down'}",
        0.85,
    ))

    buy_w = sum(p.strength * p.weight for p in specialists if p.direction == "BUY")
    sell_w = sum(p.strength * p.weight for p in specialists if p.direction == "SELL")
    wait_w = sum(max(18.0, p.strength * 0.55) * p.weight for p in specialists if p.direction == "WAIT")
    total = buy_w + sell_w + wait_w
    if buy_w >= sell_w and buy_w >= wait_w:
        decision = "BUY"
        leader_w = buy_w
    elif sell_w > buy_w and sell_w >= wait_w:
        decision = "SELL"
        leader_w = sell_w
    else:
        decision = "WAIT"
        leader_w = wait_w
    agreement = 0.0 if total <= 0 else leader_w / total
    directional = [p for p in specialists if p.direction in ("BUY", "SELL")]
    same = directional and len({p.direction for p in directional}) == 1
    majority = len([p for p in directional if p.direction == decision])
    vetoes: list[str] = []

    if decision in ("BUY", "SELL") and regime_trend not in (decision, "RANGE"):
        vetoes.append("REGIME")
        decision = "WAIT"
    if decision in ("BUY", "SELL") and majority < 4:
        vetoes.append("NO_MAJORITY")
        decision = "WAIT"
    if decision in ("BUY", "SELL") and agreement < 0.46:
        vetoes.append("LOW_AGREEMENT")
        decision = "WAIT"
    if decision in ("BUY", "SELL") and session["weight"] < 0.40:
        vetoes.append("SESSION")
        decision = "WAIT"
    if decision in ("BUY", "SELL") and not atr_ok:
        vetoes.append("ATR")
        decision = "WAIT"
    # Hard conflict: Trend vs Structure opposite = stand aside
    tdesk = next(p for p in specialists if p.name == "Trend Desk")
    sdesk = next(p for p in specialists if p.name == "Structure Desk")
    if tdesk.direction in ("BUY", "SELL") and sdesk.direction in ("BUY", "SELL") and tdesk.direction != sdesk.direction:
        vetoes.append("TREND_STRUCTURE_SPLIT")
        decision = "WAIT"

    ready_s = [p.strength for p in specialists]
    avg_s = sum(ready_s) / len(ready_s)
    score = avg_s * (0.42 + 0.58 * agreement) * (0.72 + 0.28 * session["weight"])
    if decision == "WAIT":
        score = min(score, 68.0)
    if decision in ("BUY", "SELL") and same:
        score = min(100.0, score + 6.0)

    thesis_bits = []
    if decision == "WAIT":
        thesis_bits.append("کمیته Apex فعلاً ورود را رد کرد.")
        if vetoes:
            thesis_bits.append("وتو: " + ", ".join(vetoes) + ".")
        thesis_bits.append(session["note"] + ".")
        if regime_trend == "RANGE":
            thesis_bits.append("رژیم بازار رنج است؛ اجبار به معامله ممنوع.")
    else:
        side = "خرید" if decision == "BUY" else "فروش"
        thesis_bits.append(f"اجماع {majority} میز روی {side}.")
        thesis_bits.append(f"رژیم {regime_trend} · ADX {adx15:.0f} · RSI {rv15:.0f}.")
        thesis_bits.append(session["note"] + ".")
        if sweep_low or sweep_high:
            thesis_bits.append("جاروی نقدینگی تأیید شده است.")
        if pullback_buy or pullback_sell:
            thesis_bits.append("ورود روی پولبک ساختار M5 است نه تعقیب قیمت.")

    return {
        "ok": True,
        "status": "READY",
        "engine": "APEX_QUANT_FUSION",
        "decision": decision,
        "strength_score": round(_clamp(score), 2),
        "agreement": round(agreement, 4),
        "regime": {
            "trend": regime_trend,
            "strength": round(regime_strength, 2),
            "rsi": round(rv15, 2),
            "atr": None if not math.isfinite(atr5) else round(atr5, 4),
            "adx": round(adx15, 2),
        },
        "providers": [p.to_dict() for p in specialists],
        "session": session,
        "thesis": " ".join(thesis_bits),
        "vetoes": vetoes,
        "last_price": last,
        "model_note": "strength_score is confluence, not win probability. Apex stands aside on conflict.",
        "generated_at": int(time.time()),
        "cached": False,
    }


class AdvancedAIEngine:
    def __init__(self, mt5_module: Any = None):
        self.mt5 = mt5_module
        self.lock = threading.Lock()
        self.chronos = None
        self.timesfm = None
        self.timesfm_module = None
        self.chronos_error: str | None = None
        self.timesfm_error: str | None = None
        self.cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.cache_sec = max(5, int(os.getenv("ZARNEGAR_AI_CACHE_SEC", "20")))
        self.horizon = max(1, min(24, int(os.getenv("ZARNEGAR_AI_HORIZON", "6"))))
        self.context = max(128, min(2048, int(os.getenv("ZARNEGAR_AI_CONTEXT", "512"))))
        providers = os.getenv("ZARNEGAR_AI_PROVIDERS", "apex,chronos2,timesfm25")
        self.enabled = {x.strip().lower() for x in providers.split(",") if x.strip()}

    def _rates(self, symbol: str, timeframe: Any, count: int) -> list[dict[str, float]]:
        if self.mt5 is None:
            return []
        arr = self.mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
        if arr is None:
            return []
        out: list[dict[str, float]] = []
        for r in arr:
            out.append({
                "time": float(r["time"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "tick_volume": float(r["tick_volume"]),
            })
        return out

    def _load_chronos(self):
        if self.chronos is not None or self.chronos_error is not None:
            return self.chronos
        if "chronos2" not in self.enabled:
            self.chronos_error = "disabled"
            return None
        try:
            import torch
            from chronos import Chronos2Pipeline

            device = "cuda" if torch.cuda.is_available() and os.getenv("ZARNEGAR_AI_FORCE_CPU", "0") != "1" else "cpu"
            self.chronos = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map=device)
            return self.chronos
        except Exception as exc:
            self.chronos_error = f"{type(exc).__name__}: {exc}"[:240]
            return None

    def _load_timesfm(self):
        if self.timesfm is not None or self.timesfm_error is not None:
            return self.timesfm
        if "timesfm25" not in self.enabled:
            self.timesfm_error = "disabled"
            return None
        try:
            import torch
            import timesfm

            torch.set_float32_matmul_precision("high")
            model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
            model.compile(timesfm.ForecastConfig(
                max_context=max(1024, self.context),
                max_horizon=max(64, self.horizon),
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            ))
            self.timesfm_module = timesfm
            self.timesfm = model
            return model
        except Exception as exc:
            self.timesfm_error = f"{type(exc).__name__}: {exc}"[:240]
            return None

    def _chronos_forecast(self, closes: list[float], timestamps: list[int], atr_value: float) -> ProviderForecast:
        model = self._load_chronos()
        if model is None:
            return ProviderForecast("Chronos-2", False, detail=self.chronos_error or "not loaded")
        try:
            import pandas as pd

            n = min(len(closes), self.context)
            df = pd.DataFrame({
                "id": ["XAUUSD"] * n,
                "timestamp": pd.to_datetime(timestamps[-n:], unit="s", utc=True),
                "target": closes[-n:],
            })
            pred = model.predict_df(
                df,
                prediction_length=self.horizon,
                quantile_levels=[0.1, 0.5, 0.9],
                id_column="id",
                timestamp_column="timestamp",
                target="target",
            )
            last = float(closes[-1])
            point_col = "predictions" if "predictions" in pred.columns else ("0.5" if "0.5" in pred.columns else None)
            if point_col is None:
                raise RuntimeError("forecast point column missing")
            final = float(pred[point_col].iloc[-1])
            denom = max(atr_value, 1e-9)
            move_atr = (final - last) / denom
            uncertainty = None
            if "0.1" in pred.columns and "0.9" in pred.columns:
                uncertainty = float(pred["0.9"].iloc[-1] - pred["0.1"].iloc[-1]) / denom
            direction = _direction_from_move(move_atr)
            return ProviderForecast(
                "Chronos-2", True, direction, _strength(move_atr, uncertainty), move_atr,
                uncertainty, last, final, f"horizon={self.horizon}", 1.1,
            )
        except Exception as exc:
            return ProviderForecast("Chronos-2", False, detail=f"inference {type(exc).__name__}: {exc}"[:240])

    def _timesfm_forecast(self, closes: list[float], atr_value: float) -> ProviderForecast:
        model = self._load_timesfm()
        if model is None:
            return ProviderForecast("TimesFM-2.5", False, detail=self.timesfm_error or "not loaded")
        try:
            import numpy as np

            n = min(len(closes), self.context)
            point, quant = model.forecast(horizon=self.horizon, inputs=[np.asarray(closes[-n:], dtype=np.float32)])
            last = float(closes[-1])
            final = float(point[0, -1])
            denom = max(atr_value, 1e-9)
            move_atr = (final - last) / denom
            uncertainty = None
            if quant is not None and getattr(quant, "ndim", 0) == 3 and quant.shape[2] >= 10:
                uncertainty = float(quant[0, -1, 9] - quant[0, -1, 1]) / denom
            direction = _direction_from_move(move_atr)
            return ProviderForecast(
                "TimesFM-2.5", True, direction, _strength(move_atr, uncertainty), move_atr,
                uncertainty, last, final, f"horizon={self.horizon}", 1.1,
            )
        except Exception as exc:
            return ProviderForecast("TimesFM-2.5", False, detail=f"inference {type(exc).__name__}: {exc}"[:240])

    def fuse(self, frames: dict[str, list[dict[str, Any]]], symbol: str = "XAUUSD") -> dict[str, Any]:
        apex = apex_quant_fusion(frames)
        m5 = _norm_bars(frames.get("M5") or [])
        extra: list[ProviderForecast] = []
        if m5 and ("chronos2" in self.enabled or "timesfm25" in self.enabled):
            closes = [x["close"] for x in m5]
            timestamps = [int(x["time"]) for x in m5]
            atr_value = _atr(m5, 14)
            if math.isfinite(atr_value) and atr_value > 0:
                if "chronos2" in self.enabled:
                    extra.append(self._chronos_forecast(closes, timestamps, atr_value))
                if "timesfm25" in self.enabled:
                    extra.append(self._timesfm_forecast(closes, atr_value))

        ready_extra = [p for p in extra if p.ready]
        providers = list(apex.get("providers") or []) + [p.to_dict() for p in extra]
        decision = apex.get("decision") or "WAIT"
        score = float(apex.get("strength_score") or 0)
        agreement = float(apex.get("agreement") or 0)
        vetoes = list(apex.get("vetoes") or [])
        status = "READY"

        if ready_extra:
            dirs = {p.direction for p in ready_extra if p.direction in ("BUY", "SELL")}
            if len(dirs) == 1:
                foundation_dir = next(iter(dirs))
                if decision in ("BUY", "SELL") and foundation_dir != decision:
                    vetoes.append("FOUNDATION_SPLIT")
                    decision = "WAIT"
                    score = min(score, 66.0)
                elif decision == "WAIT" and foundation_dir and score >= 55:
                    # Foundations may upgrade a close call only if Apex majority was already leaning.
                    lean = max(
                        sum(p["strength"] for p in apex.get("providers") or [] if p.get("direction") == "BUY"),
                        sum(p["strength"] for p in apex.get("providers") or [] if p.get("direction") == "SELL"),
                    )
                    if lean >= 220:
                        decision = foundation_dir
                        score = min(100.0, score + 8.0)
            elif len(dirs) > 1:
                vetoes.append("FOUNDATION_DISAGREE")
                decision = "WAIT"
                score = min(score, 64.0)
            avg_f = sum(p.strength for p in ready_extra) / len(ready_extra)
            score = 0.72 * score + 0.28 * avg_f
            agreement = min(1.0, agreement + 0.04 * len(ready_extra))
        elif extra and not ready_extra:
            status = "READY"  # Apex is first-class even if foundation models are offline

        if decision == "WAIT":
            score = min(score, 69.0)

        result = dict(apex)
        result.update({
            "ok": True,
            "status": status,
            "symbol": symbol,
            "decision": decision,
            "strength_score": round(_clamp(score), 2),
            "agreement": round(agreement, 4),
            "providers": providers,
            "vetoes": vetoes,
            "foundation_ready": len(ready_extra),
            "model_note": "Apex Quant is the primary desk. Chronos/TimesFM are optional boosters. strength_score is not win probability.",
            "generated_at": int(time.time()),
            "cached": False,
        })
        return result

    def forecast_bars(self, frames: dict[str, list[dict[str, Any]]], symbol: str = "XAUUSD") -> dict[str, Any]:
        key = f"bars:{symbol}"
        now = time.time()
        cached = self.cache.get(key)
        if cached and now - cached[0] <= self.cache_sec:
            out = dict(cached[1])
            out["cached"] = True
            return out
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.time() - cached[0] <= self.cache_sec:
                out = dict(cached[1])
                out["cached"] = True
                return out
            result = self.fuse(frames, symbol)
            self.cache[key] = (time.time(), result)
            return result

    def forecast(self, symbol: str) -> dict[str, Any]:
        now = time.time()
        cached = self.cache.get(symbol)
        if cached and now - cached[0] <= self.cache_sec:
            out = dict(cached[1])
            out["cached"] = True
            return out

        with self.lock:
            cached = self.cache.get(symbol)
            if cached and time.time() - cached[0] <= self.cache_sec:
                out = dict(cached[1])
                out["cached"] = True
                return out

            if self.mt5 is None:
                return {"ok": False, "error": "AI_NO_MT5"}

            m5 = self._rates(symbol, self.mt5.TIMEFRAME_M5, max(self.context, 220))
            m15 = self._rates(symbol, self.mt5.TIMEFRAME_M15, 240)
            h1 = self._rates(symbol, self.mt5.TIMEFRAME_H1, 240)
            m1 = self._rates(symbol, self.mt5.TIMEFRAME_M1, 240)
            if min(len(m5), len(m15), len(h1)) < 80:
                return {"ok": False, "error": "AI_NOT_ENOUGH_BARS", "counts": [len(m5), len(m15), len(h1)]}

            result = self.fuse({"M1": m1, "M5": m5, "M15": m15, "H1": h1}, symbol)
            self.cache[symbol] = (time.time(), result)
            return result
