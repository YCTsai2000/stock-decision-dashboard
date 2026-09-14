import fs from 'node:fs/promises';

const URLS = {
  NVDA: 'https://raw.githubusercontent.com/getdata-finance/nvda-5m-ohlcv-stocks-historical-data/main/NVDA_5m.csv',
  NAS100: 'https://raw.githubusercontent.com/getdata-finance/nas100-5m-ohlcv-index-historical-data/main/NAS100_5m.csv',
  SPX500: 'https://raw.githubusercontent.com/getdata-finance/spx500-5m-ohlcv-index-historical-data/main/SPX500_5m.csv',
};

const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const OR_END = 9 * 60 + 45;
const ACCOUNT_SIZE = 15_000;
const RISK_PCT = 0.5;
const MAX_ALLOC_PCT = 25;
const MIN_SCORE = 80;
const MIN_LEAD = 15;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sum = xs => xs.reduce((a, b) => a + b, 0);

function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value ?? '';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const [h, m] = time.split(':').map(Number);
  return { date: dateStr, time, minute: h * 60 + m };
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(x => x.trim().toLowerCase());
  const idx = Object.fromEntries(header.map((x, i) => [x, i]));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split(',');
    let raw = c[idx.datetime];
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) raw += 'Z';
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) continue;
    const p = nyParts(dt);
    const bar = {
      ...p,
      epoch: dt.getTime(),
      open: Number(c[idx.open]),
      high: Number(c[idx.high]),
      low: Number(c[idx.low]),
      close: Number(c[idx.close]),
      volume: Number(c[idx.volume]) || 0,
    };
    if ([bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) out.push(bar);
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'stock-decision-dashboard-backtest/1.1' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function regularBars(bars) {
  return bars.filter(b => b.minute >= REGULAR_OPEN && b.minute < REGULAR_CLOSE);
}

function groupByDate(bars) {
  const m = new Map();
  for (const b of bars) {
    if (!m.has(b.date)) m.set(b.date, []);
    m.get(b.date).push(b);
  }
  for (const xs of m.values()) xs.sort((a, b) => a.epoch - b.epoch);
  return m;
}

function aggregateDaily(bars) {
  const by = groupByDate(regularBars(bars));
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, xs]) => ({
    date,
    open: xs[0].open,
    high: Math.max(...xs.map(x => x.high)),
    low: Math.min(...xs.map(x => x.low)),
    close: xs.at(-1).close,
    volume: sum(xs.map(x => x.volume)),
  }));
}

function ma(data, n, field = 'close') {
  if (data.length < n) return null;
  return mean(data.slice(-n).map(x => x[field]));
}

function dailyBias(daily, date) {
  const prior = daily.filter(x => x.date < date);
  if (prior.length < 60) return 'NEUTRAL';
  const close = prior.at(-1).close;
  const ma20 = ma(prior, 20);
  const ma60 = ma(prior, 60);
  if (close > ma20 && ma20 > ma60) return 'LONG';
  if (close < ma20 && ma20 < ma60) return 'SHORT';
  return 'NEUTRAL';
}

function marketMode(spxDaily, nasDaily, date) {
  const spx = spxDaily.filter(x => x.date < date);
  const nas = nasDaily.filter(x => x.date < date);
  if (spx.length < 50 || nas.length < 50) return 'NEUTRAL';
  const sp = spx.at(-1).close;
  const np = nas.at(-1).close;
  const s20 = ma(spx, 20);
  const s50 = ma(spx, 50);
  const n20 = ma(nas, 20);
  const n50 = ma(nas, 50);
  const sb = sp > s20 && s20 > s50;
  const nb = np > n20 && n20 > n50;
  const ss = sp < s20 && s20 < s50;
  const ns = np < n20 && n20 < n50;
  if (sb && nb) return 'RISK_ON';
  if (ss && ns) return 'RISK_OFF';
  return 'NEUTRAL';
}

function vwapSeries(xs) {
  let pv = 0;
  let vol = 0;
  return xs.map(b => {
    const typical = (b.high + b.low + b.close) / 3;
    if (b.volume > 0) {
      pv += typical * b.volume;
      vol += b.volume;
    }
    return vol > 0 ? pv / vol : b.close;
  });
}

