import type { ApiKeys } from './types';

export type IntradayProvider = 'Twelve Data' | 'Massive' | 'Finnhub';
export type DayTradeDirection = 'LONG' | 'SHORT' | 'WAIT';
export type SessionPhase = 'PREMARKET' | 'OPENING' | 'PRIMARY' | 'MIDDAY' | 'SECONDARY' | 'CLOSING' | 'AFTER_HOURS' | 'CLOSED';

export interface IntradayBar {
  date: string;
  time: string;
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradaySource {
  provider: IntradayProvider;
  interval: '5min';
  note: string;
}

export interface IntradayFetchResult {
  bars: IntradayBar[] | null;
  source: IntradaySource | null;
  errors: string[];
}

export interface IntradayMetrics {
  sessionDate: string | null;
  latestTime: string | null;
  latestMinute: number | null;
  currentPrice: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  previousHigh: number | null;
  previousLow: number | null;
  previousClose: number | null;
  gapPct: number | null;
  vwap: number | null;
  vwapSlopeUp: boolean | null;
  orHigh: number | null;
  orLow: number | null;
  orReady: boolean;
  premarketHigh: number | null;
  premarketLow: number | null;
  rvol: number | null;
  intradayAtr: number | null;
  intradayReturnPct: number | null;
  relativeStrengthPct: number | null;
  benchmarkAboveVwap: boolean | null;
  recentLow: number | null;
  recentHigh: number | null;
  stale: boolean;
  phase: SessionPhase;
  marketOpen: boolean;
  sessionBars: IntradayBar[];
  vwapSeries: number[];
}

export interface DayTradeDecisionInput {
  metrics: IntradayMetrics;
  dailyBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  marketMode: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
  accountSizeUsd: number;
  riskPerTradePct: number;
  dailyMaxLossPct: number;
  realizedPnlUsd: number;
  maxAllocationPct: number;
  bid: number | null;
  ask: number | null;
  hasCatalyst: boolean;
}

export interface DayTradeDecision {
  direction: DayTradeDirection;
  longScore: number;
  shortScore: number;
  label: string;
  reason: string;
  hardBlock: string | null;
  spreadPct: number | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  riskPerShare: number | null;
  suggestedShares: number;
  suggestedRiskUsd: number;
  remainingDailyRiskUsd: number;
  phaseFactor: number;
  catalystBonus: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;
const INTRADAY_OUTPUT_SIZE = 2400;
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const OR_END = 9 * 60 + 45;

const cleanKey = (value: string | undefined) => (value ?? '').trim();
const toYmd = (date: Date) => date.toISOString().slice(0, 10);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const fetchJson = async (url: string, signal?: AbortSignal): Promise<any> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortOuter = () => controller.abort();
  signal?.addEventListener('abort', abortOuter);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const json = await response.json();
    if (!response.ok) throw new Error(String(json?.message ?? json?.error ?? `HTTP ${response.status}`));
    return json;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortOuter);
  }
};

