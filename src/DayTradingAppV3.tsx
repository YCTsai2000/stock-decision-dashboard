import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Database,
  Gauge,
  Radio,
  RefreshCw,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  WalletCards,
  Wifi,
  WifiOff,
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
  type DayTradeDecisionInput,
  type IntradayFetchResult,
  type IntradayMetrics,
  type SessionPhase,
} from './intraday';
import {
  connectAlpacaIex,
  EMPTY_ALPACA_SNAPSHOT,
  type AlpacaCredentials,
  type AlpacaLiveSnapshot,
  type AlpacaStreamStatus,
} from './alpacaStream';
import { applyTradingProfile, getTradingProfile, WATCHLIST } from './tradingProfiles';

const EMPTY_KEYS: ApiKeys = { massive: '', finnhub: '', fmp: '', twelve: '', fred: '' };
const INTRADAY_REFRESH_MS = 180_000;
const QUOTE_REFRESH_MS = 30_000;
const LIVE_FRESH_SECONDS = 15;
const BENCHMARK_OPTIONS = ['QQQ', 'SOXX', 'IGV', 'XLK', 'XLY', 'XAR', 'SPY'];

type BenchmarkMode = 'AUTO' | string;

type RiskMonitorStatus = 'DISARMED' | 'INVALID_PLAN' | 'MARKET_CLOSED' | 'NO_LIVE_DATA' | 'STALE' | 'HEALTHY' | 'APPROACHING_STOP' | 'STOP_TRIGGERED' | 'TP1_TRIGGERED' | 'TP2_TRIGGERED';

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

interface RiskMonitorSettings {
  armed: boolean;
  side: 'LONG' | 'SHORT';
  entry: string;
  stop: string;
  tp1: string;
  tp2: string;
}

interface RiskEvents {
  stopHit: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
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

const DEFAULT_RISK_MONITOR: RiskMonitorSettings = {
  armed: false,
  side: 'LONG',
  entry: '',
  stop: '',
  tp1: '',
  tp2: '',
};

const EMPTY_ALPACA_CREDENTIALS: AlpacaCredentials = { keyId: '', secret: '' };

const loadKeys = (): ApiKeys => {
  try {
    const raw = localStorage.getItem('stockDecisionApiKeys');
    return raw ? { ...EMPTY_KEYS, ...(JSON.parse(raw) as Partial<ApiKeys>) } : EMPTY_KEYS;
  } catch { return EMPTY_KEYS; }
};

const loadSymbols = (): string[] => {
  try {
    const raw = localStorage.getItem('stockDecisionSymbols');
    const parsed = raw ? JSON.parse(raw) : [];
    const existing = Array.isArray(parsed) ? parsed.map(v => String(v).toUpperCase()) : [];
    return [...new Set([...WATCHLIST, ...existing])].slice(0, 20);
  } catch { return WATCHLIST; }
};

const loadSettings = (): DayTradeSettings => {
  try {
    const raw = localStorage.getItem('stockDecisionDayTradeSettings');
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DayTradeSettings>) } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
};

const loadRiskMonitor = (): RiskMonitorSettings => {
  try {
    const raw = localStorage.getItem('stockDecisionRiskMonitor');
    return raw ? { ...DEFAULT_RISK_MONITOR, ...(JSON.parse(raw) as Partial<RiskMonitorSettings>), armed: false } : DEFAULT_RISK_MONITOR;
  } catch { return DEFAULT_RISK_MONITOR; }
};

const loadAlpacaCredentials = (): AlpacaCredentials => {
  try {
    const raw = sessionStorage.getItem('stockDecisionAlpacaSession');
    return raw ? { ...EMPTY_ALPACA_CREDENTIALS, ...(JSON.parse(raw) as Partial<AlpacaCredentials>) } : EMPTY_ALPACA_CREDENTIALS;
  } catch { return EMPTY_ALPACA_CREDENTIALS; }
};

