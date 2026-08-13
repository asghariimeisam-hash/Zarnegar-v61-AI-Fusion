/* --------------------------------------------------------------------------
 * WEB BRIDGE SHIM
 * Inside the Android WebView the app talks to native code via `AndroidBridge`.
 * In a plain browser we shim that same interface with fetch() calls to the
 * bundled backend (server.js), so MT5 Bridge mode + AI Fusion work online.
 * -------------------------------------------------------------------------- */
(function webBridge() {
  if (typeof AndroidBridge !== 'undefined') return;
  const call = (kind, path) => {
    fetch(path)
      .then((r) => r.json())
      .then((o) => { const Z = window.Z || {}; if (Z.onNativeReply) Z.onNativeReply(kind, JSON.stringify(o)); })
      .catch(() => { const Z = window.Z || {}; if (Z.onNativeReply) Z.onNativeReply(kind, JSON.stringify({ ok: false, error: 'NETWORK_ERROR' })); });
  };
  window.AndroidBridge = {
    isOnline: () => navigator.onLine !== false,
    requestMarket: (sym) => call('market', '/v1/market?symbol=' + encodeURIComponent(sym || 'XAUUSD')),
    requestBars: (sym, tf, count) => call('bars:' + tf, '/v1/bars?symbol=' + encodeURIComponent(sym || 'XAUUSD') + '&timeframe=' + tf + '&count=' + (count || 300)),
    requestAi: (sym) => call('ai', '/v1/ai?symbol=' + encodeURIComponent(sym || 'XAUUSD')),
    requestStats: () => call('stats', '/v1/stats'),
    requestHealth: () => call('health', '/v1/health'),
    getBridgeConfig: () => JSON.stringify({ baseUrl: '/v1', hasToken: false }),
    configureBridge: () => true,
    clearBridgeConfig: () => {},
    vibrate: () => { try { navigator.vibrate && navigator.vibrate(60); } catch (_) {} },
    toast: () => {},
    share: () => {},
    setKeepScreenOn: () => {},
    saveTextFile: () => {},
    stateChanged: () => {}
  };
})();

(() => {
'use strict';

const KEY = 'zarnegar.v61.personal.state';
const PREV_KEY = 'zarnegar.v59.personal.state';
const DEF = {
  version: 'v61',
  symbol: 'XAUUSD',
  price: 2431.80,
  appMode: 'SIGNAL',
  feedMode: 'MT5_BRIDGE',
  executionEnabled: false,
  broker: { name: 'Alpari', platform: 'UNSET', status: 'NOT_CONFIGURED', bridgeStatus: 'OFFLINE' },
  market: { status: 'SIMULATION', resolvedSymbol: 'XAUUSD', bid: null, ask: null, spread: null, tickTime: null, lastError: null, bridgeConfigured: false, hasToken: false },
  settings: {
    minQuality: 90,
    maxSpread: 0.35,
    minAtr: 0.45,
    maxAtr: 6.0,
    maxRiskPct: 0.35,
    entryWindowSec: 75,
    minRR: 1.50,
    validationMinTrades: 200,
    validationTargetWR: 0.90,
    validationMinPF: 1.50,
    validationMaxDD: 8,
    newsLock: false,
    keepScreenOn: true,
    minAiScore: 72,
    aiRefreshSec: 30
  },
  ai: {
    enabled: true,
    status: 'NOT_READY',
    decision: 'WAIT',
    strengthScore: 0,
    agreement: 0,
    regime: null,
    providers: [],
    generatedAt: null,
    receivedAt: null,
    lastError: null,
    note: 'AI strength is not win probability',
    adx: null,
    macd: null,
    bb: null,
    support: null,
    resistance: null,
    forecast: null,
    backtest: null
  },
  stats: null,
  history: [], journal: [], audit: [],
  session: { startedAt: null, cycles: 0, signals: 0, noTrades: 0 },
  ui: { tab: 'home' },
  trade: { confirm: false, lastPrepared: null }
};

const state = load();
let frames = { M1: [], M5: [], M15: [], H1: [] };
let lastCycle = state.history.at(-1) || null;
let countdownLeft = 0;
let pollTimer = null;
let countdownTimer = null;
let simTimer = null;
let aiTimer = null;
let requestPending = false;
let aiPending = false;
let requestStartedAt = 0;

document.documentElement.lang = 'fa';

function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(PREV_KEY) || '{}';
    const s = merge(JSON.parse(raw));
    if (!localStorage.getItem(KEY) && localStorage.getItem(PREV_KEY)) {
      localStorage.setItem(KEY, JSON.stringify(s));
    }
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
  s.history = Array.isArray(s.history) ? s.history.slice(-2500) : [];
  s.journal = Array.isArray(s.journal) ? s.journal.slice(-700) : [];
  s.audit = Array.isArray(s.audit) ? s.audit.slice(-3000) : [];
  // Hard safety invariant: this build never sends real orders.
  s.executionEnabled = false;
  s.trade.confirm = false;
  return s;
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  try { AndroidBridge?.stateChanged?.(); } catch (_) {}
}
function esc(x) { return String(x ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m])); }
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

function ema(vals, p) {
  if (!vals.length) return NaN;
  const k = 2 / (p + 1); let e = vals[0];
  for (let i=1; i<vals.length; i++) e = vals[i] * k + e * (1-k);
  return e;
}
function rsi(vals, p=14) {
  if (vals.length < p + 1) return 50;
  let g=0, l=0;
  for (let i=vals.length-p; i<vals.length; i++) {
    const d = vals[i] - vals[i-1]; if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  const rs = (g/p) / (l/p); return 100 - (100/(1+rs));
}
function atr(bars, p=14) {
  if (bars.length < p + 1) return NaN;
  let s=0;
  for (let i=bars.length-p; i<bars.length; i++) {
    const prev = bars[i-1].c;
    s += Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-prev), Math.abs(bars[i].l-prev));
  }
  return s/p;
}
function seedSimulation(price, n=4200) {
  const out=[]; let p=price || 2431.8;
  let t = Math.floor((Date.now()-n*60000)/60000)*60000;
  for (let i=0; i<n; i++, t+=60000) {
    const slow = Math.sin(i/170)*0.13 + Math.sin(i/47)*0.06;
    const shock = (Math.random()-.5)*0.62;
    const o=p; p=Math.max(100, p+slow+shock);
    const range=.18+Math.random()*.75;
    out.push({t,o,h:Math.max(o,p)+Math.random()*range,l:Math.min(o,p)-Math.random()*range,c:p});
  }
  return out;
}
function aggregateSeries(src, minutes) {
  const ms = minutes*60000, map = new Map();
  for (const b of src) {
    const bucket = Math.floor(b.t/ms)*ms;
    const x = map.get(bucket);
    if (!x) map.set(bucket, {t:bucket,o:b.o,h:b.h,l:b.l,c:b.c});
    else { x.h=Math.max(x.h,b.h); x.l=Math.min(x.l,b.l); x.c=b.c; }
  }
  return Array.from(map.values()).slice(-500);
}
function initSimulation() {
  const m1 = seedSimulation(state.price, 4200);
  frames.M1 = m1.slice(-500);
  frames.M5 = aggregateSeries(m1,5);
  frames.M15 = aggregateSeries(m1,15);
  frames.H1 = aggregateSeries(m1,60);
  const last = frames.M1.at(-1);
  state.price = last.c;
  const spread = .12 + Math.random()*.13;
  state.market = { ...state.market, status:'SIMULATION', resolvedSymbol:'XAUUSD', bid:last.c-spread/2, ask:last.c+spread/2, spread, tickTime:Date.now(), lastError:null };
}
function upsertBar(tf, bar, max=500) {
  const a=frames[tf], last=a.at(-1);
  if (last && last.t === bar.t) { last.h=Math.max(last.h,bar.h); last.l=Math.min(last.l,bar.l); last.c=bar.c; }
  else { a.push({...bar}); if (a.length>max) a.splice(0,a.length-max); }
}
function upsertTickToFrame(tf, minutes, mid, t) {
  const bucket=Math.floor(t/(minutes*60000))*(minutes*60000), a=frames[tf], last=a.at(-1);
  if (last && last.t===bucket) { last.h=Math.max(last.h,mid); last.l=Math.min(last.l,mid); last.c=mid; return false; }
  a.push({t:bucket,o:mid,h:mid,l:mid,c:mid}); if (a.length>500) a.shift(); return true;
}