const parseMinute = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const normalizeBars = (bars: IntradayBar[]) => {
  const map = new Map<string, IntradayBar>();
  bars.forEach(bar => {
    if (!bar.date || !bar.time || !Number.isFinite(bar.close) || bar.close <= 0) return;
    map.set(`${bar.date}-${bar.time}`, bar);
  });
  return [...map.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
};

const nyPartsFromEpoch = (epochMs: number): { date: string; time: string; minute: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return { date, time, minute: parseMinute(time) };
};

export const getNewYorkClock = () => {
  const p = nyPartsFromEpoch(Date.now());
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
  return { ...p, weekday };
};

export const getSessionPhase = (minute: number, weekday?: string): SessionPhase => {
  if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';
  if (minute >= 4 * 60 && minute < REGULAR_OPEN) return 'PREMARKET';
  if (minute >= REGULAR_OPEN && minute < OR_END) return 'OPENING';
  if (minute >= OR_END && minute < 11 * 60 + 30) return 'PRIMARY';
  if (minute >= 11 * 60 + 30 && minute < 14 * 60) return 'MIDDAY';
  if (minute >= 14 * 60 && minute < 15 * 60 + 30) return 'SECONDARY';
  if (minute >= 15 * 60 + 30 && minute < REGULAR_CLOSE) return 'CLOSING';
  if (minute >= REGULAR_CLOSE && minute < 20 * 60) return 'AFTER_HOURS';
  return 'CLOSED';
};

const fetchTwelveIntraday = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=${INTRADAY_OUTPUT_SIZE}&timezone=America/New_York&apikey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.status === 'error') throw new Error(json?.message ?? 'Twelve Data error');
  if (!Array.isArray(json?.values)) throw new Error('Twelve Data 沒有回傳 5 分 K');
  return normalizeBars(json.values.map((v: any) => {
    const [date, rawTime = '00:00:00'] = String(v.datetime ?? '').split(' ');
    const time = rawTime.slice(0, 5);
    return {
      date,
      time,
      minute: parseMinute(time),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume) || 0,
    };
  }));
};

const fetchMassiveIntraday = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const to = new Date();
  const from = new Date(to.getTime() - 35 * 86_400_000);
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/5/minute/${toYmd(from)}/${toYmd(to)}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (!Array.isArray(json?.results)) throw new Error('Massive 沒有回傳分鐘 K');
  return normalizeBars(json.results.map((v: any) => {
    const p = nyPartsFromEpoch(Number(v.t));
    return {
      ...p,
      open: Number(v.o),
      high: Number(v.h),
      low: Number(v.l),
      close: Number(v.c),
      volume: Number(v.v) || 0,
    };
  }));
};

const fetchFinnhubIntraday = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 35 * 86_400;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=5&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.s !== 'ok' || !Array.isArray(json?.c)) throw new Error(json?.error ?? 'Finnhub 5 分 K 此方案不可用');
  return normalizeBars(json.c.map((close: number, i: number) => {
    const p = nyPartsFromEpoch(Number(json.t?.[i]) * 1000);
    return {
      ...p,
      open: Number(json.o?.[i]) || Number(close),
      high: Number(json.h?.[i]) || Number(close),
      low: Number(json.l?.[i]) || Number(close),
      close: Number(close),
      volume: Number(json.v?.[i]) || 0,
    };
  }));
};

export const fetchIntradayData = async (symbol: string, keys: ApiKeys, signal?: AbortSignal): Promise<IntradayFetchResult> => {
  const upper = symbol.trim().toUpperCase();
  const providers: Array<{
    name: IntradayProvider;
    key: string;
    note: string;
    fn: (symbol: string, key: string, signal?: AbortSignal) => Promise<IntradayBar[]>;
  }> = [
    {
      name: 'Twelve Data', key: cleanKey(keys.twelve), fn: fetchTwelveIntraday,
      note: '5 分 K 主來源。免費方案可用性與即時涵蓋依 Twelve Data 帳戶權限；盤前即時通常需要更高方案。',
    },
    {
      name: 'Massive', key: cleanKey(keys.massive), fn: fetchMassiveIntraday,
      note: '5 分鐘 aggregates 備援。免費 Stocks Basic 為 EOD recency，因此盤中可能被判定為 stale。',
    },
    {
      name: 'Finnhub', key: cleanKey(keys.finnhub), fn: fetchFinnhubIntraday,
      note: '5 分 K 備援，是否可用取決於 Finnhub 帳戶 dataset 權限。',
    },
  ];

  const errors: string[] = [];
  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const bars = await provider.fn(upper, provider.key, signal);
      if (bars.length < 20) throw new Error(`只有 ${bars.length} 根 5 分 K`);
      return { bars, source: { provider: provider.name, interval: '5min', note: provider.note }, errors };
    } catch (error) {
      if (signal?.aborted) break;
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return { bars: null, source: null, errors };
};

const regularBars = (bars: IntradayBar[], date: string) => bars.filter(b => b.date === date && b.minute >= REGULAR_OPEN && b.minute < REGULAR_CLOSE);

