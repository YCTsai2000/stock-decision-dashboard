import type {
  ApiKeys,
  CompanyProfileInfo,
  EarningsInfo,
  HistoricalDataResult,
  MacroSnapshot,
  MarketCapInfo,
  QuoteInfo,
  SecFundamentalsInfo,
  SourceMeta,
  StockDataPoint,
} from './types';

const REQUEST_TIMEOUT_MS = 10_000;
const PRICE_CACHE_MS = 6 * 60 * 60 * 1000;
const METADATA_CACHE_MS = 24 * 60 * 60 * 1000;
const EARNINGS_CACHE_MS = 6 * 60 * 60 * 1000;
const MACRO_CACHE_MS = 6 * 60 * 60 * 1000;
const SEC_CACHE_MS = 24 * 60 * 60 * 1000;
const PRICE_OUTPUT_SIZE = 180;
const CACHE_PREFIX = 'stock-decision-v3:';

interface CacheEnvelope<T> {
  savedAt: number;
  value: T;
}

const now = () => Date.now();
const cleanKey = (value: string | undefined) => (value ?? '').trim();

const readCache = <T,>(key: string, ttlMs: number): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    if (!envelope?.savedAt || now() - envelope.savedAt > ttlMs) {
      localStorage.removeItem(`${CACHE_PREFIX}${key}`);
      return null;
    }
    return envelope.value;
  } catch {
    return null;
  }
};

const writeCache = <T,>(key: string, value: T) => {
  if (typeof window === 'undefined') return;
  try {
    const envelope: CacheEnvelope<T> = { savedAt: now(), value };
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(envelope));
  } catch {
    // localStorage 額度不足時不影響主程式。
  }
};

export const clearDataCache = () => {
  if (typeof window === 'undefined') return;
  const keysToDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(CACHE_PREFIX)) keysToDelete.push(key);
  }
  keysToDelete.forEach(key => localStorage.removeItem(key));
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortOuter = () => controller.abort();
  signal?.addEventListener('abort', abortOuter);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortOuter);
  }
};

const fetchJson = async (url: string, signal?: AbortSignal): Promise<any> => {
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, signal);
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: response is not JSON`);
  }

  if (!response.ok) {
    const message = json?.error ?? json?.message ?? json?.detail ?? `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return json;
};

const toYmd = (date: Date) => date.toISOString().slice(0, 10);