function simulationStep() {
  if (state.feedMode !== 'SIMULATION') return;
  const last=frames.M1.at(-1), o=last.c;
  const bias=(ema(frames.M15.map(x=>x.c),9)-ema(frames.M15.map(x=>x.c),21))*0.025;
  const c=Math.max(100,o+bias+(Math.random()-.49)*.85), range=.18+Math.random()*.85;
  const b={t:last.t+60000,o,h:Math.max(o,c)+Math.random()*range,l:Math.min(o,c)-Math.random()*range,c};
  frames.M1.push(b); if(frames.M1.length>500)frames.M1.shift();
  for (const [tf,min] of [['M5',5],['M15',15],['H1',60]]) {
    const bucket=Math.floor(b.t/(min*60000))*(min*60000);
    upsertBar(tf,{t:bucket,o:b.o,h:b.h,l:b.l,c:b.c});
  }
  const spread=.12+Math.random()*.16;
  state.price=c; state.market.bid=c-spread/2; state.market.ask=c+spread/2; state.market.spread=spread; state.market.tickTime=Date.now();
  evaluateOpenSignalsBar(b, true);
  save(); render(false);
}

function currentSource() { return state.feedMode === 'MT5_BRIDGE' ? 'SHADOW' : 'SIMULATION'; }
function metrics(source) {
  const xs = state.history.filter(x => x.source===source && x.resolution && (x.resolution.result==='WIN'||x.resolution.result==='LOSS'));
  const wins=xs.filter(x=>x.resolution.result==='WIN').length, losses=xs.length-wins;
  const wr=xs.length?wins/xs.length:null;
  let grossWin=0,grossLoss=0,equity=0,peak=0,maxDD=0;
  for(const x of xs){const r=+x.resolution.rMultiple||0;equity+=r;if(r>0)grossWin+=r;else grossLoss+=Math.abs(r);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);}
  return {n:xs.length,wins,losses,wr,pf:grossLoss?grossWin/grossLoss:(grossWin?Infinity:null),maxDD};
}
function validation() {
  const m=metrics('SHADOW');
  const pass=m.n>=state.settings.validationMinTrades && m.wr>=state.settings.validationTargetWR && (m.pf||0)>=state.settings.validationMinPF && m.maxDD<=state.settings.validationMaxDD;
  return {m,pass};
}
function metricText(v,kind){if(v==null)return'—';if(v===Infinity)return'∞';return kind==='pct'?pct(v):fmt(v,2);}

function resolveSignal(x,result,r,note='') {
  x.resolution={at:new Date().toISOString(),result,rMultiple:r,note};
  state.audit.push({at:new Date().toISOString(),type:'SIGNAL_RESOLVED',detail:{id:x.id,source:x.source,result,rMultiple:r}});
}
function evaluateOpenSignalsTick(bid,ask,newM1) {
  const source=currentSource();
  for(const x of state.history){
    if(x.source!==source||x.status!=='SIGNAL'||x.resolution)continue;
    if(newM1)x.barsAfter=(x.barsAfter||0)+1;
    const px=x.direction==='BUY'?bid:ask;
    if(!Number.isFinite(px))continue;
    const hitSL=x.direction==='BUY'?px<=x.sl:px>=x.sl;
    const hitTP=x.direction==='BUY'?px>=x.tp1:px<=x.tp1;
    if(hitTP)resolveSignal(x,'WIN',x.rr1||1.5,'TP1 before SL on tick feed');
    else if(hitSL)resolveSignal(x,'LOSS',-1,'SL before TP1 on tick feed');
    else if((x.barsAfter||0)>=45)resolveSignal(x,'EXPIRED',0,'45 M1 bars without TP1/SL');
  }
}
function evaluateOpenSignalsBar(bar,newM1) {
  const source=currentSource();
  for(const x of state.history){
    if(x.source!==source||x.status!=='SIGNAL'||x.resolution)continue;
    if(newM1)x.barsAfter=(x.barsAfter||0)+1;
    const sl=x.direction==='BUY'?bar.l<=x.sl:bar.h>=x.sl;
    const tp=x.direction==='BUY'?bar.h>=x.tp1:bar.l<=x.tp1;
    if(sl&&tp)resolveSignal(x,'AMBIGUOUS',0,'SL و TP1 در یک کندل؛ از Win/Loss حذف شد');
    else if(tp)resolveSignal(x,'WIN',x.rr1||1.5);
    else if(sl)resolveSignal(x,'LOSS',-1);
    else if((x.barsAfter||0)>=45)resolveSignal(x,'EXPIRED',0);
  }
}