const calculateVwapSeries = (bars: IntradayBar[]) => {
  let pv = 0;
  let vol = 0;
  return bars.map(bar => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    if (bar.volume > 0) {
      pv += typical * bar.volume;
      vol += bar.volume;
    }
    return vol > 0 ? pv / vol : bar.close;
  });
};

const calculateIntradayAtr = (bars: IntradayBar[], period = 14): number | null => {
  if (bars.length <= period) return null;
  const sample = bars.slice(-(period + 1));
  const tr: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    const current = sample[i];
    const prev = sample[i - 1];
    tr.push(Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close)));
  }
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
};

const calculateRvol = (bars: IntradayBar[], sessionDate: string, latestMinute: number): number | null => {
  const dates = [...new Set(bars.filter(b => b.minute >= REGULAR_OPEN && b.minute < REGULAR_CLOSE).map(b => b.date))].sort();
  const priorDates = dates.filter(d => d < sessionDate).slice(-10);
  if (priorDates.length < 3) return null;
  const currentVolume = bars
    .filter(b => b.date === sessionDate && b.minute >= REGULAR_OPEN && b.minute <= latestMinute)
    .reduce((sum, b) => sum + b.volume, 0);
  const historical = priorDates.map(date => bars
    .filter(b => b.date === date && b.minute >= REGULAR_OPEN && b.minute <= latestMinute)
    .reduce((sum, b) => sum + b.volume, 0))
    .filter(v => v > 0);
  if (historical.length < 3) return null;
  const average = historical.reduce((a, b) => a + b, 0) / historical.length;
  return average > 0 ? currentVolume / average : null;
};

const pctReturn = (start: number | null, end: number | null): number | null => {
  if (start === null || end === null || start <= 0) return null;
  return ((end / start) - 1) * 100;
};

