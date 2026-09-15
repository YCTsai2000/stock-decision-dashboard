import path from 'node:path';
import {
  OPEN_MINUTE, TICKERS, closeOf, groupByDate, highOf, loadGzipJson, lowOf,
  mean, median, pct, premarketBars, regularBars, std, sumVolume, weightedVwap,
  windowBars, futureWindow, writeCsv, writeJson, parseArgs, quantile,
} from './lib.mjs';

const args = parseArgs();
const rawDir = String(args.raw ?? 'research-output/mu-intraday/raw');
const outDir = String(args.out ?? 'research-output/mu-intraday/results');
const tickers = String(args.tickers ?? TICKERS.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const costBpsSide = Number(args.costBpsSide ?? process.env.MU_COST_BPS_SIDE ?? 5);
const stressBpsSide = Number(args.stressBpsSide ?? process.env.MU_STRESS_BPS_SIDE ?? 10);
const baselineRoundTrip = 2 * costBpsSide / 10_000;
const stressRoundTrip = 2 * stressBpsSide / 10_000;
const evalEnds = {5: OPEN_MINUTE + 4, 15: OPEN_MINUTE + 14, 30: OPEN_MINUTE + 29};
const horizons = [5, 15, 30, 60];

function sliceStats(day, endMinute) {
  const bars = windowBars(day, OPEN_MINUTE, endMinute + 1);
  if (!bars.length) return {};
  const close = closeOf(bars), open = bars[0].o, high = highOf(bars), low = lowOf(bars), vwap = weightedVwap(bars);
  return {close, open, high, low, volume: sumVolume(bars), vwap, distVwap: pct(close, vwap), retOpen: pct(close, open)};
}

function fwd(day, endMinute, h) {
  const base = windowBars(day, OPEN_MINUTE, endMinute + 1).at(-1);
  const w = futureWindow(day, endMinute, h);
  if (!base || !w.length) return {ret: null, mfe: null, mae: null};
  return {ret: pct(w.at(-1).c, base.c), mfe: pct(highOf(w), base.c), mae: pct(lowOf(w), base.c)};
}

function dailyRows(raw, ticker) {
  const map = groupByDate(raw), dates = [...map.keys()].sort(), out = [];
  let prev = null;
  for (const date of dates) {
    const day = map.get(date), reg = regularBars(day);
    if (reg.length < 30) continue;
    const pm = premarketBars(day), open = reg[0].o, close = reg.at(-1).c, high = highOf(reg), low = lowOf(reg);
    const row = {
      ticker, date, prevClose: prev?.close ?? null, prevHigh: prev?.high ?? null,
      open, high, low, close, dailyReturn: prev ? pct(close, prev.close) : null,
      gap: prev ? pct(open, prev.close) : null,
      pmClose: closeOf(pm), pmHigh: highOf(pm), pmLow: lowOf(pm), pmVolume: sumVolume(pm),
    };
    for (const [k, end] of Object.entries(evalEnds)) {
      const s = sliceStats(day, end);
      row[`close${k}`] = s.close ?? null;
      row[`high${k}`] = s.high ?? null;
      row[`low${k}`] = s.low ?? null;
      row[`vol${k}`] = s.volume ?? null;
      row[`vwap${k}`] = s.vwap ?? null;
      row[`distVwap${k}`] = s.distVwap ?? null;
      row[`retOpen${k}`] = s.retOpen ?? null;
      row[`retPrev${k}`] = prev && Number.isFinite(s.close) ? pct(s.close, prev.close) : null;
      row[`gapHold${k}`] = prev && Number.isFinite(row.gap) && Math.abs(row.gap) > 1e-6 ? (s.close - prev.close) / (open - prev.close) : null;
      for (const h of horizons) {
        const z = fwd(day, end, h);
        row[`fwd${h}From${k}`] = z.ret;
        row[`mfe${h}From${k}`] = z.mfe;
        row[`mae${h}From${k}`] = z.mae;
      }
    }
    out.push(row);
    prev = {close, high};
  }
  for (let i = 0; i < out.length; i++) {
    const hist = out.slice(Math.max(0, i - 20), i);
    for (const k of [5, 15, 30]) {
      const base = median(hist.map(x => x[`vol${k}`]));
      out[i][`rvol${k}`] = base && out[i][`vol${k}`] ? out[i][`vol${k}`] / base : null;
    }
    out[i].retStd20 = std(hist.map(x => x.dailyReturn));
  }
  return out;
}

function sideReturn(raw, side) {
  return !Number.isFinite(raw) ? null : side === 'SHORT' ? -raw : raw;
}

function sideExcursions(row, entry, h, side) {
  const rawMfe = row[`mfe${h}From${entry}`];
  const rawMae = row[`mae${h}From${entry}`];
  if (!Number.isFinite(rawMfe) || !Number.isFinite(rawMae)) return {favorable: null, adverse: null};
  if (side === 'LONG') return {favorable: rawMfe, adverse: rawMae};
  return {favorable: -rawMae, adverse: -rawMfe};
}

function stats(hits, setup, h, cost) {
  const values = [];
  const favorable = [], adverse = [];
  for (const row of hits) {
    const gross = sideReturn(row[`fwd${h}From${setup.entry}`], setup.side);
    if (!Number.isFinite(gross)) continue;
    const ex = sideExcursions(row, setup.entry, h, setup.side);
    values.push(gross - cost);
    if (Number.isFinite(ex.favorable)) favorable.push(ex.favorable);
    if (Number.isFinite(ex.adverse)) adverse.push(ex.adverse);
  }
  const wins = values.filter(x => x > 0), losses = values.filter(x => x < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    winRate: values.length ? wins.length / values.length : null,
    avgNetReturn: mean(values), medianNetReturn: median(values),
    p25NetReturn: quantile(values, 0.25), p75NetReturn: quantile(values, 0.75),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : null,
    avgFavorable: mean(favorable), medianFavorable: median(favorable),
    avgAdverse: mean(adverse), medianAdverse: median(adverse),
  };
}

function bootstrapMeanCI(values, reps = 1500) {
  const x = values.filter(Number.isFinite);
  if (x.length < 5) return {lo: null, hi: null};
  let seed = 0x5eed1234;
  const rand = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const means = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[Math.floor(rand() * x.length)];
    means.push(s / x.length);
  }
  return {lo: quantile(means, 0.025), hi: quantile(means, 0.975)};
}