function dataReady() { return ['M5','M15','H1'].every(tf => frames[tf].length >= 60); }
function tickAgeSec() { return state.market.tickTime ? Math.max(0,(Date.now()-state.market.tickTime)/1000) : Infinity; }
function aiAgeSec() { return state.ai.receivedAt ? Math.max(0,(Date.now()-state.ai.receivedAt)/1000) : Infinity; }
function pipeline() {
  const m5=frames.M5, m15=frames.M15, h1=frames.H1;
  if(!dataReady()) return {candidate:{status:'NO_TRADE',direction:null,quality:0,gates:{data:false},reasons:['داده چندتایم‌فریم هنوز کامل نیست']},feed:{}};

  const h1c=h1.map(x=>x.c), m15c=m15.map(x=>x.c), m5c=m5.map(x=>x.c);
  const h1e20=ema(h1c.slice(-120),20), h1e50=ema(h1c.slice(-160),50), h1last=h1c.at(-1);
  let direction=null;
  if(h1e20>h1e50 && h1last>h1e20) direction='BUY';
  if(h1e20<h1e50 && h1last<h1e20) direction='SELL';

  const e9=ema(m15c.slice(-80),9), e21=ema(m15c.slice(-100),21), e50=ema(m15c.slice(-140),50);
  const e9prev=ema(m15c.slice(0,-2).slice(-80),9);
  const mtfTrend = direction==='BUY' ? (e9>e21&&e21>e50&&e9>e9prev) : direction==='SELL' ? (e9<e21&&e21<e50&&e9<e9prev) : false;
  const rv=rsi(m15c,14);
  const last3=m15c.at(-1)-m15c.at(-4);
  const momentum = direction==='BUY' ? (rv>=53&&rv<=69&&last3>0) : direction==='SELL' ? (rv<=47&&rv>=31&&last3<0) : false;

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
  const freshPass=state.feedMode==='SIMULATION' || tickAgeSec()<=10;
  const newsPass=!state.settings.newsLock;
  const noOpen=!state.history.some(x=>x.source===currentSource()&&x.status==='SIGNAL'&&!x.resolution);

  const technicalQuality=(direction?20:0)+(mtfTrend?20:0)+(momentum?15:0)+(structure?20:0)+(volPass?10:0)+(spreadPass?10:0)+(freshPass?5:0);
  const aiRequired=state.feedMode==='MT5_BRIDGE' && state.ai.enabled;
  const aiFresh=!aiRequired || (aiAgeSec()<=Math.max(90,state.settings.aiRefreshSec*3));
  const aiReady=!aiRequired || ['READY','PARTIAL'].includes(state.ai.status);
  const aiDirection=!aiRequired || (!!direction && state.ai.decision===direction);
  const aiScore=!aiRequired || (+state.ai.strengthScore>=state.settings.minAiScore);
  const aiPass=aiFresh&&aiReady&&aiDirection&&aiScore;
  let quality=aiRequired?Math.round(technicalQuality*.72+Math.min(100,+state.ai.strengthScore||0)*.28):technicalQuality;
  if(!noOpen)quality=Math.min(quality,75);
  const qualityPass=quality>=state.settings.minQuality;
  const gates={h1Trend:!!direction,m15Trend:mtfTrend,momentum,structure,volatility:volPass,spread:spreadPass,fresh:freshPass,news:newsPass,noOpen,ai:aiPass,quality:qualityPass};
  const pass=Object.values(gates).every(Boolean);
  const reasons=[];
  if(!direction)reasons.push('روند H1 با EMA20/50 تأیید نشده');
  if(!mtfTrend)reasons.push('هم‌جهتی روند M15 با H1 کامل نیست');
  if(!momentum)reasons.push('RSI/Momentum در محدوده A+ نیست');
  if(!structure)reasons.push('ساختار ورود M5 تأیید نشده');
  if(!volPass)reasons.push('ATR پنج‌دقیقه خارج از محدوده مجاز است');
  if(!spreadPass)reasons.push('Spread از سقف تعیین‌شده بیشتر است');
  if(!freshPass)reasons.push('فید قیمت تازه نیست');
  if(!newsPass)reasons.push('قفل خبر مهم فعال است');
  if(!noOpen)reasons.push('یک سیگنال باز هنوز تعیین تکلیف نشده');
  if(state.feedMode==='MT5_BRIDGE'&&state.ai.enabled&&!aiReady)reasons.push('AI Fusion هنوز آماده نیست');
  if(state.feedMode==='MT5_BRIDGE'&&state.ai.enabled&&aiReady&&!aiFresh)reasons.push('خروجی AI تازه نیست');
  if(state.feedMode==='MT5_BRIDGE'&&state.ai.enabled&&aiReady&&direction&&state.ai.decision!==direction)reasons.push('AI Fusion با جهت تکنیکال هم‌نظر نیست');
  if(state.feedMode==='MT5_BRIDGE'&&state.ai.enabled&&aiReady&&+state.ai.strengthScore<state.settings.minAiScore)reasons.push('AI Strength به حداقل تعیین‌شده نرسیده');
  if(!qualityPass)reasons.push('Setup Quality به حداقل نرسیده');

  const bid=+state.market.bid, ask=+state.market.ask;
  const mid=Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:m5c.at(-1);
  const entry=direction==='BUY'&&Number.isFinite(ask)?ask:direction==='SELL'&&Number.isFinite(bid)?bid:mid;
  const risk=Math.max((Number.isFinite(av)?av:1)*1.30, Number.isFinite(spread)?spread*4:0, .60);
  const sign=direction==='SELL'?-1:1, rr1=state.settings.minRR;
  const sl=direction?entry-sign*risk:null, tp1=direction?entry+sign*risk*rr1:null, tp2=direction?entry+sign*risk*2.10:null, tp3=direction?entry+sign*risk*2.85:null;
  const z1=direction?entry-sign*(Number.isFinite(av)?av*.10:.1):null, z2=direction?entry+sign*(Number.isFinite(av)?av*.08:.1):null;

  return {
    feed:{price:mid,bid,ask,spread,atr:av,rsi:rv,h1e20,h1e50,m15e9:e9,m15e21:e21,m15e50:e50},
    candidate:{status:pass?'SIGNAL':'NO_TRADE',direction:pass?direction:null,quality,entry:pass?entry:null,entryLow:pass?Math.min(z1,z2):null,entryHigh:pass?Math.max(z1,z2):null,sl:pass?sl:null,tp1:pass?tp1:null,tp2:pass?tp2:null,tp3:pass?tp3:null,rr1,gates,reasons}
  };
}
function cycle() {
  state.session.startedAt=state.session.startedAt||new Date().toISOString();
  state.session.cycles++;
  const p=pipeline(), c=p.candidate, source=currentSource();
  const item={
    id:'sig_'+Date.now(),timestamp:new Date().toISOString(),source,symbol:state.symbol,
    resolvedSymbol:state.market.resolvedSymbol||state.symbol,price:p.feed.price??state.price,direction:c.direction,status:c.status,
    entry:c.entry,entryLow:c.entryLow,entryHigh:c.entryHigh,sl:c.sl,tp1:c.tp1,tp2:c.tp2,tp3:c.tp3,rr1:c.rr1,
    quality:c.quality,spread:p.feed.spread,atr:p.feed.atr,rsi:p.feed.rsi,gates:c.gates,reasons:c.reasons,resolution:null,barsAfter:0,
    ai:{status:state.ai.status,decision:state.ai.decision,strengthScore:state.ai.strengthScore,agreement:state.ai.agreement,generatedAt:state.ai.generatedAt},
    feedMode:state.feedMode
  };
  if(c.status==='SIGNAL'){state.session.signals++;countdownLeft=state.settings.entryWindowSec;native('vibrate');}
  else {state.session.noTrades++;countdownLeft=0;}
  state.history.push(item);state.history=state.history.slice(-2500);lastCycle=item;
  state.audit.push({at:new Date().toISOString(),type:'PRECISION_CYCLE_V61_AI_FUSION',detail:{source,status:c.status,direction:c.direction||'NO_TRADE',quality:c.quality,reasons:c.reasons}});
  state.audit=state.audit.slice(-3000); save(); render();
}

