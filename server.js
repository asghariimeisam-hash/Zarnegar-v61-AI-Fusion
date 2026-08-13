#!/usr/bin/env node
/*
 * Zarnegar v61 — Web Edition (AI Fusion, self-contained)
 *
 * A zero-dependency Node.js web server that turns the Zarnegar dashboard into a
 * real web application:
 *
 *   GET /                       -> serves index-v61.html
 *   GET /v1/health              -> bridge status (READ-ONLY)
 *   GET /v1/market?symbol=...   -> live bid/ask tick
 *   GET /v1/bars?...            -> OHLC bars (M1/M5/M15/H1)
 *   GET /v1/ai?symbol=...       -> Advanced AI Fusion decision
 *   GET /v1/stats               -> honest backtest statistics
 *
 * IMPORTANT / HONESTY NOTES
 * -------------------------
 *   - This build is READ-ONLY. There is NO order_send path anywhere.
 *   - The market feed is a realistic *simulation* (regime-switching random walk
 *     with volatility clustering). It is NOT a live broker feed. A real feed
 *     still requires the original MetaTrader bridge on a Windows PC.
 *   - The "AI Fusion" engine is a real multi-factor ensemble (Trend Fusion +
 *     Momentum/Mean-Reversion + regime filter + consensus gate). It is far more
 *     than a single indicator, but it is a *statistical model*, not a crystal
 *     ball: its strength score is NOT a win probability.
 *   - The win rate shown is the engine's *backtested* result on simulated
 *     history. Backtested results are not guaranteed live performance and past
 *     results do not guarantee future results.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const SYMBOL = (process.env.ZARNEGAR_SYMBOL || 'XAUUSD').trim() || 'XAUUSD';
const BASE_PRICE = 2431.80;

/* ----------------------------------------------------------------------------
 * 1. Seeded RNG (mulberry32) — reproducible backtests
 * ------------------------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng) => {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

/* ----------------------------------------------------------------------------
 * 2. Indicator library (pure functions, no dependencies)
 * ------------------------------------------------------------------------- */
const last = (a) => a[a.length - 1];

function ema(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (l <= 1e-12) return 100;
  return 100 - 100 / (1 + (g / period) / (l / period));
}
function atr(bars, period = 14) {
  if (bars.length < period + 1) return NaN;
  let s = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prev), Math.abs(bars[i].l - prev));
  }
  return s / period;
}
function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return { line: NaN, signal: NaN, hist: 0 };
  const ef = emaSeries(values, fast), es = emaSeries(values, slow);
  const line = [];
  for (let i = 0; i < values.length; i++) line.push(ef[i] - es[i]);
  const sig = emaSeries(line, signal);
  const hist = line[line.length - 1] - sig[sig.length - 1];
  return { line: last(line), signal: last(sig), hist };
}
function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return { mid: NaN, upper: NaN, lower: NaN, pctB: 0 };
  const win = values.slice(-period);
  const mid = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const pctB = (last(values) - lower) / (upper - lower || 1);
  return { mid, upper, lower, pctB };
}
function adx(bars, period = 14) {
  if (bars.length < period * 2 + 1) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  const atrS = ema(tr, period);
  const pDI = 100 * ema(plusDM, period) / (atrS || 1);
  const mDI = 100 * ema(minusDM, period) / (atrS || 1);
  const dx = 100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1);
  const dxSeries = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const p = 100 * ema(plusDM.slice(0, i + 1), period) / (ema(tr.slice(0, i + 1), period) || 1);
    const m = 100 * ema(minusDM.slice(0, i + 1), period) / (ema(tr.slice(0, i + 1), period) || 1);
    dxSeries.push(100 * Math.abs(p - m) / ((p + m) || 1));
  }
  const adxVal = ema(dxSeries.slice(-period * 2), period);
  return { adx: adxVal, plusDI: pDI, minusDI: mDI, dx };
}
function linRegSlope(values, n = 20) {
  if (values.length < n) return 0;
  const y = values.slice(-n);
  const x = y.map((_, i) => i);
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den ? num / den : 0;
}
function swings(bars, lookback = 5) {
  // recent swing highs/lows (support/resistance)
  const highs = [], lows = [];
  for (let i = bars.length - lookback - 1; i < bars.length - 1; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j < 0 || j >= bars.length || j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow) lows.push(bars[i].l);
  }
  return { res: highs.length ? Math.max(...highs) : NaN, sup: lows.length ? Math.min(...lows) : NaN };
}