function atr(xs, period = 14) {
  if (xs.length <= period) return null;
  const s = xs.slice(-(period + 1));
  const tr = [];
  for (let i = 1; i < s.length; i++) {
    tr.push(Math.max(
      s[i].high - s[i].low,
      Math.abs(s[i].high - s[i - 1].close),
      Math.abs(s[i].low - s[i - 1].close),
    ));
  }
  return mean(tr);
}

function phase(minute) {
  if (minute >= REGULAR_OPEN && minute < OR_END) return 'OPENING';
  if (minute >= OR_END && minute < 11 * 60 + 30) return 'PRIMARY';
  if (minute >= 11 * 60 + 30 && minute < 14 * 60) return 'MIDDAY';
  if (minute >= 14 * 60 && minute < 15 * 60 + 30) return 'SECONDARY';
  if (minute >= 15 * 60 + 30 && minute < REGULAR_CLOSE) return 'CLOSING';
  return 'CLOSED';
}

function phaseFactor(p) {
  return p === 'PRIMARY' || p === 'SECONDARY' ? 1
    : p === 'MIDDAY' ? 0.6
      : p === 'CLOSING' ? 0.5
        : p === 'OPENING' ? 0.35
          : 0;
}

function rvol(allRegularByDate, dates, date, minute) {
  const idx = dates.indexOf(date);
  if (idx < 0) return null;
  const pri = dates.slice(Math.max(0, idx - 10), idx);
  if (pri.length < 3) return null;
  const cur = sum((allRegularByDate.get(date) || []).filter(b => b.minute <= minute).map(b => b.volume));
  const hist = pri
    .map(d => sum((allRegularByDate.get(d) || []).filter(b => b.minute <= minute).map(b => b.volume)))
    .filter(x => x > 0);
  if (hist.length < 3) return null;
  const av = mean(hist);
  return av > 0 ? cur / av : null;
}

function benchmarkMetrics(benchDayBars, minute) {
  const xs = benchDayBars.filter(b => b.minute <= minute);
  if (!xs.length) return { ret: null, aboveVwap: null };
  const vw = vwapSeries(xs).at(-1);
  const ret = ((xs.at(-1).close / xs[0].open) - 1) * 100;
  return { ret, aboveVwap: xs.at(-1).close > vw };
}

function scoreAt({ stockBarsToNow, orHigh, orLow, rv, benchmark, dBias, mMode }) {
  const price = stockBarsToNow.at(-1).close;
  const vwaps = vwapSeries(stockBarsToNow);
  const vw = vwaps.at(-1);
  const slope = vwaps.length >= 4 ? vwaps.at(-1) > vwaps.at(-4) : null;
  const a = atr(stockBarsToNow, 14) ?? Math.max(price * 0.002, 0.01);
  const above = price > vw;
  const below = price < vw;
  const brokeH = price > orHigh;
  const brokeL = price < orLow;
  const near = Math.abs(price - vw) <= a * 0.35;
  const stockRet = ((price / stockBarsToNow[0].open) - 1) * 100;
  const rs = benchmark.ret === null ? null : stockRet - benchmark.ret;

  let L = 0;
  let S = 0;
  L += dBias === 'LONG' ? 10 : dBias === 'NEUTRAL' ? 5 : 0;
  S += dBias === 'SHORT' ? 10 : dBias === 'NEUTRAL' ? 5 : 0;
  L += mMode === 'RISK_ON' ? 10 : mMode === 'NEUTRAL' ? 5 : 0;
  S += mMode === 'RISK_OFF' ? 10 : mMode === 'NEUTRAL' ? 5 : 0;
  if (benchmark.aboveVwap === true) L += 10;
  if (benchmark.aboveVwap === false) S += 10;
  if (above) L += 12;
  if (below) S += 12;
  if (slope === true) L += 8;
  if (slope === false) S += 8;
  if (brokeH) L += 15;
  else if (above && near) L += 10;
  if (brokeL) S += 15;
  else if (below && near) S += 10;

  const vp = rv >= 2 ? 15 : rv >= 1.5 ? 12 : rv >= 1.2 ? 8 : rv >= 1 ? 4 : 0;
  L += vp;
  S += vp;

  if (rs !== null) {
    if (rs >= 0.5) L += 10;
    else if (rs >= 0.2) L += 7;
    else if (rs > 0) L += 3;
    if (rs <= -0.5) S += 10;
    else if (rs <= -0.2) S += 7;
    else if (rs < 0) S += 3;
  }

  // Historical bid/ask is not present in this public sample. This matches the live app's unknown-spread neutral liquidity score.
  L += 2;
  S += 2;

  const pf = phaseFactor(phase(stockBarsToNow.at(-1).minute));
  const tp = pf >= 1 ? 5 : pf >= 0.6 ? 3 : pf > 0 ? 1 : 0;
  L += tp;
  S += tp;

  L = clamp(L, 0, 100);
  S = clamp(S, 0, 100);
  let dir = 'WAIT';
  if (L >= MIN_SCORE && L - S >= MIN_LEAD) dir = 'LONG';
  else if (S >= MIN_SCORE && S - L >= MIN_LEAD) dir = 'SHORT';

  const recent = stockBarsToNow.slice(-4);
  const recentLow = Math.min(...recent.map(b => b.low));
  const recentHigh = Math.max(...recent.map(b => b.high));
  return {
    dir, L, S, price, vwap: vw, atr: a, orHigh, orLow, recentLow, recentHigh,
    rv, rs, phase: phase(stockBarsToNow.at(-1).minute), benchmarkAboveVwap: benchmark.aboveVwap,
  };
}