function parseReply(payload){try{return JSON.parse(payload);}catch{return {ok:false,error:'INVALID_JSON'};}}
function readBridgeConfig(){
  if(!hasNative())return;
  try{const c=JSON.parse(AndroidBridge.getBridgeConfig()||'{}');state.market.bridgeConfigured=!!c.baseUrl;state.market.hasToken=!!c.hasToken;save();}catch(_){}
}
function requestHealth(){
  if(!hasNative()){native('toast','این قابلیت داخل نسخه Android فعال می‌شود.');return;}
  try{AndroidBridge.requestHealth();}catch(_){ }
}
function syncBars(){
  if(!hasNative())return;
  frames={M1:[],M5:[],M15:[],H1:[]};
  for(const tf of ['M1','M5','M15','H1']){try{AndroidBridge.requestBars(state.symbol,tf,300);}catch(_){}}
  state.market.status='SYNCING';state.market.lastError=null;save();render();
}
function requestMarket(){
  if(state.feedMode!=='MT5_BRIDGE'||!hasNative())return;
  if(requestPending && Date.now()-requestStartedAt<8000)return;
  requestPending=true;requestStartedAt=Date.now();
  try{AndroidBridge.requestMarket(state.symbol);}catch(_){requestPending=false;}
}
function onMarketReply(o){
  requestPending=false;
  if(!o||o.ok===false){state.market.status='ERROR';state.market.lastError=o?.error||'MARKET_ERROR';state.broker.bridgeStatus='OFFLINE';save();render(false);return;}
  const bid=+o.bid,ask=+o.ask,t=o.time_msc?+o.time_msc:(o.time?+o.time*1000:Date.now());
  if(!Number.isFinite(bid)||!Number.isFinite(ask)){state.market.lastError='BAD_TICK';return;}
  const mid=(bid+ask)/2, spread=ask-bid;
  state.price=mid;state.market.status='LIVE';state.market.bid=bid;state.market.ask=ask;state.market.spread=spread;state.market.tickTime=t;state.market.resolvedSymbol=o.symbol||state.symbol;state.market.lastError=null;state.broker.bridgeStatus='ONLINE';
  const newM1=upsertTickToFrame('M1',1,mid,t);
  upsertTickToFrame('M5',5,mid,t);upsertTickToFrame('M15',15,mid,t);upsertTickToFrame('H1',60,mid,t);
  evaluateOpenSignalsTick(bid,ask,newM1);save();render(false);
}
function onBarsReply(kind,o){
  const tf=kind.split(':')[1];
  if(!tf||!frames[tf])return;
  if(!o||o.ok===false||!Array.isArray(o.bars)){state.market.lastError=o?.error||('BARS_'+tf+'_ERROR');save();return;}
  const arr=o.bars.map(x=>({t:(+x.time>1e12?+x.time:+x.time*1000),o:+x.open,h:+x.high,l:+x.low,c:+x.close})).filter(x=>[x.t,x.o,x.h,x.l,x.c].every(Number.isFinite));
  if(arr.length){frames[tf]=arr.slice(-500);state.market.resolvedSymbol=o.symbol||state.market.resolvedSymbol;}
  if(dataReady()){state.market.status='READY';state.market.lastError=null;if(state.feedMode==='MT5_BRIDGE'&&state.ai.enabled)requestAi();}
  save();render(false);
}
function requestAi(){
  if(state.feedMode!=='MT5_BRIDGE'||!state.ai.enabled||!hasNative()||aiPending)return;
  aiPending=true;
  try{AndroidBridge.requestAi(state.symbol);}catch(_){aiPending=false;}
}
function onAiReply(o){
  aiPending=false;
  state.ai.receivedAt=Date.now();
  if(!o||o.ok===false){state.ai.status='ERROR';state.ai.decision='WAIT';state.ai.strengthScore=0;state.ai.lastError=o?.error||'AI_ERROR';save();render(false);return;}
  state.ai.decision=['BUY','SELL','WAIT'].includes(o.decision)?o.decision:'WAIT';
  state.ai.strengthScore=Number.isFinite(+o.strength_score)?+o.strength_score:0;
  state.ai.agreement=Number.isFinite(+o.agreement)?+o.agreement:0;
  state.ai.regime=o.regime||null;
  state.ai.providers=Array.isArray(o.providers)?o.providers:[];
  state.ai.generatedAt=o.generated_at?+o.generated_at*1000:Date.now();
  state.ai.lastError=null;
  state.ai.note=o.model_note||'AI strength is not win probability';
  state.ai.adx=Number.isFinite(+o.adx)?+o.adx:null;
  state.ai.macd=o.macd||null;
  state.ai.bb=o.bb||null;
  state.ai.support=Number.isFinite(+o.support)?+o.support:null;
  state.ai.resistance=Number.isFinite(+o.resistance)?+o.resistance:null;
  state.ai.forecast=o.forecast||null;
  state.ai.backtest=o.backtest||null;
  save();render(false);
}
function requestStats(){
  if(!hasNative())return;
  try{AndroidBridge.requestStats();}catch(_){ }
}
function onStatsReply(o){
  if(!o||o.ok===false)return;
  state.stats=o;
  save();render(false);
}
function onNativeReply(kind,payload){
  const o=parseReply(payload);
  if(kind==='market'){onMarketReply(o);return;}
  if(kind==='ai'){onAiReply(o);return;}
  if(kind==='stats'){onStatsReply(o);return;}
  if(kind.startsWith('bars:')){onBarsReply(kind,o);return;}
  if(kind==='health'){
    if(o&&o.ok!==false){state.market.bridgeConfigured=true;state.market.status='BRIDGE_OK';state.broker.bridgeStatus='ONLINE';state.market.lastError=null;if(o.symbol)state.market.resolvedSymbol=o.symbol;}
    else{state.market.status='ERROR';state.broker.bridgeStatus='OFFLINE';state.market.lastError=o?.error||'HEALTH_ERROR';}
    save();render();
  }
}

function setFeedMode(mode){
  const m=mode==='MT5_BRIDGE'?'MT5_BRIDGE':'SIMULATION';
  state.feedMode=m;lastCycle=null;
  if(m==='SIMULATION'){initSimulation();state.broker.bridgeStatus='OFFLINE';state.ai.status='NOT_USED';state.ai.decision='WAIT';}
  else {frames={M1:[],M5:[],M15:[],H1:[]};state.market.status='OFFLINE';state.ai.status='NOT_READY';state.ai.decision='WAIT';state.market.bid=null;state.market.ask=null;state.market.spread=null;state.market.tickTime=null;readBridgeConfig();requestHealth();syncBars();}
  save();render();restartTimers();applyKeepScreen();
}
function saveBridge(){
  if(!hasNative()){native('toast','تنظیم Bridge فقط داخل اپ Android ذخیره می‌شود.');return;}
  const url=document.getElementById('bridgeUrl')?.value.trim()||'';
  const token=document.getElementById('bridgeToken')?.value||'';
  let ok=false;try{ok=AndroidBridge.configureBridge(url,token);}catch(_){}
  if(!ok){native('toast','آدرس نامعتبر است. HTTPS یا HTTP شبکه خصوصی وارد کنید.');return;}
  readBridgeConfig();native('toast','Bridge به‌صورت محلی در Android ذخیره شد.');requestHealth();syncBars();render();
}
function clearBridge(){try{AndroidBridge?.clearBridgeConfig?.();}catch(_){}state.market.bridgeConfigured=false;state.market.hasToken=false;state.market.status='OFFLINE';state.broker.bridgeStatus='OFFLINE';save();render();}
function saveBroker(){state.broker.platform=document.getElementById('platform').value;state.broker.status=brokerReady()?'PLATFORM_SELECTED':'NOT_CONFIGURED';save();render();}
function brokerReady(){return state.broker.platform==='MT4'||state.broker.platform==='MT5';}
function setMode(m){state.appMode=m==='TRADER'?'TRADER':'SIGNAL';state.trade.confirm=false;save();render();}
function setTab(t){state.ui.tab=t;save();render();}
function toggleNewsLock(){state.settings.newsLock=!state.settings.newsLock;save();render();}
function toggleKeepScreen(){state.settings.keepScreenOn=!state.settings.keepScreenOn;save();applyKeepScreen();render();}