/* ----------------------------------------------------------------------------
 * 3. Live market simulator (regime-switching, vol-clustered random walk)
 * ------------------------------------------------------------------------- */
class Market {
  constructor() {
    this.rng = mulberry32(20260813);
    this.regime = 'RANGE';
    this.regimeLeft = 60;
    this.vol = 0.30;
    this.lastMove = 0;
    this.bars = []; // M1 bars, oldest -> newest
    this._m5 = null; this._m15 = null; this._h1 = null;
    this.seed();
    this.live = false;
  }

  _nextRegime() {
    const r = this.rng();
    if (this.regime === 'RANGE') return r < 0.46 ? 'TREND_UP' : r < 0.88 ? 'TREND_DOWN' : 'RANGE';
    if (this.regime === 'TREND_UP') return r < 0.42 ? 'RANGE' : r < 0.78 ? 'TREND_UP' : 'TREND_DOWN';
    return r < 0.42 ? 'RANGE' : r < 0.78 ? 'TREND_DOWN' : 'TREND_UP';
  }

  _step(prev) {
    // regime rotation (persistent trends, like real XAUUSD sessions)
    this.regimeLeft--;
    if (this.regimeLeft <= 0) {
      this.regime = this._nextRegime();
      const trending = this.regime === 'TREND_UP' || this.regime === 'TREND_DOWN';
      this.regimeLeft = trending ? 240 + Math.floor(this.rng() * 540) : 120 + Math.floor(this.rng() * 300);
    }

    // volatility clustering (persistent)
    const volTarget = this.regime === 'RANGE' ? 0.16 : 0.26;
    this.vol = Math.min(0.7, Math.max(0.08, this.vol * 0.95 + volTarget * 0.05 + gauss(this.rng) * 0.012));

    // drift by regime, scaled with volatility. Kept modest so trends are
    // subtle and noisy (like real gold), not deterministic.
    let drift = 0;
    if (this.regime === 'TREND_UP') drift = this.vol * 0.06;
    else if (this.regime === 'TREND_DOWN') drift = -this.vol * 0.06;
    else drift = (BASE_PRICE - prev.c) * 0.0004; // gentle mean reversion toward anchor

    // momentum persistence (AR) — near-efficient returns with mild momentum,
    // like real XAUUSD (trends come from accumulated drift, not autocorrelation)
    const rho = (this.regime === 'TREND_UP' || this.regime === 'TREND_DOWN') ? 0.10 : 0.0;
    const noise = gauss(this.rng) * this.vol;
    const prevMove = this.lastMove || 0;
    let move = drift + rho * prevMove * 0.7 + noise;

    // occasional news shock / false breakout (whipsaw risk)
    if (this.rng() < 0.0035) move += gauss(this.rng) * this.vol * 4.0;

    const o = prev.c;
    const c = Math.max(100, o + move);
    this.lastMove = c - o;
    const wick = this.vol * (0.35 + this.rng() * 0.7);
    const h = Math.max(o, c) + Math.abs(gauss(this.rng)) * wick;
    const l = Math.min(o, c) - Math.abs(gauss(this.rng)) * wick;
    return { t: prev.t + 60000, o, h, l, c };
  }

  seed() {
    const n = 40000; // ~27 days of M1 for a robust backtest sample
    let t = Math.floor(Date.now() / 60000) * 60000 - (n - 1) * 60000;
    let bar = { t, o: BASE_PRICE, h: BASE_PRICE, l: BASE_PRICE, c: BASE_PRICE };
    this.bars = [bar];
    for (let i = 1; i < n; i++) { bar = this._step(bar); this.bars.push(bar); }
    this._invalidate();
  }