const all = {};
for (const t of tickers) {
  const j = await loadGzipJson(path.join(rawDir, `${t}.json.gz`));
  all[t] = dailyRows(j.bars, t);
  console.log(`${t}: ${all[t].length} sessions`);
}
if (!all.MU) throw new Error('MU raw data is required');

const peerNames = tickers.filter(x => x !== 'MU');
const peerMaps = Object.fromEntries(peerNames.map(t => [t, new Map(all[t].map(r => [r.date, r]))]));
const rows = all.MU.map(mu => {
  const r = {...mu};
  for (const k of [5, 15, 30]) {
    const peers = peerNames.map(t => peerMaps[t].get(mu.date)?.[`retPrev${k}`]).filter(Number.isFinite);
    r[`peerRet${k}`] = mean(peers);
    r[`rs${k}`] = Number.isFinite(mu[`retPrev${k}`]) && Number.isFinite(r[`peerRet${k}`]) ? mu[`retPrev${k}`] - r[`peerRet${k}`] : null;
  }
  return r;
});

const setupDefs = [
  {name: 'gap_go_long_15', side: 'LONG', entry: 15, test: r => r.gap >= 0.01 && r.gapHold5 >= 0.70 && r.distVwap15 > 0 && r.rs15 > 0 && (r.rvol15 ?? 0) >= 1.2},
  {name: 'failed_breakout_short_15', side: 'SHORT', entry: 15, test: r => r.gap >= 0.01 && r.gapHold5 < 0.70 && r.distVwap15 < 0 && r.rs15 < 0},
  {name: 'reversal_long_30', side: 'LONG', entry: 30, test: r => r.gap <= -0.01 && r.close30 > r.open && r.distVwap30 > 0 && r.rs30 > r.rs5},
  {name: 'trend_breakdown_short_15', side: 'SHORT', entry: 15, test: r => r.gap <= -0.01 && r.close15 < r.open && r.distVwap15 < 0 && r.rs15 < 0},
];

const dates = rows.map(r => r.date);
const splitIndex = Math.floor(dates.length * 0.70);
const splitDate = dates[splitIndex] ?? '';
const foldCuts = [0, 0.25, 0.50, 0.75, 1].map(p => dates[Math.min(dates.length - 1, Math.floor((dates.length - 1) * p))] ?? '');
const reports = [];