function header(){return `<header><div><div class="micro">PERSONAL • XAUUSD AI FUSION</div><div class="brand">ZARNEGAR <b>v61</b></div><div class="sub">Trend Fusion + Momentum + Regime Gates • Web AI Engine</div></div><div class="precisionBadge">AI FUSION</div></header>`;}
function modeSwitch(){return `<section class="modeSwitch"><button class="${state.appMode==='SIGNAL'?'active':''}" onclick="Z.mode('SIGNAL')">◆ SIGNAL MODE<br><small>تحلیل و Shadow</small></button><button class="trader ${state.appMode==='TRADER'?'active':''}" onclick="Z.mode('TRADER')">⚡ TRADER MODE<br><small>Real execution قفل است</small></button></section>`;}
function brokerStrip(){const age=tickAgeSec();return `<section class="brokerStrip"><div><small>BROKER</small><b>${esc(state.broker.name)}</b></div><div><small>PLATFORM</small><b class="${brokerReady()?'ready':'neutral'}">${esc(state.broker.platform)}</b></div><div><small>FEED</small><b class="${state.market.status==='LIVE'||state.market.status==='READY'?'ready':'neutral'}">${esc(state.feedMode)}</b></div><div><small>TICK AGE</small><b class="${age<=10?'ready':'locked'}">${Number.isFinite(age)?fmt(age,1)+'s':'—'}</b></div></section>`;}
function feedPanel(){return `<section class="panel livePanel"><div class="title"><span class="kicker">MARKET DATA</span><span>${esc(state.market.status)}</span></div><div class="marketGrid"><div><small>BID</small><b>${fmt(state.market.bid)}</b></div><div><small>ASK</small><b>${fmt(state.market.ask)}</b></div><div><small>SPREAD</small><b>${fmt(state.market.spread,3)}</b></div><div><small>SYMBOL</small><b>${esc(state.market.resolvedSymbol||state.symbol)}</b></div></div><div class="statusline"><span class="statusdot ${state.market.status==='LIVE'||state.market.status==='READY'?'':'warn'}"></span>${faTime()} • ${state.market.lastError?'خطا: '+esc(state.market.lastError):'Execution: READ-ONLY / SHADOW'}</div>${state.feedMode==='MT5_BRIDGE'?`<div class="toolbar"><button onclick="Z.testBridge()">تست Bridge</button><button onclick="Z.syncBars()">همگام‌سازی MTF</button></div>`:''}</section>`;}
function aiPanel(){
  const ps=state.ai.providers||[];
  const age=aiAgeSec();
  const providerHtml=ps.length?ps.map(p=>`<div class="aiProvider"><div><b>${esc(p.name)}</b><small>${p.ready?'READY':'OFFLINE'}</small></div><strong class="${p.direction==='BUY'?'ok':p.direction==='SELL'?'redTxt':'neutral'}">${esc(p.direction||'WAIT')}</strong><span>S ${fmt(p.strength,0)}</span></div>`).join(''):'<div class="empty">هنوز خروجی مدل دریافت نشده است.</div>';
  const extra=state.ai.adx!==null?`<div class="evidenceLine"><div><small>ADX</small><b>${fmt(state.ai.adx,1)}</b></div><div><small>MACD H</small><b class="${state.ai.macd&&state.ai.macd.hist>0?'ok':'redTxt'}">${state.ai.macd?fmt(state.ai.macd.hist,3):'—'}</b></div><div><small>BB %B</small><b>${state.ai.bb?fmt(state.ai.bb.pctB,2):'—'}</b></div><div><small>SUPPORT</small><b>${fmt(state.ai.support)}</b></div><div><small>RESIST</small><b>${fmt(state.ai.resistance)}</b></div></div>`:'';
  const forecast=state.ai.forecast?`<div class="statusline"><span class="statusdot ${state.ai.decision==='WAIT'?'warn':''}"></span>Forecast +${state.ai.forecast.horizon} TF: <b>${fmt(state.ai.forecast.forecast_price)}</b> (last ${fmt(state.ai.forecast.last_price)})</div>`:'';
  const bt=state.ai.backtest;
  const backtestHtml=bt?`<section class="panel"><div class="title"><span class="kicker">HONEST BACKTEST</span><span>SIMULATED</span></div><div class="metricBoard"><div><small>TRADES</small><b>${bt.n}</b><span>sample</span></div><div><small>WIN RATE</small><b>${bt.winRate!=null?pct(bt.winRate):'—'}</b><span>${bt.wins}W/${bt.losses}L</span></div><div><small>PROFIT FACTOR</small><b>${metricText(bt.profitFactor)}</b><span>R:R 1.50</span></div><div><small>MAX DD</small><b>${fmt(bt.maxDrawdown,2)}R</b><span>worst</span></div></div><p class="mini">${esc(bt.note)}</p></section>`:'';
  return `<section class="panel aiPanel"><div class="title"><span class="kicker">ADVANCED AI FUSION</span><span>${esc(state.ai.status)}</span></div><div class="aiDecision"><div><small>DECISION</small><b class="${state.ai.decision==='BUY'?'ok':state.ai.decision==='SELL'?'redTxt':'neutral'}">${esc(state.ai.decision)}</b></div><div><small>AI STRENGTH</small><b>${fmt(state.ai.strengthScore,0)}/100</b></div><div><small>AGREEMENT</small><b>${pct(state.ai.agreement)}</b></div><div><small>AGE</small><b>${Number.isFinite(age)?fmt(age,0)+'s':'—'}</b></div></div>${state.ai.regime?`<div class="statusline"><span class="statusdot ${state.ai.regime.trend==='RANGE'?'warn':''}"></span>Regime: ${esc(state.ai.regime.trend)} • RSI ${fmt(state.ai.regime.rsi,1)} • ATR ${fmt(state.ai.regime.atr,2)}</div>`:''}${extra}${forecast}<div class="aiProviders">${providerHtml}</div><p class="mini">AI Strength فقط امتیاز قدرت/هم‌جهتی مدل‌هاست و به معنی احتمال برد نیست. اگر مدل‌ها اختلاف داشته باشند، خروجی به WAIT متمایل می‌شود.</p>${backtestHtml}${state.feedMode==='MT5_BRIDGE'?`<button class="goldBtn" onclick="Z.aiNow()">به‌روزرسانی AI</button>`:''}</section>`;
}
function gatesHtml(x){
  if(!x?.gates)return'';
  const labels={h1Trend:'H1 Trend',m15Trend:'M15 Align',momentum:'Momentum',structure:'M5 Entry',volatility:'ATR',spread:'Spread',fresh:'Fresh Tick',news:'News Lock',noOpen:'No Open',ai:'AI Fusion',quality:'Quality'};
  return `<div class="gateGrid">${Object.entries(x.gates).map(([k,v])=>`<div class="gate ${v?'pass':'fail'}"><span>${labels[k]||esc(k)}</span><b>${v?'PASS':'BLOCK'}</b></div>`).join('')}</div>`;
}
function signalCard(x){
  if(!x)return `<section class="hero signalHero"><div class="heroTop"><span class="eyebrow">PRECISION SCAN</span><span class="tinyPill">${dataReady()?'MTF READY':'WAITING DATA'}</span></div><h1 class="noTrade">READY</h1><p class="note">اسکن فقط با لمس شما اجرا می‌شود. Quality احتمال برد نیست؛ امتیاز عبور فیلترهاست.</p><button class="goldBtn" onclick="Z.cycle()" ${!dataReady()?'disabled':''}>اجرای Precision Scan</button></section>`;
  if(x.status!=='SIGNAL')return `<section class="hero signalHero"><div class="heroTop"><span class="eyebrow">LAST SCAN • ${esc(x.source)}</span><span class="qualityRing">${fmt(x.quality,0)}</span></div><h1 class="noTrade">NO TRADE</h1><p class="note">شرایط A+ کامل نیست؛ عدم ورود بخشی از سیستم است.</p>${gatesHtml(x)}${x.reasons?.length?`<ul class="reasonList">${x.reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}<button class="goldBtn" onclick="Z.cycle()" ${!dataReady()?'disabled':''}>اسکن مجدد</button></section>`;
  return `<section class="hero signalHero"><div class="signalHead"><div><span class="eyebrow">${esc(x.source)} • ${esc(x.resolvedSymbol||x.symbol)}</span><div class="signalDirection ${x.direction==='BUY'?'buy':'sell'}">${x.direction}</div></div><span class="qualityRing">${fmt(x.quality,0)}</span></div><div class="entryZone"><div><small>ENTRY ZONE</small><b>${fmt(x.entryLow)} — ${fmt(x.entryHigh)}</b></div><div><small>ENTRY EXECUTABLE</small><b>${fmt(x.entry)}</b></div></div><div class="targetGrid"><div><small>SL</small><b class="redTxt">${fmt(x.sl)}</b></div><div><small>TP1</small><b>${fmt(x.tp1)}</b></div><div><small>TP2</small><b>${fmt(x.tp2)}</b></div><div><small>TP3</small><b>${fmt(x.tp3)}</b></div></div><div class="countdown"><span>Entry window</span><b id="countdown">${countdownLeft>0?countdownLeft+'s':'—'}</b></div>${gatesHtml(x)}${state.appMode==='TRADER'?tradeBox(x):''}<button class="goldBtn" onclick="Z.cycle()">اسکن جدید</button></section>`;
}
function tradeBox(x){return `<div class="confirmBox"><b>🔒 Real Execution در v61 غیرفعال است</b><p class="mini">این نسخه فقط سفارش را برای بررسی آماده می‌کند و هیچ درخواست معاملاتی به MT5 ارسال نمی‌کند.</p><label><input type="checkbox" ${state.trade.confirm?'checked':''} onchange="Z.confirmTrade(this.checked)"> مقادیر Entry / SL / TP را بررسی کردم</label><button class="tradeBtn" ${state.trade.confirm?'':'disabled'} onclick="Z.prepareTrade('${esc(x.id)}')">PREPARE ONLY</button></div>`;}
function statBoard(){const sim=metrics('SIMULATION'),sh=metrics('SHADOW');return `<section class="panel"><div class="title"><span class="kicker">REALITY CHECK</span><span>WR جداگانه</span></div><div class="metricBoard"><div><small>SIM WR</small><b>${metricText(sim.wr,'pct')}</b><span>n=${sim.n}</span></div><div><small>SHADOW WR</small><b>${metricText(sh.wr,'pct')}</b><span>n=${sh.n}</span></div><div><small>SHADOW PF</small><b>${metricText(sh.pf)}</b><span>هدف ≥ ${fmt(state.settings.validationMinPF)}</span></div><div><small>SHADOW DD</small><b>${fmt(sh.maxDD,2)}R</b><span>سقف ${fmt(state.settings.validationMaxDD,1)}R</span></div></div></section>`;}
function statsPanel(){
  const st=state.stats;
  if(!st)return '';
  const rec=st.recommended, sw=st.sweep||[];
  const rows=sw.map(r=>{
    const s=r.stats; if(!s)return'';
    const wr=s.winRate!=null?pct(s.winRate):'—';
    const isRec=r.label.includes('BE 0.25');
    const trap=s.winRate!=null&&s.winRate>=0.8;
    return `<div class="sweepRow ${isRec?'rec':''} ${trap?'trap':''}"><span>${esc(r.label)}</span><b>${wr}</b><b>${metricText(s.profitFactor)}</b><b>${fmt(s.avgR,3)}R</b></div>`;
  }).join('');
  return `<section class="panel"><div class="title"><span class="kicker">وین‌ریت در برابر سود — صادقانه</span><span>SIMULATED</span></div>
  <div class="metricBoard"><div><small>پیشنهادی WR</small><b>${rec&&rec.winRate!=null?pct(rec.winRate):'—'}</b><span>TP 1.5R + BE</span></div><div><small>PROFIT FACTOR</small><b>${rec?metricText(rec.profitFactor):'—'}</b><span>هدف ≥ 1.5</span></div><div><small>TRADES</small><b>${rec?rec.n:'—'}</b><span>sample</span></div><div><small>MAX DD</small><b>${rec?fmt(rec.maxDrawdown,1)+'R':'—'}</b><span>worst</span></div></div>
  <div class="sweepHead"><span>پروفایل</span><b>WR</b><b>PF</b><b>Avg R</b></div><div class="sweepList">${rows}</div>
  <p class="mini">وین‌ریت ۸۰–۹۰٪ فقط با هدف سود بسیار نزدیک ممکن است (سود هر معامله ~۰.۰۱R) که با کسر اسپرد/کمیسیون واقعی به ضرر تبدیل می‌شود. ستون Avg R یعنی «واقعاً در هر معامله چقدر می‌برید» — عدد بزرگ‌تر = سود واقعی بیشتر. بهترین تعادل، ردیف سبز (BE) است.</p></section>`;
}
function validationPanel(){const v=validation(),m=v.m;return `<section class="panel"><div class="validationLock ${v.pass?'good':''}"><div class="title"><span>90% Validation Gate</span><span>${v.pass?'REVIEW ELIGIBLE':'LOCKED'}</span></div><div class="systemList"><div class="systemItem"><b>Shadow sample</b><span>${m.n} / ≥ ${state.settings.validationMinTrades}</span></div><div class="systemItem"><b>Win rate</b><span>${metricText(m.wr,'pct')} / ≥ ${pct(state.settings.validationTargetWR)}</span></div><div class="systemItem"><b>Profit Factor</b><span>${metricText(m.pf)} / ≥ ${fmt(state.settings.validationMinPF)}</span></div><div class="systemItem"><b>Max Drawdown</b><span>${fmt(m.maxDD,2)}R / ≤ ${fmt(state.settings.validationMaxDD,1)}R</span></div></div></div></section>`;}
function chart(){const b=frames.M5.slice(-120);if(b.length<2)return'<div class="empty">داده نمودار هنوز آماده نیست</div>';const w=680,h=250,pad=18,min=Math.min(...b.map(x=>x.l)),max=Math.max(...b.map(x=>x.h));const pts=b.map((x,i)=>`${pad+i*(w-2*pad)/(b.length-1)},${h-pad-(x.c-min)/(max-min||1)*(h-2*pad)}`).join(' ');return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="grid" d="M0 60H680M0 125H680M0 190H680"/><polyline points="${pts}" class="line"/></svg>`;}
function row(x){const r=x.resolution?.result||'OPEN';return `<div class="row"><div><b>${x.status==='SIGNAL'?x.direction:'NO TRADE'}</b><small>${new Date(x.timestamp).toLocaleTimeString('fa-IR')} • Q${fmt(x.quality,0)} • ${esc(r)}</small></div><strong>${fmt(x.price)}</strong><span>${esc(x.source)}</span></div>`;}
function safety(){return `<div class="safety"><b>🔒 اصل نسخه v61 AI Fusion</b><span>Chronos‑2 و TimesFM فقط لایه پیش‌بینی‌اند؛ AI Strength احتمال برد نیست. هدف ۹۰٪ فقط Gate ارزیابی است و تضمین نیست. اجرای واقعی سفارش همچنان غیرفعال است تا Shadow/Forward Validation کافی انجام شود.</span></div>`;}
function nav(){return `<nav>${[['home','⌂','خانه'],['signal','◆','سیگنال'],['replay','◫','اعتبارسنجی'],['journal','☷','ژورنال'],['settings','⚙','تنظیمات']].map(x=>`<button class="${state.ui.tab===x[0]?'active':''}" onclick="Z.tab('${x[0]}')"><span>${x[1]}</span>${x[2]}</button>`).join('')}</nav>`;}