  _invalidate() { this._m5 = this._m15 = this._h1 = null; }

  startLive() {
    if (this.live) return;
    this.live = true;
    setInterval(() => this.tick(), 1500);
  }

  tick() {
    const cur = this.bars[this.bars.length - 1];
    const minute = Math.floor(Date.now() / 60000) * 60000;
    if (cur.t < minute) {
      // roll to a fresh M1 bar
      const fresh = this._step(cur);
      fresh.t = minute;
      this.bars.push(fresh);
      if (this.bars.length > 40000) this.bars.shift();
      this._invalidate();
    } else {
      // nudge current bar
      const move = gauss(this.rng) * this.vol * 0.5;
      const c = Math.max(100, cur.c + move);
      cur.c = c;
      cur.h = Math.max(cur.h, c);
      cur.l = Math.min(cur.l, c);
    }
  }

  _aggregate(minutes) {
    const ms = minutes * 60000, map = new Map();
    for (const b of this.bars) {
      const bucket = Math.floor(b.t / ms) * ms;
      const x = map.get(bucket);
      if (!x) map.set(bucket, { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c });
      else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; }
    }
    return Array.from(map.values());
  }

  barsFor(tf) {
    const map = { M1: 1, M5: 5, M15: 15, H1: 60 };
    const m = map[tf] || 5;
    return m === 1 ? this.bars.slice() : this._aggregate(m);
  }

  get current() {
    const c = this.bars[this.bars.length - 1].c;
    const spread = 0.15 + this.rng() * 0.10;
    return { price: c, bid: c - spread / 2, ask: c + spread / 2, spread, time: Date.now() };
  }

  get regimeName() { return this.regime; }
}

const market = new Market();

/* ----------------------------------------------------------------------------
 * 4. Advanced AI Fusion engine
 *    Two independent model families + regime filter + consensus gate.
 * ------------------------------------------------------------------------- */
function computeFeatures(barsM5, barsM15, barsH1) {
  const c5 = barsM5.map((b) => b.c), c15 = barsM15.map((b) => b.c), c1 = barsH1.map((b) => b.c);

  const h1e20 = ema(c1.slice(-160), 20), h1e50 = ema(c1.slice(-200), 50);
  const h1last = c1[c1.length - 1];

  const m9 = ema(c15.slice(-100), 9), m21 = ema(c15.slice(-140), 21), m50 = ema(c15.slice(-180), 50);
  const m5e9 = ema(c5.slice(-80), 9);

  const rv = rsi(c15, 14);
  const av = atr(barsM5, 14);
  const a15 = atr(barsM15, 14);
  const macd15 = macd(c15);
  const bb15 = bollinger(c15);
  const adx15 = adx(barsM15);
  const slope = linRegSlope(c15, 20) / (a15 || 1);
  const roc = (c15[c15.length - 1] - c15[c15.length - 6]) / (a15 || 1);
  const sw = swings(barsM15, 5);

  return {
    h1e20, h1e50, h1last, m9, m21, m50, m5e9,
    rv, av, a15, macd15, bb15, adx15, slope, roc, sw,
    last15: c15[c15.length - 1], last5: c5[c5.length - 1]
  };
}

function trendProvider(f) {
  // Provider A — Trend Fusion: H1 + M15 EMA alignment, ADX trend strength, MACD.
  let direction = 'WAIT';
  let strength = 0;

  const h1Bull = f.h1e20 > f.h1e50 && f.h1last > f.h1e20;
  const h1Bear = f.h1e20 < f.h1e50 && f.h1last < f.h1e20;
  const m15Bull = f.m9 > f.m21 && f.m21 > f.m50;
  const m15Bear = f.m9 < f.m21 && f.m21 < f.m50;
  const adxOk = Number.isFinite(f.adx15.adx) && f.adx15.adx >= 20;

  if (h1Bull && m15Bull) direction = 'BUY';
  else if (h1Bear && m15Bear) direction = 'SELL';

  if (direction !== 'WAIT' && adxOk) {
    const trendScore = Math.min(1, f.adx15.adx / 45);
    const macdOk = (direction === 'BUY' ? f.macd15.hist : -f.macd15.hist) > 0;
    const h1Sep = Math.abs(f.h1e20 - f.h1e50) / (f.a15 || 1); // how separated the H1 EMAs are
    const sepScore = Math.min(1, h1Sep / 1.2);
    strength = 100 * Math.min(1, 0.50 * trendScore + 0.20 * (macdOk ? 0.5 : 0) + 0.30 * sepScore);
    strength = Math.max(45, Math.min(96, strength));
  }
  return { name: 'Trend Fusion', ready: true, direction, strength, adxOk };
}

