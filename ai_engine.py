#!/usr/bin/env python3
"""Advanced AI forecasting layer for Zarnegar v61.

This module is intentionally prediction-only. It never sends orders.
It can combine two modern time-series foundation models when installed:
  - Amazon Chronos-2
  - Google TimesFM 2.5

The returned ``strength_score`` is an ensemble agreement/forecast-strength
score, NOT a calibrated probability of winning a trade.
"""
from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass
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


def _direction_from_move(move_atr: float, threshold: float = 0.18) -> str:
    if move_atr >= threshold:
        return "BUY"
    if move_atr <= -threshold:
        return "SELL"
    return "WAIT"


def _strength(move_atr: float, uncertainty_atr: float | None) -> float:
    # Deliberately not a probability. High only when effect size is meaningful
    # and forecast interval is reasonably tight.
    effect = min(1.0, abs(move_atr) / 1.10)
    if uncertainty_atr is None or not math.isfinite(uncertainty_atr):
        certainty = 0.55
    else:
        certainty = 1.0 / (1.0 + max(0.0, uncertainty_atr))
    return max(0.0, min(100.0, 100.0 * (0.68 * effect + 0.32 * certainty)))


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
        self.cache_sec = max(5, int(os.getenv("ZARNEGAR_AI_CACHE_SEC", "30")))
        self.horizon = max(1, min(24, int(os.getenv("ZARNEGAR_AI_HORIZON", "6"))))
        self.context = max(128, min(2048, int(os.getenv("ZARNEGAR_AI_CONTEXT", "512"))))
        providers = os.getenv("ZARNEGAR_AI_PROVIDERS", "chronos2,timesfm25")
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
        except Exception as exc:  # model/dependency/network errors are reported, not fatal
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
                # Official example: mean, then 10th through 90th quantiles.
                uncertainty = float(quant[0, -1, 9] - quant[0, -1, 1]) / denom
            direction = _direction_from_move(move_atr)
            return ProviderForecast(
                "TimesFM-2.5", True, direction, _strength(move_atr, uncertainty), move_atr,
                uncertainty, last, final, f"horizon={self.horizon}",
            )
        except Exception as exc:
            return ProviderForecast("TimesFM-2.5", False, detail=f"inference {type(exc).__name__}: {exc}"[:240])

    def _regime(self, m5: list[dict[str, float]], m15: list[dict[str, float]], h1: list[dict[str, float]]) -> dict[str, Any]:
        c5 = [x["close"] for x in m5]
        c15 = [x["close"] for x in m15]
        c1h = [x["close"] for x in h1]
        a = _atr(m5, 14)
        h20, h50 = _ema(c1h[-120:], 20), _ema(c1h[-180:], 50)
        m9, m21, m50 = _ema(c15[-90:], 9), _ema(c15[-120:], 21), _ema(c15[-180:], 50)
        rv = _rsi(c15, 14)
        slope = (c15[-1] - c15[-5]) / max(a, 1e-9) if len(c15) >= 5 and math.isfinite(a) else 0.0
        if h20 > h50 and m9 > m21 > m50:
            trend = "BUY"
        elif h20 < h50 and m9 < m21 < m50:
            trend = "SELL"
        else:
            trend = "RANGE"
        strength = min(100.0, max(0.0, 35.0 * abs(slope) + 0.9 * abs(rv - 50.0)))
        return {"trend": trend, "strength": round(strength, 2), "rsi": round(rv, 2), "atr": a}

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

            providers = [
                self._chronos_forecast(closes, timestamps, atr_value),
                self._timesfm_forecast(closes, atr_value),
            ]
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
                    "model_note": "No foundation model is available; do not treat this as an AI signal.",
                    "generated_at": int(time.time()),
                    "cached": False,
                }
                self.cache[symbol] = (time.time(), result)
                return result

            buy_weight = sum(p.strength for p in ready if p.direction == "BUY")
            sell_weight = sum(p.strength for p in ready if p.direction == "SELL")
            wait_weight = sum(max(20.0, p.strength) for p in ready if p.direction == "WAIT")
            total = buy_weight + sell_weight + wait_weight
            leader = max(("BUY", buy_weight), ("SELL", sell_weight), ("WAIT", wait_weight), key=lambda x: x[1])
            decision = leader[0]
            agreement = 0.0 if total <= 0 else leader[1] / total

            # Require model consensus plus regime compatibility. This is designed
            # to prefer WAIT over forcing a trade.
            directional_ready = [p for p in ready if p.direction in ("BUY", "SELL")]
            same_dir = directional_ready and len({p.direction for p in directional_ready}) == 1
            regime_ok = regime["trend"] == decision or regime["trend"] == "RANGE"
            if len(ready) >= 2 and not same_dir:
                decision = "WAIT"
            if decision in ("BUY", "SELL") and not regime_ok:
                decision = "WAIT"

            avg_strength = sum(p.strength for p in ready) / len(ready)
            score = avg_strength * (0.55 + 0.45 * agreement)
            if decision == "WAIT":
                score = min(score, 69.0)

            result = {
                "ok": True,
                "status": "READY" if len(ready) >= 2 else "PARTIAL",
                "decision": decision,
                "strength_score": round(max(0.0, min(100.0, score)), 2),
                "agreement": round(agreement, 4),
                "regime": regime,
                "providers": [p.to_dict() for p in providers],
                "model_note": "strength_score is not win probability; live/shadow validation is required.",
                "generated_at": int(time.time()),
                "cached": False,
            }
            self.cache[symbol] = (time.time(), result)
            return result