const daysBetweenLocalDates = (futureDate: string): number | null => {
  const target = new Date(`${futureDate}T12:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const current = new Date();
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate(), 12, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
};

const makeSource = (provider: SourceMeta['provider'], note?: string, cached = false): SourceMeta => ({
  provider,
  updatedAt: now(),
  cached,
  note,
});

const normalizeBars = (bars: StockDataPoint[]) => {
  const byTime = new Map<number, StockDataPoint>();
  bars
    .filter(bar => Number.isFinite(bar.price) && bar.price > 0 && Number.isFinite(bar.time))
    .forEach(bar => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-PRICE_OUTPUT_SIZE);
};

// -------------------------
// Historical OHLCV providers
// -------------------------
const fetchMassiveHistory = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<StockDataPoint[]> => {
  const to = new Date();
  const from = new Date(to.getTime() - 430 * 86_400_000);
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${toYmd(from)}/${toYmd(to)}?adjusted=true&sort=asc&limit=500&apiKey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (!Array.isArray(json?.results)) throw new Error('Massive 沒有回傳 OHLCV');

  return normalizeBars(json.results.map((v: any) => ({
    open: Number(v.o),
    price: Number(v.c),
    high: Number(v.h),
    low: Number(v.l),
    volume: Number(v.v) || 0,
    time: Number(v.t),
  })));
};

const fetchTwelveHistory = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<StockDataPoint[]> => {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${PRICE_OUTPUT_SIZE}&apikey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.status === 'error') throw new Error(json?.message ?? 'Twelve Data error');
  if (!Array.isArray(json?.values)) throw new Error('Twelve Data 沒有回傳 OHLCV');

  return normalizeBars(json.values.map((v: any) => {
    const close = Number(v.close);
    return {
      open: Number(v.open) || close,
      price: close,
      high: Number(v.high) || close,
      low: Number(v.low) || close,
      volume: Number(v.volume) || 0,
      time: new Date(v.datetime).getTime(),
    };
  }));
};

const fetchFinnhubHistory = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<StockDataPoint[]> => {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 430 * 86_400;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (json?.s !== 'ok' || !Array.isArray(json?.c)) throw new Error(json?.error ?? 'Finnhub Candle 此方案不可用');

  const bars: StockDataPoint[] = json.c.map((close: number, i: number) => ({
    open: Number(json.o?.[i]) || Number(close),
    price: Number(close),
    high: Number(json.h?.[i]) || Number(close),
    low: Number(json.l?.[i]) || Number(close),
    volume: Number(json.v?.[i]) || 0,
    time: Number(json.t?.[i]) * 1000,
  }));
  return normalizeBars(bars);
};

export const fetchHistoricalData = async (
  symbol: string,
  keys: ApiKeys,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<HistoricalDataResult> => {
  const upper = symbol.trim().toUpperCase();
  const cacheKey = `history:${upper}`;

  if (!options.force) {
    const cached = readCache<{ data: StockDataPoint[]; source: SourceMeta }>(cacheKey, PRICE_CACHE_MS);
    if (cached?.data?.length) {
      return {
        data: cached.data,
        source: { ...cached.source, provider: 'Cache', cached: true, note: `原來源：${cached.source.provider}` },
        errors: [],
      };
    }
  }

  const errors: string[] = [];
  const providers: Array<{ name: SourceMeta['provider']; key: string; fn: (s: string, k: string, sig?: AbortSignal) => Promise<StockDataPoint[]> }> = [
    { name: 'Massive', key: cleanKey(keys.massive), fn: fetchMassiveHistory },
    { name: 'Twelve Data', key: cleanKey(keys.twelve), fn: fetchTwelveHistory },
    { name: 'Finnhub', key: cleanKey(keys.finnhub), fn: fetchFinnhubHistory },
  ];

  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const data = await provider.fn(upper, provider.key, options.signal);
      if (data.length < 60) throw new Error(`只有 ${data.length} 根日 K`);
      const source = makeSource(provider.name);
      writeCache(cacheKey, { data, source });
      return { data, source, errors };
    } catch (error) {
      if (options.signal?.aborted) break;
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  return { data: null, source: null, errors };
};

// -------------------------
// Quote
// -------------------------
const fetchFinnhubQuote = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<QuoteInfo> => {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  const price = Number(json?.c);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Finnhub quote unavailable');
  return {
    price,
    change: Number.isFinite(Number(json?.d)) ? Number(json.d) : null,
    changePct: Number.isFinite(Number(json?.dp)) ? Number(json.dp) : null,
    previousClose: Number.isFinite(Number(json?.pc)) ? Number(json.pc) : null,
    updatedAt: Number(json?.t) ? Number(json.t) * 1000 : now(),
    source: makeSource('Finnhub'),
  };
};

const fetchMassiveSnapshot = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<QuoteInfo> => {
  const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  const ticker = json?.ticker ?? json?.results ?? null;
  const day = ticker?.day ?? {};
  const prev = ticker?.prevDay ?? {};
  const price = Number(day?.c || ticker?.lastTrade?.p || prev?.c);
  const prevClose = Number(prev?.c);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Massive snapshot unavailable');
  const change = Number.isFinite(prevClose) && prevClose > 0 ? price - prevClose : null;
  const changePct = change !== null && prevClose > 0 ? (change / prevClose) * 100 : null;
  return {
    price,
    change,
    changePct,
    previousClose: Number.isFinite(prevClose) ? prevClose : null,
    updatedAt: now(),
    source: makeSource('Massive', 'snapshot'),
  };
};

export const fetchQuote = async (symbol: string, keys: ApiKeys, signal?: AbortSignal): Promise<QuoteInfo> => {
  const upper = symbol.toUpperCase();
  if (cleanKey(keys.finnhub)) {
    try { return await fetchFinnhubQuote(upper, keys.finnhub, signal); } catch { /* fallback */ }
  }
  if (cleanKey(keys.massive)) {
    try { return await fetchMassiveSnapshot(upper, keys.massive, signal); } catch { /* fallback */ }
  }
  return { price: null, change: null, changePct: null, previousClose: null, updatedAt: null, source: null };
};

// -------------------------
// Company profile + market cap
// -------------------------
interface ProfileBundle {
  profile: CompanyProfileInfo;
  marketCap: MarketCapInfo;
}

const fetchFinnhubProfile = async (symbol: string, apiKey: string, signal?: AbortSignal) => {
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  if (!json || Object.keys(json).length === 0) throw new Error('Finnhub profile unavailable');
  const marketCapMillions = Number(json.marketCapitalization);
  return {
    profile: {
      name: typeof json.name === 'string' ? json.name : null,
      sector: null,
      industry: typeof json.finnhubIndustry === 'string' ? json.finnhubIndustry : null,
      exchange: typeof json.exchange === 'string' ? json.exchange : null,
      country: typeof json.country === 'string' ? json.country : null,
    },
    marketCap: Number.isFinite(marketCapMillions) && marketCapMillions > 0 ? marketCapMillions * 1_000_000 : null,
  };
};

const fetchFmpProfile = async (symbol: string, apiKey: string, signal?: AbortSignal) => {
  const urls = [
    `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`,
    `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(apiKey)}`,
  ];
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const json = await fetchJson(url, signal);
      const row = Array.isArray(json) ? json[0] : (Array.isArray(json?.data) ? json.data[0] : json);
      if (!row || (!row.symbol && !row.companyName && !row.companyName)) throw new Error('FMP profile unavailable');
      return {
        profile: {
          name: typeof row.companyName === 'string' ? row.companyName : (typeof row.name === 'string' ? row.name : null),
          sector: typeof row.sector === 'string' ? row.sector : null,
          industry: typeof row.industry === 'string' ? row.industry : null,
          exchange: typeof row.exchangeShortName === 'string' ? row.exchangeShortName : (typeof row.exchange === 'string' ? row.exchange : null),
          country: typeof row.country === 'string' ? row.country : null,
        },
        marketCap: Number.isFinite(Number(row.mktCap ?? row.marketCap)) ? Number(row.mktCap ?? row.marketCap) : null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('FMP profile unavailable');
};

export const fetchCompanyProfileAndMarketCap = async (
  symbol: string,
  keys: ApiKeys,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ProfileBundle> => {
  const upper = symbol.toUpperCase();
  const cacheKey = `profile:${upper}`;
  if (!options.force) {
    const cached = readCache<ProfileBundle>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
  }

  let finnhub: Awaited<ReturnType<typeof fetchFinnhubProfile>> | null = null;
  let fmp: Awaited<ReturnType<typeof fetchFmpProfile>> | null = null;

  if (cleanKey(keys.finnhub)) {
    try { finnhub = await fetchFinnhubProfile(upper, keys.finnhub, options.signal); } catch { /* fallback */ }
  }
  if (cleanKey(keys.fmp)) {
    try { fmp = await fetchFmpProfile(upper, keys.fmp, options.signal); } catch { /* fallback */ }
  }

  const sourceProvider: SourceMeta['provider'] = fmp ? 'FMP' : finnhub ? 'Finnhub' : 'Proxy';
  const source = makeSource(sourceProvider, fmp && finnhub ? 'FMP + Finnhub 合併' : undefined);
  const profile: CompanyProfileInfo = {
    name: fmp?.profile.name ?? finnhub?.profile.name ?? null,
    sector: fmp?.profile.sector ?? finnhub?.profile.sector ?? null,
    industry: fmp?.profile.industry ?? finnhub?.profile.industry ?? null,
    exchange: fmp?.profile.exchange ?? finnhub?.profile.exchange ?? null,
    country: fmp?.profile.country ?? finnhub?.profile.country ?? null,
    source: (fmp || finnhub) ? source : null,
  };
  const marketCapValue = fmp?.marketCap ?? finnhub?.marketCap ?? null;
  const marketCap: MarketCapInfo = {
    value: marketCapValue,
    source: marketCapValue ? source : null,
  };

  const bundle = { profile, marketCap };
  writeCache(cacheKey, bundle);
  return bundle;
};

// -------------------------
// Earnings calendar
// -------------------------
const normalizeEarningsTime = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.toLowerCase();
  if (value.includes('amc') || value.includes('after')) return '盤後';
  if (value.includes('bmo') || value.includes('before')) return '盤前';
  return raw;
};

const fetchFinnhubEarnings = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<EarningsInfo> => {
  const from = new Date();
  const to = new Date(from.getTime() + 150 * 86_400_000);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${toYmd(from)}&to=${toYmd(to)}&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const json = await fetchJson(url, signal);
  const rows = Array.isArray(json?.earningsCalendar) ? json.earningsCalendar : [];
  const normalized = rows
    .map((row: any) => ({
      date: typeof row?.date === 'string' ? row.date : '',
      time: normalizeEarningsTime(row?.hour ?? row?.time),
      daysUntil: typeof row?.date === 'string' ? daysBetweenLocalDates(row.date) : null,
    }))
    .filter((row: any) => row.date && row.daysUntil !== null && row.daysUntil >= 0)
    .sort((a: any, b: any) => a.daysUntil - b.daysUntil);
  if (!normalized.length) throw new Error('Finnhub earnings unavailable');
  return {
    nextDate: normalized[0].date,
    time: normalized[0].time,
    daysUntil: normalized[0].daysUntil,
    source: makeSource('Finnhub'),
  };
};

const fetchFmpEarnings = async (symbol: string, apiKey: string, signal?: AbortSignal): Promise<EarningsInfo> => {
  const from = new Date();
  const to = new Date(from.getTime() + 150 * 86_400_000);
  const urls = [
    `https://financialmodelingprep.com/stable/earnings-calendar?from=${toYmd(from)}&to=${toYmd(to)}&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`,
    `https://financialmodelingprep.com/api/v3/earning_calendar?from=${toYmd(from)}&to=${toYmd(to)}&apikey=${encodeURIComponent(apiKey)}`,
  ];
  for (const url of urls) {
    try {
      const json = await fetchJson(url, signal);
      const rows = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
      const normalized = rows
        .filter((row: any) => !row.symbol || String(row.symbol).toUpperCase() === symbol.toUpperCase())
        .map((row: any) => ({
          date: typeof row?.date === 'string' ? row.date.slice(0, 10) : '',
          time: normalizeEarningsTime(row?.time),
          daysUntil: typeof row?.date === 'string' ? daysBetweenLocalDates(row.date.slice(0, 10)) : null,
        }))
        .filter((row: any) => row.date && row.daysUntil !== null && row.daysUntil >= 0)
        .sort((a: any, b: any) => a.daysUntil - b.daysUntil);
      if (normalized.length) {
        return {
          nextDate: normalized[0].date,
          time: normalized[0].time,
          daysUntil: normalized[0].daysUntil,
          source: makeSource('FMP'),
        };
      }
    } catch {
      // try legacy endpoint / next provider
    }
  }
  throw new Error('FMP earnings unavailable');
};