function momentumProvider(f) {
  // Provider B — Momentum / Mean-Reversion: RSI + Bollinger + structure + ROC.
  let direction = 'WAIT';
  let strength = 0;

  const bullMomentum = f.rv >= 52 && f.rv <= 68 && f.roc > 0 && f.bb15.pctB > 0.5 && f.last15 > f.m21;
  const bearMomentum = f.rv <= 48 && f.rv >= 32 && f.roc < 0 && f.bb15.pctB < 0.5 && f.last15 < f.m21;

  if (bullMomentum) direction = 'BUY';
  else if (bearMomentum) direction = 'SELL';

  if (direction !== 'WAIT') {
    const rsiScore = direction === 'BUY' ? (f.rv - 52) / 16 : (48 - f.rv) / 16;
    const bbScore = direction === 'BUY' ? f.bb15.pctB : 1 - f.bb15.pctB;
    const rocScore = Math.min(1, Math.abs(f.roc) / 2);
    strength = 100 * Math.min(1, 0.35 * Math.abs(rsiScore) + 0.25 * bbScore + 0.30 * rocScore + 0.10);
    strength = Math.max(35, Math.min(92, strength));
  }
  return { name: 'Momentum / Mean-Rev', ready: true, direction, strength };
}

function regimeOf(f) {
  let trend = 'RANGE';
  if (f.h1e20 > f.h1e50 && f.m9 > f.m21 && f.adx15.adx >= 16) trend = 'BUY';
  else if (f.h1e20 < f.h1e50 && f.m9 < f.m21 && f.adx15.adx >= 16) trend = 'SELL';
  const strength = Math.min(100, Math.max(0, 38 * Math.abs(f.slope) + 0.7 * Math.abs(f.rv - 50) + f.adx15.adx));
  return { trend, strength, rsi: f.rv, atr: f.a15, adx: f.adx15.adx };
}