function home(){const recent=state.history.slice(-6).reverse();return `<main>${header()}${modeSwitch()}${brokerStrip()}<div class="targetNotice">🧠 v61 AI Fusion: دو مدل مستقل (Trend Fusion + Momentum/Mean-Rev) با فیلتر Regime و Consensus. اختلاف مدل‌ها یا ضعف شرایط بازار = WAIT / NO TRADE. اجرای واقعی سفارش غیرفعال است.</div>${feedPanel()}${aiPanel()}${statsPanel()}<section class="quick"><div><small>SCANS</small><b>${state.session.cycles}</b><span>cycles</span></div><div><small>SIGNALS</small><b>${state.session.signals}</b><span>A+ only</span></div><div><small>NO TRADE</small><b>${state.session.noTrades}</b><span>filtered</span></div><div><small>RISK</small><b>${fmt(state.settings.maxRiskPct,2)}%</b><span>planned max</span></div></section>${signalCard(lastCycle)}${statBoard()}${validationPanel()}<section class="panel"><div class="title"><span class="kicker">M5 MARKET MONITOR</span><span>${frames.M5.length} bars</span></div><div class="chart">${chart()}</div></section><section class="panel"><div class="title"><span class="kicker">SIGNAL TAPE</span><span>${recent.length} مورد</span></div>${recent.length?recent.map(row).join(''):'<div class="empty">رکوردی وجود ندارد</div>'}</section>${safety()}</main>${nav()}`;}
function signal(){return `<main>${header()}${modeSwitch()}${feedPanel()}${aiPanel()}${signalCard(lastCycle)}<section class="panel"><div class="title">منطق MTF Precision</div><ul class="rules"><li>جهت اصلی از H1 EMA20/50 تعیین می‌شود.</li><li>M15 باید هم‌جهت باشد و Momentum/RSI محدوده A+ را پاس کند.</li><li>M5 برای ساختار Entry و ATR استفاده می‌شود.</li><li>Spread و تازگی Tick Gate مستقل دارند.</li><li>قفل خبر مهم دستی است و هنگام خبرهای پرریسک باید فعال شود.</li><li>Quality احتمال برد نیست.</li></ul></section>${validationPanel()}${safety()}</main>${nav()}`;}
function replay(){const h=state.history.slice().reverse();return `<main>${header()}${statBoard()}${validationPanel()}<section class="panel"><div class="title">History / Forward Validation <span>${h.length} records</span></div><div class="toolbar"><button onclick="Z.export()">Export JSON</button><button onclick="Z.clearHistory()">پاک‌سازی</button></div>${h.length?h.slice(0,160).map(row).join(''):'<div class="empty">داده‌ای وجود ندارد</div>'}</section>${safety()}</main>${nav()}`;}
function journal(){return `<main>${header()}<section class="panel"><div class="title">ژورنال شخصی</div><textarea id="jn" placeholder="Context بازار، خبر، دلیل ورود/عدم ورود، خطاها و نکته‌ها..."></textarea><div class="toolbar"><button class="goldBtn noMargin" onclick="Z.note()">ثبت یادداشت</button></div>${state.journal.slice().reverse().slice(0,100).map(x=>`<div class="journal"><b>${esc(x.tag)}</b><small>${new Date(x.at).toLocaleString('fa-IR')}</small><p>${esc(x.note)}</p></div>`).join('')}</section>${safety()}</main>${nav()}`;}
function settings(){
  return `<main>${header()}<section class="panel"><div class="title">Market Feed</div><label>Feed Mode<select id="feedMode"><option value="SIMULATION" ${state.feedMode==='SIMULATION'?'selected':''}>Simulation Lab</option><option value="MT5_BRIDGE" ${state.feedMode==='MT5_BRIDGE'?'selected':''}>Live Bridge • AI (Web)</option></select></label><button class="goldBtn" onclick="Z.applyFeed()">اعمال Feed</button><p class="note">برای آمار واقعی Shadow باید MT5 Bridge فعال باشد. Simulation با Shadow مخلوط نمی‌شود.</p></section><section class="panel"><div class="title">MT5 Bridge • Personal</div><p class="note">Bridge روی کامپیوتری اجرا می‌شود که MetaTrader 5 روی آن باز و وارد حساب شده است. رمز حساب بروکر داخل اپ ذخیره نمی‌شود. Token در SharedPreferences بومی Android ذخیره می‌شود و WebView امکان خواندن آن را ندارد.</p><label>Bridge URL<input id="bridgeUrl" class="ltr" placeholder="http://192.168.1.20:8765"></label><label>Bearer Token<input id="bridgeToken" class="ltr" type="password" placeholder="اگر قبلاً ذخیره شده خالی بگذارید"></label><div class="systemList"><div class="systemItem"><b>Configured</b><span>${state.market.bridgeConfigured?'YES':'NO'}</span></div><div class="systemItem"><b>Token saved</b><span>${state.market.hasToken?'YES':'NO'}</span></div><div class="systemItem"><b>Status</b><span>${esc(state.market.status)}</span></div></div><div class="toolbar"><button class="goldBtn noMargin" onclick="Z.saveBridge()">ذخیره و تست</button><button onclick="Z.clearBridge()">پاک‌کردن Bridge</button></div><p class="mini">HTTP فقط برای localhost/LAN/Tailscale private range پذیرفته می‌شود. برای آدرس عمومی HTTPS لازم است.</p></section><section class="panel"><div class="title">Broker Adapter</div><div class="selectRow"><label>Broker<input value="Alpari" disabled></label><label>Platform<select id="platform"><option value="UNSET" ${state.broker.platform==='UNSET'?'selected':''}>بعداً تعیین می‌کنم</option><option value="MT4" ${state.broker.platform==='MT4'?'selected':''}>MetaTrader 4</option><option value="MT5" ${state.broker.platform==='MT5'?'selected':''}>MetaTrader 5</option></select></label></div><button class="goldBtn" onclick="Z.saveBroker()">ذخیره</button></section><section class="panel"><div class="title">AI Fusion Engine</div><button class="${state.ai.enabled?'safeToggle':'dangerToggle'}" onclick="Z.toggleAi()">${state.ai.enabled?'🧠 AI FUSION ON':'⚪ AI FUSION OFF'}</button><p class="note">در فید MT5، سیگنال فقط وقتی عبور می‌کند که AI و موتور تکنیکال هم‌جهت باشند. خاموش‌کردن AI برای تست مقایسه‌ای است.</p><label>Minimum AI Strength (0-100)<input id="minAiScore" type="number" min="40" max="100" step="1" value="${state.settings.minAiScore}"></label><label>AI Refresh (sec)<input id="aiRefresh" type="number" min="15" max="300" step="5" value="${state.settings.aiRefreshSec}"></label><button class="goldBtn" onclick="Z.saveSettings()">ذخیره AI Gates</button><div class="systemList"><div class="systemItem"><b>Decision</b><span>${esc(state.ai.decision)}</span></div><div class="systemItem"><b>Strength</b><span>${fmt(state.ai.strengthScore,0)}/100</span></div><div class="systemItem"><b>Status</b><span>${esc(state.ai.status)}</span></div></div></section><section class="panel"><div class="title">Safety / News</div><button class="${state.settings.newsLock?'dangerToggle':'safeToggle'}" onclick="Z.toggleNewsLock()">${state.settings.newsLock?'🔴 NEWS LOCK ON — ورود مسدود':'🟢 NEWS LOCK OFF'}</button><p class="note">قبل و هنگام اخبار پرقدرت طلا/دلار این قفل را دستی روشن کنید. نسخه v61 هنوز Economic Calendar خودکار ندارد.</p></section><section class="panel"><div class="title">Precision Gates</div><label>Minimum Setup Quality (0-100)<input id="minQuality" type="number" min="50" max="100" step="1" value="${state.settings.minQuality}"></label><label>Max Spread (price units)<input id="spread" type="number" step=".01" value="${state.settings.maxSpread}"></label><label>Min M5 ATR<input id="minAtr" type="number" step=".05" value="${state.settings.minAtr}"></label><label>Max M5 ATR<input id="maxAtr" type="number" step=".1" value="${state.settings.maxAtr}"></label><label>TP1 minimum R:R<input id="rr" type="number" step=".05" value="${state.settings.minRR}"></label><label>Planned Max Risk %<input id="risk" type="number" step=".05" value="${state.settings.maxRiskPct}"></label><label>Entry Window (sec)<input id="entryWindow" type="number" step="5" value="${state.settings.entryWindowSec}"></label><button class="goldBtn" onclick="Z.saveSettings()">ذخیره تنظیمات</button></section><section class="panel"><div class="title">90% Validation Gate</div><label>Minimum Shadow Trades<input id="valN" type="number" step="10" value="${state.settings.validationMinTrades}"></label><label>Target WR<input id="valWR" type="number" step=".01" value="${state.settings.validationTargetWR}"></label><label>Minimum Profit Factor<input id="valPF" type="number" step=".1" value="${state.settings.validationMinPF}"></label><label>Max Drawdown (R)<input id="valDD" type="number" step=".5" value="${state.settings.validationMaxDD}"></label><button class="goldBtn" onclick="Z.saveSettings()">ذخیره Gate</button></section><section class="panel"><div class="title">نمایش Android</div><button class="${state.settings.keepScreenOn?'safeToggle':'dangerToggle'}" onclick="Z.toggleKeepScreen()">${state.settings.keepScreenOn?'🟢 صفحه هنگام کار روشن بماند':'⚪ خاموش‌شدن خودکار صفحه'}</button><p class="note">برای مانیتور زنده می‌توانید روشن‌ماندن صفحه را فعال نگه دارید؛ این گزینه روی مصرف باتری اثر دارد.</p></section><section class="panel"><div class="title">داده و پشتیبان</div><div class="toolbar"><button onclick="Z.export()">خروجی JSON</button><label class="file">ورود JSON<input id="imp" type="file" accept="application/json" onchange="Z.import(this)"></label><button onclick="Z.reset()">بازنشانی</button></div></section>${safety()}</main>${nav()}`;
}
function prepareTrade(id){const x=state.history.find(s=>s.id===id);if(!x||x.status!=='SIGNAL'||!state.trade.confirm)return;state.trade.lastPrepared={at:new Date().toISOString(),broker:state.broker.name,platform:state.broker.platform,symbol:x.resolvedSymbol||x.symbol,direction:x.direction,entry:x.entry,sl:x.sl,tp1:x.tp1,tp2:x.tp2,tp3:x.tp3,status:'PREPARED_NOT_SENT'};state.audit.push({at:new Date().toISOString(),type:'TRADE_PREPARED_NOT_SENT',detail:state.trade.lastPrepared});save();native('toast','فقط آماده شد؛ هیچ سفارشی ارسال نشد.');render();}
function saveSettings(){const n=id=>document.getElementById(id);if(n('minQuality'))state.settings.minQuality=Math.min(100,Math.max(50,+n('minQuality').value||90));if(n('spread'))state.settings.maxSpread=Math.max(.01,+n('spread').value||.35);if(n('minAtr'))state.settings.minAtr=Math.max(.01,+n('minAtr').value||.45);if(n('maxAtr'))state.settings.maxAtr=Math.max(state.settings.minAtr,+n('maxAtr').value||6);if(n('rr'))state.settings.minRR=Math.max(1,+n('rr').value||1.5);if(n('risk'))state.settings.maxRiskPct=Math.max(.05,+n('risk').value||.35);if(n('entryWindow'))state.settings.entryWindowSec=Math.max(15,+n('entryWindow').value||75);if(n('minAiScore'))state.settings.minAiScore=Math.min(100,Math.max(40,+n('minAiScore').value||72));if(n('aiRefresh'))state.settings.aiRefreshSec=Math.min(300,Math.max(15,+n('aiRefresh').value||30));if(n('valN'))state.settings.validationMinTrades=Math.max(30,+n('valN').value||200);if(n('valWR'))state.settings.validationTargetWR=Math.min(.99,Math.max(.5,+n('valWR').value||.9));if(n('valPF'))state.settings.validationMinPF=Math.max(1,+n('valPF').value||1.5);if(n('valDD'))state.settings.validationMaxDD=Math.max(1,+n('valDD').value||8);save();render();}
function render(full=true){document.body.innerHTML=({home,signal,replay,journal,settings}[state.ui.tab]||home)();if(full)updateCountdown();}
function updateCountdown(){const el=document.getElementById('countdown');if(el)el.textContent=countdownLeft>0?countdownLeft+'s':'—';}
function restartTimers(){clearInterval(pollTimer);clearInterval(simTimer);clearInterval(aiTimer);if(state.feedMode==='MT5_BRIDGE'){pollTimer=setInterval(requestMarket,2200);if(state.ai.enabled)aiTimer=setInterval(requestAi,Math.max(15,state.settings.aiRefreshSec)*1000);}else simTimer=setInterval(simulationStep,3000);}

