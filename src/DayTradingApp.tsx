import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  WalletCards,
  Zap,
} from 'lucide-react';
import type { ApiKeys, HistoricalDataResult, QuoteInfo } from './types';
import { calculateMA, evaluateMarketRegime } from './analysis';
import { fetchHistoricalData, fetchQuote } from './dataLayer';
import {
  buildDayTradeDecision,
  computeIntradayMetrics,
  fetchIntradayData,
  getNewYorkClock,
  getSessionPhase,
  type IntradayBar,
  type IntradayFetchResult,
  type IntradayMetrics,
  type SessionPhase,
} from './intraday';

const EMPTY_KEYS: ApiKeys = { massive: '', finnhub: '', fmp: '', twelve: '', fred: '' };
const DEFAULT_SYMBOLS = ['NVDA', 'AAPL', 'TSLA', 'AMD', 'ORCL', 'MU'];
const INTRADAY_REFRESH_MS = 180_000;
const QUOTE_REFRESH_MS = 30_000;

interface DayTradeSettings {
  accountSizeUsd: number;
  riskPerTradePct: number;
  dailyMaxLossPct: number;
  realizedPnlUsd: number;
  maxAllocationPct: number;
  bid: string;
  ask: string;
  hasCatalyst: boolean;
}

const DEFAULT_SETTINGS: DayTradeSettings = {
  accountSizeUsd: 15_000,
  riskPerTradePct: 0.5,
  dailyMaxLossPct: 1.5,
  realizedPnlUsd: 0,
  maxAllocationPct: 25,
  bid: '',
  ask: '',
  hasCatalyst: false,
};

const loadKeys = (): ApiKeys => {
  try {
    const raw = localStorage.getItem('stockDecisionApiKeys');
    return raw ? { ...EMPTY_KEYS, ...(JSON.parse(raw) as Partial<ApiKeys>) } : EMPTY_KEYS;
  } catch { return EMPTY_KEYS; }
};

const loadSymbols = (): string[] => {
  try {
    const raw = localStorage.getItem('stockDecisionSymbols');
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_SYMBOLS;
  } catch { return DEFAULT_SYMBOLS; }
};

const loadSettings = (): DayTradeSettings => {
  try {
    const raw = localStorage.getItem('stockDecisionDayTradeSettings');
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DayTradeSettings>) } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
};

const numberOrNull = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const formatPrice = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `$${value.toFixed(2)}`;
const formatPct = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const phaseLabel = (phase: SessionPhase) => ({
  PREMARKET: '盤前', OPENING: '開盤 15 分鐘', PRIMARY: '主交易時段', MIDDAY: '午盤低效率', SECONDARY: '午後交易時段',
  CLOSING: '尾盤', AFTER_HOURS: '盤後', CLOSED: '休市',
}[phase]);

const getDailyBias = (result: HistoricalDataResult | null): 'LONG' | 'SHORT' | 'NEUTRAL' => {
  const data = result?.data;
  if (!data || data.length < 60) return 'NEUTRAL';
  const close = data.at(-1)!.price;
  const ma20 = calculateMA(data, 20);
  const ma60 = calculateMA(data, 60);
  if (ma20 === null || ma60 === null) return 'NEUTRAL';
  if (close > ma20 && ma20 > ma60) return 'LONG';
  if (close < ma20 && ma20 < ma60) return 'SHORT';
  return 'NEUTRAL';
};