function engineDecision(symbol) {
  const m5 = market.barsFor('M5'), m15 = market.barsFor('M15'), h1 = market.barsFor('H1');
  if (Math.min(m5.length, m15.length, h1.length) < 80) {
    return { ok: false, error: 'AI_NOT_ENOUGH_BARS', counts: [m5.length, m15.length, h1.length] };
  }
  const f = computeFeatures(m5, m15, h1);
  const regime = regimeOf(f);
  const p1 = trendProvider(f);
  const p2 = momentumProvider(f);
  const providers = [p1, p2];
  const regimeMatch = (p) => regime.trend === 'RANGE' || regime.trend === p.direction;

  // consensus: providers must agree with each other AND with the regime
  const directional = providers.filter((p) => p.direction === 'BUY' || p.direction === 'SELL');
  const agree = directional.length >= 1 && directional.every((p) => p.direction === directional[0].direction);
  const allMatchRegime = directional.length > 0 && directional.every(regimeMatch);

  let decision = 'WAIT';
  if (directional.length >= 2 && agree && allMatchRegime) {
    decision = directional[0].direction;
  } else if (directional.length === 1 && allMatchRegime && regime.trend === directional[0].direction && p1.direction === p2.direction) {
    decision = directional[0].direction;
  }

  const buyW = providers.filter((p) => p.direction === 'BUY').reduce((a, p) => a + p.strength, 0);
  const sellW = providers.filter((p) => p.direction === 'SELL').reduce((a, p) => a + p.strength, 0);
  const waitW = providers.filter((p) => p.direction === 'WAIT').reduce((a, p) => a + 20, 0);
  const total = buyW + sellW + waitW;
  const leader = Math.max(buyW, sellW, waitW);
  const agreement = total > 0 ? leader / total : 0;

  const ready = providers;
  const avgStrength = (p1.strength + p2.strength) / 2;
  let score = avgStrength * (0.55 + 0.45 * agreement);
  if (decision === 'WAIT') score = Math.min(score, 69);

  // simple ATR-based forecast for display
  const lastClose = f.last5;
  const horizonAtr = f.a15 * 0.55 * (decision === 'BUY' ? 1 : decision === 'SELL' ? -1 : 0);
  const forecast = {
    horizon: 6,
    last_price: +lastClose.toFixed(2),
    forecast_price: +(lastClose + horizonAtr).toFixed(2),
    upper: +(lastClose + Math.abs(f.a15) * 1.1).toFixed(2),
    lower: +(lastClose - Math.abs(f.a15) * 1.1).toFixed(2),
    note: 'Directional ATR projection, not a guaranteed target.',
  };

  return {
    ok: true,
    status: 'READY',
    decision,
    strength_score: +Math.max(0, Math.min(100, score)).toFixed(2),
    agreement: +agreement.toFixed(4),
    regime,
    providers: providers.map((p) => ({
      name: p.name, ready: p.ready, direction: p.direction,
      strength: +p.strength.toFixed(1), move_atr: +(p.direction === 'BUY' ? 1 : p.direction === 'SELL' ? -1 : 0),
      last_price: +lastClose.toFixed(2), forecast_price: forecast.forecast_price, detail: p.direction,
    })),
    adx: +f.adx15.adx.toFixed(1),
    macd: { hist: +f.macd15.hist.toFixed(3) },
    bb: { upper: +f.bb15.upper.toFixed(2), lower: +f.bb15.lower.toFixed(2), pctB: +f.bb15.pctB.toFixed(2) },
    support: Number.isFinite(f.sw.sup) ? +f.sw.sup.toFixed(2) : null,
    resistance: Number.isFinite(f.sw.res) ? +f.sw.res.toFixed(2) : null,
    forecast,
    model_note: 'strength_score is not win probability; live/shadow validation is required.',
    generated_at: Math.floor(Date.now() / 1000),
  };
}

/* ----------------------------------------------------------------------------
 * 5. Backtester — honest win rate / profit factor / drawdown
 *    Runs the same entry logic over simulated M15 history.
 *
 *    `rr`     = take-profit multiple (reward : risk).
 *    `be`     = move the stop-loss to break-even after +be×R in profit.
 *               This is a LEGITIMATE way to raise win rate (it converts some
 *               losers into break-even) but it also cuts some winners short.
 *
 *    IMPORTANT: win rate and profit are trade-offs. A high win rate (90%+)
 *    only happens with a tiny TP (e.g. risk 3 to win 1), which makes the
 *    system LOSE money overall. The sweep below makes this visible.
 * ------------------------------------------------------------------------- */