export const computeIntradayMetrics = (bars: IntradayBar[] | null, benchmarkBars: IntradayBar[] | null): IntradayMetrics => {
  const clock = getNewYorkClock();
  const phase = getSessionPhase(clock.minute, clock.weekday);
  const marketOpen = phase === 'OPENING' || phase === 'PRIMARY' || phase === 'MIDDAY' || phase === 'SECONDARY' || phase === 'CLOSING';
  const empty: IntradayMetrics = {
    sessionDate: null, latestTime: null, latestMinute: null, currentPrice: null, sessionOpen: null, sessionHigh: null, sessionLow: null,
    previousHigh: null, previousLow: null, previousClose: null, gapPct: null, vwap: null, vwapSlopeUp: null,
    orHigh: null, orLow: null, orReady: false, premarketHigh: null, premarketLow: null, rvol: null, intradayAtr: null,
    intradayReturnPct: null, relativeStrengthPct: null, benchmarkAboveVwap: null, recentLow: null, recentHigh: null,
    stale: true, phase, marketOpen, sessionBars: [], vwapSeries: [],
  };
  if (!bars?.length) return empty;

  const regularDates = [...new Set(bars.filter(b => b.minute >= REGULAR_OPEN && b.minute < REGULAR_CLOSE).map(b => b.date))].sort();
  const sessionDate = regularDates.at(-1) ?? null;
  if (!sessionDate) return empty;
  const previousDate = regularDates.at(-2) ?? null;
  const sessionBars = regularBars(bars, sessionDate);
  if (!sessionBars.length) return empty;
  const previousBars = previousDate ? regularBars(bars, previousDate) : [];
  const last = sessionBars.at(-1)!;
  const vwapSeries = calculateVwapSeries(sessionBars);
  const vwap = vwapSeries.at(-1) ?? null;
  const vwapSlopeUp = vwapSeries.length >= 4 ? vwapSeries.at(-1)! > vwapSeries.at(-4)! : null;
  const opening = sessionBars.filter(b => b.minute >= REGULAR_OPEN && b.minute < OR_END);
  const premarket = bars.filter(b => b.date === sessionDate && b.minute >= 4 * 60 && b.minute < REGULAR_OPEN);
  const sessionOpen = sessionBars[0]?.open ?? null;
  const currentPrice = last.close;
  const benchmarkDates = benchmarkBars
    ? [...new Set(benchmarkBars.filter(b => b.minute >= REGULAR_OPEN && b.minute < REGULAR_CLOSE).map(b => b.date))].sort()
    : [];
  const benchmarkDate = benchmarkDates.at(-1) ?? null;
  const benchmarkSession = benchmarkDate && benchmarkBars ? regularBars(benchmarkBars, benchmarkDate) : [];
  const benchmarkVwaps = calculateVwapSeries(benchmarkSession);
  const benchmarkReturn = benchmarkSession.length ? pctReturn(benchmarkSession[0].open, benchmarkSession.at(-1)!.close) : null;
  const stockReturn = pctReturn(sessionOpen, currentPrice);
  const isSameNyDate = sessionDate === clock.date;
  const ageMinutes = isSameNyDate ? clock.minute - last.minute : 24 * 60;
  const stale = marketOpen ? (!isSameNyDate || ageMinutes > 12) : false;

  return {
    sessionDate,
    latestTime: last.time,
    latestMinute: last.minute,
    currentPrice,
    sessionOpen,
    sessionHigh: Math.max(...sessionBars.map(b => b.high)),
    sessionLow: Math.min(...sessionBars.map(b => b.low)),
    previousHigh: previousBars.length ? Math.max(...previousBars.map(b => b.high)) : null,
    previousLow: previousBars.length ? Math.min(...previousBars.map(b => b.low)) : null,
    previousClose: previousBars.length ? previousBars.at(-1)!.close : null,
    gapPct: previousBars.length ? pctReturn(previousBars.at(-1)!.close, sessionOpen) : null,
    vwap,
    vwapSlopeUp,
    orHigh: opening.length ? Math.max(...opening.map(b => b.high)) : null,
    orLow: opening.length ? Math.min(...opening.map(b => b.low)) : null,
    orReady: last.minute >= OR_END,
    premarketHigh: premarket.length ? Math.max(...premarket.map(b => b.high)) : null,
    premarketLow: premarket.length ? Math.min(...premarket.map(b => b.low)) : null,
    rvol: calculateRvol(bars, sessionDate, last.minute),
    intradayAtr: calculateIntradayAtr(sessionBars, 14),
    intradayReturnPct: stockReturn,
    relativeStrengthPct: stockReturn !== null && benchmarkReturn !== null ? stockReturn - benchmarkReturn : null,
    benchmarkAboveVwap: benchmarkSession.length && benchmarkVwaps.length
      ? benchmarkSession.at(-1)!.close > benchmarkVwaps.at(-1)!
      : null,
    recentLow: sessionBars.length ? Math.min(...sessionBars.slice(-4).map(b => b.low)) : null,
    recentHigh: sessionBars.length ? Math.max(...sessionBars.slice(-4).map(b => b.high)) : null,
    stale,
    phase,
    marketOpen,
    sessionBars,
    vwapSeries,
  };
};

const phaseFactor = (phase: SessionPhase) => {
  if (phase === 'PRIMARY' || phase === 'SECONDARY') return 1;
  if (phase === 'MIDDAY') return 0.6;
  if (phase === 'CLOSING') return 0.5;
  if (phase === 'OPENING') return 0.35;
  return 0;
};