function levels(sig, actualEntry) {
  const { dir, vwap, atr: a, orHigh, orLow, recentLow, recentHigh } = sig;
  if (dir === 'LONG') {
    const c = [vwap - a * 0.25, orHigh - a * 0.20, recentLow - a * 0.10].filter(v => v < actualEntry);
    const structural = c.length ? Math.max(...c) : actualEntry - a * 0.5;
    const stop = Math.max(0.01, Math.min(structural, actualEntry - a * 0.35));
    const risk = Math.max(0.01, actualEntry - stop);
    return { stop, risk, t1: actualEntry + 1.5 * risk, t2: actualEntry + 2 * risk };
  }
  const c = [vwap + a * 0.25, orLow + a * 0.20, recentHigh + a * 0.10].filter(v => v > actualEntry);
  const structural = c.length ? Math.min(...c) : actualEntry + a * 0.5;
  const stop = Math.max(actualEntry + a * 0.35, structural);
  const risk = Math.max(0.01, stop - actualEntry);
  return { stop, risk, t1: actualEntry - 1.5 * risk, t2: actualEntry - 2 * risk };
}

function evaluateTrade(dayBars, entryIndex, sig) {
  const entry = dayBars[entryIndex].open;
  const lv = levels(sig, entry);
  let outcome = 'EOD';
  let exit = dayBars.at(-1).close;
  let exitTime = dayBars.at(-1).time;
  let hitT2 = false;

  for (let i = entryIndex; i < dayBars.length; i++) {
    const b = dayBars[i];
    if (sig.dir === 'LONG') {
      const hitStop = b.low <= lv.stop;
      const hitT1 = b.high >= lv.t1;
      const h2 = b.high >= lv.t2;
      if (h2) hitT2 = true;
      if (hitStop) { outcome = 'STOP'; exit = lv.stop; exitTime = b.time; break; }
      if (hitT1) { outcome = 'TP1'; exit = lv.t1; exitTime = b.time; break; }
    } else {
      const hitStop = b.high >= lv.stop;
      const hitT1 = b.low <= lv.t1;
      const h2 = b.low <= lv.t2;
      if (h2) hitT2 = true;
      if (hitStop) { outcome = 'STOP'; exit = lv.stop; exitTime = b.time; break; }
      if (hitT1) { outcome = 'TP1'; exit = lv.t1; exitTime = b.time; break; }
    }
  }

  const r = sig.dir === 'LONG' ? (exit - entry) / lv.risk : (entry - exit) / lv.risk;
  const pf = phaseFactor(sig.phase);
  const riskBudget = ACCOUNT_SIZE * (RISK_PCT / 100) * pf;
  const shares = Math.max(0, Math.min(
    Math.floor(riskBudget / lv.risk),
    Math.floor((ACCOUNT_SIZE * (MAX_ALLOC_PCT / 100)) / entry),
  ));
  const pnl = shares * (sig.dir === 'LONG' ? (exit - entry) : (entry - exit));
  return { entry, ...lv, outcome, exit, exitTime, r, shares, pnl, hitT2 };
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0);
  const losses = trades.filter(t => t.r < 0);
  const bes = trades.filter(t => Math.abs(t.r) < 1e-9);
  const grossWin = sum(wins.map(t => t.pnl));
  const grossLoss = -sum(losses.map(t => t.pnl));
  const rs = trades.map(t => t.r);
  const avgR = mean(rs) ?? 0;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: bes.length,
    winRate: n ? wins.length / n * 100 : 0,
    avgR,
    medianR: n ? [...rs].sort((a, b) => a - b)[Math.floor(n / 2)] : 0,
    totalR: sum(rs),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    totalPnl: sum(trades.map(t => t.pnl)),
    maxDrawdownUsd: maxDd,
    tp1Rate: n ? trades.filter(t => t.outcome === 'TP1').length / n * 100 : 0,
    stopRate: n ? trades.filter(t => t.outcome === 'STOP').length / n * 100 : 0,
  };
}