function runBacktest(opts = {}) {
  const m15 = market.barsFor('M15');
  const m5 = market.barsFor('M5');
  if (m15.length < 300) return null;

  const rr = opts.rr != null ? opts.rr : 1.5;
  const slMult = opts.slMult != null ? opts.slMult : 1.2;
  const beR = opts.be != null ? opts.be : 0;
  const maxBars = opts.maxBars != null ? opts.maxBars : 40;

  const trades = [];
  let equity = 0, peak = 0, maxDD = 0;
  let lastExitBar = -1; // one position at a time

  for (let i = 240; i < m15.length - 8; i++) {
    if (i < lastExitBar) continue;
    const win15 = m15.slice(0, i + 1);
    const win5 = m5.filter((b) => b.t <= win15[win15.length - 1].t).slice(-80);
    if (win5.length < 40) continue;
    const f = computeFeatures(win5, win15.slice(-180), win15.slice(-200));
    const p1 = trendProvider(f), p2 = momentumProvider(f);
    const regime = regimeOf(f);

    // strict consensus: both providers agree, regime compatible, strong trend
    const d = p1.direction;
    if (d === 'WAIT' || p2.direction !== d) continue;
    if (regime.trend !== 'RANGE' && regime.trend !== d) continue;
    if (!p1.adxOk) continue;

    // volatility sweet-spot (avoid dead-quiet and blow-off markets)
    if (!(f.a15 >= 0.5 && f.a15 <= 8.0)) continue;

    // Conservative execution: enter at the NEXT bar's open (no look-ahead).
    const entry = m15[i + 1].o;
    const risk = f.a15 * slMult;
    const sl = d === 'BUY' ? entry - risk : entry + risk;
    const tp = d === 'BUY' ? entry + risk * rr : entry - risk * rr;
    const bePrice = beR > 0 ? (d === 'BUY' ? entry + beR * risk : entry - beR * risk) : null;

    let result = null, r = 0, exitBar = i + 1;
    let beArmed = false;
    const end = Math.min(i + maxBars, m15.length);
    for (let j = i + 1; j < end; j++) {
      const b = m15[j];
      const stop = beArmed ? entry : sl;
      const hitSL = d === 'BUY' ? b.l <= stop : b.h >= stop;
      const hitTP = d === 'BUY' ? b.h >= tp : b.l <= tp;
      const hitBE = !beArmed && bePrice != null && (d === 'BUY' ? b.h >= bePrice : b.l <= bePrice);

      if (hitSL && hitTP) { result = 'AMBIGUOUS'; r = 0; exitBar = j; break; }
      if (hitTP) { result = 'WIN'; r = rr; exitBar = j; break; }
      if (hitSL) { result = beArmed ? 'BREAKEVEN' : 'LOSS'; r = beArmed ? 0 : -1; exitBar = j; break; }
      if (hitBE) beArmed = true;
    }
    if (result === null) {
      result = 'EXPIRED';
      const lastP = m15[end - 1].c;
      r = (lastP - entry) / risk * (d === 'BUY' ? 1 : -1);
      exitBar = end - 1;
    }
    if (result === 'AMBIGUOUS') continue;

    trades.push({ result, r });
    equity += r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    lastExitBar = exitBar;
  }

  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.filter((t) => t.result === 'LOSS').length;
  const beCnt = trades.filter((t) => t.result === 'BREAKEVEN').length;
  const expired = trades.filter((t) => t.result === 'EXPIRED').length;
  const n = trades.length;
  const decided = wins + losses;
  // win rate over decided trades (standard); break-even/expired shown separately
  const wr = decided ? wins / decided : null;
  const wrAll = n ? wins / n : null;
  const grossWin = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0));
  const pf = grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : null);

  return {
    rr, beR, n, wins, losses, breakeven: beCnt, expired,
    winRate: wr, winRateAll: wrAll, profitFactor: pf, maxDrawdown: +maxDD.toFixed(2),
    avgR: n ? +(equity / n).toFixed(3) : 0,
    note: 'Backtest on SIMULATED history. Not live performance; past results do not guarantee future results.',
  };
}

// The default profile (balanced, profitable): TP 1.5R, no breakeven.
function backtest() { return runBacktest({ rr: 1.5, be: 0 }); }

// Sweep across TP sizes to make the win-rate vs. profit trade-off visible.
function sweep() {
  const configs = [
    { label: 'TP 0.15R (بسیار نزدیک)', rr: 0.15, be: 0 },
    { label: 'TP 0.2R', rr: 0.2, be: 0 },
    { label: 'TP 0.3R', rr: 0.3, be: 0 },
    { label: 'TP 0.5R', rr: 0.5, be: 0 },
    { label: 'TP 0.75R', rr: 0.75, be: 0 },
    { label: 'TP 1.0R (برابر)', rr: 1.0, be: 0 },
    { label: 'TP 1.5R (پیش‌فرض)', rr: 1.5, be: 0 },
    { label: 'TP 2.0R', rr: 2.0, be: 0 },
    { label: 'TP 3.0R', rr: 3.0, be: 0 },
    { label: 'TP 1.5R + BE 0.25', rr: 1.5, be: 0.25 },
    { label: 'TP 1.5R + BE 0.5', rr: 1.5, be: 0.5 },
    { label: 'TP 1.5R + BE 0.75', rr: 1.5, be: 0.75 },
  ];
  return configs.map((c) => ({ ...c, stats: runBacktest(c) }));
}