const spreadPercent = (bid: number | null, ask: number | null) => {
  if (bid === null || ask === null || bid <= 0 || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 100;
};

export const buildDayTradeDecision = (input: DayTradeDecisionInput): DayTradeDecision => {
  const m = input.metrics;
  const spreadPct = spreadPercent(input.bid, input.ask);
  const pf = phaseFactor(m.phase);
  const dailyLossLimit = input.accountSizeUsd * (input.dailyMaxLossPct / 100);
  const usedLoss = Math.max(0, -input.realizedPnlUsd);
  const remainingDailyRiskUsd = Math.max(0, dailyLossLimit - usedLoss);

  let hardBlock: string | null = null;
  if (!m.currentPrice || !m.sessionBars.length) hardBlock = '盤中資料不足';
  else if (m.marketOpen && m.stale) hardBlock = '分鐘資料不是即時：禁止把 stale 資料當成當沖進場訊號';
  else if (remainingDailyRiskUsd <= 0) hardBlock = '已達每日最大虧損上限';
  else if (spreadPct !== null && spreadPct > 0.5) hardBlock = `Bid-Ask spread ${spreadPct.toFixed(2)}% 過大`;
  else if (m.phase === 'OPENING' && !m.orReady) hardBlock = 'OR15 尚未形成，先觀察開盤價格發現';
  else if (!m.marketOpen) hardBlock = '目前非美股正常交易時段；僅供盤前/盤後規劃';

  const price = m.currentPrice ?? 0;
  const atr = m.intradayAtr ?? Math.max(price * 0.002, 0.01);
  const aboveVwap = m.vwap !== null ? price > m.vwap : false;
  const belowVwap = m.vwap !== null ? price < m.vwap : false;
  const brokeOrHigh = m.orReady && m.orHigh !== null ? price > m.orHigh : false;
  const brokeOrLow = m.orReady && m.orLow !== null ? price < m.orLow : false;
  const nearVwap = m.vwap !== null ? Math.abs(price - m.vwap) <= atr * 0.35 : false;

  let longScore = 0;
  let shortScore = 0;

  // 1) 日線與大盤背景：20 分
  longScore += input.dailyBias === 'LONG' ? 10 : input.dailyBias === 'NEUTRAL' ? 5 : 0;
  shortScore += input.dailyBias === 'SHORT' ? 10 : input.dailyBias === 'NEUTRAL' ? 5 : 0;
  longScore += input.marketMode === 'RISK_ON' ? 10 : input.marketMode === 'NEUTRAL' ? 5 : 0;
  shortScore += input.marketMode === 'RISK_OFF' ? 10 : input.marketMode === 'NEUTRAL' ? 5 : 0;

  // 2) Benchmark 同步：10 分
  if (m.benchmarkAboveVwap === true) longScore += 10;
  if (m.benchmarkAboveVwap === false) shortScore += 10;

  // 3) VWAP 結構：20 分
  if (aboveVwap) longScore += 12;
  if (belowVwap) shortScore += 12;
  if (m.vwapSlopeUp === true) longScore += 8;
  if (m.vwapSlopeUp === false) shortScore += 8;

  // 4) OR15 / VWAP pullback：15 分
  if (brokeOrHigh) longScore += 15;
  else if (aboveVwap && nearVwap) longScore += 10;
  if (brokeOrLow) shortScore += 15;
  else if (belowVwap && nearVwap) shortScore += 10;

  // 5) Intraday RVOL：15 分
  const rvol = m.rvol ?? 0;
  const volumePoints = rvol >= 2 ? 15 : rvol >= 1.5 ? 12 : rvol >= 1.2 ? 8 : rvol >= 1 ? 4 : 0;
  longScore += volumePoints;
  shortScore += volumePoints;

  // 6) 盤中相對強弱：10 分
  const rs = m.relativeStrengthPct;
  if (rs !== null) {
    if (rs >= 0.5) longScore += 10; else if (rs >= 0.2) longScore += 7; else if (rs > 0) longScore += 3;
    if (rs <= -0.5) shortScore += 10; else if (rs <= -0.2) shortScore += 7; else if (rs < 0) shortScore += 3;
  }

  // 7) 流動性：5 分（無 bid/ask 時給中性 2 分）
  if (spreadPct === null) { longScore += 2; shortScore += 2; }
  else if (spreadPct <= 0.15) { longScore += 5; shortScore += 5; }
  else if (spreadPct <= 0.30) { longScore += 3; shortScore += 3; }

  // 8) 時段品質：5 分
  const timePoints = pf >= 1 ? 5 : pf >= 0.6 ? 3 : pf > 0 ? 1 : 0;
  longScore += timePoints;
  shortScore += timePoints;

  // Catalyst 不拿來彌補壞的價格結構，只做顯示與同分優先。
  longScore = clamp(longScore, 0, 100);
  shortScore = clamp(shortScore, 0, 100);

  let direction: DayTradeDirection = 'WAIT';
  if (!hardBlock) {
    if (longScore >= 80 && longScore - shortScore >= 15) direction = 'LONG';
    else if (shortScore >= 80 && shortScore - longScore >= 15) direction = 'SHORT';
  }

  let label = '等待';
  let reason = '目前尚未形成高品質盤中優勢。';
  if (hardBlock) {
    label = '暫停新倉';
    reason = hardBlock;
  } else if (direction === 'LONG') {
    label = 'LONG 候選';
    reason = brokeOrHigh ? '價格站上 VWAP 並突破 OR15，高分多方結構。' : '多方背景成立，價格在 VWAP 附近形成順勢回踩。';
  } else if (direction === 'SHORT') {
    label = 'SHORT 候選';
    reason = brokeOrLow ? '價格跌破 VWAP 並跌破 OR15，高分空方結構。' : '空方背景成立，價格在 VWAP 附近形成反彈受阻。';
  } else if (Math.max(longScore, shortScore) >= 65) {
    label = 'WATCH';
    reason = '條件接近，但方向優勢或確認程度不足，等待下一根 5 分 K。';
  }

  let entry: number | null = null;
  let stop: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let riskPerShare: number | null = null;
  let suggestedShares = 0;
  let suggestedRiskUsd = 0;

  if (direction !== 'WAIT' && m.currentPrice !== null) {
    entry = m.currentPrice;
    if (direction === 'LONG') {
      const candidates = [
        m.vwap !== null ? m.vwap - atr * 0.25 : null,
        m.orHigh !== null ? m.orHigh - atr * 0.20 : null,
        m.recentLow !== null ? m.recentLow - atr * 0.10 : null,
      ].filter((v): v is number => v !== null && v < entry!);
      const structural = candidates.length ? Math.max(...candidates) : entry - atr * 0.5;
      stop = Math.max(0.01, Math.min(structural, entry - atr * 0.35));
      riskPerShare = Math.max(0.01, entry - stop);
      target1 = entry + riskPerShare * 1.5;
      target2 = entry + riskPerShare * 2.0;
    } else {
      const candidates = [
        m.vwap !== null ? m.vwap + atr * 0.25 : null,
        m.orLow !== null ? m.orLow + atr * 0.20 : null,
        m.recentHigh !== null ? m.recentHigh + atr * 0.10 : null,
      ].filter((v): v is number => v !== null && v > entry!);
      const structural = candidates.length ? Math.min(...candidates) : entry + atr * 0.5;
      stop = Math.max(entry + atr * 0.35, structural);
      riskPerShare = Math.max(0.01, stop - entry);
      target1 = entry - riskPerShare * 1.5;
      target2 = entry - riskPerShare * 2.0;
    }

    const baseRiskBudget = input.accountSizeUsd * (input.riskPerTradePct / 100);
    const timeAdjustedBudget = baseRiskBudget * pf;
    const riskBudget = Math.min(timeAdjustedBudget, remainingDailyRiskUsd);
    const maxRiskShares = Math.floor(riskBudget / riskPerShare);
    const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / entry);
    suggestedShares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));
    suggestedRiskUsd = suggestedShares * riskPerShare;
  }

  return {
    direction,
    longScore,
    shortScore,
    label,
    reason,
    hardBlock,
    spreadPct,
    entry,
    stop,
    target1,
    target2,
    riskPerShare,
    suggestedShares,
    suggestedRiskUsd,
    remainingDailyRiskUsd,
    phaseFactor: pf,
    catalystBonus: input.hasCatalyst,
  };
};