function groupStats(trades, keyFn) {
  const m = {};
  for (const t of trades) {
    const k = keyFn(t);
    (m[k] ??= []).push(t);
  }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stats(v)]));
}

async function main() {
  console.log('Downloading public 5m samples...');
  const [nvTxt, nasTxt, spxTxt] = await Promise.all([
    fetchText(URLS.NVDA), fetchText(URLS.NAS100), fetchText(URLS.SPX500),
  ]);
  const nv = parseCsv(nvTxt);
  const nas = parseCsv(nasTxt);
  const spx = parseCsv(spxTxt);
  const nvReg = regularBars(nv);
  const nasReg = regularBars(nas);
  const spxReg = regularBars(spx);
  const nvBy = groupByDate(nvReg);
  const nasBy = groupByDate(nasReg);
  const spxBy = groupByDate(spxReg);
  const nvDates = [...nvBy.keys()].sort();
  const nasDates = new Set(nasBy.keys());
  const spxDates = new Set(spxBy.keys());
  const common = nvDates.filter(d => nasDates.has(d) && spxDates.has(d));
  const nvDaily = aggregateDaily(nv);
  const nasDaily = aggregateDaily(nas);
  const spxDaily = aggregateDaily(spx);
  const warmupEligible = common.filter(d =>
    nvDaily.filter(x => x.date < d).length >= 60
    && nasDaily.filter(x => x.date < d).length >= 50
    && spxDaily.filter(x => x.date < d).length >= 50
  ).length;

  const trades = [];
  const skipped = { noNextBar: 0, noSignal: 0 };
  let neutralFallbackSessions = 0;

  for (const date of common) {
    const nvPriorCount = nvDaily.filter(x => x.date < date).length;
    const nasPriorCount = nasDaily.filter(x => x.date < date).length;
    const spxPriorCount = spxDaily.filter(x => x.date < date).length;
    if (nvPriorCount < 60 || nasPriorCount < 50 || spxPriorCount < 50) neutralFallbackSessions++;

    // This is code-faithful: insufficient daily context falls back to NEUTRAL rather than skipping the date.
    const dBias = dailyBias(nvDaily, date);
    const mMode = marketMode(spxDaily, nasDaily, date);
    const day = nvBy.get(date);
    const benchDay = nasBy.get(date);
    if (!day?.length || !benchDay?.length) { skipped.noSignal++; continue; }

    const opening = day.filter(b => b.minute >= REGULAR_OPEN && b.minute < OR_END);
    if (opening.length < 3) { skipped.noSignal++; continue; }
    const orHigh = Math.max(...opening.map(b => b.high));
    const orLow = Math.min(...opening.map(b => b.low));

    let found = false;
    for (let i = 0; i < day.length - 1; i++) {
      const b = day[i];
      if (b.minute < OR_END) continue;
      const p = phase(b.minute);
      if (p === 'CLOSED' || p === 'OPENING') continue;
      const xs = day.slice(0, i + 1);
      const bench = benchmarkMetrics(benchDay, b.minute);
      if (bench.ret === null) continue;
      const rv = rvol(nvBy, nvDates, date, b.minute);
      const sig = scoreAt({
        stockBarsToNow: xs,
        orHigh,
        orLow,
        rv: rv ?? 0,
        benchmark: bench,
        dBias,
        mMode,
      });
      if (sig.dir === 'WAIT') continue;
      const entryIndex = i + 1;
      if (entryIndex >= day.length) { skipped.noNextBar++; break; }
      const tr = evaluateTrade(day, entryIndex, sig);
      trades.push({
        date,
        signalTime: b.time,
        entryTime: day[entryIndex].time,
        dailyBias: dBias,
        marketMode: mMode,
        direction: sig.dir,
        longScore: sig.L,
        shortScore: sig.S,
        rvol: sig.rv,
        rs: sig.rs,
        phase: sig.phase,
        ...tr,
      });
      found = true;
      break;
    }
    if (!found) skipped.noSignal++;
  }

  const summary = stats(trades);
  const report = {
    methodology: {
      version: 'code-faithful-neutral-fallback-v2',
      instrument: 'NVDA',
      benchmarkProxy: 'NASDAQ-100 index (NAS100) as QQQ proxy',
      marketProxy: 'SPX500 + NAS100 as SPY/QQQ proxies',
      sampleIntersection: common.length ? `${common[0]} to ${common.at(-1)}` : 'none',
      commonSessions: common.length,
      fullDailyWarmupSessions: warmupEligible,
      neutralFallbackSessions,
      contextHandling: 'Matches app behavior: when MA60/MA50 history is insufficient, daily bias / market regime becomes NEUTRAL instead of excluding the session.',
      tradeRule: 'first score>=80 with >=15 point directional lead per day; enter next 5m bar open; full exit at first TP1(1.5R), stop, or EOD; same-bar stop/target => stop first',
      spread: 'historical bid/ask unavailable; app neutral liquidity score +2 used; spread hard-block not reconstructable',
      costs: 'no commission, taxes, or slippage included',
      volume: 'public sample labels volume as tick volume; RVOL therefore approximates live share-volume RVOL',
    },
    sourceRows: { NVDA: nv.length, NAS100: nas.length, SPX500: spx.length },
    skipped,
    summary,
    byDirection: groupStats(trades, t => t.direction),
    byPhase: groupStats(trades, t => t.phase),
    byScore: groupStats(trades, t => {
      const s = Math.max(t.longScore, t.shortScore);
      return s >= 90 ? '90+' : s >= 85 ? '85-89' : '80-84';
    }),
    byMarketMode: groupStats(trades, t => t.marketMode),
    byDailyBias: groupStats(trades, t => t.dailyBias),
    trades,
  };

  await fs.mkdir('backtest-output', { recursive: true });
  await fs.writeFile('backtest-output/nvda-backtest.json', JSON.stringify(report, null, 2));
  const cols = [
    'date', 'signalTime', 'entryTime', 'direction', 'longScore', 'shortScore', 'dailyBias', 'marketMode',
    'phase', 'rvol', 'rs', 'entry', 'stop', 't1', 't2', 'outcome', 'exit', 'exitTime', 'r', 'shares', 'pnl',
  ];
  const csv = [cols.join(','), ...trades.map(t => cols.map(k => t[k] ?? '').join(','))].join('\n');
  await fs.writeFile('backtest-output/nvda-trades.csv', csv);

  console.log('\n=== NVDA BACKTEST SUMMARY ===');
  console.log(JSON.stringify({
    methodology: report.methodology,
    sourceRows: report.sourceRows,
    skipped,
    summary,
    byDirection: report.byDirection,
    byPhase: report.byPhase,
    byScore: report.byScore,
    byMarketMode: report.byMarketMode,
    byDailyBias: report.byDailyBias,
  }, null, 2));
  console.log('\nOutput: backtest-output/nvda-backtest.json, backtest-output/nvda-trades.csv');
}

main().catch(e => { console.error(e); process.exit(1); });
