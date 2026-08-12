(() => {
'use strict';

const KEY = 'zarnegar.v61.personal.state';
const PREV_KEY = 'zarnegar.v59.personal.state';
const DEF = {
  version: 'v61-apex',
  symbol: 'XAUUSD',
  price: 4404.70,
  appMode: 'SIGNAL',
  feedMode: 'ONLINE_AI',
  executionEnabled: false,
  autoScan: true,
  broker: { name: 'Alpari', platform: 'UNSET', status: 'NOT_CONFIGURED', bridgeStatus: 'OFFLINE' },
  market: {
    status: 'CONNECTING', resolvedSymbol: 'XAUUSD', bid: null, ask: null, spread: null,
    tickTime: null, lastError: null, bridgeConfigured: false, hasToken: false,
    source: null, quality: null, venue: null
  },
  settings: {
    minQuality: 86, maxSpread: 0.90, minAtr: 0.35, maxAtr: 18.0, maxRiskPct: 0.35,
    entryWindowSec: 75, minRR: 1.60, validationMinTrades: 200, validationTargetWR: 0.90,
    validationMinPF: 1.50, validationMaxDD: 8, newsLock: false, keepScreenOn: true,
    minAiScore: 68, aiRefreshSec: 20, sound: true
  },
  ai: {
    enabled: true, status: 'NOT_READY', decision: 'WAIT', strengthScore: 0, agreement: 0,
    regime: null, providers: [], generatedAt: null, receivedAt: null, lastError: null,
    note: 'AI strength is not win probability', thesis: '', vetoes: [], session: null
  },
  history: [], journal: [], audit: [],
  session: { startedAt: null, cycles: 0, signals: 0, noTrades: 0 },
  ui: { tab: 'home' },
  trade: { confirm: false, lastPrepared: null }
};

const state = load();
let frames = { M1: [], M5: [], M15: [], H1: [] };
let lastCycle = state.history.at(-1) || null;
let livePreview = null;
let countdownLeft = 0;
let pollTimer = null, countdownTimer = null, simTimer = null, aiTimer = null, barsTimer = null;
let requestPending = false, aiPending = false, barsPending = false;
let requestStartedAt = 0;
let lastPx = state.price;
let pxDir = 0;
let publicPending = {};
let tickTape = [];
let lastSaveAt = 0;
let saveDirty = false;
let lastPatchedSig = null;
let serverFeedOk = null;

document.documentElement.lang = 'fa';

function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(PREV_KEY) || '{}';
    const s = merge(JSON.parse(raw));
    if (!localStorage.getItem(KEY) && localStorage.getItem(PREV_KEY)) localStorage.setItem(KEY, JSON.stringify(s));
    return s;
  } catch { return merge({}); }
}
function merge(x) {
  const s = { ...DEF, ...x };
  s.settings = { ...DEF.settings, ...(x.settings || {}) };
  s.session = { ...DEF.session, ...(x.session || {}) };
  s.ui = { ...DEF.ui, ...(x.ui || {}) };
  s.broker = { ...DEF.broker, ...(x.broker || {}) };
  s.market = { ...DEF.market, ...(x.market || {}) };
  s.trade = { ...DEF.trade, ...(x.trade || {}) };
  s.ai = { ...DEF.ai, ...(x.ai || {}) };
  s.ai.providers = Array.isArray(s.ai.providers) ? s.ai.providers : [];
  s.ai.vetoes = Array.isArray(s.ai.vetoes) ? s.ai.vetoes : [];
  s.history = Array.isArray(s.history) ? s.history.slice(-2500) : [];
  s.journal = Array.isArray(s.journal) ? s.journal.slice(-700) : [];
  s.audit = Array.isArray(s.audit) ? s.audit.slice(-3000) : [];
  if (!['ONLINE_AI', 'MT5_BRIDGE', 'SIMULATION'].includes(s.feedMode)) s.feedMode = 'ONLINE_AI';
  s.executionEnabled = false;
  s.trade.confirm = false;
  s.version = 'v61-apex';
  return s;
}
function save() {
  lastSaveAt = Date.now(); saveDirty = false;
  localStorage.setItem(KEY, JSON.stringify(state));
  try { AndroidBridge?.stateChanged?.(); } catch (_) {}
}
function saveSoft() {
  if (Date.now() - lastSaveAt < 12000) { saveDirty = true; return; }
  save();
}
function flushSave() { if (saveDirty) save(); }
function esc(x) { return String(x ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function fmt(n, d=2) { return Number.isFinite(+n) ? (+n).toFixed(d) : '—'; }
function pct(n) { return Number.isFinite(+n) ? ((+n) * 100).toFixed(1) + '%' : '—'; }
function faTime(d=Date.now()) { return new Date(d).toLocaleTimeString('fa-IR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
function native(action, payload) {
  try {
    if (action === 'vibrate') AndroidBridge?.vibrate?.();
    if (action === 'toast') AndroidBridge?.toast?.(String(payload || ''));
    if (action === 'share') AndroidBridge?.share?.(String(payload || ''));
  } catch (_) {}
}
function online() { try { return !!AndroidBridge?.isOnline?.(); } catch (_) { return navigator.onLine !== false; } }
function hasNative() { try { return typeof AndroidBridge !== 'undefined' && !!AndroidBridge.requestMarket; } catch (_) { return false; } }
function applyKeepScreen(){ try { AndroidBridge?.setKeepScreenOn?.(!!state.settings.keepScreenOn); } catch(_){} }
function beep(kind='signal') {
  if (state.settings.sound === false) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = kind === 'signal' ? 880 : 520;
    g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.stop(ctx.currentTime + 0.24); setTimeout(() => ctx.close?.(), 400);
  } catch (_) {}
}
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast'; el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(showToast._t); showToast._t = setTimeout(() => el.classList.remove('show'), 3200);
}
function tfBias(bars) {
  if (!bars || bars.length < 24) return { dir: '—', cls: 'neutral' };
  const c = bars.map(x => x.c);
  const e9 = ema(c.slice(-80), 9), e21 = ema(c.slice(-100), 21);
  if (e9 > e21 && c.at(-1) > e9) return { dir: 'BUY', cls: 'ok' };
  if (e9 < e21 && c.at(-1) < e9) return { dir: 'SELL', cls: 'redTxt' };
  return { dir: 'FLAT', cls: 'neutral' };
}
function mtfStripInner() {
  const rows = [['M1', frames.M1], ['M5', frames.M5], ['M15', frames.M15], ['H1', frames.H1]];
  return rows.map(([n, b]) => {
    const x = tfBias(b);
    return `<div><small>${n}</small><b class="${x.cls}">${x.dir}</b></div>`;
  }).join('');
}
function tickTapeHtml() {
  if (!tickTape.length) return '<span>—</span>';
  return tickTape.slice(-18).reverse().map(t =>
    `<span class="${t.d>=0?'up':'dn'}">${fmt(t.p,2)} ${t.d>=0?'▲':'▼'}</span>`
  ).join('');
}
function equitySvg() {
  const xs = state.history.filter(x => x.resolution && (x.resolution.result==='WIN'||x.resolution.result==='LOSS'));
  if (xs.length < 2) return '<div class="empty" style="padding:16px">منحنی سرمایه بعد از چند Shadow Trade ظاهر می‌شود</div>';
  let eq = 0; const pts = xs.map(x => (eq += (+x.resolution.rMultiple || 0), eq));
  const w = 640, h = 72, min = Math.min(0, ...pts), max = Math.max(0, ...pts), rng = max - min || 1;
  const line = pts.map((v,i) => `${(i/(pts.length-1))*w},${h-8-((v-min)/rng)*(h-16)}`).join(' ');
  const col = eq >= 0 ? '#3ee0a8' : '#ff6b7d';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${line}" fill="none" stroke="${col}" stroke-width="2"/></svg>`;
}
function liveMissHtml() {
  const p = livePreview || (dataReady() ? pipeline() : null);
  livePreview = p;
  if (!p?.candidate) return '<b>LIVE SETUP</b><div class="mini">در انتظار داده…</div>';
  const c = p.candidate;
  if (c.status === 'SIGNAL') return `<b>A+ READY · ${esc(c.direction)}</b><div class="mini">Quality ${fmt(c.quality,0)} — Auto Scan در صورت فعال بودن ثبت می‌کند.</div>`;
  const rs = (c.reasons || []).slice(0, 4);
  return `<b>WAIT · Q${fmt(c.quality,0)}</b><ul class="reasonList">${rs.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
}
function setTxt(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (text != null && el.textContent !== String(text)) el.textContent = String(text);
  if (cls != null) el.className = cls;
  return true;
}
function isOnlineMode() { return state.feedMode === 'ONLINE_AI'; }
function isLiveFeed() { return state.feedMode === 'ONLINE_AI' || state.feedMode === 'MT5_BRIDGE'; }

function ema(vals, p) {
  if (!vals.length) return NaN;
  const k = 2 / (p + 1); let e = vals[0];
  for (let i=1;i<vals.length;i++) e = vals[i]*k + e*(1-k);
  return e;
}
function emaSeries(vals, p) {
  if (!vals.length) return [];
  const k = 2 / (p + 1); const out = [vals[0]];
  for (let i=1;i<vals.length;i++) out.push(vals[i]*k + out[i-1]*(1-k));
  return out;
}
function sma(vals, p) { return vals.length < p ? NaN : vals.slice(-p).reduce((a,b)=>a+b,0)/p; }
function stdev(vals) {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.reduce((s,x)=>s+(x-m)*(x-m),0)/(vals.length-1));
}
function rsi(vals, p=14) {
  if (vals.length < p + 1) return 50;
  let g=0,l=0;
  for (let i=vals.length-p;i<vals.length;i++) { const d=vals[i]-vals[i-1]; if (d>0) g+=d; else l-=d; }
  if (l===0) return 100;
  const rs=(g/p)/(l/p); return 100-(100/(1+rs));
}
function atr(bars, p=14) {
  if (bars.length < p + 1) return NaN;
  let s=0;
  for (let i=bars.length-p;i<bars.length;i++) {
    const prev=bars[i-1].c;
    s += Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-prev), Math.abs(bars[i].l-prev));
  }
  return s/p;
}
function macd(vals) {
  if (vals.length < 35) return { line:0, signal:0, hist:0 };
  const e12=emaSeries(vals,12), e26=emaSeries(vals,26);
  const line=e12.map((v,i)=>v-e26[i]);
  const sig=emaSeries(line,9);
  return { line:line.at(-1), signal:sig.at(-1), hist:line.at(-1)-sig.at(-1) };
}
function adx(bars, p=14) {
  if (bars.length < p*2+2) return 0;
  const plus=[], minus=[], tr=[];
  for (let i=1;i<bars.length;i++) {
    const up=bars[i].h-bars[i-1].h, dn=bars[i-1].l-bars[i].l;
    plus.push(up>dn && up>0 ? up : 0);
    minus.push(dn>up && dn>0 ? dn : 0);
    const prev=bars[i-1].c;
    tr.push(Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-prev), Math.abs(bars[i].l-prev)));
  }
  const wilder=(arr,n)=>{ if(arr.length<n) return 0; let s=arr.slice(0,n).reduce((a,b)=>a+b,0); for(let i=n;i<arr.length;i++) s=s-s/n+arr[i]; return s/n; };
  const a=wilder(tr,p); if(a<=1e-12) return 0;
  const pdi=100*wilder(plus,p)/a, mdi=100*wilder(minus,p)/a;
  const d=pdi+mdi; return d<=1e-12 ? 0 : Math.max(0, Math.min(100, 100*Math.abs(pdi-mdi)/d));
}
function stoch(bars, p=14) {
  if (bars.length < p) return 50;
  const w=bars.slice(-p); const hi=Math.max(...w.map(x=>x.h)), lo=Math.min(...w.map(x=>x.l));
  if (hi-lo<=1e-12) return 50;
  return 100*(bars.at(-1).c-lo)/(hi-lo);
}
function swings(bars, left=2, right=2) {
  const highs=[], lows=[];
  for (let i=left;i<bars.length-right;i++) {
    const h=bars[i].h, l=bars[i].l;
    let isH=true, isL=true;
    for (let j=1;j<=left;j++) { if (h<bars[i-j].h) isH=false; if (l>bars[i-j].l) isL=false; }
    for (let j=1;j<=right;j++) { if (h<=bars[i+j].h) isH=false; if (l>=bars[i+j].l) isL=false; }
    if (isH) highs.push(h); if (isL) lows.push(l);
  }
  return { highs, lows };
}
function sessionInfo(d=new Date()) {
  const h=d.getUTCHours(), wd=d.getUTCDay();
  if (wd===6 || (wd===5 && h>=21) || (wd===0 && h<22)) return { name:'WEEKEND', weight:0.15, note:'بازار طلا کم‌عمق است' };
  if (h>=12 && h<16) return { name:'LONDON_NY', weight:1, note:'هم‌پوشانی لندن/نیویورک — بهترین نقدشوندگی طلا' };
  if (h>=7 && h<12) return { name:'LONDON', weight:0.92, note:'جلسه لندن' };
  if (h>=16 && h<21) return { name:'NEW_YORK', weight:0.84, note:'جلسه نیویورک' };
  if (h>=0 && h<7) return { name:'ASIA', weight:0.52, note:'جلسه آسیا — بیشتر رنج' };
  return { name:'OFF_HOURS', weight:0.38, note:'ساعات کم‌حجم' };
}

function seedSimulation(price, n=4200) {
  const out=[]; let p=price || 4404.7;
  let t=Math.floor((Date.now()-n*60000)/60000)*60000;
  for (let i=0;i<n;i++,t+=60000) {
    const slow=Math.sin(i/170)*0.22+Math.sin(i/47)*0.10;
    const shock=(Math.random()-.5)*1.05;
    const o=p; p=Math.max(100,p+slow+shock);
    const range=.35+Math.random()*1.15;
    out.push({t,o,h:Math.max(o,p)+Math.random()*range,l:Math.min(o,p)-Math.random()*range,c:p});
  }
  return out;
}
function aggregateSeries(src, minutes) {
  const ms=minutes*60000, map=new Map();
  for (const b of src) {
    const bucket=Math.floor(b.t/ms)*ms;
    const x=map.get(bucket);
    if (!x) map.set(bucket,{t:bucket,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v||1});
    else { x.h=Math.max(x.h,b.h); x.l=Math.min(x.l,b.l); x.c=b.c; x.v=(x.v||0)+(b.v||1); }
  }
  return Array.from(map.values()).slice(-500);
}
function pointsToBars(points, minutes) {
  const ms=minutes*60000, map=new Map();
  for (const row of points) {
    const t=Array.isArray(row)?+row[0]:+row.t;
    const p=Array.isArray(row)?+row[1]:+row.p;
    if (!Number.isFinite(t)||!Number.isFinite(p)) continue;
    const bucket=Math.floor(t/ms)*ms;
    const x=map.get(bucket);
    if (!x) map.set(bucket,{t:bucket,o:p,h:p,l:p,c:p,v:1});
    else { x.h=Math.max(x.h,p); x.l=Math.min(x.l,p); x.c=p; x.v++; }
  }
  return Array.from(map.values());
}
function initSimulation() {
  const m1=seedSimulation(state.price, 4200);
  frames.M1=m1.slice(-500);
  frames.M5=aggregateSeries(m1,5);
  frames.M15=aggregateSeries(m1,15);
  frames.H1=aggregateSeries(m1,60);
  const last=frames.M1.at(-1);
  state.price=last.c;
  const spread=.18+Math.random()*.16;
  state.market={ ...state.market, status:'SIMULATION', resolvedSymbol:'XAUUSD', source:'SIM', quality:'LAB',
    bid:last.c-spread/2, ask:last.c+spread/2, spread, tickTime:Date.now(), lastError:null };
}
function upsertBar(tf, bar, max=500) {
  const a=frames[tf], last=a.at(-1);
  if (last && last.t===bar.t) { last.h=Math.max(last.h,bar.h); last.l=Math.min(last.l,bar.l); last.c=bar.c; if(bar.v) last.v=(last.v||0)+bar.v; }
  else { a.push({...bar}); if (a.length>max) a.splice(0,a.length-max); }
}
function upsertTickToFrame(tf, minutes, mid, t) {
  const bucket=Math.floor(t/(minutes*60000))*(minutes*60000), a=frames[tf], last=a.at(-1);
  if (last && last.t===bucket) { last.h=Math.max(last.h,mid); last.l=Math.min(last.l,mid); last.c=mid; return false; }
  a.push({t:bucket,o:mid,h:mid,l:mid,c:mid,v:1}); if (a.length>500) a.shift(); return true;
}
function simulationStep() {
  if (state.feedMode!=='SIMULATION') return;
  const last=frames.M1.at(-1), o=last.c;
  const bias=(ema(frames.M15.map(x=>x.c),9)-ema(frames.M15.map(x=>x.c),21))*0.025;
  const c=Math.max(100,o+bias+(Math.random()-.49)*1.05), range=.28+Math.random()*1.05;
  const b={t:last.t+60000,o,h:Math.max(o,c)+Math.random()*range,l:Math.min(o,c)-Math.random()*range,c};
  frames.M1.push(b); if(frames.M1.length>500) frames.M1.shift();
  for (const [tf,min] of [['M5',5],['M15',15],['H1',60]]) {
    const bucket=Math.floor(b.t/(min*60000))*(min*60000);
    upsertBar(tf,{t:bucket,o:b.o,h:b.h,l:b.l,c:b.c});
  }
  const spread=.16+Math.random()*.18;
  lastPx=state.price; pxDir=c-state.price;
  state.price=c; state.market.bid=c-spread/2; state.market.ask=c+spread/2; state.market.spread=spread; state.market.tickTime=Date.now();
  evaluateOpenSignalsBar(b, true);
  runLocalAi();
  maybeAutoCycle();
  saveSoft(); render(false);
}

function currentSource() { return state.feedMode==='SIMULATION' ? 'SIMULATION' : 'SHADOW'; }
function metrics(source) {
  const xs=state.history.filter(x=>x.source===source && x.resolution && (x.resolution.result==='WIN'||x.resolution.result==='LOSS'));
  const wins=xs.filter(x=>x.resolution.result==='WIN').length, losses=xs.length-wins;
  const wr=xs.length?wins/xs.length:null;
  let grossWin=0,grossLoss=0,equity=0,peak=0,maxDD=0;
  for (const x of xs){ const r=+x.resolution.rMultiple||0; equity+=r; if(r>0)grossWin+=r; else grossLoss+=Math.abs(r); peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity); }
  return { n:xs.length, wins, losses, wr, pf:grossLoss?grossWin/grossLoss:(grossWin?Infinity:null), maxDD };
}
function validation() {
  const m=metrics('SHADOW');
  const pass=m.n>=state.settings.validationMinTrades && m.wr>=state.settings.validationTargetWR && (m.pf||0)>=state.settings.validationMinPF && m.maxDD<=state.settings.validationMaxDD;
  return { m, pass };
}
function metricText(v,kind){ if(v==null)return'—'; if(v===Infinity)return'∞'; return kind==='pct'?pct(v):fmt(v,2); }

function resolveSignal(x,result,r,note='') {
  x.resolution={ at:new Date().toISOString(), result, rMultiple:r, note };
  state.audit.push({ at:new Date().toISOString(), type:'SIGNAL_RESOLVED', detail:{ id:x.id, source:x.source, result, rMultiple:r }});
}
function evaluateOpenSignalsTick(bid,ask,newM1) {
  const source=currentSource();
  for (const x of state.history) {
    if (x.source!==source||x.status!=='SIGNAL'||x.resolution) continue;
    if (newM1) x.barsAfter=(x.barsAfter||0)+1;
    const px=x.direction==='BUY'?bid:ask;
    if (!Number.isFinite(px)) continue;
    const hitSL=x.direction==='BUY'?px<=x.sl:px>=x.sl;
    const hitTP=x.direction==='BUY'?px>=x.tp1:px<=x.tp1;
    if (hitTP) resolveSignal(x,'WIN',x.rr1||1.6,'TP1 before SL on tick feed');
    else if (hitSL) resolveSignal(x,'LOSS',-1,'SL before TP1 on tick feed');
    else if ((x.barsAfter||0)>=45) resolveSignal(x,'EXPIRED',0,'45 M1 bars without TP1/SL');
  }
}
function evaluateOpenSignalsBar(bar,newM1) {
  const source=currentSource();
  for (const x of state.history) {
    if (x.source!==source||x.status!=='SIGNAL'||x.resolution) continue;
    if (newM1) x.barsAfter=(x.barsAfter||0)+1;
    const sl=x.direction==='BUY'?bar.l<=x.sl:bar.h>=x.sl;
    const tp=x.direction==='BUY'?bar.h>=x.tp1:bar.l<=x.tp1;
    if (sl&&tp) resolveSignal(x,'AMBIGUOUS',0,'SL و TP1 در یک کندل؛ از Win/Loss حذف شد');
    else if (tp) resolveSignal(x,'WIN',x.rr1||1.6);
    else if (sl) resolveSignal(x,'LOSS',-1);
    else if ((x.barsAfter||0)>=45) resolveSignal(x,'EXPIRED',0);
  }
}

function spec(name, direction, strength, detail, weight=1) {
  return { name, ready:true, direction, strength:Math.max(0,Math.min(100,strength)), detail, weight, move_atr:0 };
}

function apexFusion(fr=frames) {
  const m5=fr.M5||[], m15=fr.M15||[], h1=fr.H1||[];
  const session=sessionInfo();
  if (m5.length<60||m15.length<60||h1.length<60) {
    return { ok:true, status:'NOT_READY', decision:'WAIT', strength_score:0, agreement:0,
      regime:{ trend:'RANGE', strength:0, rsi:50, atr:null, adx:0 }, providers:[], session,
      thesis:'داده چندتایم‌فریم برای Apex کافی نیست.', vetoes:['DATA'],
      model_note:'Apex Quant needs M5/M15/H1 history.', generated_at:Math.floor(Date.now()/1000) };
  }
  const c5=m5.map(x=>x.c), c15=m15.map(x=>x.c), c1h=h1.map(x=>x.c);
  const atr5=atr(m5,14), atr15=atr(m15,14), last=c5.at(-1);
  const h20=ema(c1h.slice(-140),20), h50=ema(c1h.slice(-180),50);
  const m9=ema(c15.slice(-100),9), m21=ema(c15.slice(-140),21), m50=ema(c15.slice(-180),50);
  const e59=ema(c5.slice(-80),9), e521=ema(c5.slice(-100),21);
  const rv15=rsi(c15,14), rv5=rsi(c5,14), adx15=adx(m15,14), mac=macd(c15), k15=stoch(m15,14);
  const bbMid=sma(c15,20), bbSd=stdev(c15.slice(-20));
  const bbUp=bbMid+2*bbSd, bbDn=bbMid-2*bbSd;
  const slopeH1=c1h.length>=5 && Number.isFinite(atr5) ? (c1h.at(-1)-c1h.at(-5))/Math.max(atr5,1e-9) : 0;
  const slope15=c15.length>=5 ? (c15.at(-1)-c15.at(-5))/Math.max(Number.isFinite(atr15)?atr15:atr5,1e-9) : 0;
  let regime = (h20>h50 && c1h.at(-1)>h20 && m9>m21) ? 'BUY' : (h20<h50 && c1h.at(-1)<h20 && m9<m21) ? 'SELL' : 'RANGE';
  if (adx15<16) regime='RANGE';
  const regimeStr=Math.max(0,Math.min(100,28*Math.abs(slopeH1)+0.85*Math.abs(rv15-50)+0.35*adx15));
  const providers=[];

  let trendDir='WAIT', trendS=35;
  if (h20>h50 && m9>m21 && m21>m50 && c1h.at(-1)>h20) { trendDir='BUY'; trendS=62+Math.min(30,adx15); }
  else if (h20<h50 && m9<m21 && m21<m50 && c1h.at(-1)<h20) { trendDir='SELL'; trendS=62+Math.min(30,adx15); }
  else if (h20>h50 && c1h.at(-1)>h50) { trendDir='BUY'; trendS=48+Math.min(18,adx15*0.5); }
  else if (h20<h50 && c1h.at(-1)<h50) { trendDir='SELL'; trendS=48+Math.min(18,adx15*0.5); }
  providers.push(spec('Trend Desk', trendDir, trendS, `H1 EMA20/50 ${h20>h50?'bull':'bear'} · ADX ${adx15.toFixed(1)}`, 1.45));

  let momDir='WAIT', momS=30;
  if (rv15>=52 && rv15<=68 && mac.hist>0 && slope15>0) { momDir='BUY'; momS=58+Math.min(28,Math.abs(rv15-50)); }
  else if (rv15<=48 && rv15>=32 && mac.hist<0 && slope15<0) { momDir='SELL'; momS=58+Math.min(28,Math.abs(rv15-50)); }
  else if (mac.hist>0 && rv15>50) { momDir='BUY'; momS=44; }
  else if (mac.hist<0 && rv15<50) { momDir='SELL'; momS=44; }
  providers.push(spec('Momentum Desk', momDir, momS, `RSI ${rv15.toFixed(1)} · MACD ${mac.hist.toFixed(3)} · Stoch ${k15.toFixed(0)}`, 1.25));

  const sw=swings(m15,2,2);
  const hh=sw.highs.length>=2 && sw.highs.at(-1)>sw.highs.at(-2);
  const hl=sw.lows.length>=2 && sw.lows.at(-1)>sw.lows.at(-2);
  const lh=sw.highs.length>=2 && sw.highs.at(-1)<sw.highs.at(-2);
  const ll=sw.lows.length>=2 && sw.lows.at(-1)<sw.lows.at(-2);
  const last5=m5.at(-1);
  const pbBuy=last5.c>e59 && last5.l<=e59+Math.max(atr5,0.2)*0.45 && last5.c>last5.o;
  const pbSell=last5.c<e59 && last5.h>=e59-Math.max(atr5,0.2)*0.45 && last5.c<last5.o;
  let stDir='WAIT', stS=32;
  if (hh&&hl&&pbBuy) { stDir='BUY'; stS=78; }
  else if (lh&&ll&&pbSell) { stDir='SELL'; stS=78; }
  else if (hh&&hl) { stDir='BUY'; stS=56; }
  else if (lh&&ll) { stDir='SELL'; stS=56; }
  else if (pbBuy && regime==='BUY') { stDir='BUY'; stS=60; }
  else if (pbSell && regime==='SELL') { stDir='SELL'; stS=60; }
  providers.push(spec('Structure Desk', stDir, stS, `${hh&&hl?'HH/HL':lh&&ll?'LH/LL':'mixed'} · M5 pullback ${pbBuy||pbSell?'yes':'no'}`, 1.35));

  const atrOk=Number.isFinite(atr5)&&atr5>=0.35&&atr5<=22;
  const expanding=m5.length>=20 && atr(m5.slice(-8),5)>atr(m5.slice(-20,-8),5)*1.08;
  const squeeze=bbSd>0 && (bbUp-bbDn)/Math.max(last,1)<0.0045;
  let volDir='WAIT', volS=28;
  if (atrOk && expanding && slope15>0.15) { volDir='BUY'; volS=64; }
  else if (atrOk && expanding && slope15<-0.15) { volDir='SELL'; volS=64; }
  else if (squeeze) { volDir='WAIT'; volS=22; }
  else if (atrOk && (regime==='BUY'||regime==='SELL')) { volDir=regime; volS=40; }
  providers.push(spec('Volatility Desk', volDir, volS, `ATR5 ${fmt(atr5,2)} · ${expanding?'expansion':squeeze?'squeeze':'normal'}`, 0.95));

  const look=m15.slice(-12);
  const priorHi=look.length>2?Math.max(...look.slice(0,-1).map(x=>x.h)):last;
  const priorLo=look.length>2?Math.min(...look.slice(0,-1).map(x=>x.l)):last;
  const sweepHi=m15.at(-1).h>priorHi && m15.at(-1).c<priorHi && m15.at(-1).c<m15.at(-1).o;
  const sweepLo=m15.at(-1).l<priorLo && m15.at(-1).c>priorLo && m15.at(-1).c>m15.at(-1).o;
  const body=Math.abs(last5.c-last5.o);
  const disp=Number.isFinite(atr5)&&body>atr5*0.72;
  let liqDir='WAIT', liqS=30;
  if (sweepLo && (disp||rv5<45)) { liqDir='BUY'; liqS=80; }
  else if (sweepHi && (disp||rv5>55)) { liqDir='SELL'; liqS=80; }
  else if (sweepLo) { liqDir='BUY'; liqS=58; }
  else if (sweepHi) { liqDir='SELL'; liqS=58; }
  providers.push(spec('Liquidity Desk', liqDir, liqS, `${sweepLo?'sweep low':sweepHi?'sweep high':'no sweep'} · disp ${disp?'yes':'no'}`, 1.15));

  let mrDir='WAIT', mrS=24;
  if (regime==='RANGE') {
    if (rv15<=28 && last<=bbDn) { mrDir='BUY'; mrS=70; }
    else if (rv15>=72 && last>=bbUp) { mrDir='SELL'; mrS=70; }
    else if (rv15<=34) { mrDir='BUY'; mrS=48; }
    else if (rv15>=66) { mrDir='SELL'; mrS=48; }
  }
  providers.push(spec('Mean-Revert Desk', mrDir, mrS, `BB ${last<=bbDn?'lower':last>=bbUp?'upper':'mid'} · RSI ${rv15.toFixed(1)}`, regime==='RANGE'?0.80:0.35));

  let sessDir = session.weight>=0.8 && (regime==='BUY'||regime==='SELL') ? regime : 'WAIT';
  let sessS = sessDir!=='WAIT' ? 20+70*session.weight : 18+40*session.weight;
  if (session.name==='ASIA' && regime==='RANGE') { sessDir='WAIT'; sessS=25; }
  providers.push(spec('Session Desk', sessDir, sessS, session.note, 0.70));

  const vols=m5.slice(-30).map(x=>x.v || (x.h-x.l));
  const avgV=vols.slice(0,-3).reduce((a,b)=>a+b,0)/Math.max(1,vols.length-3);
  const lastV=vols.slice(-3).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(3,vols.length));
  const impulse=avgV>0 && lastV>avgV*1.15;
  let flowDir='WAIT', flowS=30;
  if (impulse && last5.c>last5.o && e59>e521) { flowDir='BUY'; flowS=66; }
  else if (impulse && last5.c<last5.o && e59<e521) { flowDir='SELL'; flowS=66; }
  else if (e59>e521) { flowDir='BUY'; flowS=42; }
  else if (e59<e521) { flowDir='SELL'; flowS=42; }
  providers.push(spec('Flow Desk', flowDir, flowS, `${impulse?'impulse':'quiet'} · EMA9/21 ${e59>e521?'up':'down'}`, 0.85));

  const buyW=providers.filter(p=>p.direction==='BUY').reduce((s,p)=>s+p.strength*p.weight,0);
  const sellW=providers.filter(p=>p.direction==='SELL').reduce((s,p)=>s+p.strength*p.weight,0);
  const waitW=providers.filter(p=>p.direction==='WAIT').reduce((s,p)=>s+Math.max(18,p.strength*0.55)*p.weight,0);
  const total=buyW+sellW+waitW;
  let decision='WAIT', leader=waitW;
  if (buyW>=sellW && buyW>=waitW) { decision='BUY'; leader=buyW; }
  else if (sellW>buyW && sellW>=waitW) { decision='SELL'; leader=sellW; }
  const agreement=total<=0?0:leader/total;
  const directional=providers.filter(p=>p.direction==='BUY'||p.direction==='SELL');
  const majority=directional.filter(p=>p.direction===decision).length;
  const vetoes=[];
  if (decision!=='WAIT' && regime!==decision && regime!=='RANGE') { vetoes.push('REGIME'); decision='WAIT'; }
  if (decision!=='WAIT' && majority<4) { vetoes.push('NO_MAJORITY'); decision='WAIT'; }
  if (decision!=='WAIT' && agreement<0.46) { vetoes.push('LOW_AGREEMENT'); decision='WAIT'; }
  if (decision!=='WAIT' && session.weight<0.40) { vetoes.push('SESSION'); decision='WAIT'; }
  if (decision!=='WAIT' && !atrOk) { vetoes.push('ATR'); decision='WAIT'; }
  const tdesk=providers.find(p=>p.name==='Trend Desk');
  const sdesk=providers.find(p=>p.name==='Structure Desk');
  if (tdesk && sdesk && ['BUY','SELL'].includes(tdesk.direction) && ['BUY','SELL'].includes(sdesk.direction) && tdesk.direction!==sdesk.direction) {
    vetoes.push('TREND_STRUCTURE_SPLIT'); decision='WAIT';
  }
  const avgS=providers.reduce((s,p)=>s+p.strength,0)/providers.length;
  let score=avgS*(0.42+0.58*agreement)*(0.72+0.28*session.weight);
  if (decision==='WAIT') score=Math.min(score,68);
  if (decision!=='WAIT' && directional.length && directional.every(p=>p.direction===decision)) score=Math.min(100,score+6);

  let thesis;
  if (decision==='WAIT') {
    thesis='کمیته Apex فعلاً ورود را رد کرد.' + (vetoes.length?' وتو: '+vetoes.join(', ')+'.':'') + ' ' + session.note + '.' + (regime==='RANGE'?' رژیم بازار رنج است.':'');
  } else {
    thesis=`اجماع ${majority} میز روی ${decision==='BUY'?'خرید':'فروش'}. رژیم ${regime} · ADX ${adx15.toFixed(0)} · RSI ${rv15.toFixed(0)}. ${session.note}.` +
      ((sweepLo||sweepHi)?' جاروی نقدینگی تأیید شد.':'') + ((pbBuy||pbSell)?' ورود روی پولبک M5 است.':'');
  }
  return {
    ok:true, status:'READY', engine:'APEX_QUANT_FUSION', decision, strength_score:+score.toFixed(2),
    agreement:+agreement.toFixed(4),
    regime:{ trend:regime, strength:+regimeStr.toFixed(2), rsi:+rv15.toFixed(2), atr:Number.isFinite(atr5)?+atr5.toFixed(4):null, adx:+adx15.toFixed(2) },
    providers, session, thesis, vetoes, last_price:last,
    model_note:'strength_score is confluence, not win probability. Apex stands aside on conflict.',
    generated_at:Math.floor(Date.now()/1000)
  };
}

function applyAiPack(o) {
  state.ai.receivedAt=Date.now();
  if (!o || o.ok===false) {
    state.ai.status='ERROR'; state.ai.decision='WAIT'; state.ai.strengthScore=0;
    state.ai.lastError=o?.error||'AI_ERROR';
    return;
  }
  state.ai.status=o.status||'READY';
  state.ai.decision=['BUY','SELL','WAIT'].includes(o.decision)?o.decision:'WAIT';
  state.ai.strengthScore=Number.isFinite(+o.strength_score)?+o.strength_score:0;
  state.ai.agreement=Number.isFinite(+o.agreement)?+o.agreement:0;
  state.ai.regime=o.regime||null;
  state.ai.providers=Array.isArray(o.providers)?o.providers:[];
  state.ai.generatedAt=o.generated_at?+o.generated_at*1000:Date.now();
  state.ai.lastError=null;
  state.ai.note=o.model_note||'AI strength is not win probability';
  state.ai.thesis=o.thesis||'';
  state.ai.vetoes=Array.isArray(o.vetoes)?o.vetoes:[];
  state.ai.session=o.session||null;
}
function runLocalAi() {
  if (!state.ai.enabled) return;
  if (!dataReady()) { state.ai.status='NOT_READY'; state.ai.decision='WAIT'; return; }
  applyAiPack(apexFusion());
}

function dataReady() { return ['M5','M15','H1'].every(tf => frames[tf].length >= 60); }
function tickAgeSec() { return state.market.tickTime ? Math.max(0,(Date.now()-state.market.tickTime)/1000) : Infinity; }
function aiAgeSec() { return state.ai.receivedAt ? Math.max(0,(Date.now()-state.ai.receivedAt)/1000) : Infinity; }

function pipeline() {
  const m5=frames.M5, m15=frames.M15, h1=frames.H1;
  if (!dataReady()) return { candidate:{ status:'NO_TRADE', direction:null, quality:0, gates:{ data:false }, reasons:['داده چندتایم‌فریم هنوز کامل نیست'] }, feed:{} };

  const h1c=h1.map(x=>x.c), m15c=m15.map(x=>x.c), m5c=m5.map(x=>x.c);
  const h1e20=ema(h1c.slice(-120),20), h1e50=ema(h1c.slice(-160),50), h1last=h1c.at(-1);
  let direction=null;
  if (h1e20>h1e50 && h1last>h1e20) direction='BUY';
  if (h1e20<h1e50 && h1last<h1e20) direction='SELL';

  const e9=ema(m15c.slice(-80),9), e21=ema(m15c.slice(-100),21), e50=ema(m15c.slice(-140),50);
  const e9prev=ema(m15c.slice(0,-2).slice(-80),9);
  const mtfTrend = direction==='BUY' ? (e9>e21&&e21>e50&&e9>e9prev) : direction==='SELL' ? (e9<e21&&e21<e50&&e9<e9prev) : false;
  const rv=rsi(m15c,14);
  const last3=m15c.at(-1)-m15c.at(-4);
  const momentum = direction==='BUY' ? (rv>=52&&rv<=70&&last3>0) : direction==='SELL' ? (rv<=48&&rv>=30&&last3<0) : false;

  const av=atr(m5,14), m5e9=ema(m5c.slice(-80),9), last=m5.at(-1), prev=m5.slice(-5,-1);
  const prevLow=Math.min(...prev.map(x=>x.l)), prevHigh=Math.max(...prev.map(x=>x.h));
  const structure = direction==='BUY'
    ? (last.c>m5e9 && last.c>last.o && last.l>prevLow && last.l<=m5e9+(Number.isFinite(av)?av*.35:0))
    : direction==='SELL'
      ? (last.c<m5e9 && last.c<last.o && last.h<prevHigh && last.h>=m5e9-(Number.isFinite(av)?av*.35:0))
      : false;

  const spread=Number.isFinite(+state.market.spread)?+state.market.spread:Infinity;
  const spreadPass=spread<=state.settings.maxSpread;
  const volPass=Number.isFinite(av)&&av>=state.settings.minAtr&&av<=state.settings.maxAtr;
  const freshPass=state.feedMode==='SIMULATION' || tickAgeSec()<=12;
  const newsPass=!state.settings.newsLock;
  const noOpen=!state.history.some(x=>x.source===currentSource()&&x.status==='SIGNAL'&&!x.resolution);

  const technicalQuality=(direction?20:0)+(mtfTrend?20:0)+(momentum?15:0)+(structure?20:0)+(volPass?10:0)+(spreadPass?10:0)+(freshPass?5:0);
  const aiRequired=isLiveFeed() && state.ai.enabled;
  const aiFresh=!aiRequired || (aiAgeSec()<=Math.max(90,state.settings.aiRefreshSec*3));
  const aiReady=!aiRequired || ['READY','PARTIAL'].includes(state.ai.status);
  const aiDirection=!aiRequired || (!!direction && state.ai.decision===direction);
  const aiScore=!aiRequired || (+state.ai.strengthScore>=state.settings.minAiScore);
  const aiPass=aiFresh&&aiReady&&aiDirection&&aiScore;
  let quality=aiRequired?Math.round(technicalQuality*.68+Math.min(100,+state.ai.strengthScore||0)*.32):technicalQuality;
  if (!noOpen) quality=Math.min(quality,75);
  const qualityPass=quality>=state.settings.minQuality;
  const gates={ h1Trend:!!direction, m15Trend:mtfTrend, momentum, structure, volatility:volPass, spread:spreadPass, fresh:freshPass, news:newsPass, noOpen, ai:aiPass, quality:qualityPass };
  const pass=Object.values(gates).every(Boolean);
  const reasons=[];
  if (!direction) reasons.push('روند H1 با EMA20/50 تأیید نشده');
  if (!mtfTrend) reasons.push('هم‌جهتی روند M15 با H1 کامل نیست');
  if (!momentum) reasons.push('RSI/Momentum در محدوده A+ نیست');
  if (!structure) reasons.push('ساختار ورود M5 تأیید نشده');
  if (!volPass) reasons.push('ATR پنج‌دقیقه خارج از محدوده مجاز است');
  if (!spreadPass) reasons.push('Spread از سقف تعیین‌شده بیشتر است');
  if (!freshPass) reasons.push('فید قیمت تازه نیست');
  if (!newsPass) reasons.push('قفل خبر مهم فعال است');
  if (!noOpen) reasons.push('یک سیگنال باز هنوز تعیین تکلیف نشده');
  if (aiRequired && !aiReady) reasons.push('Apex Fusion هنوز آماده نیست');
  if (aiRequired && aiReady && !aiFresh) reasons.push('خروجی AI تازه نیست');
  if (aiRequired && aiReady && direction && state.ai.decision!==direction) reasons.push('Apex با جهت تکنیکال هم‌نظر نیست');
  if (aiRequired && aiReady && +state.ai.strengthScore<state.settings.minAiScore) reasons.push('AI Strength به حداقل تعیین‌شده نرسیده');
  if (!qualityPass) reasons.push('Setup Quality به حداقل نرسیده');

  const bid=+state.market.bid, ask=+state.market.ask;
  const mid=Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:m5c.at(-1);
  const entry=direction==='BUY'&&Number.isFinite(ask)?ask:direction==='SELL'&&Number.isFinite(bid)?bid:mid;
  const risk=Math.max((Number.isFinite(av)?av:1)*1.30, Number.isFinite(spread)?spread*4:0, .80);
  const sign=direction==='SELL'?-1:1, rr1=state.settings.minRR;
  const sl=direction?entry-sign*risk:null, tp1=direction?entry+sign*risk*rr1:null, tp2=direction?entry+sign*risk*2.20:null, tp3=direction?entry+sign*risk*3.00:null;
  const z1=direction?entry-sign*(Number.isFinite(av)?av*.10:.12):null, z2=direction?entry+sign*(Number.isFinite(av)?av*.08:.12):null;

  return {
    feed:{ price:mid, bid, ask, spread, atr:av, rsi:rv, h1e20, h1e50, m15e9:e9, m15e21:e21, m15e50:e50 },
    candidate:{ status:pass?'SIGNAL':'NO_TRADE', direction:pass?direction:null, quality, entry:pass?entry:null,
      entryLow:pass?Math.min(z1,z2):null, entryHigh:pass?Math.max(z1,z2):null, sl:pass?sl:null, tp1:pass?tp1:null,
      tp2:pass?tp2:null, tp3:pass?tp3:null, rr1, gates, reasons }
  };
}

function cycle(fromAuto=false) {
  state.session.startedAt=state.session.startedAt||new Date().toISOString();
  state.session.cycles++;
  if (state.ai.enabled && dataReady() && (aiAgeSec()>state.settings.aiRefreshSec || state.ai.status==='NOT_READY')) runLocalAi();
  const p=pipeline(), c=p.candidate, source=currentSource();
  const item={
    id:'sig_'+Date.now(), timestamp:new Date().toISOString(), source, symbol:state.symbol,
    resolvedSymbol:state.market.resolvedSymbol||state.symbol, price:p.feed.price??state.price, direction:c.direction, status:c.status,
    entry:c.entry, entryLow:c.entryLow, entryHigh:c.entryHigh, sl:c.sl, tp1:c.tp1, tp2:c.tp2, tp3:c.tp3, rr1:c.rr1,
    quality:c.quality, spread:p.feed.spread, atr:p.feed.atr, rsi:p.feed.rsi, gates:c.gates, reasons:c.reasons, resolution:null, barsAfter:0,
    ai:{ status:state.ai.status, decision:state.ai.decision, strengthScore:state.ai.strengthScore, agreement:state.ai.agreement, generatedAt:state.ai.generatedAt, thesis:state.ai.thesis },
    feedMode:state.feedMode, auto:!!fromAuto
  };
  if (c.status==='SIGNAL') {
    state.session.signals++; countdownLeft=state.settings.entryWindowSec; native('vibrate');
    beep('signal'); showToast(`سیگنال A+ ${c.direction} · Q${fmt(c.quality,0)}`);
  } else { state.session.noTrades++; countdownLeft=0; }
  state.history.push(item); state.history=state.history.slice(-2500); lastCycle=item;
  state.audit.push({ at:new Date().toISOString(), type:'PRECISION_CYCLE_V61_APEX', detail:{ source, status:c.status, direction:c.direction||'NO_TRADE', quality:c.quality, reasons:c.reasons }});
  state.audit=state.audit.slice(-3000); save(); render(true);
}

function maybeAutoCycle() {
  if (!state.autoScan || !dataReady()) return;
  livePreview=pipeline();
  if (livePreview.candidate.status!=='SIGNAL') return;
  const lastSig=state.history.filter(x=>x.status==='SIGNAL'&&x.source===currentSource()).at(-1);
  if (lastSig && !lastSig.resolution) return;
  if (lastSig && Date.now()-new Date(lastSig.timestamp).getTime()<3*60*1000 && lastSig.direction===livePreview.candidate.direction) return;
  cycle(true);
}

function parseReply(payload){ try { return JSON.parse(payload); } catch { return { ok:false, error:'INVALID_JSON' }; } }
function readBridgeConfig(){
  if (!hasNative()) return;
  try { const c=JSON.parse(AndroidBridge.getBridgeConfig()||'{}'); state.market.bridgeConfigured=!!c.baseUrl; state.market.hasToken=!!c.hasToken; save(); } catch(_){}
}

async function fetchJson(url, ms=8000) {
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(), ms);
  try {
    const r=await fetch(url, { signal:ctrl.signal, cache:'no-store', headers:{ 'Accept':'application/json' } });
    if (!r.ok) throw new Error('HTTP_'+r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function applyTick(o) {
  const bid=+o.bid, ask=+o.ask, t=o.time_msc?+o.time_msc:(o.time?+o.time*1000:Date.now());
  if (!Number.isFinite(bid)||!Number.isFinite(ask)) { state.market.lastError='BAD_TICK'; return; }
  const mid=(bid+ask)/2, spread=ask-bid;
  lastPx=state.price; pxDir=mid-state.price;
  state.price=mid;
  state.market.status='LIVE';
  state.market.bid=bid; state.market.ask=ask; state.market.spread=spread; state.market.tickTime=t;
  state.market.resolvedSymbol=o.symbol||o.resolvedSymbol||state.symbol;
  state.market.source=o.source||state.market.source;
  state.market.quality=o.quality||state.market.quality;
  state.market.venue=o.venue||state.market.venue;
  state.market.lastError=null;
  state.broker.bridgeStatus='ONLINE';
  const newM1=upsertTickToFrame('M1',1,mid,t);
  upsertTickToFrame('M5',5,mid,t); upsertTickToFrame('M15',15,mid,t); upsertTickToFrame('H1',60,mid,t);
  evaluateOpenSignalsTick(bid,ask,newM1);
  tickTape.push({ p: mid, d: mid - (lastPx || mid), t });
  if (tickTape.length > 40) tickTape = tickTape.slice(-40);
}

function parseSwissquote(data) {
  if (!Array.isArray(data)) throw new Error('SQ_SHAPE');
  let best=null, score=1e9;
  let ts=Date.now();
  for (const venue of data) {
    ts=venue.ts||ts;
    for (const row of venue.spreadProfilePrices||[]) {
      const bid=+row.bid, ask=+row.ask;
      if (!(bid>0 && ask>bid)) continue;
      const spread=ask-bid;
      const prof=String(row.spreadProfile||'').toLowerCase();
      const s=spread-(prof==='elite'||prof==='prime'?0.08:0);
      if (s<score) { score=s; best={ bid, ask, spread, profile:prof, venue:(venue.topo||{}).platform||'Swissquote' }; }
    }
  }
  if (!best) throw new Error('SQ_EMPTY');
  return { ok:true, source:'SWISSQUOTE', symbol:'XAUUSD', resolvedSymbol:'XAUUSD', ...best, last:(best.bid+best.ask)/2, time_msc:ts, time:Math.floor(ts/1000), quality:'INSTITUTIONAL' };
}

async function fetchOnlineTickBrowser() {
  const jobs=[
    async () => parseSwissquote(await fetchJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD', 6000)),
    async () => {
      const j=await fetchJson('https://api.gold-api.com/price/XAU', 6000);
      const px=+j.price; if (!(px>100)) throw new Error('GOLD');
      const spread=Math.max(0.28,px*0.00008);
      return { ok:true, source:'GOLD_API', symbol:'XAUUSD', bid:px-spread/2, ask:px+spread/2, last:px, spread, time_msc:Date.now(), quality:'SPOT', venue:'gold-api.com' };
    },
    async () => {
      const j=await fetchJson('https://xaus.com/api/v1/spot', 6000);
      const px=+(j.xau?.price||j.spot_usd_oz); if (!(px>100)) throw new Error('XAUS');
      const spread=Math.max(0.30,px*0.00008);
      return { ok:true, source:'XAUS', symbol:'XAUUSD', bid:px-spread/2, ask:px+spread/2, last:px, spread, time_msc:Date.now(), quality:'SPOT', venue:'xaus.com' };
    },
    async () => {
      const j=await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold,tether-gold&vs_currencies=usd', 7000);
      const px=+(j['pax-gold']?.usd||j['tether-gold']?.usd); if (!(px>100)) throw new Error('CG');
      const spread=Math.max(0.35,px*0.0001);
      return { ok:true, source:'COINGECKO', symbol:'XAUUSD', resolvedSymbol:'PAXG', bid:px-spread/2, ask:px+spread/2, last:px, spread, time_msc:Date.now(), quality:'PROXY', venue:'CoinGecko' };
    }
  ];
  try { return await Promise.any(jobs.map(j => j())); }
  catch (e) {
    const errors = (e && e.errors) ? e.errors.map(x => String(x.message||x)) : [String(e.message||e)];
    throw new Error(errors.join('|')||'ALL_FEEDS_FAILED');
  }
}

async function fetchOnlineBarsBrowser() {
  const day=await fetchJson('https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days=1', 12000);
  let w=[];
  try {
    const week=await fetchJson('https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days=14', 14000);
    w=week.prices||[];
  } catch(_){}
  const d=day.prices||[];
  if (d.length<40) throw new Error('FEW_POINTS');
  const mix=d.concat(w);
  return {
    M1: pointsToBars(d,1).slice(-500),
    M5: pointsToBars(d,5).slice(-500),
    M15: pointsToBars(mix,15).slice(-500),
    H1: pointsToBars(w.length?w:d,60).slice(-500)
  };
}

function applyBarMap(map) {
  for (const tf of ['M1','M5','M15','H1']) {
    if (Array.isArray(map[tf]) && map[tf].length) frames[tf]=map[tf].slice(-500);
  }
  if (dataReady()) {
    if (state.market.status!=='LIVE') state.market.status='READY';
    if (state.ai.enabled) runLocalAi();
  }
}

function requestNativePublicFeeds() {
  if (!hasNative() || !AndroidBridge.requestPublicGet) return;
  try { AndroidBridge.requestPublicGet('online_market', 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'); } catch(_){}
  try { AndroidBridge.requestPublicGet('online_spot', 'https://api.gold-api.com/price/XAU'); } catch(_){}
  try { AndroidBridge.requestPublicGet('online_bars', 'https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days=1'); } catch(_){}
}

async function onlineTick() {
  if (!isOnlineMode() || requestPending) return;
  requestPending=true; requestStartedAt=Date.now();
  try {
    let tick=null;
    if (serverFeedOk !== false) {
      try {
        const j=await fetchJson('/v1/market?symbol=XAUUSD', serverFeedOk ? 3500 : 1200);
        if (j&&j.ok!==false&&j.bid) { tick=j; serverFeedOk=true; }
        else serverFeedOk=false;
      } catch(_) { serverFeedOk=false; }
    }
    if (!tick) {
      requestNativePublicFeeds();
      tick=await fetchOnlineTickBrowser();
    }
    applyTick(tick);
    runLocalAi();
    maybeAutoCycle();
    saveSoft(); render(false);
  } catch (e) {
    state.market.status = dataReady() ? 'DEGRADED' : 'ERROR';
    state.market.lastError=String(e.message||e).slice(0,80);
    state.broker.bridgeStatus='OFFLINE';
    saveSoft(); render(false);
  } finally { requestPending=false; }
}

async function onlineBars() {
  if (!isOnlineMode() || barsPending) return;
  barsPending=true;
  state.market.status = state.market.status==='LIVE' ? 'LIVE' : 'SYNCING';
  try {
    let got=false;
    if (serverFeedOk !== false) {
      try {
        const pack={};
        for (const tf of ['M1','M5','M15','H1']) {
          const j=await fetchJson(`/v1/bars?symbol=XAUUSD&timeframe=${tf}&count=300`, serverFeedOk ? 7000 : 1500);
          if (j&&j.ok!==false&&Array.isArray(j.bars)) pack[tf]=j.bars.map(normalizeBar).filter(Boolean);
        }
        if (pack.M5?.length>=40) { applyBarMap(pack); got=true; state.market.source=state.market.source||'SERVER'; serverFeedOk=true; }
        else serverFeedOk=false;
      } catch(_) { serverFeedOk=false; }
    }
    if (!got) {
      const map=await fetchOnlineBarsBrowser();
      applyBarMap(map);
      state.market.source=state.market.source||'COINGECKO';
    }
    save(); render(false);
  } catch (e) {
    state.market.lastError=String(e.message||e).slice(0,80);
    save(); render(false);
  } finally { barsPending=false; }
}

function normalizeBar(x) {
  const t=+(x.time??x.t); const o=+(x.open??x.o); const h=+(x.high??x.h); const l=+(x.low??x.l); const c=+(x.close??x.c);
  if (![t,o,h,l,c].every(Number.isFinite)) return null;
  return { t:t>1e12?t:t*1000, o, h, l, c, v:+(x.tick_volume||x.v||0) };
}

function requestHealth(){
  if (isOnlineMode()) { onlineTick(); return; }
  if (!hasNative()) { native('toast','این قابلیت داخل نسخه Android فعال می‌شود.'); return; }
  try { AndroidBridge.requestHealth(); } catch(_){}
}
function syncBars(){
  if (isOnlineMode()) { onlineBars(); return; }
  if (!hasNative()) return;
  frames={ M1:[], M5:[], M15:[], H1:[] };
  for (const tf of ['M1','M5','M15','H1']) { try { AndroidBridge.requestBars(state.symbol,tf,300); } catch(_){ } }
  state.market.status='SYNCING'; state.market.lastError=null; save(); render();
}
function requestMarket(){
  if (isOnlineMode()) { onlineTick(); return; }
  if (state.feedMode!=='MT5_BRIDGE'||!hasNative()) return;
  if (requestPending && Date.now()-requestStartedAt<8000) return;
  requestPending=true; requestStartedAt=Date.now();
  try { AndroidBridge.requestMarket(state.symbol); } catch(_){ requestPending=false; }
}
function onMarketReply(o){
  requestPending=false;
  if (!o||o.ok===false) { state.market.status='ERROR'; state.market.lastError=o?.error||'MARKET_ERROR'; state.broker.bridgeStatus='OFFLINE'; save(); render(false); return; }
  applyTick(o);
  save(); render(false);
}
function onBarsReply(kind,o){
  const tf=kind.split(':')[1];
  if (!tf||!frames[tf]) return;
  if (!o||o.ok===false||!Array.isArray(o.bars)) { state.market.lastError=o?.error||('BARS_'+tf+'_ERROR'); save(); return; }
  const arr=o.bars.map(normalizeBar).filter(Boolean);
  if (arr.length) { frames[tf]=arr.slice(-500); state.market.resolvedSymbol=o.symbol||state.market.resolvedSymbol; }
  if (dataReady()) { if (state.market.status!=='LIVE') state.market.status='READY'; state.market.lastError=null; if (isLiveFeed()&&state.ai.enabled) { runLocalAi(); requestAi(); } }
  save(); render(false);
}
function requestAi(){
  if (!state.ai.enabled) return;
  if (isOnlineMode()) {
    runLocalAi();
    if (!aiPending) {
      aiPending=true;
      fetchJson('/v1/ai?symbol=XAUUSD', 12000).then(onAiReply).catch(()=>{}).finally(()=>{ aiPending=false; });
    }
    maybeAutoCycle();
    save(); render(false);
    return;
  }
  if (state.feedMode!=='MT5_BRIDGE'||!hasNative()||aiPending) { if (dataReady()) { runLocalAi(); save(); render(false); } return; }
  aiPending=true;
  try { AndroidBridge.requestAi(state.symbol); } catch(_){ aiPending=false; runLocalAi(); }
}
function onAiReply(o){
  aiPending=false;
  if (o && o.ok!==false && Array.isArray(o.providers) && o.providers.length) applyAiPack(o);
  else if (dataReady()) runLocalAi();
  else applyAiPack(o);
  save(); render(false);
}
function onNativeReply(kind,payload){
  const o=parseReply(payload);
  if (kind==='market') { onMarketReply(o); return; }
  if (kind==='ai') { onAiReply(o); return; }
  if (kind.startsWith('bars:')) { onBarsReply(kind,o); return; }
  if (kind==='online_market') {
    try {
      const tick = Array.isArray(o) ? parseSwissquote(o) : o;
      if (tick && tick.ok!==false) { applyTick(tick); runLocalAi(); maybeAutoCycle(); save(); render(false); }
    } catch(_){}
    return;
  }
  if (kind==='online_spot') {
    const px=+(o.price||o.xau?.price||o.spot_usd_oz);
    if (px>100) {
      const spread=Math.max(0.28,px*0.00008);
      applyTick({ ok:true, source:'GOLD_API', bid:px-spread/2, ask:px+spread/2, last:px, spread, time_msc:Date.now(), quality:'SPOT' });
      runLocalAi(); save(); render(false);
    }
    return;
  }
  if (kind==='online_bars') {
    try {
      const prices=o.prices||[];
      if (prices.length>=40) {
        applyBarMap({
          M1: pointsToBars(prices,1).slice(-500),
          M5: pointsToBars(prices,5).slice(-500),
          M15: pointsToBars(prices,15).slice(-500)
        });
        save(); render(false);
      }
    } catch(_){}
    return;
  }
  if (kind==='health') {
    if (o&&o.ok!==false) { state.market.bridgeConfigured=true; state.market.status=state.market.status==='LIVE'? 'LIVE':'BRIDGE_OK'; state.broker.bridgeStatus='ONLINE'; state.market.lastError=null; if (o.symbol) state.market.resolvedSymbol=o.symbol; }
    else { state.market.status='ERROR'; state.broker.bridgeStatus='OFFLINE'; state.market.lastError=o?.error||'HEALTH_ERROR'; }
    save(); render();
  }
}

function setFeedMode(mode) {
  const m=['ONLINE_AI','MT5_BRIDGE','SIMULATION'].includes(mode)?mode:'ONLINE_AI';
  state.feedMode=m; lastCycle=null;
  if (m==='SIMULATION') {
    initSimulation(); state.broker.bridgeStatus='OFFLINE'; state.ai.status='LOCAL'; runLocalAi();
  } else if (m==='ONLINE_AI') {
    serverFeedOk=null;
    frames={ M1:[], M5:[], M15:[], H1:[] };
    state.market.status='CONNECTING'; state.ai.status='NOT_READY'; state.ai.decision='WAIT';
    state.market.bid=null; state.market.ask=null; state.market.spread=null; state.market.tickTime=null;
    onlineBars(); onlineTick();
  } else {
    frames={ M1:[], M5:[], M15:[], H1:[] };
    state.market.status='OFFLINE'; state.ai.status='NOT_READY'; state.ai.decision='WAIT';
    state.market.bid=null; state.market.ask=null; state.market.spread=null; state.market.tickTime=null;
    readBridgeConfig(); requestHealth(); syncBars();
  }
  save(true); render(true); restartTimers(); applyKeepScreen();
}
function saveBridge(){
  if (!hasNative()) { native('toast','تنظیم Bridge فقط داخل اپ Android ذخیره می‌شود.'); return; }
  const url=document.getElementById('bridgeUrl')?.value.trim()||'';
  const token=document.getElementById('bridgeToken')?.value||'';
  let ok=false; try { ok=AndroidBridge.configureBridge(url,token); } catch(_){}
  if (!ok) { native('toast','آدرس نامعتبر است. HTTPS یا HTTP شبکه خصوصی وارد کنید.'); return; }
  readBridgeConfig(); native('toast','Bridge به‌صورت محلی در Android ذخیره شد.'); requestHealth(); syncBars(); render();
}
function clearBridge(){ try { AndroidBridge?.clearBridgeConfig?.(); } catch(_){} state.market.bridgeConfigured=false; state.market.hasToken=false; if (state.feedMode==='MT5_BRIDGE') { state.market.status='OFFLINE'; state.broker.bridgeStatus='OFFLINE'; } save(); render(); }
function saveBroker(){ state.broker.platform=document.getElementById('platform').value; state.broker.status=brokerReady()?'PLATFORM_SELECTED':'NOT_CONFIGURED'; save(); render(); }
function brokerReady(){ return state.broker.platform==='MT4'||state.broker.platform==='MT5'; }
function setMode(m){ state.appMode=m==='TRADER'?'TRADER':'SIGNAL'; state.trade.confirm=false; save(); render(); }
function setTab(t){ state.ui.tab=t; save(); render(); }
function toggleNewsLock(){ state.settings.newsLock=!state.settings.newsLock; save(); render(); }
function toggleKeepScreen(){ state.settings.keepScreenOn=!state.settings.keepScreenOn; save(); applyKeepScreen(); render(); }
function toggleAuto(){ state.autoScan=!state.autoScan; save(); render(); }

function candleChart() {
  const b=frames.M5.slice(-120);
  if (b.length<2) return '<div class="empty">در حال همگام‌سازی نمودار زنده طلا…</div>';
  const w=920, h=320, padL=10, padR=58, padT=14, volH=54, padB=8;
  const plotH=h-volH-padT-padB;
  const min=Math.min(...b.map(x=>x.l)), max=Math.max(...b.map(x=>x.h));
  const rng=max-min||1;
  const vmax=Math.max(...b.map(x=>x.v||(x.h-x.l)), 1e-9);
  const xAt=i=>padL+i*(w-padL-padR)/Math.max(1,b.length-1);
  const yAt=p=>padT+(max-p)/rng*plotH;
  const cw=Math.max(2.2, (w-padL-padR)/b.length*0.62);
  let candles='';
  b.forEach((k,i)=>{
    const x=xAt(i), up=k.c>=k.o, col=up?'#3ee0a8':'#ff6b7d';
    const y1=yAt(k.h), y2=yAt(k.l), yo=yAt(k.o), yc=yAt(k.c);
    const top=Math.min(yo,yc), bh=Math.max(1.2,Math.abs(yc-yo));
    const vv=k.v||(k.h-k.l);
    const vh=Math.max(2,(vv/vmax)*(volH-10));
    candles += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}" stroke-width="1"/>`+
      `<rect x="${x-cw/2}" y="${top}" width="${cw}" height="${bh}" fill="${col}" opacity=".92"/>`+
      `<rect class="vol" x="${x-cw/2}" y="${h-padB-vh}" width="${cw}" height="${vh}" fill="${col}"/>`;
  });
  const e20=emaSeries(b.map(x=>x.c),20), e50=emaSeries(b.map(x=>x.c),50);
  const p20=e20.map((v,i)=>`${xAt(i)},${yAt(v)}`).join(' ');
  const p50=e50.map((v,i)=>`${xAt(i)},${yAt(v)}`).join(' ');
  const last=b.at(-1).c, ly=yAt(last);
  const sig=lastCycle?.status==='SIGNAL'?lastCycle:null;
  let levels='';
  if (sig) {
    const draw=(px,col,label)=>{ if(!Number.isFinite(px))return; const y=yAt(px); levels+=`<line x1="${padL}" y1="${y}" x2="${w-padR}" y2="${y}" stroke="${col}" stroke-dasharray="5 4" stroke-width="1.1"/><text x="${w-padR+4}" y="${y+3}" fill="${col}" font-size="9" font-family="IBM Plex Mono,monospace">${label}</text>`; };
    draw(sig.sl,'#ff6b7d','SL'); draw(sig.entry,'#e2c56d','IN'); draw(sig.tp1,'#3ee0a8','TP1');
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <path class="grid" d="M${padL} ${padT+plotH/3}H${w-padR}M${padL} ${padT+2*plotH/3}H${w-padR}"/>
    <polyline points="${p50}" class="ema50"/><polyline points="${p20}" class="ema20"/>
    ${candles}
    <line class="lastPx" x1="${padL}" y1="${ly}" x2="${w-padR}" y2="${ly}"/>
    <text x="${w-padR+4}" y="${ly+3}" fill="#e2c56d" font-size="10" font-family="IBM Plex Mono,monospace">${fmt(last,2)}</text>
    ${levels}
  </svg>`;
}

function header(){
  const live=state.market.status==='LIVE'||state.market.status==='READY';
  const chg=pxDir;
  const sess=state.ai.session||sessionInfo();
  return `<header>
    <div><div class="micro">PERSONAL • XAUUSD APEX DESK</div>
      <div class="brand">ZARNEGAR <b>APEX</b></div>
      <div class="sub">Online Institutional Fusion · 8 desks + MTF gates</div></div>
    <div class="headerQuote">
      <b id="hdrPx" class="${chg>0?'flashUp':chg<0?'flashDn':''}">${fmt(state.price,2)}</b>
      <span id="hdrChg" class="${chg>=0?'up':'dn'}">${chg>=0?'▲':'▼'} ${fmt(Math.abs(chg),2)} · ${esc(state.market.source||state.feedMode)}</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
      <div id="livePill" class="livePill ${live?'':'off'}"><i></i>${live?'LIVE':'OFF'} ${esc(state.market.quality||'')}</div>
      <span class="killzone">${esc(sess.name||'SESSION')} · UTC ${String(new Date().getUTCHours()).padStart(2,'0')}:00</span>
    </div>
  </header>`;
}
function modeSwitch(){ return `<section class="modeSwitch"><button class="${state.appMode==='SIGNAL'?'active':''}" onclick="Z.mode('SIGNAL')">◆ SIGNAL DESK<br><small>تحلیل زنده و Shadow</small></button><button class="trader ${state.appMode==='TRADER'?'active':''}" onclick="Z.mode('TRADER')">⚡ TRADER MODE<br><small>Real execution قفل است</small></button></section>`; }
function brokerStrip(){
  const age=tickAgeSec(); const sess=state.ai.session||sessionInfo();
  return `<section class="brokerStrip">
    <div><small>FEED</small><b class="${state.market.status==='LIVE'?'ready':'neutral'}">${esc(state.feedMode)}</b></div>
    <div><small>TICK AGE</small><b id="tickAge" class="${age<=10?'ready':'locked'}">${Number.isFinite(age)?fmt(age,1)+'s':'—'}</b></div>
    <div><small>SESSION</small><b class="${(sess.weight||0)>=0.8?'ready':'neutral'}">${esc(sess.name||'—')}</b></div>
    <div><small>AUTO</small><b class="${state.autoScan?'ready':'neutral'}">${state.autoScan?'ARMED':'MANUAL'}</b></div>
  </section>`;
}
function feedPanel(){
  return `<section class="panel livePanel"><div class="title"><span class="kicker">LIVE XAUUSD</span><span>${esc(state.market.status)}</span></div>
    <div class="marketGrid">
      <div><small>BID</small><b id="bidPx">${fmt(state.market.bid)}</b></div>
      <div><small>ASK</small><b id="askPx">${fmt(state.market.ask)}</b></div>
      <div><small>SPREAD</small><b id="sprPx">${fmt(state.market.spread,3)}</b></div>
      <div><small>VENUE</small><b id="venuePx" style="font-size:11px">${esc(state.market.venue||state.market.source||'—')}</b></div>
    </div>
    <div class="statusline"><span class="statusdot ${state.market.status==='LIVE'||state.market.status==='READY'?'':'warn'}"></span>${faTime()} • ${state.market.lastError?'خطا: '+esc(state.market.lastError):'Execution: READ-ONLY / SHADOW'} • ${esc(state.market.resolvedSymbol||'XAUUSD')}</div>
    <div class="toolbar">
      <button onclick="Z.testBridge()">تست فید</button>
      <button onclick="Z.syncBars()">همگام‌سازی MTF</button>
      <button onclick="Z.toggleAuto()">${state.autoScan?'⏸ Auto Scan':'▶ Auto Scan'}</button>
    </div>
  </section>`;
}
function aiPanel(){
  const ps=state.ai.providers||[];
  const age=aiAgeSec();
  const d=state.ai.decision;
  const providerHtml=ps.length?ps.map(p=>`<div class="aiProvider"><div><b>${esc(p.name)}</b><small>${p.ready===false?'OFFLINE':esc(p.detail||'')}</small></div><strong class="${p.direction==='BUY'?'ok':p.direction==='SELL'?'redTxt':'neutral'}">${esc(p.direction||'WAIT')}</strong><span>${fmt(p.strength,0)}</span></div>`).join(''):'<div class="empty">کمیته هنوز رأی نداده است.</div>';
  return `<section class="panel aiPanel">
    <div class="title"><span class="kicker">APEX FUSION AI</span><span id="aiStat">${esc(state.ai.status)}</span></div>
    <div id="aiOrb" class="aiOrb ${d==='BUY'?'buy':d==='SELL'?'sell':''}"><b id="aiDec" class="${d==='BUY'?'ok':d==='SELL'?'redTxt':'neutral'}">${esc(d)}</b><span>CONFLUENCE</span></div>
    <div class="confTrack"><i id="confFill" style="width:${Math.round((state.ai.agreement||0)*100)}%"></i></div>
    <div class="aiDecision">
      <div><small>AI STRENGTH</small><b id="aiStr">${fmt(state.ai.strengthScore,0)}</b></div>
      <div><small>AGREEMENT</small><b id="aiAgr">${pct(state.ai.agreement)}</b></div>
      <div><small>AGE</small><b id="aiAge">${Number.isFinite(age)?fmt(age,0)+'s':'—'}</b></div>
      <div><small>VETOES</small><b id="aiVeto">${(state.ai.vetoes||[]).length||'0'}</b></div>
    </div>
    ${state.ai.regime?`<div class="statusline"><span class="statusdot ${state.ai.regime.trend==='RANGE'?'warn':''}"></span>Regime ${esc(state.ai.regime.trend)} • RSI ${fmt(state.ai.regime.rsi,1)} • ADX ${fmt(state.ai.regime.adx,0)} • ATR ${fmt(state.ai.regime.atr,2)}</div>`:''}
    <div id="thesisBox" class="thesis">${esc(state.ai.thesis||'کمیته در حال جمع‌بندی رأی میزهاست…')}</div>
    <div class="aiProviders">${providerHtml}</div>
    <p class="mini">Apex یک کمیته ۸ میزه است. Strength احتمال برد نیست. اختلاف میزها = WAIT. وین‌ریت بالا از نترید کردن در شرایط ضعیف ساخته می‌شود.</p>
    <button class="goldBtn ai" onclick="Z.aiNow()">به‌روزرسانی کمیته AI</button>
  </section>`;
}
function gatesHtml(x){
  if (!x?.gates) return '';
  const labels={ h1Trend:'H1 Trend', m15Trend:'M15 Align', momentum:'Momentum', structure:'M5 Entry', volatility:'ATR', spread:'Spread', fresh:'Fresh Tick', news:'News Lock', noOpen:'No Open', ai:'Apex AI', quality:'Quality', data:'Data' };
  return `<div class="gateGrid">${Object.entries(x.gates).map(([k,v])=>`<div class="gate ${v?'pass':'fail'}"><span>${labels[k]||esc(k)}</span><b>${v?'PASS':'BLOCK'}</b></div>`).join('')}</div>`;
}
function signalCard(x){
  const preview=(!x || x.status!=='SIGNAL') && livePreview?.candidate ? livePreview : null;
  if (!x && !preview) return `<section class="hero signalHero"><div class="heroTop"><span class="eyebrow">APEX SCAN</span><span class="tinyPill">${dataReady()?'MTF READY':'WAITING DATA'}</span></div><h1 class="noTrade">LIVE DESK</h1><p class="note">کمیته آنلاین است. اسکن دستی یا Auto Scan فقط ستاپ A+ را ثبت می‌کند.</p><button class="goldBtn" onclick="Z.cycle()" ${!dataReady()?'disabled':''}>اجرای Precision Scan</button></section>`;
  const show=x&&x.status==='SIGNAL'?x:(preview&&preview.candidate.status==='SIGNAL'?null:x);
  if (!show || show.status!=='SIGNAL') {
    const g=show||{ quality:livePreview?.candidate?.quality||0, gates:livePreview?.candidate?.gates, reasons:livePreview?.candidate?.reasons||[], source:'LIVE' };
    return `<section class="hero signalHero"><div class="heroTop"><span class="eyebrow">LAST SCAN • ${esc(g.source||'LIVE')}</span><span class="qualityRing">${fmt(g.quality,0)}</span></div><h1 class="noTrade">NO TRADE</h1><p class="note">شرایط A+ کامل نیست؛ ایستادن بخشی از سیستم حرفه‌ای است.</p>${gatesHtml(g)}${g.reasons?.length?`<ul class="reasonList">${g.reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}<button class="goldBtn" onclick="Z.cycle()" ${!dataReady()?'disabled':''}>اسکن مجدد</button></section>`;
  }
  return `<section class="hero signalHero"><div class="signalHead"><div><span class="eyebrow">${esc(show.source)} • ${esc(show.resolvedSymbol||show.symbol)}</span><div class="signalDirection ${show.direction==='BUY'?'buy':'sell'}">${show.direction}</div></div><span class="qualityRing">${fmt(show.quality,0)}</span></div>
    <div class="entryZone"><div><small>ENTRY ZONE</small><b>${fmt(show.entryLow)} — ${fmt(show.entryHigh)}</b></div><div><small>ENTRY EXECUTABLE</small><b>${fmt(show.entry)}</b></div></div>
    <div class="targetGrid"><div><small>SL</small><b class="redTxt">${fmt(show.sl)}</b></div><div><small>TP1</small><b>${fmt(show.tp1)}</b></div><div><small>TP2</small><b>${fmt(show.tp2)}</b></div><div><small>TP3</small><b>${fmt(show.tp3)}</b></div></div>
    <div class="countdown"><span>Entry window</span><b id="countdown">${countdownLeft>0?countdownLeft+'s':'—'}</b></div>
    ${gatesHtml(show)}${state.appMode==='TRADER'?tradeBox(show):''}
    <button class="goldBtn" onclick="Z.cycle()">اسکن جدید</button></section>`;
}
function tradeBox(x){ return `<div class="confirmBox"><b>🔒 Real Execution در Apex قفل است</b><p class="mini">این نسخه فقط سفارش را برای بررسی آماده می‌کند و هیچ درخواست معاملاتی ارسال نمی‌کند.</p><label><input type="checkbox" ${state.trade.confirm?'checked':''} onchange="Z.confirmTrade(this.checked)"> مقادیر Entry / SL / TP را بررسی کردم</label><button class="tradeBtn" ${state.trade.confirm?'':'disabled'} onclick="Z.prepareTrade('${esc(x.id)}')">PREPARE ONLY</button></div>`; }
function statBoard(){
  const sim=metrics('SIMULATION'), sh=metrics('SHADOW');
  return `<section class="panel"><div class="title"><span class="kicker">REALITY CHECK</span><span>WR جداگانه</span></div>
    <div class="metricBoard">
      <div><small>SIM WR</small><b>${metricText(sim.wr,'pct')}</b><span>n=${sim.n}</span></div>
      <div><small>LIVE/SHADOW WR</small><b>${metricText(sh.wr,'pct')}</b><span>n=${sh.n}</span></div>
      <div><small>SHADOW PF</small><b>${metricText(sh.pf)}</b><span>هدف ≥ ${fmt(state.settings.validationMinPF)}</span></div>
      <div><small>SHADOW DD</small><b>${fmt(sh.maxDD,2)}R</b><span>سقف ${fmt(state.settings.validationMaxDD,1)}R</span></div>
    </div>
    <div class="equityBox" id="equityBox">${equitySvg()}</div></section>`;
}
function validationPanel(){
  const v=validation(), m=v.m;
  return `<section class="panel"><div class="validationLock ${v.pass?'good':''}"><div class="title"><span>90% Validation Gate</span><span>${v.pass?'REVIEW ELIGIBLE':'LOCKED'}</span></div>
    <div class="systemList">
      <div class="systemItem"><b>Shadow sample</b><span>${m.n} / ≥ ${state.settings.validationMinTrades}</span></div>
      <div class="systemItem"><b>Win rate</b><span>${metricText(m.wr,'pct')} / ≥ ${pct(state.settings.validationTargetWR)}</span></div>
      <div class="systemItem"><b>Profit Factor</b><span>${metricText(m.pf)} / ≥ ${fmt(state.settings.validationMinPF)}</span></div>
      <div class="systemItem"><b>Max Drawdown</b><span>${fmt(m.maxDD,2)}R / ≤ ${fmt(state.settings.validationMaxDD,1)}R</span></div>
    </div></div></section>`;
}
function row(x){ const r=x.resolution?.result||'OPEN'; return `<div class="row"><div><b>${x.status==='SIGNAL'?x.direction:'NO TRADE'}</b><small>${new Date(x.timestamp).toLocaleTimeString('fa-IR')} • Q${fmt(x.quality,0)} • ${esc(r)}</small></div><strong>${fmt(x.price)}</strong><span>${esc(x.source)}</span></div>`; }
function safety(){ return `<div class="safety"><b>🔒 اصل زرنگار Apex</b><span>فید زنده طلا از Swissquote / Gold API / XAUS / CoinGecko است. Apex یک کمیته کمّی است نه پیش‌گویی. Strength احتمال برد نیست. هدف ۹۰٪ فقط Gate ارزیابی است و تضمین نیست. سفارش واقعی ارسال نمی‌شود.</span></div>`; }
function nav(){ return `<nav>${[['home','⌂','خانه'],['signal','◆','سیگنال'],['replay','◫','اعتبارسنجی'],['journal','☷','ژورنال'],['settings','⚙','تنظیمات']].map(x=>`<button class="${state.ui.tab===x[0]?'active':''}" onclick="Z.tab('${x[0]}')"><span>${x[1]}</span>${x[2]}</button>`).join('')}</nav>`; }

function home(){
  const recent=state.history.slice(-6).reverse();
  return `<main>${header()}${modeSwitch()}${brokerStrip()}
    <div class="targetNotice">آنلاین و متصل به Apex Fusion: ۸ میز تخصصی + رژیم + سشن + وتوی اختلاف. فقط ستاپ A+ سیگنال می‌شود.</div>
    <section class="mtfStrip" id="mtfStrip">${mtfStripInner()}</section>
    <div class="desk" id="liveRoot">${aiPanel()}<section class="panel"><div class="title"><span class="kicker">XAUUSD · M5</span><span id="barCount">${frames.M5.length} bars</span></div><div class="chart" id="chartBox">${candleChart()}</div><div class="tickTape" id="tickTape">${tickTapeHtml()}</div><div class="liveMiss" id="liveMiss">${liveMissHtml()}</div></section>${feedPanel()}</div>
    <section class="quick"><div><small>SCANS</small><b>${state.session.cycles}</b><span>cycles</span></div><div><small>SIGNALS</small><b>${state.session.signals}</b><span>A+ only</span></div><div><small>NO TRADE</small><b>${state.session.noTrades}</b><span>filtered</span></div><div><small>RISK</small><b>${fmt(state.settings.maxRiskPct,2)}%</b><span>planned max</span></div></section>
    ${signalCard(lastCycle)}${statBoard()}${validationPanel()}
    <section class="panel"><div class="title"><span class="kicker">SIGNAL TAPE</span><span>${recent.length} مورد</span></div>${recent.length?recent.map(row).join(''):'<div class="empty">رکوردی وجود ندارد</div>'}</section>
    ${safety()}</main>${nav()}`;
}
function signal(){ return `<main>${header()}${modeSwitch()}${feedPanel()}${aiPanel()}${signalCard(lastCycle)}<section class="panel"><div class="title">منطق Apex Precision</div><ul class="rules"><li>جهت اصلی از H1 EMA20/50 و ADX.</li><li>۸ میز Apex باید اکثریت هم‌جهت بسازند.</li><li>اختلاف Trend و Structure = وتو و WAIT.</li><li>سشن ضعیف یا اسپرد پهن ورود را می‌بندد.</li><li>Quality و Strength احتمال برد نیستند.</li></ul></section>${validationPanel()}${safety()}</main>${nav()}`; }
function replay(){ const h=state.history.slice().reverse(); return `<main>${header()}${statBoard()}${validationPanel()}<section class="panel"><div class="title">History / Forward Validation <span>${h.length} records</span></div><div class="toolbar"><button onclick="Z.export()">Export JSON</button><button onclick="Z.clearHistory()">پاک‌سازی</button></div>${h.length?h.slice(0,160).map(row).join(''):'<div class="empty">داده‌ای وجود ندارد</div>'}</section>${safety()}</main>${nav()}`; }
function journal(){ return `<main>${header()}<section class="panel"><div class="title">ژورنال شخصی</div><textarea id="jn" placeholder="Context بازار، خبر، دلیل ورود/عدم ورود..."></textarea><div class="toolbar"><button class="goldBtn noMargin" onclick="Z.note()">ثبت یادداشت</button></div>${state.journal.slice().reverse().slice(0,100).map(x=>`<div class="journal"><b>${esc(x.tag)}</b><small>${new Date(x.at).toLocaleString('fa-IR')}</small><p>${esc(x.note)}</p></div>`).join('')}</section>${safety()}</main>${nav()}`; }
function settings(){
  return `<main>${header()}
    <section class="panel"><div class="title">Market Feed</div>
      <label>Feed Mode<select id="feedMode">
        <option value="ONLINE_AI" ${state.feedMode==='ONLINE_AI'?'selected':''}>Online Apex • Live Gold</option>
        <option value="MT5_BRIDGE" ${state.feedMode==='MT5_BRIDGE'?'selected':''}>MT5 Bridge • Read Only</option>
        <option value="SIMULATION" ${state.feedMode==='SIMULATION'?'selected':''}>Simulation Lab</option>
      </select></label>
      <button class="goldBtn" onclick="Z.applyFeed()">اعمال Feed</button>
      <p class="note">حالت Online بدون MT5 به فید زنده XAUUSD (Swissquote / Gold API / XAUS / CoinGecko) وصل می‌شود و کمیته Apex را روی همان داده اجرا می‌کند.</p>
    </section>
    <section class="panel"><div class="title">MT5 Bridge • اختیاری</div>
      <p class="note">اگر حساب بروکر دارید، Bridge را روی PC دارای MetaTrader 5 اجرا کنید. رمز حساب داخل اپ ذخیره نمی‌شود.</p>
      <label>Bridge URL<input id="bridgeUrl" class="ltr" placeholder="http://192.168.1.20:8765"></label>
      <label>Bearer Token<input id="bridgeToken" class="ltr" type="password" placeholder="اگر قبلاً ذخیره شده خالی بگذارید"></label>
      <div class="systemList"><div class="systemItem"><b>Configured</b><span>${state.market.bridgeConfigured?'YES':'NO'}</span></div><div class="systemItem"><b>Token saved</b><span>${state.market.hasToken?'YES':'NO'}</span></div><div class="systemItem"><b>Status</b><span>${esc(state.market.status)}</span></div></div>
      <div class="toolbar"><button class="goldBtn noMargin" onclick="Z.saveBridge()">ذخیره و تست</button><button onclick="Z.clearBridge()">پاک‌کردن Bridge</button></div>
    </section>
    <section class="panel"><div class="title">Broker Adapter</div>
      <div class="selectRow"><label>Broker<input value="Alpari" disabled></label><label>Platform<select id="platform"><option value="UNSET" ${state.broker.platform==='UNSET'?'selected':''}>بعداً تعیین می‌کنم</option><option value="MT4" ${state.broker.platform==='MT4'?'selected':''}>MetaTrader 4</option><option value="MT5" ${state.broker.platform==='MT5'?'selected':''}>MetaTrader 5</option></select></label></div>
      <button class="goldBtn" onclick="Z.saveBroker()">ذخیره</button>
    </section>
    <section class="panel"><div class="title">Apex Fusion Engine</div>
      <button class="${state.ai.enabled?'safeToggle':'dangerToggle'}" onclick="Z.toggleAi()">${state.ai.enabled?'🧠 APEX FUSION ON':'⚪ APEX FUSION OFF'}</button>
      <button class="${state.autoScan?'safeToggle':'dangerToggle'}" onclick="Z.toggleAuto()" style="margin-top:8px">${state.autoScan?'📡 AUTO SCAN ON':'⚪ AUTO SCAN OFF'}</button>
      <button class="${state.settings.sound!==false?'safeToggle':'dangerToggle'}" onclick="Z.toggleSound()" style="margin-top:8px">${state.settings.sound!==false?'🔔 هشدار صوتی روشن':'🔕 هشدار صوتی خاموش'}</button>
      <label>Minimum AI Strength (0-100)<input id="minAiScore" type="number" min="40" max="100" step="1" value="${state.settings.minAiScore}"></label>
      <label>AI Refresh (sec)<input id="aiRefresh" type="number" min="10" max="300" step="5" value="${state.settings.aiRefreshSec}"></label>
      <button class="goldBtn" onclick="Z.saveSettings()">ذخیره AI Gates</button>
    </section>
    <section class="panel"><div class="title">Safety / News</div>
      <button class="${state.settings.newsLock?'dangerToggle':'safeToggle'}" onclick="Z.toggleNewsLock()">${state.settings.newsLock?'🔴 NEWS LOCK ON — ورود مسدود':'🟢 NEWS LOCK OFF'}</button>
    </section>
    <section class="panel"><div class="title">Precision Gates</div>
      <label>Minimum Setup Quality (0-100)<input id="minQuality" type="number" min="50" max="100" step="1" value="${state.settings.minQuality}"></label>
      <label>Max Spread (price units)<input id="spread" type="number" step=".01" value="${state.settings.maxSpread}"></label>
      <label>Min M5 ATR<input id="minAtr" type="number" step=".05" value="${state.settings.minAtr}"></label>
      <label>Max M5 ATR<input id="maxAtr" type="number" step=".1" value="${state.settings.maxAtr}"></label>
      <label>TP1 minimum R:R<input id="rr" type="number" step=".05" value="${state.settings.minRR}"></label>
      <label>Planned Max Risk %<input id="risk" type="number" step=".05" value="${state.settings.maxRiskPct}"></label>
      <label>Entry Window (sec)<input id="entryWindow" type="number" step="5" value="${state.settings.entryWindowSec}"></label>
      <button class="goldBtn" onclick="Z.saveSettings()">ذخیره تنظیمات</button>
    </section>
    <section class="panel"><div class="title">90% Validation Gate</div>
      <label>Minimum Shadow Trades<input id="valN" type="number" step="10" value="${state.settings.validationMinTrades}"></label>
      <label>Target WR<input id="valWR" type="number" step=".01" value="${state.settings.validationTargetWR}"></label>
      <label>Minimum Profit Factor<input id="valPF" type="number" step=".1" value="${state.settings.validationMinPF}"></label>
      <label>Max Drawdown (R)<input id="valDD" type="number" step=".5" value="${state.settings.validationMaxDD}"></label>
      <button class="goldBtn" onclick="Z.saveSettings()">ذخیره Gate</button>
    </section>
    <section class="panel"><div class="title">نمایش Android</div>
      <button class="${state.settings.keepScreenOn?'safeToggle':'dangerToggle'}" onclick="Z.toggleKeepScreen()">${state.settings.keepScreenOn?'🟢 صفحه هنگام کار روشن بماند':'⚪ خاموش‌شدن خودکار صفحه'}</button>
    </section>
    <section class="panel"><div class="title">داده و پشتیبان</div>
      <div class="toolbar"><button onclick="Z.export()">خروجی JSON</button><label class="file">ورود JSON<input id="imp" type="file" accept="application/json" onchange="Z.import(this)"></label><button onclick="Z.reset()">بازنشانی</button></div>
    </section>${safety()}</main>${nav()}`;
}

function prepareTrade(id){
  const x=state.history.find(s=>s.id===id);
  if (!x||x.status!=='SIGNAL'||!state.trade.confirm) return;
  state.trade.lastPrepared={ at:new Date().toISOString(), broker:state.broker.name, platform:state.broker.platform, symbol:x.resolvedSymbol||x.symbol, direction:x.direction, entry:x.entry, sl:x.sl, tp1:x.tp1, tp2:x.tp2, tp3:x.tp3, status:'PREPARED_NOT_SENT' };
  state.audit.push({ at:new Date().toISOString(), type:'TRADE_PREPARED_NOT_SENT', detail:state.trade.lastPrepared });
  save(); native('toast','فقط آماده شد؛ هیچ سفارشی ارسال نشد.'); render();
}
function saveSettings(){
  const n=id=>document.getElementById(id);
  if (n('minQuality')) state.settings.minQuality=Math.min(100,Math.max(50,+n('minQuality').value||86));
  if (n('spread')) state.settings.maxSpread=Math.max(.01,+n('spread').value||.90);
  if (n('minAtr')) state.settings.minAtr=Math.max(.01,+n('minAtr').value||.35);
  if (n('maxAtr')) state.settings.maxAtr=Math.max(state.settings.minAtr,+n('maxAtr').value||18);
  if (n('rr')) state.settings.minRR=Math.max(1,+n('rr').value||1.6);
  if (n('risk')) state.settings.maxRiskPct=Math.max(.05,+n('risk').value||.35);
  if (n('entryWindow')) state.settings.entryWindowSec=Math.max(15,+n('entryWindow').value||75);
  if (n('minAiScore')) state.settings.minAiScore=Math.min(100,Math.max(40,+n('minAiScore').value||68));
  if (n('aiRefresh')) state.settings.aiRefreshSec=Math.min(300,Math.max(10,+n('aiRefresh').value||20));
  if (n('valN')) state.settings.validationMinTrades=Math.max(30,+n('valN').value||200);
  if (n('valWR')) state.settings.validationTargetWR=Math.min(.99,Math.max(.5,+n('valWR').value||.9));
  if (n('valPF')) state.settings.validationMinPF=Math.max(1,+n('valPF').value||1.5);
  if (n('valDD')) state.settings.validationMaxDD=Math.max(1,+n('valDD').value||8);
  save(true); render(true); restartTimers();
}
function patchHeader() {
  setTxt('hdrPx', fmt(state.price, 2), pxDir>0?'flashUp':pxDir<0?'flashDn':'');
  setTxt('hdrChg', `${pxDir>=0?'▲':'▼'} ${fmt(Math.abs(pxDir),2)} · ${state.market.source||state.feedMode}`, pxDir>=0?'up':'dn');
  const pill = document.getElementById('livePill');
  const live = state.market.status==='LIVE'||state.market.status==='READY';
  if (pill) { pill.className = 'livePill' + (live?'':' off'); pill.innerHTML = `<i></i>${live?'LIVE':'OFF'} ${esc(state.market.quality||'')}`; }
}
function patchLive() {
  if (dataReady()) livePreview = pipeline();
  patchHeader();
  setTxt('bidPx', fmt(state.market.bid));
  setTxt('askPx', fmt(state.market.ask));
  setTxt('sprPx', fmt(state.market.spread, 3));
  setTxt('venuePx', state.market.venue || state.market.source || '—');
  const age = tickAgeSec();
  setTxt('tickAge', Number.isFinite(age) ? fmt(age,1)+'s' : '—', age<=10?'ready':'locked');
  const d = state.ai.decision;
  setTxt('aiDec', d, d==='BUY'?'ok':d==='SELL'?'redTxt':'neutral');
  setTxt('aiStr', fmt(state.ai.strengthScore, 0));
  setTxt('aiAgr', pct(state.ai.agreement));
  const ageA = aiAgeSec();
  setTxt('aiAge', Number.isFinite(ageA) ? fmt(ageA,0)+'s' : '—');
  setTxt('aiVeto', String((state.ai.vetoes||[]).length || 0));
  setTxt('aiStat', state.ai.status);
  const orb = document.getElementById('aiOrb');
  if (orb) orb.className = 'aiOrb ' + (d==='BUY'?'buy':d==='SELL'?'sell':'');
  const fill = document.getElementById('confFill');
  if (fill) fill.style.width = Math.round((state.ai.agreement||0)*100) + '%';
  const thesis = document.getElementById('thesisBox');
  if (thesis && state.ai.thesis) thesis.textContent = state.ai.thesis;
  const chart = document.getElementById('chartBox');
  if (chart) chart.innerHTML = candleChart();
  const mtf = document.getElementById('mtfStrip');
  if (mtf) mtf.innerHTML = mtfStripInner();
  const tape = document.getElementById('tickTape');
  if (tape) tape.innerHTML = tickTapeHtml();
  setTxt('barCount', `${frames.M5.length} bars`);
  const miss = document.getElementById('liveMiss');
  if (miss) miss.innerHTML = liveMissHtml();
  const eq = document.getElementById('equityBox');
  if (eq) eq.innerHTML = equitySvg();
  const sigKey = lastCycle ? lastCycle.id + ':' + (lastCycle.resolution?.result||'OPEN') : '';
  if (sigKey && sigKey !== lastPatchedSig && lastCycle && lastCycle.status==='SIGNAL') {
    lastPatchedSig = sigKey;
  }
  updateCountdown();
}
function render(full=true){
  if (!full) {
    if (['settings','journal'].includes(state.ui.tab)) { patchHeader(); return; }
    if (document.getElementById('hdrPx') && ['home','signal','replay'].includes(state.ui.tab)) { patchLive(); return; }
  }
  const y = window.scrollY || 0;
  document.body.innerHTML = ({ home, signal, replay, journal, settings }[state.ui.tab] || home)() + '<div id="toast" class="toast"></div>';
  if (full && y > 40 && ['home','signal'].includes(state.ui.tab)) window.scrollTo(0, y);
  updateCountdown();
}
function updateCountdown(){ const el=document.getElementById('countdown'); if (el) el.textContent=countdownLeft>0?countdownLeft+'s':'—'; }
function restartTimers(){
  clearInterval(pollTimer); clearInterval(simTimer); clearInterval(aiTimer); clearInterval(barsTimer);
  if (state.feedMode==='ONLINE_AI') {
    pollTimer=setInterval(onlineTick, 3000);
    aiTimer=setInterval(requestAi, Math.max(10,state.settings.aiRefreshSec)*1000);
    barsTimer=setInterval(onlineBars, 70000);
  } else if (state.feedMode==='MT5_BRIDGE') {
    pollTimer=setInterval(requestMarket, 2200);
    if (state.ai.enabled) aiTimer=setInterval(requestAi, Math.max(15,state.settings.aiRefreshSec)*1000);
  } else {
    simTimer=setInterval(simulationStep, 3000);
  }
}

window.Z = {
  tab:setTab, mode:setMode, cycle:()=>cycle(false), onNativeReply, saveBridge, clearBridge, syncBars, testBridge:requestHealth,
  toggleNewsLock, toggleKeepScreen, saveBroker, toggleAuto, aiNow:requestAi,
  toggleSound(){ state.settings.sound = state.settings.sound===false; save(true); render(true); },
  toggleAi(){ state.ai.enabled=!state.ai.enabled; if(!state.ai.enabled){ state.ai.status='DISABLED'; state.ai.decision='WAIT'; } else { state.ai.status='NOT_READY'; requestAi(); } save(); restartTimers(); render(); },
  applyFeed(){ setFeedMode(document.getElementById('feedMode')?.value||'ONLINE_AI'); },
  confirmTrade(v){ state.trade.confirm=!!v; save(); render(); }, prepareTrade, saveSettings,
  export(){ const json=JSON.stringify({ app:'Zarnegar Apex XAUUSD', version:'v61-apex', exportedAt:new Date().toISOString(), state },null,2); const name=`zarnegar-apex-${new Date().toISOString().slice(0,10)}.json`; try{ if(AndroidBridge?.saveTextFile){ AndroidBridge.saveTextFile(name,json); return; } }catch(_){} const blob=new Blob([json],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); },
  import(inp){ const f=inp.files?.[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ try{ const x=JSON.parse(r.result); Object.assign(state,merge(x.state||x)); save(); location.reload(); }catch{ alert('فایل معتبر نیست.'); } }; r.readAsText(f); },
  reset(){ if(confirm('تمام داده‌های محلی زرنگار پاک شود؟')){ localStorage.removeItem(KEY); localStorage.removeItem(PREV_KEY); location.reload(); } },
  clearHistory(){ if(confirm('History پاک شود؟')){ state.history=[]; state.session.signals=0; state.session.noTrades=0; lastCycle=null; save(); render(); } },
  note(){ const n=document.getElementById('jn')?.value.trim(); if(!n)return; state.journal.push({ id:'j_'+Date.now(), at:new Date().toISOString(), tag:'NOTE', note:n }); state.journal=state.journal.slice(-700); save(); render(); }
};

readBridgeConfig();
if (state.feedMode==='SIMULATION') { initSimulation(); runLocalAi(); }
else if (state.feedMode==='ONLINE_AI') { requestNativePublicFeeds(); onlineBars(); onlineTick(); }
else { frames={ M1:[], M5:[], M15:[], H1:[] }; requestHealth(); syncBars(); setTimeout(requestAi, 2500); }
render(); restartTimers(); applyKeepScreen();
countdownTimer=setInterval(()=>{ if (countdownLeft>0){ countdownLeft--; updateCountdown(); } if (typeof flushSave==='function') flushSave(); }, 1000);

})();