const numberOrNull = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const formatPrice = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `$${value.toFixed(2)}`;
const formatPct = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const phaseLabel = (phase: SessionPhase) => ({
  PREMARKET: '盤前', OPENING: '開盤 15 分鐘', PRIMARY: '主交易時段', MIDDAY: '午盤', SECONDARY: '午後', CLOSING: '尾盤', AFTER_HOURS: '盤後', CLOSED: '休市',
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
  return <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3"><div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div><div className={`font-mono font-bold mt-1 ${cls}`}>{value}</div>{hint ? <div className="text-[10px] text-slate-600 mt-1 leading-relaxed">{hint}</div> : null}</div>;
};

const SourceStatus = ({ result }: { result: IntradayFetchResult | null }) => {
  if (!result?.source) return <span className="text-xs text-rose-300">無 5 分 K 資料來源</span>;
  return <span title={result.source.note} className="inline-flex items-center gap-1 text-[11px] rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-300 px-2 py-1"><Database size={11} /> {result.source.provider} · {result.source.interval}</span>;
};

const streamTone = (status: AlpacaStreamStatus) => status === 'connected' ? 'text-emerald-300' : status === 'error' ? 'text-rose-300' : status === 'disabled' ? 'text-slate-500' : 'text-amber-300';

const riskStatusMeta = (status: RiskMonitorStatus) => {
  if (status === 'STOP_TRIGGERED') return { label: 'STOP TRIGGERED', cls: 'border-rose-500/50 bg-rose-500/15 text-rose-200' };
  if (status === 'TP2_TRIGGERED') return { label: 'TP2 TRIGGERED', cls: 'border-emerald-400/50 bg-emerald-400/15 text-emerald-200' };
  if (status === 'TP1_TRIGGERED') return { label: 'TP1 TRIGGERED', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' };
  if (status === 'APPROACHING_STOP') return { label: 'APPROACHING STOP', cls: 'border-amber-500/50 bg-amber-500/15 text-amber-200' };
  if (status === 'HEALTHY') return { label: 'POSITION HEALTHY', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' };
  if (status === 'DISARMED') return { label: 'MONITOR DISARMED', cls: 'border-slate-700 bg-slate-900 text-slate-400' };
  if (status === 'MARKET_CLOSED') return { label: 'REGULAR SESSION CLOSED', cls: 'border-slate-700 bg-slate-900 text-slate-400' };
  if (status === 'INVALID_PLAN') return { label: 'INVALID PLAN', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' };
  return { label: 'LIVE DATA UNAVAILABLE', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-300' };
};

export default function DayTradingAppV3() {
  const [keys, setKeys] = useState<ApiKeys>(loadKeys);
  const [symbols, setSymbols] = useState<string[]>(loadSymbols);
  const [activeSymbol, setActiveSymbol] = useState(() => loadSymbols()[0] ?? 'NVDA');
  const [newSymbol, setNewSymbol] = useState('');
  const [benchmarkMode, setBenchmarkMode] = useState<BenchmarkMode>('AUTO');
  const [settings, setSettings] = useState<DayTradeSettings>(loadSettings);
  const [riskMonitor, setRiskMonitor] = useState<RiskMonitorSettings>(loadRiskMonitor);
  const [riskEvents, setRiskEvents] = useState<RiskEvents>({ stopHit: false, tp1Hit: false, tp2Hit: false });
  const [alpacaCredentials, setAlpacaCredentials] = useState<AlpacaCredentials>(loadAlpacaCredentials);
  const [alpacaStatus, setAlpacaStatus] = useState<AlpacaStreamStatus>('disabled');
  const [alpacaStatusText, setAlpacaStatusText] = useState('尚未設定 Alpaca');
  const [alpacaLive, setAlpacaLive] = useState<AlpacaLiveSnapshot>({ ...EMPTY_ALPACA_SNAPSHOT });
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
  const [now, setNow] = useState(Date.now());

  const profile = useMemo(() => getTradingProfile(activeSymbol), [activeSymbol]);
  const effectiveBenchmark = benchmarkMode === 'AUTO' ? profile.benchmark : benchmarkMode;

  useEffect(() => { localStorage.setItem('stockDecisionApiKeys', JSON.stringify(keys)); }, [keys]);
  useEffect(() => { localStorage.setItem('stockDecisionSymbols', JSON.stringify(symbols)); }, [symbols]);
  useEffect(() => { localStorage.setItem('stockDecisionDayTradeSettings', JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem('stockDecisionRiskMonitor', JSON.stringify({ ...riskMonitor, armed: false })); }, [riskMonitor]);
  useEffect(() => { sessionStorage.setItem('stockDecisionAlpacaSession', JSON.stringify(alpacaCredentials)); }, [alpacaCredentials]);

  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); setNyClock(getNewYorkClock()); }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setAlpacaLive({ ...EMPTY_ALPACA_SNAPSHOT, symbol: activeSymbol });
    if (!alpacaCredentials.keyId.trim() || !alpacaCredentials.secret.trim()) {
      setAlpacaStatus('disabled');
      setAlpacaStatusText('請輸入 Alpaca Key ID / Secret');
      return;
    }
    return connectAlpacaIex({
      symbol: activeSymbol,
      credentials: alpacaCredentials,
      onStatus: (status, message) => { setAlpacaStatus(status); setAlpacaStatusText(message ?? status); },
      onSnapshot: snapshot => setAlpacaLive({ ...snapshot }),
    });
  }, [activeSymbol, alpacaCredentials.keyId, alpacaCredentials.secret]);

  const refresh = useCallback(async () => {
    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) {
      setError('請至少設定 Twelve Data、Massive 或 Finnhub 其中一組 Key，供 5 分 K Strategy Engine 使用。');
      return;
    }
    setLoading(true);
    setError('');
    const controller = new AbortController();
    try {
      const [intradayResult, benchmarkResult, dailyResult, spyResult, qqqResult, quoteResult] = await Promise.all([
        fetchIntradayData(activeSymbol, keys, controller.signal),
        fetchIntradayData(effectiveBenchmark, keys, controller.signal),
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
      if (!intradayResult.bars) setError(intradayResult.errors.join(' ｜ ') || '找不到可用的 5 分 K');
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失敗');
    } finally {
      setLoading(false);
    }
  }, [activeSymbol, effectiveBenchmark, keys]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), INTRADAY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!keys.finnhub.trim() && !keys.massive.trim()) return;
    const id = window.setInterval(async () => {
      try { setQuote(await fetchQuote(activeSymbol, keys)); } catch { /* optional quote fallback */ }
    }, QUOTE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeSymbol, keys]);

  const strategyMetrics = useMemo(() => computeIntradayMetrics(intraday?.bars ?? null, benchmarkIntraday?.bars ?? null), [intraday, benchmarkIntraday]);
  const marketRegime = useMemo(() => evaluateMarketRegime(spyDaily?.data ?? undefined, qqqDaily?.data ?? undefined), [spyDaily, qqqDaily]);
  const dailyBias = useMemo(() => getDailyBias(daily), [daily]);
  const manualBid = numberOrNull(settings.bid);
  const manualAsk = numberOrNull(settings.ask);
  const effectiveBid = alpacaLive.bid ?? manualBid;
  const effectiveAsk = alpacaLive.ask ?? manualAsk;

  const decisionInput = useMemo<DayTradeDecisionInput>(() => ({
    metrics: strategyMetrics,
    dailyBias,
    marketMode: marketRegime.mode,
    accountSizeUsd: settings.accountSizeUsd,
    riskPerTradePct: settings.riskPerTradePct,
    dailyMaxLossPct: settings.dailyMaxLossPct,
    realizedPnlUsd: settings.realizedPnlUsd,
    maxAllocationPct: settings.maxAllocationPct,
    bid: effectiveBid,
    ask: effectiveAsk,
    hasCatalyst: settings.hasCatalyst,
  }), [strategyMetrics, dailyBias, marketRegime.mode, settings, effectiveBid, effectiveAsk]);

  const decision = useMemo(() => {
    const base = buildDayTradeDecision(decisionInput);
    return applyTradingProfile(decisionInput, base, profile);
  }, [decisionInput, profile]);

  const livePhase = getSessionPhase(nyClock.minute, nyClock.weekday);
  const marketOpen = ['OPENING', 'PRIMARY', 'MIDDAY', 'SECONDARY', 'CLOSING'].includes(livePhase);
  const liveAgeSec = alpacaLive.receivedAt ? Math.max(0, (now - alpacaLive.receivedAt) / 1000) : null;
  const liveFresh = alpacaStatus === 'connected' && liveAgeSec !== null && liveAgeSec <= LIVE_FRESH_SECONDS;
  const displayLivePrice = alpacaLive.tradePrice ?? (alpacaLive.bid !== null && alpacaLive.ask !== null ? (alpacaLive.bid + alpacaLive.ask) / 2 : null) ?? quote?.price ?? strategyMetrics.currentPrice;

  const entry = numberOrNull(riskMonitor.entry);
  const stop = numberOrNull(riskMonitor.stop);
  const tp1 = numberOrNull(riskMonitor.tp1);
  const tp2 = numberOrNull(riskMonitor.tp2);
  const planValid = riskMonitor.side === 'LONG'
    ? entry !== null && stop !== null && tp1 !== null && tp2 !== null && stop < entry && tp1 > entry && tp2 >= tp1
    : entry !== null && stop !== null && tp1 !== null && tp2 !== null && stop > entry && tp1 < entry && tp2 <= tp1;
  const triggerPrice = riskMonitor.side === 'LONG' ? (alpacaLive.bid ?? alpacaLive.tradePrice) : (alpacaLive.ask ?? alpacaLive.tradePrice);
  const planRiskPerShare = planValid && entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  const rMultiple = planValid && triggerPrice !== null && entry !== null && planRiskPerShare !== null && planRiskPerShare > 0
    ? (riskMonitor.side === 'LONG' ? triggerPrice - entry : entry - triggerPrice) / planRiskPerShare
    : null;

  useEffect(() => {
    setRiskEvents({ stopHit: false, tp1Hit: false, tp2Hit: false });
  }, [activeSymbol, riskMonitor.side, riskMonitor.entry, riskMonitor.stop, riskMonitor.tp1, riskMonitor.tp2, riskMonitor.armed]);

  useEffect(() => {
    if (!riskMonitor.armed || !planValid || !liveFresh || !marketOpen || triggerPrice === null || stop === null || tp1 === null || tp2 === null) return;
    setRiskEvents(prev => ({
      stopHit: prev.stopHit || (riskMonitor.side === 'LONG' ? triggerPrice <= stop : triggerPrice >= stop),
      tp1Hit: prev.tp1Hit || (riskMonitor.side === 'LONG' ? triggerPrice >= tp1 : triggerPrice <= tp1),
      tp2Hit: prev.tp2Hit || (riskMonitor.side === 'LONG' ? triggerPrice >= tp2 : triggerPrice <= tp2),
    }));
  }, [riskMonitor.armed, riskMonitor.side, planValid, liveFresh, marketOpen, triggerPrice, stop, tp1, tp2]);

  const riskStatus: RiskMonitorStatus = useMemo(() => {
    if (!riskMonitor.armed) return 'DISARMED';
    if (!planValid) return 'INVALID_PLAN';
    if (!marketOpen) return 'MARKET_CLOSED';
    if (alpacaStatus !== 'connected' || triggerPrice === null) return 'NO_LIVE_DATA';
    if (!liveFresh) return 'STALE';
    if (riskEvents.stopHit) return 'STOP_TRIGGERED';
    if (riskEvents.tp2Hit) return 'TP2_TRIGGERED';
    if (riskEvents.tp1Hit) return 'TP1_TRIGGERED';
    if (rMultiple !== null && rMultiple <= -0.75) return 'APPROACHING_STOP';
    return 'HEALTHY';
  }, [riskMonitor.armed, planValid, marketOpen, alpacaStatus, triggerPrice, liveFresh, riskEvents, rMultiple]);

  const riskMeta = riskStatusMeta(riskStatus);

  const applyStrategyPlan = () => {
    if (decision.direction === 'WAIT' || decision.entry === null || decision.stop === null || decision.target1 === null || decision.target2 === null) return;
    setRiskMonitor({ armed: false, side: decision.direction, entry: decision.entry.toFixed(2), stop: decision.stop.toFixed(2), tp1: decision.target1.toFixed(2), tp2: decision.target2.toFixed(2) });
  };

  const addSymbol = () => {
    const upper = newSymbol.trim().toUpperCase();
    if (!upper) return;
    setSymbols(prev => [...new Set([...prev, upper])].slice(0, 20));
    setActiveSymbol(upper);
    setNewSymbol('');
    setRiskMonitor(prev => ({ ...prev, armed: false }));
  };

  const signalClass = decision.direction === 'LONG'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : decision.direction === 'SHORT'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      : decision.hardBlock
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-slate-700 bg-slate-800/70 text-slate-300';

  return <div className="min-h-screen bg-slate-950 text-slate-200 pt-14 pb-16">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <header className="mb-5 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div><div className="flex items-center gap-2 text-cyan-400 text-sm font-bold mb-1"><Zap size={16} /> DAY TRADING V3 · ADAPTIVE</div><h1 className="text-2xl md:text-3xl font-black text-white">5min Strategy + Sector RS + Real-time Risk</h1><p className="text-xs text-slate-500 mt-2 max-w-3xl">股票會自動套用產業 Benchmark 與交易 Profile；5 分 K 產生 setup，Alpaca IEX WebSocket 獨立負責即時 Stop / TP 監控。</p></div>
        <div className="flex items-center gap-2 text-xs"><div className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2"><div className="text-slate-500">New York</div><div className="font-mono text-white">{nyClock.date} {nyClock.time}</div></div><div className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2"><div className="text-slate-500">Session</div><div className={marketOpen ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>{phaseLabel(livePhase)}</div></div></div>
      </header>

      <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 mb-4">
        <div className="flex flex-col xl:flex-row gap-3 xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">{symbols.map(symbol => <button key={symbol} onClick={() => { setActiveSymbol(symbol); setRiskMonitor(prev => ({ ...prev, armed: false })); }} className={`px-3 py-2 rounded-lg border text-xs font-bold ${activeSymbol === symbol ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-white'}`}>{symbol}</button>)}</div>
          <div className="flex flex-wrap items-center gap-2"><input value={newSymbol} onChange={e => setNewSymbol(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') addSymbol(); }} placeholder="新增股票" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs w-28" /><button onClick={addSymbol} className="border border-slate-700 rounded-lg px-3 py-2 text-xs">加入</button><select value={benchmarkMode} onChange={e => setBenchmarkMode(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs"><option value="AUTO">AUTO: {profile.benchmark}</option>{BENCHMARK_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}</select><button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 rounded-lg px-3 py-2 text-xs disabled:opacity-50"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 更新</button></div>
        </div>
        <div className="mt-3 grid md:grid-cols-4 gap-2"><Metric label="Trading Profile" value={profile.label} hint={profile.note} /><Metric label="Primary Benchmark" value={effectiveBenchmark} hint={`Secondary: ${profile.secondaryBenchmark}`} /><Metric label="Min RVOL" value={`${profile.minRvol.toFixed(1)}x`} hint={`A+: ${profile.highConvictionRvol.toFixed(1)}x`} /><Metric label="Risk Geometry" value={`${profile.minStopAtr.toFixed(2)} ATR`} hint={`TP1 ${profile.target1R}R · TP2 ${profile.target2R}R`} /></div>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-[10px] text-slate-500"><SourceStatus result={intraday} /><span className={`inline-flex items-center gap-1 ${streamTone(alpacaStatus)}`}>{alpacaStatus === 'connected' ? <Wifi size={11} /> : <WifiOff size={11} />} {alpacaStatusText}</span><span>Profile: {profile.experimental ? 'Experimental' : 'Adaptive'} · Strategy 每 3 分鐘輪詢</span>{lastRefresh ? <span>更新：{new Date(lastRefresh).toLocaleTimeString('zh-TW')}</span> : null}</div>
        {error ? <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs p-3">{error}</div> : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className={`lg:col-span-2 rounded-2xl border p-5 ${signalClass}`}><div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4"><div><div className="text-xs opacity-70 mb-1">{activeSymbol} · {profile.family} · RS vs {effectiveBenchmark} · Daily {dailyBias} · Market {marketRegime.mode}</div><div className="flex items-center gap-2">{decision.direction === 'LONG' ? <TrendingUp size={24} /> : decision.direction === 'SHORT' ? <TrendingDown size={24} /> : <Activity size={24} />}<div className="text-2xl font-black">{decision.label}</div></div><div className="text-xs mt-2 opacity-80">{decision.reason}</div></div><div className="grid grid-cols-2 gap-2 min-w-[220px]"><div className="bg-slate-950/40 rounded-xl p-3 text-center"><div className="text-[10px] opacity-60">LONG</div><div className="text-2xl font-black text-emerald-300">{decision.longScore}</div></div><div className="bg-slate-950/40 rounded-xl p-3 text-center"><div className="text-[10px] opacity-60">SHORT</div><div className="text-2xl font-black text-rose-300">{decision.shortScore}</div></div></div></div></div>
        <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-5"><div className="flex items-center gap-2 text-cyan-300 text-sm font-bold"><Radio size={16} /> Alpaca IEX Live</div><div className="text-3xl font-black font-mono text-white mt-2">{formatPrice(displayLivePrice)}</div><div className="grid grid-cols-2 gap-2 mt-3"><Metric label="IEX Bid" value={formatPrice(alpacaLive.bid)} /><Metric label="IEX Ask" value={formatPrice(alpacaLive.ask)} /></div><div className={`text-[10px] mt-3 ${liveFresh ? 'text-emerald-300' : 'text-amber-300'}`}>{alpacaLive.receivedAt ? `最後推送 ${liveAgeSec?.toFixed(1)} 秒前` : '尚未收到 IEX trade/quote'} · IEX ≠ SIP/NBBO</div></div>
      </div>

      <div className={`rounded-2xl border p-5 mb-4 ${riskMeta.cls}`}><div className="flex flex-col xl:flex-row gap-5 xl:items-start xl:justify-between"><div className="min-w-[240px]"><div className="flex items-center gap-2 text-xs font-bold opacity-80"><ShieldAlert size={16} /> REAL-TIME RISK MONITOR</div><div className="text-2xl font-black mt-2">{riskMeta.label}</div><div className="text-xs opacity-75 mt-2">LONG 用 IEX Bid；SHORT 用 IEX Ask 監控觸發，不等待下一根 5 分 K。</div><div className="grid grid-cols-2 gap-2 mt-3"><Metric label="Trigger Price" value={formatPrice(triggerPrice)} /><Metric label="Live R" value={rMultiple === null ? '—' : `${rMultiple >= 0 ? '+' : ''}${rMultiple.toFixed(2)}R`} tone={rMultiple !== null && rMultiple >= 0 ? 'good' : rMultiple !== null && rMultiple <= -0.75 ? 'bad' : 'normal'} /></div></div><div className="flex-1 grid grid-cols-2 md:grid-cols-5 gap-2"><label className="field-label">方向<select className="field-input" value={riskMonitor.side} onChange={e => setRiskMonitor(prev => ({ ...prev, armed: false, side: e.target.value as 'LONG' | 'SHORT' }))}><option>LONG</option><option>SHORT</option></select></label><label className="field-label">Entry<input className="field-input" value={riskMonitor.entry} onChange={e => setRiskMonitor(prev => ({ ...prev, entry: e.target.value }))} /></label><label className="field-label">Stop<input className="field-input" value={riskMonitor.stop} onChange={e => setRiskMonitor(prev => ({ ...prev, stop: e.target.value }))} /></label><label className="field-label">TP1<input className="field-input" value={riskMonitor.tp1} onChange={e => setRiskMonitor(prev => ({ ...prev, tp1: e.target.value }))} /></label><label className="field-label">TP2<input className="field-input" value={riskMonitor.tp2} onChange={e => setRiskMonitor(prev => ({ ...prev, tp2: e.target.value }))} /></label><div className="col-span-2 md:col-span-5 flex flex-wrap gap-2 mt-1"><button onClick={applyStrategyPlan} disabled={decision.direction === 'WAIT'} className="rounded-lg border border-cyan-500/40 px-3 py-2 text-xs text-cyan-300 disabled:opacity-40">套用策略計畫</button><button onClick={() => setRiskMonitor(prev => ({ ...prev, armed: !prev.armed }))} className={`rounded-lg border px-4 py-2 text-xs font-bold ${riskMonitor.armed ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>{riskMonitor.armed ? '停止即時監控' : 'ARM 即時監控'}</button></div></div></div></div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <div className="xl:col-span-2 bg-slate-900/60 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 mb-3"><BarChart3 size={18} className="text-cyan-400" /><h2 className="font-bold">Adaptive Strategy Metrics</h2></div><div className="grid grid-cols-2 md:grid-cols-4 gap-2"><Metric label="5m Price" value={formatPrice(strategyMetrics.currentPrice)} /><Metric label="VWAP" value={formatPrice(strategyMetrics.vwap)} hint={strategyMetrics.vwapSlopeUp === null ? 'Slope —' : strategyMetrics.vwapSlopeUp ? 'Slope ↑' : 'Slope ↓'} /><Metric label="OR15 H / L" value={`${formatPrice(strategyMetrics.orHigh)} / ${formatPrice(strategyMetrics.orLow)}`} /><Metric label="RVOL" value={strategyMetrics.rvol === null ? '—' : `${strategyMetrics.rvol.toFixed(2)}x`} tone={(strategyMetrics.rvol ?? 0) >= profile.highConvictionRvol ? 'good' : (strategyMetrics.rvol ?? 0) >= profile.minRvol ? 'warn' : 'normal'} /><Metric label={`RS vs ${effectiveBenchmark}`} value={formatPct(strategyMetrics.relativeStrengthPct)} /><Metric label="5m ATR(14)" value={formatPrice(strategyMetrics.intradayAtr)} /><Metric label={`${effectiveBenchmark} vs VWAP`} value={strategyMetrics.benchmarkAboveVwap === null ? '—' : strategyMetrics.benchmarkAboveVwap ? 'Above' : 'Below'} /><Metric label="Gap" value={formatPct(strategyMetrics.gapPct)} /></div></div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 mb-3"><Target size={18} className="text-emerald-400" /><h2 className="font-bold">Adaptive Plan</h2></div><div className="space-y-2"><Metric label="Entry" value={formatPrice(decision.entry)} /><Metric label={`Stop · ≥${profile.minStopAtr.toFixed(2)} ATR`} value={formatPrice(decision.stop)} tone={decision.stop !== null ? 'bad' : 'normal'} /><div className="grid grid-cols-2 gap-2"><Metric label={`TP1 · ${profile.target1R}R`} value={formatPrice(decision.target1)} tone="good" /><Metric label={`TP2 · ${profile.target2R}R`} value={formatPrice(decision.target2)} tone="good" /></div><Metric label="Suggested shares" value={decision.suggestedShares > 0 ? `${decision.suggestedShares} 股` : '0'} hint={`預估風險 $${decision.suggestedRiskUsd.toFixed(0)}`} /></div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 mb-4"><WalletCards size={18} className="text-violet-400" /><h2 className="font-bold">每日風控</h2></div><div className="grid grid-cols-2 md:grid-cols-3 gap-3"><label className="field-label">帳戶資金 USD<input className="field-input" type="number" value={settings.accountSizeUsd} onChange={e => setSettings(s => ({ ...s, accountSizeUsd: Number(e.target.value) || 0 }))} /></label><label className="field-label">單筆風險 %<input className="field-input" type="number" step="0.1" value={settings.riskPerTradePct} onChange={e => setSettings(s => ({ ...s, riskPerTradePct: Number(e.target.value) || 0 }))} /></label><label className="field-label">每日最大虧損 %<input className="field-input" type="number" step="0.1" value={settings.dailyMaxLossPct} onChange={e => setSettings(s => ({ ...s, dailyMaxLossPct: Number(e.target.value) || 0 }))} /></label><label className="field-label">今日已實現 P/L<input className="field-input" type="number" value={settings.realizedPnlUsd} onChange={e => setSettings(s => ({ ...s, realizedPnlUsd: Number(e.target.value) || 0 }))} /></label><label className="field-label">最大資金 %<input className="field-input" type="number" value={settings.maxAllocationPct} onChange={e => setSettings(s => ({ ...s, maxAllocationPct: Number(e.target.value) || 0 }))} /></label><label className="field-label">Catalyst<label className="h-[38px] bg-slate-950 border border-slate-700 rounded-lg px-3 flex items-center gap-2"><input type="checkbox" checked={settings.hasCatalyst} onChange={e => setSettings(s => ({ ...s, hasCatalyst: e.target.checked }))} /><span className="text-xs">有消息催化</span></label></label></div></div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4"><div className="flex items-center gap-2 mb-4"><Gauge size={18} className="text-amber-400" /><h2 className="font-bold">即時流動性</h2></div><div className="grid grid-cols-2 gap-2"><Metric label="IEX Bid / Ask" value={`${formatPrice(alpacaLive.bid)} / ${formatPrice(alpacaLive.ask)}`} /><Metric label="Spread" value={decision.spreadPct === null ? '—' : `${decision.spreadPct.toFixed(3)}%`} tone={(decision.spreadPct ?? 0) > 0.5 ? 'bad' : 'normal'} /></div><div className="grid grid-cols-2 gap-3 mt-3"><label className="field-label">Fallback Bid<input className="field-input" value={settings.bid} onChange={e => setSettings(s => ({ ...s, bid: e.target.value }))} /></label><label className="field-label">Fallback Ask<input className="field-input" value={settings.ask} onChange={e => setSettings(s => ({ ...s, ask: e.target.value }))} /></label></div></div>
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-4"><div className="flex items-center gap-2 mb-3"><Database size={15} className="text-sky-400" /><h2 className="font-bold">API / WebSocket 設定</h2></div><div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">{([['twelve', 'Twelve Data'], ['finnhub', 'Finnhub'], ['massive', 'Massive'], ['fmp', 'FMP'], ['fred', 'FRED']] as const).map(([key, label]) => <label key={key} className="field-label">{label}<input type="password" className="field-input" value={keys[key]} onChange={e => setKeys(prev => ({ ...prev, [key]: e.target.value }))} placeholder={`${label} API Key`} /></label>)}<label className="field-label">Alpaca Key ID<input type="password" className="field-input" value={alpacaCredentials.keyId} onChange={e => setAlpacaCredentials(prev => ({ ...prev, keyId: e.target.value }))} /></label><label className="field-label">Alpaca Secret<input type="password" className="field-input" value={alpacaCredentials.secret} onChange={e => setAlpacaCredentials(prev => ({ ...prev, secret: e.target.value }))} /></label></div><div className="mt-3 text-[10px] text-slate-500">最低當沖組合：Twelve Data + Alpaca。Finnhub / Massive / FMP / FRED 用於 quote、fallback、基本面與總經補強。Alpaca 憑證只存 sessionStorage。</div></div>

      <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 text-xs text-amber-200/80 leading-relaxed"><div className="flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" /><div><strong>重要：</strong>Adaptive Profile 是交易輔助，不是自動下單。5 分 K 決定 setup；Stop/TP 用 Alpaca IEX WebSocket 即時監控。真正 Hard Stop 若券商支援，仍應直接掛在券商端。SPCX profile 因歷史較短標示為 Experimental。</div></div></div>
    </div>
  </div>;
}
