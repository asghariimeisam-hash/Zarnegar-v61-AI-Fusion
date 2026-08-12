#!/usr/bin/env python3
"""Advanced AI forecasting layer for Zarnegar v61 (Alpha Fusion).

Prediction-only. Never sends orders.

Ensemble:
  - Local Alpha (always on): multi-horizon slope, ADX, Wilder RSI, MACD,
    volume z-score, session quality, HH/HL structure.
  - Amazon Chronos-2 (optional)
  - Google TimesFM 2.5 (optional)

strength_score is agreement/forecast strength, NOT a calibrated win probability.
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
        }


def _ema(values: list[float], period: int) -> float:
    if not values:
        return float("nan")
    k = 2.0 / (period + 1.0)
    e = float(values[0])
    for v in values[1:]:
        e = float(v) * k + e * (1.0 - k)
    return e


def _wilder_rsi(values: list[float], period: int = 14) -> float:
    if len(values) < period + 1:
        return 50.0
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    avg_g = gains / period
    avg_l = losses / period
    for i in range(period + 1, len(values)):
        d = values[i] - values[i - 1]
        g = d if d > 0 else 0.0
        l = -d if d < 0 else 0.0
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
    if avg_l <= 1e-12:
        return 100.0
    rs = avg_g / avg_l
    return 100.0 - 100.0 / (1.0 + rs)


def _atr(rates: list[dict[str, float]], period: int = 14) -> float:
    if len(rates) < period + 1:
        return float("nan")
    trs: list[float] = []
    for i in range(1, len(rates)):
        prev = rates[i - 1]["close"]
        cur = rates[i]
        trs.append(max(cur["high"] - cur["low"], abs(cur["high"] - prev), abs(cur["low"] - prev)))
    if len(trs) < period:
        return float("nan")
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr


def _adx(rates: list[dict[str, float]], period: int = 14) -> float:
    if len(rates) < period * 2 + 2:
        return 0.0
    plus_dm: list[float] = []
    minus_dm: list[float] = []
    trs: list[float] = []
    for i in range(1, len(rates)):
        up = rates[i]["high"] - rates[i - 1]["high"]
        dn = rates[i - 1]["low"] - rates[i]["low"]
        plus_dm.append(up if up > dn and up > 0 else 0.0)
        minus_dm.append(dn if dn > up and dn > 0 else 0.0)
        prev = rates[i - 1]["close"]
        cur = rates[i]
        trs.append(max(cur["high"] - cur["low"], abs(cur["high"] - prev), abs(cur["low"] - prev)))
    def wilder(xs: list[float]) -> float:
        s = sum(xs[:period])
        for x in xs[period:]:
            s = s - s / period + x
        return s / period
    atr = wilder(trs)
    if atr <= 1e-12:
        return 0.0
    pdi = 100.0 * wilder(plus_dm) / atr
    mdi = 100.0 * wilder(minus_dm) / atr
    denom = pdi + mdi
    if denom <= 1e-12:
        return 0.0
    dx = 100.0 * abs(pdi - mdi) / denom
    return max(0.0, min(100.0, dx))


def _linreg_slope(values: list[float]) -> float:
    n = len(values)
    if n < 4:
        return 0.0
    sx = n * (n - 1) / 2.0
    sy = sum(values)
    sxx = (n - 1) * n * (2 * n - 1) / 6.0
    sxy = sum(i * v for i, v in enumerate(values))
    den = n * sxx - sx * sx
    if abs(den) < 1e-12:
        return 0.0
    return (n * sxy - sx * sy) / den


def _macd_hist(values: list[float]) -> float:
    if len(values) < 35:
        return 0.0
    fast = _ema(values, 12)
    slow = _ema(values, 26)
    # approximate signal as EMA of last macd path via two-pass
    macd = fast - slow
    return macd


def _direction_from_move(move_atr: float, threshold: float = 0.22) -> str:
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


def _session_quality(now: datetime | None = None) -> tuple[float, str]:
    """XAUUSD historically has cleaner directional flow in London/NY."""
    now = now or datetime.now(timezone.utc)
    h = now.hour + now.minute / 60.0
    wd = now.weekday()  # 0=Mon
    if wd >= 5:
        return 0.15, "WEEKEND"
    # Friday after 18:00 UTC — thinning liquidity
    if wd == 4 and h >= 18.0:
        return 0.25, "FRIDAY_LATE"
    # London 07–11, NY 12–17, overlap 12–16
    if 12.0 <= h < 16.5:
        return 1.0, "LONDON_NY_OVERLAP"
    if 7.0 <= h < 12.0:
        return 0.88, "LONDON"
    if 16.5 <= h < 20.0:
        return 0.72, "NY_AFTERNOON"
    if 0.5 <= h < 7.0:
        return 0.35, "ASIA"
    return 0.28, "OFF_HOURS"


class AdvancedAIEngine:
    def __init__(self, mt5_module: Any):
        self.mt5 = mt5_module
        self.lock = threading.Lock()
        self.chronos = None
        self.timesfm = None
        self.timesfm_module = None
        self.chronos_error: str | None = None
        self.timesfm_error: str | None = None
        self.cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.cache_sec = max(5, int(os.getenv("ZARNEGAR_AI_CACHE_SEC", "25")))
        self.horizon = max(1, min(24, int(os.getenv("ZARNEGAR_AI_HORIZON", "6"))))
        self.context = max(128, min(2048, int(os.getenv("ZARNEGAR_AI_CONTEXT", "512"))))
        providers = os.getenv("ZARNEGAR_AI_PROVIDERS", "local,chronos2,timesfm25")
        self.enabled = {x.strip().lower() for x in providers.split(",") if x.strip()}

    def _rates(self, symbol: str, timeframe: Any, count: int) -> list[dict[str, float]]:
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
            direction = _direction_from_move(move_atr, 0.24)
            return ProviderForecast(
                "Chronos-2", True, direction, _strength(move_atr, uncertainty), move_atr,
                uncertainty, last, final, f"horizon={self.horizon}",
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
            direction = _direction_from_move(move_atr, 0.24)
            return ProviderForecast(
                "TimesFM-2.5", True, direction, _strength(move_atr, uncertainty), move_atr,
                uncertainty, last, final, f"horizon={self.horizon}",
            )
        except Exception as exc:
            return ProviderForecast("TimesFM-2.5", False, detail=f"inference {type(exc).__name__}: {exc}"[:240])

    def _local_alpha(self, m5: list[dict[str, float]], m15: list[dict[str, float]], h1: list[dict[str, float]]) -> ProviderForecast:
        c5 = [x["close"] for x in m5]
        c15 = [x["close"] for x in m15]
        c1h = [x["close"] for x in h1]
        last = float(c5[-1])
        a = _atr(m5, 14)
        if not math.isfinite(a) or a <= 0:
            return ProviderForecast("Local-Alpha", False, detail="bad ATR")

        slope5 = _linreg_slope(c5[-24:]) / a
        slope15 = _linreg_slope(c15[-16:]) / max(_atr(m15, 14), 1e-9)
        slope1h = _linreg_slope(c1h[-20:]) / max(_atr(h1, 14), 1e-9)
        adx15 = _adx(m15, 14)
        rsi15 = _wilder_rsi(c15, 14)
        macd = _macd_hist(c15) / a
        e9, e21, e50 = _ema(c15[-90:], 9), _ema(c15[-120:], 21), _ema(c15[-180:], 50)
        h20, h50 = _ema(c1h[-120:], 20), _ema(c1h[-180:], 50)

        vols = [x.get("tick_volume", 0.0) for x in m5[-40:]]
        mean_v = sum(vols) / max(1, len(vols))
        var_v = sum((v - mean_v) ** 2 for v in vols) / max(1, len(vols))
        zvol = (vols[-1] - mean_v) / math.sqrt(var_v + 1e-9)

        # Structure: last swing vs prior
        swing_hi = max(x["high"] for x in m15[-8:])
        prev_hi = max(x["high"] for x in m15[-16:-8])
        swing_lo = min(x["low"] for x in m15[-8:])
        prev_lo = min(x["low"] for x in m15[-16:-8])
        hh_hl = swing_hi >= prev_hi and swing_lo >= prev_lo
        lh_ll = swing_hi <= prev_hi and swing_lo <= prev_lo

        sess_q, sess_name = _session_quality()

        buy_pts = 0.0
        sell_pts = 0.0
        if h20 > h50 and last > h20:
            buy_pts += 1.4
        if h20 < h50 and last < h20:
            sell_pts += 1.4
        if e9 > e21 > e50:
            buy_pts += 1.2
        if e9 < e21 < e50:
            sell_pts += 1.2
        if slope1h > 0.08:
            buy_pts += 1.0
        if slope1h < -0.08:
            sell_pts += 1.0
        if slope15 > 0.10:
            buy_pts += 0.8
        if slope15 < -0.10:
            sell_pts += 0.8
        if 48 <= rsi15 <= 68:
            buy_pts += 0.7
        if 32 <= rsi15 <= 52:
            sell_pts += 0.7
        # exhaustion penalty
        if rsi15 > 72:
            buy_pts -= 1.2
        if rsi15 < 28:
            sell_pts -= 1.2
        if macd > 0:
            buy_pts += 0.4
        else:
            sell_pts += 0.4
        if hh_hl:
            buy_pts += 0.8
        if lh_ll:
            sell_pts += 0.8
        if adx15 >= 22:
            buy_pts += 0.5
            sell_pts += 0.5
        else:
            buy_pts -= 0.6
            sell_pts -= 0.6
        if zvol > 0.4:
            buy_pts += 0.25
            sell_pts += 0.25

        buy_pts *= sess_q
        sell_pts *= sess_q

        move_atr = 0.55 * slope5 + 0.30 * slope15 + 0.15 * slope1h
        if buy_pts - sell_pts >= 1.8 and adx15 >= 18 and sess_q >= 0.70:
            direction = "BUY"
        elif sell_pts - buy_pts >= 1.8 and adx15 >= 18 and sess_q >= 0.70:
            direction = "SELL"
        else:
            direction = "WAIT"

        edge = abs(buy_pts - sell_pts)
        strength = min(96.0, max(0.0, 18.0 * edge + 0.55 * adx15 + 12.0 * sess_q))
        if direction == "WAIT":
            strength = min(strength, 64.0)
        forecast = last + move_atr * a * self.horizon / 6.0
        return ProviderForecast(
            "Local-Alpha", True, direction, strength, move_atr, max(0.35, 1.4 - adx15 / 50.0),
            last, forecast, f"session={sess_name} adx={adx15:.1f} rsi={rsi15:.1f} zvol={zvol:.2f}",
        )

    def _regime(self, m5: list[dict[str, float]], m15: list[dict[str, float]], h1: list[dict[str, float]]) -> dict[str, Any]:
        c15 = [x["close"] for x in m15]
        c1h = [x["close"] for x in h1]
        a = _atr(m5, 14)
        h20, h50 = _ema(c1h[-120:], 20), _ema(c1h[-180:], 50)
        m9, m21, m50 = _ema(c15[-90:], 9), _ema(c15[-120:], 21), _ema(c15[-180:], 50)
        rv = _wilder_rsi(c15, 14)
        adx = _adx(m15, 14)
        slope = (c15[-1] - c15[-5]) / max(a, 1e-9) if len(c15) >= 5 and math.isfinite(a) else 0.0
        if h20 > h50 and m9 > m21 > m50 and adx >= 18:
            trend = "BUY"
        elif h20 < h50 and m9 < m21 < m50 and adx >= 18:
            trend = "SELL"
        else:
            trend = "RANGE"
        strength = min(100.0, max(0.0, 28.0 * abs(slope) + 0.7 * abs(rv - 50.0) + 0.35 * adx))
        sess_q, sess_name = _session_quality()
        return {
            "trend": trend,
            "strength": round(strength, 2),
            "rsi": round(rv, 2),
            "atr": a,
            "adx": round(adx, 2),
            "session": sess_name,
            "session_q": round(sess_q, 2),
        }

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

            m5 = self._rates(symbol, self.mt5.TIMEFRAME_M5, max(self.context, 220))
            m15 = self._rates(symbol, self.mt5.TIMEFRAME_M15, 240)
            h1 = self._rates(symbol, self.mt5.TIMEFRAME_H1, 240)
            if min(len(m5), len(m15), len(h1)) < 80:
                return {"ok": False, "error": "AI_NOT_ENOUGH_BARS", "counts": [len(m5), len(m15), len(h1)]}

            closes = [x["close"] for x in m5]
            timestamps = [int(x["time"]) for x in m5]
            atr_value = _atr(m5, 14)
            if not math.isfinite(atr_value) or atr_value <= 0:
                return {"ok": False, "error": "AI_BAD_ATR"}

            providers: list[ProviderForecast] = []
            if "local" in self.enabled or True:
                providers.append(self._local_alpha(m5, m15, h1))
            if "chronos2" in self.enabled:
                providers.append(self._chronos_forecast(closes, timestamps, atr_value))
            if "timesfm25" in self.enabled:
                providers.append(self._timesfm_forecast(closes, atr_value))

            ready = [p for p in providers if p.ready]
            regime = self._regime(m5, m15, h1)

            if not ready:
                result = {
                    "ok": True,
                    "status": "DEGRADED",
                    "decision": "WAIT",
                    "strength_score": 0.0,
                    "agreement": 0.0,
                    "regime": regime,
                    "providers": [p.to_dict() for p in providers],
                    "model_note": "No model available; do not treat this as an AI signal.",
                    "generated_at": int(time.time()),
                    "cached": False,
                }
                self.cache[symbol] = (time.time(), result)
                return result

            buy_weight = sum(p.strength for p in ready if p.direction == "BUY")
            sell_weight = sum(p.strength for p in ready if p.direction == "SELL")
            wait_weight = sum(max(22.0, p.strength) for p in ready if p.direction == "WAIT")
            total = buy_weight + sell_weight + wait_weight
            leader = max(("BUY", buy_weight), ("SELL", sell_weight), ("WAIT", wait_weight), key=lambda x: x[1])
            decision = leader[0]
            agreement = 0.0 if total <= 0 else leader[1] / total

            directional_ready = [p for p in ready if p.direction in ("BUY", "SELL")]
            same_dir = directional_ready and len({p.direction for p in directional_ready}) == 1
            local = next((p for p in ready if p.name == "Local-Alpha"), None)
            regime_ok = regime["trend"] == decision
            session_ok = float(regime.get("session_q") or 0) >= 0.70
            adx_ok = float(regime.get("adx") or 0) >= 18

            # Hard consensus: any opposing foundation model vetoes the trade
            if len(directional_ready) >= 2 and not same_dir:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and local and local.direction not in (decision, "WAIT") and local.direction != decision:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and local and local.direction == "WAIT":
                decision = "WAIT"
            if decision in ("BUY", "SELL") and not regime_ok:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and not session_ok:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and not adx_ok:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and agreement < 0.62:
                decision = "WAIT"

            avg_strength = sum(p.strength for p in ready) / len(ready)
            score = avg_strength * (0.50 + 0.50 * agreement)
            if local:
                score = 0.62 * local.strength + 0.38 * score
            if decision == "WAIT":
                score = min(score, 68.0)

            foundation_ready = sum(1 for p in ready if p.name != "Local-Alpha")
            status = "READY" if foundation_ready >= 1 else "PARTIAL"

            result = {
                "ok": True,
                "status": status,
                "decision": decision,
                "strength_score": round(max(0.0, min(100.0, score)), 2),
                "agreement": round(agreement, 4),
                "regime": regime,
                "providers": [p.to_dict() for p in providers],
                "model_note": "Alpha Fusion: Local-Alpha + optional Chronos/TimesFM. strength_score is not win probability.",
                "generated_at": int(time.time()),
                "cached": False,
            }
            self.cache[symbol] = (time.time(), result)
            return result
