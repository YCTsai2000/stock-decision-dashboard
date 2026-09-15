import type { ApiKeys } from './types';
import {
  getNewYorkClock,
  type IntradayBar,
  type IntradayFetchResult,
  type IntradayProvider,
} from './intradayCore';

const REQUEST_TIMEOUT_MS = 10_000;
const TWELVE_OUTPUT_SIZE = 5000;
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const MIN_RVOL_SESSIONS = 11; // current session + 10 prior sessions, matching canonical backtest.

const cleanKey = (value: string | undefined) => (value ?? '').trim();
const toYmd = (date: Date) => date.toISOString().slice(0, 10);
const parseMinute = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
const formatMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

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

const normalizeOneMinuteBars = (bars: IntradayBar[]) => {
  const dedupe = new Map<string, IntradayBar>();
  for (const bar of bars) {
    if (!bar.date || !bar.time || !Number.isFinite(bar.close) || bar.close <= 0) continue;
    if (bar.minute < REGULAR_OPEN || bar.minute >= REGULAR_CLOSE) continue;
    dedupe.set(`${bar.date}-${bar.time}`, bar);
  }
  return [...dedupe.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
};

/**
 * Canonical V6 data contract:
 * provider 1m bars -> locally aggregate only completed 5m buckets.
 * Historical buckets tolerate one missing 1m print (>=4 bars), matching the canonical replay.
 * Today's bucket is stricter: all five 1m bars must actually be present before it can drive a signal.
 */
export const aggregateCanonicalFiveMinuteBars = (rawBars: IntradayBar[], now = getNewYorkClock()): IntradayBar[] => {
  const bars = normalizeOneMinuteBars(rawBars);
  const buckets = new Map<string, IntradayBar[]>();
  for (const bar of bars) {
    const bucketMinute = REGULAR_OPEN + Math.floor((bar.minute - REGULAR_OPEN) / 5) * 5;
    if (bar.date === now.date && now.minute < bucketMinute + 5) continue;
    const key = `${bar.date}-${bucketMinute}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(bar);
  }

  const out: IntradayBar[] = [];
  for (const values of buckets.values()) {
    values.sort((a, b) => a.minute - b.minute);
    const first = values[0];
    if (!first) continue;
    const bucketMinute = REGULAR_OPEN + Math.floor((first.minute - REGULAR_OPEN) / 5) * 5;
    const isToday = first.date === now.date;
    if (isToday) {
      if (values.length < 5 || first.minute !== bucketMinute || values.at(-1)!.minute !== bucketMinute + 4) continue;
    } else if (values.length < 4) {
      continue;
    }
    const last = values.at(-1)!;
    out.push({
      date: first.date,
      time: formatMinute(bucketMinute),
      minute: bucketMinute,
      open: first.open,
      high: Math.max(...values.map(v => v.high)),
      low: Math.min(...values.map(v => v.low)),
      close: last.close,
      volume: values.reduce((sum, v) => sum + v.volume, 0),
    });
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
};

const fetchTwelveOneMinute = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=${TWELVE_OUTPUT_SIZE}&timezone=America/New_York&prepost=false&order=asc&apikey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.status === 'error') throw new Error(json?.message ?? 'Twelve Data error');
  if (!Array.isArray(json?.values)) throw new Error('Twelve Data 沒有回傳 1 分 K');
  return json.values.map((v: any) => {
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
  });
};

const fetchMassiveOneMinute = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const to = new Date();
  const from = new Date(to.getTime() - 35 * 86_400_000);
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${toYmd(from)}/${toYmd(to)}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (!Array.isArray(json?.results)) throw new Error('Massive 沒有回傳 1 分 K');
  return json.results.map((v: any) => ({
    ...nyPartsFromEpoch(Number(v.t)),
    open: Number(v.o),
    high: Number(v.h),
    low: Number(v.l),
    close: Number(v.c),
    volume: Number(v.v) || 0,
  }));
};

const fetchFinnhubOneMinute = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<IntradayBar[]> => {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 35 * 86_400;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.s !== 'ok' || !Array.isArray(json?.c)) throw new Error(json?.error ?? 'Finnhub 1 分 K 此方案不可用');
  return json.c.map((close: number, i: number) => ({
    ...nyPartsFromEpoch(Number(json.t?.[i]) * 1000),
    open: Number(json.o?.[i]) || Number(close),
    high: Number(json.h?.[i]) || Number(close),
    low: Number(json.l?.[i]) || Number(close),
    close: Number(close),
    volume: Number(json.v?.[i]) || 0,
  }));
};

const regularSessionCount = (bars: IntradayBar[]) => new Set(bars.map(b => b.date)).size;

export const fetchIntradayData = async (symbol: string, keys: ApiKeys, signal?: AbortSignal): Promise<IntradayFetchResult> => {
  const upper = symbol.trim().toUpperCase();
  const providers: Array<{
    name: IntradayProvider;
    key: string;
    note: string;
    fn: (symbol: string, key: string, signal?: AbortSignal) => Promise<IntradayBar[]>;
  }> = [
    {
      name: 'Twelve Data', key: cleanKey(keys.twelve), fn: fetchTwelveOneMinute,
      note: 'V6.3.5 canonical：Twelve 1 分 K（prepost=false）→ 本地聚合已完成 5 分 K；RVOL 與 replay 使用相同資料粒度。',
    },
    {
      name: 'Massive', key: cleanKey(keys.massive), fn: fetchMassiveOneMinute,
      note: 'V6.3.5 canonical：Massive 1 分 K → 本地聚合已完成 5 分 K；免費方案盤中 recency 可能 stale。',
    },
    {
      name: 'Finnhub', key: cleanKey(keys.finnhub), fn: fetchFinnhubOneMinute,
      note: 'V6.3.5 canonical：Finnhub 1 分 K → 本地聚合已完成 5 分 K；可用性依 dataset 權限。',
    },
  ];

  const errors: string[] = [];
  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const oneMinute = await provider.fn(upper, provider.key, signal);
      const bars = aggregateCanonicalFiveMinuteBars(oneMinute);
      const sessions = regularSessionCount(bars);
      if (bars.length < 20) throw new Error(`聚合後只有 ${bars.length} 根完成 5 分 K`);
      if (sessions < MIN_RVOL_SESSIONS) {
        throw new Error(`canonical RVOL 歷史不足：只有 ${sessions} 個 regular sessions，需要至少 ${MIN_RVOL_SESSIONS}`);
      }
      return { bars, source: { provider: provider.name, interval: '5min', note: provider.note }, errors };
    } catch (error) {
      if (signal?.aborted) break;
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return { bars: null, source: null, errors };
};