window.Z={
  tab:setTab,mode:setMode,cycle,onNativeReply,saveBridge,clearBridge,syncBars,testBridge:requestHealth,toggleNewsLock,toggleKeepScreen,saveBroker,
  aiNow:requestAi,toggleAi(){state.ai.enabled=!state.ai.enabled;if(!state.ai.enabled){state.ai.status='DISABLED';state.ai.decision='WAIT';}else if(state.feedMode==='MT5_BRIDGE'){state.ai.status='NOT_READY';requestAi();}save();restartTimers();render();},
  applyFeed(){const v=document.getElementById('feedMode')?.value||'SIMULATION';setFeedMode(v);},
  confirmTrade(v){state.trade.confirm=!!v;save();render();},prepareTrade,
  saveSettings,
  export(){const json=JSON.stringify({app:'Zarnegar Personal XAUUSD',version:'v61',exportedAt:new Date().toISOString(),state},null,2);const name=`zarnegar-v61-backup-${new Date().toISOString().slice(0,10)}.json`;try{if(AndroidBridge?.saveTextFile){AndroidBridge.saveTextFile(name,json);return;}}catch(_){}const blob=new Blob([json],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);},
  import(inp){const f=inp.files?.[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const x=JSON.parse(r.result);Object.assign(state,merge(x.state||x));save();location.reload();}catch{alert('فایل معتبر نیست.');}};r.readAsText(f);},
  reset(){if(confirm('تمام داده‌های محلی زرنگار پاک شود؟')){localStorage.removeItem(KEY);localStorage.removeItem(PREV_KEY);location.reload();}},
  clearHistory(){if(confirm('History پاک شود؟')){state.history=[];state.session.signals=0;state.session.noTrades=0;lastCycle=null;save();render();}},
  note(){const n=document.getElementById('jn')?.value.trim();if(!n)return;state.journal.push({id:'j_'+Date.now(),at:new Date().toISOString(),tag:'NOTE',note:n});state.journal=state.journal.slice(-700);save();render();}
};

readBridgeConfig();
if(state.feedMode==='SIMULATION')initSimulation();else{frames={M1:[],M5:[],M15:[],H1:[]};requestHealth();syncBars();setTimeout(requestAi,2500);}
requestStats();
render();restartTimers();applyKeepScreen();
countdownTimer=setInterval(()=>{if(countdownLeft>0){countdownLeft--;updateCountdown();}},1000);

})();