const Metric = ({ label, value, hint, tone = 'normal' }: { label: string; value: string; hint?: string; tone?: 'normal' | 'good' | 'bad' | 'warn' }) => {
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-300' : 'text-slate-100';
  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono font-bold mt-1 ${cls}`}>{value}</div>
      {hint ? <div className="text-[10px] text-slate-600 mt-1 leading-relaxed">{hint}</div> : null}
    </div>
  );
};

const MiniChart = ({ metrics }: { metrics: IntradayMetrics }) => {
  const bars = metrics.sessionBars.slice(-60);
  if (bars.length < 2) return <div className="h-40 flex items-center justify-center text-xs text-slate-600">分鐘資料不足</div>;
  const vwaps = metrics.vwapSeries.slice(-bars.length);
  const all = [...bars.map(b => b.close), ...vwaps];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = Math.max(0.01, max - min);
  const point = (value: number, i: number, total: number) => `${(i / Math.max(1, total - 1)) * 100},${100 - ((value - min) / span) * 90 - 5}`;
  const pricePoints = bars.map((b, i) => point(b.close, i, bars.length)).join(' ');
  const vwapPoints = vwaps.map((v, i) => point(v, i, vwaps.length)).join(' ');
  return (
    <div className="h-44 bg-slate-950/70 border border-slate-800 rounded-xl p-3">
      <div className="flex items-center justify-between text-[10px] text-slate-500 mb-2">
        <span>最近 {bars.length} 根 5 分 K 收盤線</span>
        <span>灰：Price · 藍：VWAP</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-[120px] overflow-visible">
        <polyline points={pricePoints} fill="none" stroke="rgb(203 213 225)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        <polyline points={vwapPoints} fill="none" stroke="rgb(56 189 248)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

const SourceStatus = ({ result }: { result: IntradayFetchResult | null }) => {
  if (!result?.source) return <span className="text-xs text-rose-300">無分鐘資料來源</span>;
  return (
    <span title={result.source.note} className="inline-flex items-center gap-1 text-[11px] rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-300 px-2 py-1">
      <Database size={11} /> {result.source.provider} · {result.source.interval}
    </span>
  );
};

export default function DayTradingApp() {
  const [keys, setKeys] = useState<ApiKeys>(loadKeys);
  const [symbols, setSymbols] = useState<string[]>(loadSymbols);
  const [activeSymbol, setActiveSymbol] = useState(() => loadSymbols()[0] ?? 'NVDA');
  const [newSymbol, setNewSymbol] = useState('');
  const [benchmark, setBenchmark] = useState('QQQ');
  const [settings, setSettings] = useState<DayTradeSettings>(loadSettings);
  const [intraday, setIntraday] = useState<IntradayFetchResult | null>(null);
  const [benchmarkIntraday, setBenchmarkIntraday] = useState<IntradayFetchResult | null>(null);
  const [daily, setDaily] = useState<HistoricalDataResult | null>(null);
  const [spyDaily, setSpyDaily] = useState<HistoricalDataResult | null>(null);
  const [qqqDaily, setQqqDaily] = useState<HistoricalDataResult | null>(null);
  const [quote, setQuote] = useState<QuoteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [nyClock, setNyClock] = useState(getNewYorkClock());

  useEffect(() => { localStorage.setItem('stockDecisionApiKeys', JSON.stringify(keys)); }, [keys]);
  useEffect(() => { localStorage.setItem('stockDecisionSymbols', JSON.stringify(symbols)); }, [symbols]);
  useEffect(() => { localStorage.setItem('stockDecisionDayTradeSettings', JSON.stringify(settings)); }, [settings]);
  useEffect(() => {
    const id = window.setInterval(() => setNyClock(getNewYorkClock()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!activeSymbol) return;
    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) {
      setError('請至少設定 Twelve Data、Massive 或 Finnhub 其中一組 Key。當沖分鐘資料建議優先使用 Twelve Data。');
      return;
    }
    setLoading(true);
    setError('');
    const controller = new AbortController();
    try {
      const [intradayResult, benchmarkResult, dailyResult, spyResult, qqqResult, quoteResult] = await Promise.all([
        fetchIntradayData(activeSymbol, keys, controller.signal),
        fetchIntradayData(benchmark, keys, controller.signal),
        fetchHistoricalData(activeSymbol, keys, { signal: controller.signal }),
        fetchHistoricalData('SPY', keys, { signal: controller.signal }),
        fetchHistoricalData('QQQ', keys, { signal: controller.signal }),
        fetchQuote(activeSymbol, keys, controller.signal),
      ]);
      setIntraday(intradayResult);
      setBenchmarkIntraday(benchmarkResult);
      setDaily(dailyResult);
      setSpyDaily(spyResult);
      setQqqDaily(qqqResult);
      setQuote(quoteResult);
      setLastRefresh(Date.now());
      if (!intradayResult.bars) setError(intradayResult.errors.join(' ｜ ') || '找不到可用的分鐘資料');
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失敗');
    } finally {
      setLoading(false);
    }
    return () => controller.abort();
  }, [activeSymbol, benchmark, keys]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), INTRADAY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!keys.finnhub.trim() && !keys.massive.trim()) return;
    const refreshQuote = async () => {
      try { setQuote(await fetchQuote(activeSymbol, keys)); } catch { /* 分鐘資料仍可運作 */ }
    };
    const id = window.setInterval(() => void refreshQuote(), QUOTE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeSymbol, keys]);

  const rawMetrics = useMemo(() => computeIntradayMetrics(intraday?.bars ?? null, benchmarkIntraday?.bars ?? null), [intraday, benchmarkIntraday]);
  const metrics = useMemo<IntradayMetrics>(() => {
    const livePrice = quote?.price && quote.price > 0 ? quote.price : rawMetrics.currentPrice;
    return { ...rawMetrics, currentPrice: livePrice };
  }, [rawMetrics, quote]);
  const marketRegime = useMemo(() => evaluateMarketRegime(spyDaily?.data ?? undefined, qqqDaily?.data ?? undefined), [spyDaily, qqqDaily]);
  const dailyBias = useMemo(() => getDailyBias(daily), [daily]);
  const decision = useMemo(() => buildDayTradeDecision({
    metrics,
    dailyBias,
    marketMode: marketRegime.mode,
    accountSizeUsd: settings.accountSizeUsd,
    riskPerTradePct: settings.riskPerTradePct,
    dailyMaxLossPct: settings.dailyMaxLossPct,
    realizedPnlUsd: settings.realizedPnlUsd,
    maxAllocationPct: settings.maxAllocationPct,
    bid: numberOrNull(settings.bid),
    ask: numberOrNull(settings.ask),
    hasCatalyst: settings.hasCatalyst,
  }), [metrics, dailyBias, marketRegime.mode, settings]);

  const addSymbol = () => {
    const upper = newSymbol.trim().toUpperCase();
    if (!upper) return;
    const next = [...new Set([...symbols, upper])].slice(0, 12);
    setSymbols(next);
    setActiveSymbol(upper);
    setNewSymbol('');
  };

  const signalClass = decision.direction === 'LONG'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : decision.direction === 'SHORT'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      : decision.hardBlock
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-slate-700 bg-slate-800/70 text-slate-300';

  const livePhase = getSessionPhase(nyClock.minute, nyClock.weekday);
  const providerStale = metrics.marketOpen && metrics.stale;
  const latestPrice = metrics.currentPrice;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 pt-14 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <header className="mb-5">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-cyan-400 text-sm font-bold mb-1"><Zap size={16} /> DAY TRADING MODE</div>
              <h1 className="text-2xl md:text-3xl font-black text-white">美股當沖決策輔助</h1>
              <p className="text-xs text-slate-500 mt-2 max-w-3xl">5 分 K + VWAP + OR15 + RVOL + 盤中相對強弱 + 日線背景 + 每日風控。這是交易決策輔助，不是自動下單系統。</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2">
                <div className="text-slate-500">New York</div>
                <div className="font-mono text-white">{nyClock.date} {nyClock.time}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2">
                <div className="text-slate-500">Session</div>
                <div className={livePhase === 'PRIMARY' || livePhase === 'SECONDARY' ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>{phaseLabel(livePhase)}</div>
              </div>
            </div>
          </div>
        </header>

        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 mb-4">
          <div className="flex flex-col xl:flex-row gap-3 xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2">
              {symbols.map(symbol => (
                <button key={symbol} onClick={() => setActiveSymbol(symbol)} className={`px-3 py-2 rounded-lg border text-xs font-bold transition-colors ${activeSymbol === symbol ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-white'}`}>{symbol}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={newSymbol} onChange={e => setNewSymbol(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') addSymbol(); }} placeholder="新增股票" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs w-28 focus:outline-none focus:border-cyan-500" />
              <button onClick={addSymbol} className="border border-slate-700 rounded-lg px-3 py-2 text-xs hover:border-cyan-500">加入</button>
              <select value={benchmark} onChange={e => setBenchmark(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs">
                <option value="QQQ">Benchmark: QQQ</option>
                <option value="SOXX">Benchmark: SOXX</option>
                <option value="SPY">Benchmark: SPY</option>
              </select>
              <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 rounded-lg px-3 py-2 text-xs disabled:opacity-50">
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 更新
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-3 text-[10px] text-slate-500">
            <SourceStatus result={intraday} />
            <span>分鐘資料每 3 分鐘更新；Quote 約 30 秒更新。</span>
            {lastRefresh ? <span>最後整體更新：{new Date(lastRefresh).toLocaleTimeString('zh-TW')}</span> : null}
            {providerStale ? <span className="text-rose-300 font-bold">⚠ 分鐘資料 stale，禁止依此進場</span> : null}
          </div>
          {error ? <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs p-3">{error}</div> : null}
        </div>

        <div className={`rounded-2xl border p-5 mb-4 ${signalClass}`}>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="text-xs opacity-70 mb-1">{activeSymbol} · 現價 {formatPrice(latestPrice)} · Daily bias {dailyBias} · Market {marketRegime.mode}</div>
              <div className="flex items-center gap-2">
                {decision.direction === 'LONG' ? <TrendingUp size={24} /> : decision.direction === 'SHORT' ? <TrendingDown size={24} /> : <Activity size={24} />}
                <div className="text-2xl font-black">{decision.label}</div>
              </div>
              <div className="text-xs mt-2 opacity-80">{decision.reason}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 min-w-[220px]">
              <div className="bg-slate-950/40 rounded-xl p-3 text-center"><div className="text-[10px] opacity-60">LONG</div><div className="text-2xl font-black text-emerald-300">{decision.longScore}</div></div>
              <div className="bg-slate-950/40 rounded-xl p-3 text-center"><div className="text-[10px] opacity-60">SHORT</div><div className="text-2xl font-black text-rose-300">{decision.shortScore}</div></div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
          <div className="xl:col-span-2 bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><BarChart3 size={18} className="text-cyan-400" /><h2 className="font-bold">盤中結構</h2></div>
              <div className="text-[10px] text-slate-500">5 分 K session: {metrics.sessionDate ?? '—'} {metrics.latestTime ?? ''}</div>
            </div>
            <MiniChart metrics={metrics} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
              <Metric label="VWAP" value={formatPrice(metrics.vwap)} tone={metrics.currentPrice !== null && metrics.vwap !== null ? metrics.currentPrice > metrics.vwap ? 'good' : 'bad' : 'normal'} hint={metrics.vwapSlopeUp === null ? '斜率未知' : metrics.vwapSlopeUp ? 'VWAP slope ↑' : 'VWAP slope ↓'} />
              <Metric label="OR15 High / Low" value={`${formatPrice(metrics.orHigh)} / ${formatPrice(metrics.orLow)}`} tone={metrics.orReady ? 'normal' : 'warn'} hint={metrics.orReady ? 'Opening range 已完成' : '09:45 ET 前不做 OR breakout'} />
              <Metric label="RVOL" value={metrics.rvol === null ? '—' : `${metrics.rvol.toFixed(2)}x`} tone={(metrics.rvol ?? 0) >= 1.5 ? 'good' : (metrics.rvol ?? 0) < 1 ? 'warn' : 'normal'} hint="同一盤中時間 vs 近 10 個交易日" />
              <Metric label={`Intraday RS vs ${benchmark}`} value={formatPct(metrics.relativeStrengthPct)} tone={(metrics.relativeStrengthPct ?? 0) > 0.2 ? 'good' : (metrics.relativeStrengthPct ?? 0) < -0.2 ? 'bad' : 'normal'} />
              <Metric label="PDH / PDL" value={`${formatPrice(metrics.previousHigh)} / ${formatPrice(metrics.previousLow)}`} hint={`PDC ${formatPrice(metrics.previousClose)}`} />
              <Metric label="Premarket H / L" value={`${formatPrice(metrics.premarketHigh)} / ${formatPrice(metrics.premarketLow)}`} hint={metrics.premarketHigh === null ? '免費來源若不含當日盤前資料會顯示 —' : '盤前結構可用'} />
              <Metric label="Gap" value={formatPct(metrics.gapPct)} tone={Math.abs(metrics.gapPct ?? 0) > 5 ? 'warn' : 'normal'} hint="今日 regular open vs 前收" />
              <Metric label="Intraday ATR(14)" value={formatPrice(metrics.intradayAtr)} hint="5 分 K 真實波幅；用於盤中停損" />
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3"><Target size={18} className="text-emerald-400" /><h2 className="font-bold">交易計畫</h2></div>
            <div className="space-y-2 text-sm">
              <Metric label="Entry reference" value={formatPrice(decision.entry)} />
              <Metric label="Technical stop" value={formatPrice(decision.stop)} tone={decision.stop !== null ? 'bad' : 'normal'} hint="VWAP / OR / 最近 4 根 swing + 5m ATR" />
              <div className="grid grid-cols-2 gap-2">
                <Metric label="TP1 · 1.5R" value={formatPrice(decision.target1)} tone="good" />
                <Metric label="TP2 · 2.0R" value={formatPrice(decision.target2)} tone="good" />
              </div>
              <Metric label="Suggested shares" value={decision.suggestedShares > 0 ? `${decision.suggestedShares} 股` : '0'} hint={`預估單筆風險 $${decision.suggestedRiskUsd.toFixed(0)} · 時段係數 ${decision.phaseFactor.toFixed(2)}`} />
              <Metric label="Remaining daily risk" value={`$${decision.remainingDailyRiskUsd.toFixed(0)}`} tone={decision.remainingDailyRiskUsd > 0 ? 'normal' : 'bad'} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4"><WalletCards size={18} className="text-violet-400" /><h2 className="font-bold">每日風控</h2></div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <label className="field-label">帳戶資金 USD<input className="field-input" type="number" min="100" value={settings.accountSizeUsd} onChange={e => setSettings(s => ({ ...s, accountSizeUsd: Number(e.target.value) || 0 }))} /></label>
              <label className="field-label">單筆最大風險 %<input className="field-input" type="number" min="0.1" step="0.1" value={settings.riskPerTradePct} onChange={e => setSettings(s => ({ ...s, riskPerTradePct: Number(e.target.value) || 0 }))} /></label>
              <label className="field-label">每日最大虧損 %<input className="field-input" type="number" min="0.1" step="0.1" value={settings.dailyMaxLossPct} onChange={e => setSettings(s => ({ ...s, dailyMaxLossPct: Number(e.target.value) || 0 }))} /></label>
              <label className="field-label">今日已實現 P/L USD<input className="field-input" type="number" step="1" value={settings.realizedPnlUsd} onChange={e => setSettings(s => ({ ...s, realizedPnlUsd: Number(e.target.value) || 0 }))} /></label>
              <label className="field-label">單一股票最大資金 %<input className="field-input" type="number" min="1" step="1" value={settings.maxAllocationPct} onChange={e => setSettings(s => ({ ...s, maxAllocationPct: Number(e.target.value) || 0 }))} /></label>
              <label className="field-label">Catalyst<label className="h-[38px] bg-slate-950 border border-slate-700 rounded-lg px-3 flex items-center gap-2"><input type="checkbox" checked={settings.hasCatalyst} onChange={e => setSettings(s => ({ ...s, hasCatalyst: e.target.checked }))} /><span className="text-xs">有明確消息催化</span></label></label>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4"><Gauge size={18} className="text-amber-400" /><h2 className="font-bold">流動性與資料品質</h2></div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="field-label">Bid（可從券商手動填）<input className="field-input" inputMode="decimal" value={settings.bid} onChange={e => setSettings(s => ({ ...s, bid: e.target.value }))} placeholder="例如 185.20" /></label>
              <label className="field-label">Ask（可從券商手動填）<input className="field-input" inputMode="decimal" value={settings.ask} onChange={e => setSettings(s => ({ ...s, ask: e.target.value }))} placeholder="例如 185.24" /></label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Bid-Ask Spread" value={decision.spreadPct === null ? '未輸入' : `${decision.spreadPct.toFixed(3)}%`} tone={(decision.spreadPct ?? 0) > 0.5 ? 'bad' : (decision.spreadPct ?? 0) > 0.3 ? 'warn' : 'normal'} />
              <Metric label={`${benchmark} vs VWAP`} value={metrics.benchmarkAboveVwap === null ? '—' : metrics.benchmarkAboveVwap ? 'Above' : 'Below'} tone={metrics.benchmarkAboveVwap === true ? 'good' : metrics.benchmarkAboveVwap === false ? 'bad' : 'normal'} />
            </div>
            <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
              免費 API 很可能沒有 consolidated SIP 即時 bid/ask，因此 spread 不自動杜撰。你可以從實際券商畫面輸入 Bid / Ask；若 spread &gt; 0.5%，系統直接 Hard Block。
            </div>
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-3"><ShieldAlert size={18} className="text-rose-400" /><h2 className="font-bold">Hard Filters 與執行規則</h2></div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
            <div className="bg-slate-950/60 rounded-xl p-3"><div className="font-bold text-slate-200">資料新鮮度</div><div className="text-slate-500 mt-1">正常交易時段若最新 5 分 K 落後 &gt;12 分鐘，禁止產生 LONG/SHORT。</div></div>
            <div className="bg-slate-950/60 rounded-xl p-3"><div className="font-bold text-slate-200">OR15</div><div className="text-slate-500 mt-1">09:45 ET 前不把開盤波動當成正式 breakout 訊號。</div></div>
            <div className="bg-slate-950/60 rounded-xl p-3"><div className="font-bold text-slate-200">每日停手機制</div><div className="text-slate-500 mt-1">今日已實現虧損達 Daily Max Loss 後，系統鎖住新倉。</div></div>
            <div className="bg-slate-950/60 rounded-xl p-3"><div className="font-bold text-slate-200">分數門檻</div><div className="text-slate-500 mt-1">方向分數 ≥80 且領先反向至少 15 分才形成候選訊號。</div></div>
          </div>
        </div>

        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 text-xs text-amber-200/80 leading-relaxed">
          <div className="flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" /><div><strong>資料限制：</strong>Massive Stocks Basic 的分鐘 aggregates 屬 EOD recency；Twelve Data 免費方案雖可提供 US equities / intraday，但實際即時覆蓋與盤前資料依帳戶權限而異。本頁會以最新 bar 時間做 stale 檢查。若你看到「分鐘資料不是即時」，請只把畫面用於復盤，不要拿來下當沖單。</div></div>
        </div>

        <div className="mt-4 bg-slate-900/40 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center gap-2 text-sm font-bold mb-3"><Database size={15} className="text-sky-400" />API Key（與日線模式共用）</div>
          <div className="grid md:grid-cols-3 gap-3">
            {([
              ['twelve', 'Twelve Data', '5 分 K 優先'],
              ['finnhub', 'Finnhub', 'Quote / 5 分 K fallback'],
              ['massive', 'Massive', '日 K主源 / 分鐘 EOD fallback'],
            ] as const).map(([key, label, hint]) => (
              <label key={key} className="field-label">{label}<input type="password" className="field-input" value={keys[key]} onChange={e => setKeys(prev => ({ ...prev, [key]: e.target.value }))} placeholder={`${label} API Key`} /><span className="text-[10px] text-slate-600">{hint}</span></label>
            ))}
          </div>
        </div>

        <footer className="text-center text-[10px] text-slate-600 mt-6">
          Day Trading Mode 只提供決策輔助；實際成交、滑價、停損執行與券商資料應以你的交易平台為準。
        </footer>
      </div>
    </div>
  );
}