for (const setup of setupDefs) {
  const hits = rows.filter(setup.test);
  const train = hits.filter(x => x.date < splitDate);
  const test = hits.filter(x => x.date >= splitDate);
  const trainCandidates = horizons.map(h => ({h, s: stats(train, setup, h, baselineRoundTrip)}));
  trainCandidates.sort((a, b) => {
    const qa = (a.s.avgNetReturn ?? -9) * Math.sqrt(Math.max(1, a.s.n)) + Math.min(3, a.s.profitFactor ?? 0) * 0.002;
    const qb = (b.s.avgNetReturn ?? -9) * Math.sqrt(Math.max(1, b.s.n)) + Math.min(3, b.s.profitFactor ?? 0) * 0.002;
    return qb - qa;
  });
  const chosenHorizon = trainCandidates[0]?.h ?? 30;
  const allStats = stats(hits, setup, chosenHorizon, baselineRoundTrip);
  const trainStats = stats(train, setup, chosenHorizon, baselineRoundTrip);
  const testStats = stats(test, setup, chosenHorizon, baselineRoundTrip);
  const stressTestStats = stats(test, setup, chosenHorizon, stressRoundTrip);
  const testNet = test.map(row => {
    const x = sideReturn(row[`fwd${chosenHorizon}From${setup.entry}`], setup.side);
    return Number.isFinite(x) ? x - baselineRoundTrip : null;
  }).filter(Number.isFinite);
  const ci = bootstrapMeanCI(testNet);
  const folds = [];
  for (let i = 0; i < 4; i++) {
    const lo = foldCuts[i], hi = i === 3 ? '9999-12-31' : foldCuts[i + 1];
    const foldHits = hits.filter(x => x.date >= lo && x.date < hi);
    folds.push({from: lo, to: hi, ...stats(foldHits, setup, chosenHorizon, baselineRoundTrip)});
  }
  const eligibleFolds = folds.filter(f => f.n >= 3);
  const positiveFoldRatio = eligibleFolds.length ? eligibleFolds.filter(f => (f.avgNetReturn ?? -1) > 0).length / eligibleFolds.length : 0;
  const gateChecks = {
    enoughAllSamples: allStats.n >= 20,
    enoughTrainSamples: trainStats.n >= 12,
    enoughTestSamples: testStats.n >= 6,
    trainPositive: (trainStats.avgNetReturn ?? -1) > 0,
    testPositive: (testStats.avgNetReturn ?? -1) > 0,
    testProfitFactor: (testStats.profitFactor ?? 0) >= 1.15,
    stressPositive: (stressTestStats.avgNetReturn ?? -1) > 0,
    regimeStability: positiveFoldRatio >= 0.60,
  };
  const passed = Object.values(gateChecks).every(Boolean);
  const qualityScore = Math.max(0, Math.min(100, Math.round(
    (Math.min(allStats.n / 40, 1) * 15) +
    (Math.min(testStats.n / 15, 1) * 15) +
    (Math.min(Math.max((testStats.winRate ?? 0) - 0.45, 0) / 0.20, 1) * 15) +
    (Math.min((testStats.profitFactor ?? 0) / 2, 1) * 20) +
    (Math.min(Math.max((testStats.avgNetReturn ?? 0), 0) / 0.005, 1) * 20) +
    (positiveFoldRatio * 15)
  )));
  reports.push({
    name: setup.name, side: setup.side, entryMinute: setup.entry, chosenHorizon,
    costs: {baselineBpsSide: costBpsSide, stressBpsSide},
    all: allStats, train: trainStats, test: testStats, stressTest: stressTestStats,
    bootstrap95MeanNet: ci, folds, positiveFoldRatio, gateChecks, passed, qualityScore,
  });
}

const deployable = reports.filter(x => x.passed).sort((a, b) => b.qualityScore - a.qualityScore);
const status = deployable.length ? 'DEPLOYABLE_CANDIDATES' : 'NO_DEPLOY';
const summary = {
  generatedAt: new Date().toISOString(),
  methodology: 'Pre-specified MU setups; horizon selected only on chronological 70% train data, then judged on untouched 30% test. Returns include configurable round-trip friction. Four time folds test regime stability. A setup is not deployable unless every gate passes.',
  sample: {start: dates[0] ?? null, end: dates.at(-1) ?? null, sessions: dates.length, splitDate},
  costs: {baselineBpsSide: costBpsSide, baselineRoundTripPct: baselineRoundTrip * 100, stressBpsSide, stressRoundTripPct: stressRoundTrip * 100},
  status, deployable: deployable.map(x => ({name: x.name, side: x.side, entryMinute: x.entryMinute, horizon: x.chosenHorizon, qualityScore: x.qualityScore})),
  reports,
};

await writeJson(path.join(outDir, 'validation.json'), summary);
await writeJson(path.join(outDir, 'deployable_setups.json'), {generatedAt: summary.generatedAt, status, setups: deployable});
await writeCsv(path.join(outDir, 'validation.csv'), reports.map(r => ({
  setup: r.name, side: r.side, entryMinute: r.entryMinute, chosenHorizon: r.chosenHorizon,
  qualityScore: r.qualityScore, passed: r.passed,
  nAll: r.all.n, nTrain: r.train.n, nTest: r.test.n,
  trainAvgNet: r.train.avgNetReturn, testAvgNet: r.test.avgNetReturn, stressAvgNet: r.stressTest.avgNetReturn,
  testWinRate: r.test.winRate, testProfitFactor: r.test.profitFactor,
  ci95Lo: r.bootstrap95MeanNet.lo, ci95Hi: r.bootstrap95MeanNet.hi,
  positiveFoldRatio: r.positiveFoldRatio,
})));

console.log(JSON.stringify({status, deployable: summary.deployable, reports: reports.map(r => ({name:r.name, passed:r.passed, score:r.qualityScore, horizon:r.chosenHorizon, test:r.test, stress:r.stressTest, gates:r.gateChecks}))}, null, 2));