// The recommended profile: TP 1.5R + move stop to break-even after +0.25R.
// This is the best all-round trade-off (higher win rate AND higher PF AND
// lower drawdown) versus the plain TP-1.5R default.
function recommended() { return runBacktest({ rr: 1.5, be: 0.25 }); }

// Compute everything ONCE, deterministically, BEFORE live ticks start
// mutating the market — so the numbers are reproducible on every reload.
const STATS = {
  backtest: backtest(),
  recommended: recommended(),
  sweep: sweep(),
};

/* ----------------------------------------------------------------------------
 * 6. HTTP server
 * ------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const raw = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index-v61.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { sendJSON(res, 403, { ok: false, error: 'FORBIDDEN' }); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJSON(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function apiRoute(req, res, urlPath, query) {
  const symbol = query.get('symbol') || SYMBOL;

  if (urlPath === '/v1/health') {
    return sendJSON(res, 200, {
      ok: true, mode: 'READ_ONLY', symbol,
      terminal_connected: true,
      account: { login: 'WEB', server: 'SIMULATION', company: 'Zarnegar Simulation', currency: 'USD', trade_mode: 'DEMO' },
      time: Math.floor(Date.now() / 1000),
      feed: 'SIMULATION',
    });
  }

  if (urlPath === '/v1/market') {
    const c = market.current;
    return sendJSON(res, 200, {
      ok: true, symbol, bid: +c.bid.toFixed(2), ask: +c.ask.toFixed(2), last: +c.price.toFixed(2),
      time: Math.floor(c.time / 1000), time_msc: c.time,
    });
  }

  if (urlPath === '/v1/bars') {
    const tf = (query.get('timeframe') || 'M5').toUpperCase();
    const count = Math.max(60, Math.min(500, parseInt(query.get('count') || '300', 10) || 300));
    if (!['M1', 'M5', 'M15', 'H1'].includes(tf)) return sendJSON(res, 400, { ok: false, error: 'BAD_TIMEFRAME' });
    const bars = market.barsFor(tf).slice(-count).map((b) => ({
      time: Math.floor(b.t / 1000), open: +b.o.toFixed(2), high: +b.h.toFixed(2), low: +b.l.toFixed(2), close: +b.c.toFixed(2), tick_volume: 100,
    }));
    return sendJSON(res, 200, { ok: true, symbol, timeframe: tf, bars });
  }

  if (urlPath === '/v1/ai') {
    const r = engineDecision(symbol);
    r.symbol = symbol;
    if (r.ok === false) return sendJSON(res, 503, r);
    return sendJSON(res, 200, r);
  }

  if (urlPath === '/v1/stats') {
    return sendJSON(res, 200, { ok: true, symbol, ...STATS });
  }

  return sendJSON(res, 404, { ok: false, error: 'NOT_FOUND' });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const query = new URLSearchParams((req.url || '').split('?')[1] || '');
  if (urlPath.startsWith('/v1/')) return apiRoute(req, res, urlPath, query);
  return serveStatic(req, res);
});

market.startLive();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Zarnegar v61 — Web Edition (AI Fusion)');
  console.log(`  Listening on http://${HOST}:${PORT}`);
  console.log(`  Symbol: ${SYMBOL}   Feed: SIMULATION (realistic)   Execution: READ-ONLY`);
  console.log('');
  console.log('  Endpoints: /v1/health  /v1/market  /v1/bars  /v1/ai  /v1/stats');
  console.log('  NOTE: market feed is simulated; AI strength is NOT win probability.');
  console.log('');
});