export const fetchNextEarnings = async (
  symbol: string,
  keys: ApiKeys,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<EarningsInfo> => {
  const upper = symbol.toUpperCase();
  const cacheKey = `earnings:${upper}`;
  if (!options.force) {
    const cached = readCache<EarningsInfo>(cacheKey, EARNINGS_CACHE_MS);
    if (cached) return cached;
  }

  if (cleanKey(keys.finnhub)) {
    try {
      const result = await fetchFinnhubEarnings(upper, keys.finnhub, options.signal);
      writeCache(cacheKey, result);
      return result;
    } catch { /* fallback */ }
  }
  if (cleanKey(keys.fmp)) {
    try {
      const result = await fetchFmpEarnings(upper, keys.fmp, options.signal);
      writeCache(cacheKey, result);
      return result;
    } catch { /* fallback */ }
  }

  const unavailable: EarningsInfo = { nextDate: null, time: null, daysUntil: null, source: null };
  writeCache(cacheKey, unavailable);
  return unavailable;
};

// -------------------------
// FRED macro data
// -------------------------
interface FredObservation { date: string; value: string; }

const fetchFredSeries = async (seriesId: string, apiKey: string, limit: number, signal?: AbortSignal): Promise<FredObservation[]> => {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;
  const json = await fetchJson(url, signal);
  return Array.isArray(json?.observations) ? json.observations : [];
};

const numericObservations = (observations: FredObservation[]) => observations
  .map(row => ({ date: row.date, value: Number(row.value) }))
  .filter(row => Number.isFinite(row.value));

export const fetchMacroSnapshot = async (
  keys: ApiKeys,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<MacroSnapshot> => {
  const cacheKey = 'macro:fred';
  if (!options.force) {
    const cached = readCache<MacroSnapshot>(cacheKey, MACRO_CACHE_MS);
    if (cached) return cached;
  }

  if (!cleanKey(keys.fred)) {
    return { tenYear: null, tenYearPrev: null, twoYear: null, twoYearPrev: null, yieldCurve: null, cpi: null, cpiYoY: null, updatedAt: null, source: null, status: 'unavailable' };
  }

  try {
    const [tenYearRows, twoYearRows, cpiRows] = await Promise.all([
      fetchFredSeries('DGS10', keys.fred, 10, options.signal),
      fetchFredSeries('DGS2', keys.fred, 10, options.signal),
      fetchFredSeries('CPIAUCSL', keys.fred, 16, options.signal),
    ]);
    const ten = numericObservations(tenYearRows);
    const two = numericObservations(twoYearRows);
    const cpi = numericObservations(cpiRows);
    const tenYear = ten[0]?.value ?? null;
    const tenYearPrev = ten[1]?.value ?? null;
    const twoYear = two[0]?.value ?? null;
    const twoYearPrev = two[1]?.value ?? null;
    const cpiNow = cpi[0]?.value ?? null;
    const cpi12m = cpi.length >= 13 ? cpi[12]?.value ?? null : null;
    const cpiYoY = cpiNow !== null && cpi12m !== null && cpi12m !== 0 ? ((cpiNow / cpi12m) - 1) * 100 : null;
    const result: MacroSnapshot = {
      tenYear,
      tenYearPrev,
      twoYear,
      twoYearPrev,
      yieldCurve: tenYear !== null && twoYear !== null ? tenYear - twoYear : null,
      cpi: cpiNow,
      cpiYoY,
      updatedAt: now(),
      source: makeSource('FRED', '官方總經資料'),
      status: 'ok',
    };
    writeCache(cacheKey, result);
    return result;
  } catch {
    return { tenYear: null, tenYearPrev: null, twoYear: null, twoYearPrev: null, yieldCurve: null, cpi: null, cpiYoY: null, updatedAt: null, source: null, status: 'unavailable' };
  }
};

// -------------------------
// SEC official fundamentals (best-effort in browser)
// -------------------------
interface SecTickerRow { cik_str: number; ticker: string; title: string; }

const fetchSecTickerMap = async (signal?: AbortSignal): Promise<Record<string, SecTickerRow>> => {
  const cacheKey = 'sec:ticker-map';
  const cached = readCache<Record<string, SecTickerRow>>(cacheKey, 30 * 24 * 60 * 60 * 1000);
  if (cached) return cached;
  const json = await fetchJson('https://www.sec.gov/files/company_tickers.json', signal);
  const map: Record<string, SecTickerRow> = {};
  Object.values(json ?? {}).forEach((row: any) => {
    if (row?.ticker) map[String(row.ticker).toUpperCase()] = row as SecTickerRow;
  });
  writeCache(cacheKey, map);
  return map;
};

const getLatestSecFact = (companyFacts: any, tags: string[]) => {
  for (const tag of tags) {
    const fact = companyFacts?.facts?.['us-gaap']?.[tag];
    const units = fact?.units;
    if (!units || typeof units !== 'object') continue;
    const rows: any[] = units.USD ?? Object.values(units)[0] ?? [];
    if (!Array.isArray(rows)) continue;
    const valid = rows
      .filter(row => Number.isFinite(Number(row?.val)) && ['10-Q', '10-K'].includes(String(row?.form)))
      .sort((a, b) => new Date(b.filed ?? b.end ?? 0).getTime() - new Date(a.filed ?? a.end ?? 0).getTime());
    if (valid.length) return valid[0];
  }
  return null;
};

export const fetchSecFundamentals = async (
  symbol: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<SecFundamentalsInfo> => {
  const upper = symbol.toUpperCase();
  const cacheKey = `sec:fundamentals:${upper}`;
  if (!options.force) {
    const cached = readCache<SecFundamentalsInfo>(cacheKey, SEC_CACHE_MS);
    if (cached) return cached;
  }

  try {
    const tickerMap = await fetchSecTickerMap(options.signal);
    const ticker = tickerMap[upper];
    if (!ticker) {
      return { cik: null, filingDate: null, form: null, revenue: null, netIncome: null, operatingCashFlow: null, capex: null, freeCashFlow: null, source: null, status: 'not-found' };
    }
    const cik = String(ticker.cik_str).padStart(10, '0');
    const json = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, options.signal);
    const revenueFact = getLatestSecFact(json, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
    const netIncomeFact = getLatestSecFact(json, ['NetIncomeLoss']);
    const ocfFact = getLatestSecFact(json, ['NetCashProvidedByUsedInOperatingActivities']);
    const capexFact = getLatestSecFact(json, ['PaymentsToAcquirePropertyPlantAndEquipment']);

    const revenue = revenueFact ? Number(revenueFact.val) : null;
    const netIncome = netIncomeFact ? Number(netIncomeFact.val) : null;
    const operatingCashFlow = ocfFact ? Number(ocfFact.val) : null;
    const capex = capexFact ? Math.abs(Number(capexFact.val)) : null;
    const freeCashFlow = operatingCashFlow !== null && capex !== null ? operatingCashFlow - capex : null;
    const anchor = revenueFact ?? netIncomeFact ?? ocfFact ?? capexFact;
    const result: SecFundamentalsInfo = {
      cik,
      filingDate: anchor?.filed ?? null,
      form: anchor?.form ?? null,
      revenue,
      netIncome,
      operatingCashFlow,
      capex,
      freeCashFlow,
      source: makeSource('SEC', 'EDGAR Company Facts · 官方資料'),
      status: 'ok',
    };
    writeCache(cacheKey, result);
    return result;
  } catch {
    return { cik: null, filingDate: null, form: null, revenue: null, netIncome: null, operatingCashFlow: null, capex: null, freeCashFlow: null, source: null, status: 'unavailable' };
  }
};

export const hasAnyHistoricalPriceKey = (keys: ApiKeys) => Boolean(
  cleanKey(keys.massive) || cleanKey(keys.twelve) || cleanKey(keys.finnhub)
);
