import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Database, Radio, RefreshCw, ShieldAlert, Target, TrendingDown, TrendingUp, Wifi, WifiOff, Zap } from 'lucide-react';
import type { ApiKeys, HistoricalDataResult } from './types';
import { calculateMA, evaluateMarketRegime } from './analysis';
import { fetchHistoricalData } from './dataLayer';
import { buildDayTradeDecision, computeIntradayMetrics, fetchIntradayData, getNewYorkClock, getSessionPhase, type DayTradeDecisionInput, type IntradayFetchResult, type SessionPhase } from './intraday';
import { connectAlpacaIexMulti, EMPTY_ALPACA_SNAPSHOT, type AlpacaCredentials, type AlpacaLiveSnapshot, type AlpacaStreamStatus } from './alpacaStream';
import { applyTradingProfile, getTradingProfile, WATCHLIST } from './tradingProfiles';
import { getAllExecutionTickers, getExecutionForDirection, getTradingInstrument, type LeveragedExecution } from './tradingInstruments';
import WatchlistRanker from './WatchlistRanker';

const EMPTY_KEYS: ApiKeys = { massive: '', finnhub: '', fmp: '', twelve: '', fred: '' };
const REFRESH_MS = 180_000;
const LIVE_FRESH_SECONDS = 15;
const BENCHMARKS = ['QQQ', 'SOXX', 'IGV', 'XLK', 'XLY', 'XAR', 'SPY'];

type Bias = 'LONG' | 'SHORT' | 'NEUTRAL';
type RiskState = 'DISARMED' | 'HEALTHY' | 'APPROACHING_STOP' | 'STOP' | 'TP1' | 'TP2' | 'NO_DATA' | 'CLOSED';

const loadKeys = (): ApiKeys => { try { const raw = localStorage.getItem('stockDecisionApiKeys'); return raw ? { ...EMPTY_KEYS, ...JSON.parse(raw) } : EMPTY_KEYS; } catch { return EMPTY_KEYS; } };
const loadAlpaca = (): AlpacaCredentials => { try { const raw = sessionStorage.getItem('stockDecisionAlpacaSession'); return raw ? JSON.parse(raw) : { keyId: '', secret: '' }; } catch { return { keyId: '', secret: '' }; } };
const fmt = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`;
const pct = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const phaseLabel = (phase: SessionPhase) => ({ PREMARKET: '盤前', OPENING: '開盤15m', PRIMARY: '主時段', MIDDAY: '午盤', SECONDARY: '午後', CLOSING: '尾盤', AFTER_HOURS: '盤後', CLOSED: '休市' }[phase]);

const dailyBias = (result: HistoricalDataResult | null): Bias => {
  const data = result?.data;
  if (!data || data.length < 60) return 'NEUTRAL';
  const ma20 = calculateMA(data, 20), ma60 = calculateMA(data, 60), close = data.at(-1)?.price;
  if (ma20 == null || ma60 == null || close == null) return 'NEUTRAL';
  if (close > ma20 && ma20 > ma60) return 'LONG';
  if (close < ma20 && ma20 < ma60) return 'SHORT';
  return 'NEUTRAL';
};

const Metric = ({ label, value, hint, tone = 'normal' }: { label: string; value: string; hint?: string; tone?: 'normal' | 'good' | 'bad' | 'warn' }) => {
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-300' : 'text-slate-100';
  return <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"><div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div><div className={`mt-1 font-mono font-bold ${cls}`}>{value}</div>{hint ? <div className="mt-1 text-[10px] leading-relaxed text-slate-600">{hint}</div> : null}</div>;
};

const ExecutionCard = ({ title, candidate, live, selected }: { title: string; candidate: LeveragedExecution | null; live: AlpacaLiveSnapshot; selected: boolean }) => {
  const spread = live.bid && live.ask && live.ask > live.bid ? ((live.ask - live.bid) / ((live.ask + live.bid) / 2)) * 100 : null;
  return <div className={`rounded-xl border p-3 ${selected ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/60'}`}>
    <div className="text-[10px] uppercase text-slate-500">{title}</div>
    <div className="mt-1 flex items-center justify-between"><div className="text-xl font-black text-white">{candidate?.ticker ?? '無'}</div><div className="text-[10px] text-slate-500">{candidate ? `${candidate.leverage > 0 ? '+' : ''}${candidate.leverage}x · ${candidate.liquidityTier}` : ''}</div></div>
    {candidate ? <><div className="mt-2 grid grid-cols-2 gap-2 text-xs"><span>Bid {fmt(live.bid)}</span><span>Ask {fmt(live.ask)}</span></div><div className="mt-1 text-[10px] text-slate-500">Spread {spread == null ? '—' : `${spread.toFixed(3)}%`} · baseline vol {candidate.baselineVolume ? candidate.baselineVolume.toLocaleString() : '需即時確認'}</div></> : <div className="mt-2 text-[10px] text-amber-300">目前無已驗證的單股反向槓桿 ETF；該方向不使用槓桿 ETF。</div>}
  </div>;
};

export default function DayTradingAppV4() {
  const [keys, setKeys] = useState<ApiKeys>(loadKeys);
  const [alpaca, setAlpaca] = useState<AlpacaCredentials>(loadAlpaca);
  const [active, setActive] = useState('NVDA');
  const [benchmarkMode, setBenchmarkMode] = useState('AUTO');
  const [intraday, setIntraday] = useState<IntradayFetchResult | null>(null);
  const [benchmarkData, setBenchmarkData] = useState<IntradayFetchResult | null>(null);
  const [daily, setDaily] = useState<HistoricalDataResult | null>(null);
  const [spy, setSpy] = useState<HistoricalDataResult | null>(null);
  const [qqq, setQqq] = useState<HistoricalDataResult | null>(null);
  const [live, setLive] = useState<Record<string, AlpacaLiveSnapshot>>({});
  const [streamStatus, setStreamStatus] = useState<AlpacaStreamStatus>('disabled');
  const [streamText, setStreamText] = useState('尚未設定 Alpaca');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(getNewYorkClock());
  const [now, setNow] = useState(Date.now());
  const [armed, setArmed] = useState(false);
  const [hit, setHit] = useState({ stop: false, tp1: false, tp2: false });
  const [account, setAccount] = useState(15_000);
  const [riskPct, setRiskPct] = useState(0.5);
  const [maxAlloc, setMaxAlloc] = useState(25);

  const profile = useMemo(() => getTradingProfile(active), [active]);
  const instrument = useMemo(() => getTradingInstrument(active), [active]);
  const benchmark = benchmarkMode === 'AUTO' ? profile.benchmark : benchmarkMode;
  const bullLive = live[instrument.longExecution?.ticker ?? ''] ?? { ...EMPTY_ALPACA_SNAPSHOT };
  const bearLive = live[instrument.shortExecution?.ticker ?? ''] ?? { ...EMPTY_ALPACA_SNAPSHOT };
  const underlyingLive = live[active] ?? { ...EMPTY_ALPACA_SNAPSHOT, symbol: active };

  useEffect(() => { localStorage.setItem('stockDecisionApiKeys', JSON.stringify(keys)); }, [keys]);
  useEffect(() => { sessionStorage.setItem('stockDecisionAlpacaSession', JSON.stringify(alpaca)); }, [alpaca]);
  useEffect(() => { const id = window.setInterval(() => { setClock(getNewYorkClock()); setNow(Date.now()); }, 1000); return () => window.clearInterval(id); }, []);

  useEffect(() => {
    setLive({}); setArmed(false); setHit({ stop: false, tp1: false, tp2: false });
    if (!alpaca.keyId.trim() || !alpaca.secret.trim()) { setStreamStatus('disabled'); setStreamText('請輸入 Alpaca Key ID / Secret'); return; }
    return connectAlpacaIexMulti({
      symbols: [active, ...getAllExecutionTickers(active)], credentials: alpaca,
      onStatus: (s, msg) => { setStreamStatus(s); setStreamText(msg ?? s); },
      onSnapshot: s => setLive(prev => ({ ...prev, [s.symbol]: { ...s } })),
    });
  }, [active, alpaca.keyId, alpaca.secret]);

  const refresh = useCallback(async () => {
    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) { setError('請至少設定 Twelve Data、Massive 或 Finnhub 一組 Key。'); return; }
    setLoading(true); setError('');
    try {
      const [i, b, d, s, q] = await Promise.all([
        fetchIntradayData(active, keys), fetchIntradayData(benchmark, keys), fetchHistoricalData(active, keys), fetchHistoricalData('SPY', keys), fetchHistoricalData('QQQ', keys),
      ]);
      setIntraday(i); setBenchmarkData(b); setDaily(d); setSpy(s); setQqq(q);
      if (!i.bars) setError(i.errors.join(' ｜ ') || '無可用 5 分 K');
    } catch (e) { setError(e instanceof Error ? e.message : '更新失敗'); }
    finally { setLoading(false); }
  }, [active, benchmark, keys]);

  useEffect(() => { void refresh(); const id = window.setInterval(() => void refresh(), REFRESH_MS); return () => window.clearInterval(id); }, [refresh]);

  const metrics = useMemo(() => computeIntradayMetrics(intraday?.bars ?? null, benchmarkData?.bars ?? null), [intraday, benchmarkData]);
  const market = useMemo(() => evaluateMarketRegime(spy?.data ?? undefined, qqq?.data ?? undefined), [spy, qqq]);
  const bias = useMemo(() => dailyBias(daily), [daily]);
  const decisionInput = useMemo<DayTradeDecisionInput>(() => ({ metrics, dailyBias: bias, marketMode: market.mode, accountSizeUsd: account, riskPerTradePct: riskPct, dailyMaxLossPct: 1.5, realizedPnlUsd: 0, maxAllocationPct: maxAlloc, bid: null, ask: null, hasCatalyst: false }), [metrics, bias, market.mode, account, riskPct, maxAlloc]);
  const decision = useMemo(() => applyTradingProfile(decisionInput, buildDayTradeDecision(decisionInput), profile), [decisionInput, profile]);
  const execution = getExecutionForDirection(active, decision.direction);
  const executionLive = execution?.side === 'LONG' ? bullLive : execution?.side === 'SHORT' ? bearLive : { ...EMPTY_ALPACA_SNAPSHOT };
  const executionPrice = executionLive.tradePrice ?? (executionLive.bid && executionLive.ask ? (executionLive.bid + executionLive.ask) / 2 : null);
  const executionSpread = executionLive.bid && executionLive.ask && executionLive.ask > executionLive.bid ? ((executionLive.ask - executionLive.bid) / ((executionLive.bid + executionLive.ask) / 2)) * 100 : null;
  const executionAllowed = execution !== null && execution.liquidityTier !== 'POOR' && (executionSpread === null || executionSpread <= 0.5);

  const stopPct = decision.entry && decision.stop ? Math.abs(decision.entry - decision.stop) / decision.entry : null;
  const etfRiskPerShare = executionPrice && stopPct && execution ? executionPrice * stopPct * Math.abs(execution.leverage) : null;
  const sharesRisk = etfRiskPerShare ? Math.floor((account * riskPct / 100) / etfRiskPerShare) : 0;
  const sharesAlloc = executionPrice ? Math.floor((account * maxAlloc / 100) / executionPrice) : 0;
  const shares = executionAllowed ? Math.max(0, Math.min(sharesRisk, sharesAlloc)) : 0;

  const phase = getSessionPhase(clock.minute, clock.weekday);
  const marketOpen = ['OPENING', 'PRIMARY', 'MIDDAY', 'SECONDARY', 'CLOSING'].includes(phase);
  const age = underlyingLive.receivedAt ? (now - underlyingLive.receivedAt) / 1000 : null;
  const fresh = streamStatus === 'connected' && age !== null && age <= LIVE_FRESH_SECONDS;
  const trigger = decision.direction === 'SHORT' ? (underlyingLive.ask ?? underlyingLive.tradePrice) : (underlyingLive.bid ?? underlyingLive.tradePrice);

  useEffect(() => { setArmed(false); setHit({ stop: false, tp1: false, tp2: false }); }, [active, decision.direction, decision.stop, decision.target1, decision.target2]);
  useEffect(() => {
    if (!armed || !fresh || !marketOpen || !trigger || decision.direction === 'WAIT' || !decision.stop || !decision.target1 || !decision.target2) return;
    setHit(prev => ({
      stop: prev.stop || (decision.direction === 'LONG' ? trigger <= decision.stop! : trigger >= decision.stop!),
      tp1: prev.tp1 || (decision.direction === 'LONG' ? trigger >= decision.target1! : trigger <= decision.target1!),
      tp2: prev.tp2 || (decision.direction === 'LONG' ? trigger >= decision.target2! : trigger <= decision.target2!),
    }));
  }, [armed, fresh, marketOpen, trigger, decision.direction, decision.stop, decision.target1, decision.target2]);

  const riskState: RiskState = !armed ? 'DISARMED' : !marketOpen ? 'CLOSED' : !fresh ? 'NO_DATA' : hit.stop ? 'STOP' : hit.tp2 ? 'TP2' : hit.tp1 ? 'TP1' : decision.entry && decision.stop && trigger ? ((decision.direction === 'LONG' ? (trigger - decision.entry) : (decision.entry - trigger)) / Math.abs(decision.entry - decision.stop) <= -0.75 ? 'APPROACHING_STOP' : 'HEALTHY') : 'NO_DATA';
  const riskTone = riskState === 'STOP' ? 'border-rose-500/50 bg-rose-500/15 text-rose-200' : riskState === 'TP1' || riskState === 'TP2' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : riskState === 'APPROACHING_STOP' ? 'border-amber-500/50 bg-amber-500/10 text-amber-200' : 'border-slate-700 bg-slate-900 text-slate-300';

  const signalLabel = decision.direction === 'LONG' ? `偏多 → BUY ${execution?.ticker ?? '無槓桿ETF'}` : decision.direction === 'SHORT' ? `偏空 → BUY ${execution?.ticker ?? '無反向ETF'}` : 'WAIT';

  return <div className="min-h-screen bg-slate-950 text-slate-200 pt-14 pb-16"><div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
    <header className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><div className="mb-1 flex items-center gap-2 text-sm font-bold text-cyan-400"><Zap size={16}/> DAY TRADING V4 · DIRECTION + RANK</div><h1 className="text-2xl font-black text-white md:text-3xl">Underlying Signal → Bull/Bear ETF Execution</h1><p className="mt-2 max-w-4xl text-xs text-slate-500">方向由原型股決定；偏多買多方槓桿 ETF，偏空買反向槓桿 ETF。技術 Stop/TP 始終由原型股即時價觸發。</p></div><div className="flex gap-2 text-xs"><Metric label="New York" value={`${clock.date} ${clock.time}`} /><Metric label="Session" value={phaseLabel(phase)} /></div></header>

    <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className="flex flex-wrap gap-2">{WATCHLIST.map(s => <button key={s} onClick={() => setActive(s)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${active === s ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-slate-700 bg-slate-950 text-slate-400'}`}>{s}</button>)}</div><div className="mt-3 flex flex-wrap items-center gap-2"><select value={benchmarkMode} onChange={e => setBenchmarkMode(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"><option value="AUTO">AUTO: {profile.benchmark}</option>{BENCHMARKS.map(b => <option key={b}>{b}</option>)}</select><button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-300"><RefreshCw size={13} className={loading ? 'animate-spin' : ''}/>更新</button><span className="text-[10px] text-slate-500">{streamStatus === 'connected' ? <Wifi size={11} className="inline"/> : <WifiOff size={11} className="inline"/>} {streamText}</span></div>{error ? <div className="mt-3 text-xs text-rose-300">{error}</div> : null}</div>

    <WatchlistRanker keys={keys} marketMode={market.mode} onSelect={setActive} />

    <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3"><div className={`rounded-2xl border p-5 lg:col-span-2 ${decision.direction === 'LONG' ? 'border-emerald-500/40 bg-emerald-500/10' : decision.direction === 'SHORT' ? 'border-rose-500/40 bg-rose-500/10' : 'border-slate-800 bg-slate-900/60'}`}><div className="text-xs text-slate-500">{active} · {profile.label} · RS vs {benchmark} · Daily {bias} · Market {market.mode}</div><div className="mt-2 flex items-center gap-2">{decision.direction === 'LONG' ? <TrendingUp/> : decision.direction === 'SHORT' ? <TrendingDown/> : <Activity/>}<div className="text-2xl font-black">{signalLabel}</div></div><p className="mt-2 text-xs text-slate-400">{decision.reason}</p><div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label="LONG score" value={String(decision.longScore)} /><Metric label="SHORT score" value={String(decision.shortScore)} /><Metric label="RVOL" value={metrics.rvol == null ? '—' : `${metrics.rvol.toFixed(2)}x`} /><Metric label={`RS vs ${benchmark}`} value={pct(metrics.relativeStrengthPct)} /></div></div><div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex items-center gap-2 text-sm font-bold"><Radio size={15}/> 原型股 Live</div><div className="mt-2 text-3xl font-black">{fmt(underlyingLive.tradePrice ?? metrics.currentPrice)}</div><div className="mt-3 grid grid-cols-2 gap-2"><Metric label="Bid" value={fmt(underlyingLive.bid)} /><Metric label="Ask" value={fmt(underlyingLive.ask)} /></div><div className={`mt-2 text-[10px] ${fresh ? 'text-emerald-300' : 'text-amber-300'}`}>{age == null ? '尚未收到 tick' : `${age.toFixed(1)} 秒前`}</div></div></div>

    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2"><ExecutionCard title="多方執行 ETF" candidate={instrument.longExecution} live={bullLive} selected={decision.direction === 'LONG'} /><ExecutionCard title="空方 / 反向執行 ETF" candidate={instrument.shortExecution} live={bearLive} selected={decision.direction === 'SHORT'} /></div>

    <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3"><div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 xl:col-span-2"><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label="VWAP" value={fmt(metrics.vwap)} hint={metrics.vwapSlopeUp == null ? '—' : metrics.vwapSlopeUp ? 'slope ↑' : 'slope ↓'} /><Metric label="OR15 H/L" value={`${fmt(metrics.orHigh)} / ${fmt(metrics.orLow)}`} /><Metric label={`${benchmark} vs VWAP`} value={metrics.benchmarkAboveVwap == null ? '—' : metrics.benchmarkAboveVwap ? 'Above' : 'Below'} /><Metric label="5m ATR" value={fmt(metrics.intradayAtr)} /></div></div><div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex items-center gap-2 font-bold"><Target size={16}/> Execution Plan</div><div className="mt-3 grid grid-cols-2 gap-2"><Metric label="Underlying Entry" value={fmt(decision.entry)} /><Metric label="Underlying Stop" value={fmt(decision.stop)} tone="bad" /><Metric label={`TP1 ${profile.target1R}R`} value={fmt(decision.target1)} tone="good" /><Metric label={`TP2 ${profile.target2R}R`} value={fmt(decision.target2)} tone="good" /></div><div className="mt-2"><Metric label="ETF 建議股數" value={executionAllowed && shares ? `${shares} 股 ${execution?.ticker ?? ''}` : '0 / AVOID'} hint={execution ? `ETF risk/share ≈ ${etfRiskPerShare ? `$${etfRiskPerShare.toFixed(2)}` : '—'} · ${execution.liquidityTier}` : '沒有該方向的已驗證槓桿 ETF'} /></div></div></div>

    <div className={`mb-4 rounded-2xl border p-4 ${riskTone}`}><div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2 text-xs font-bold"><ShieldAlert size={15}/> REAL-TIME UNDERLYING RISK</div><div className="mt-1 text-xl font-black">{riskState}</div><div className="mt-1 text-[10px] opacity-70">ARM 後以 {decision.direction === 'SHORT' ? '原型股 Ask' : '原型股 Bid'} 觸發技術 Stop/TP；不是用 2x ETF 價格硬換算。</div></div><button onClick={() => setArmed(v => !v)} disabled={decision.direction === 'WAIT' || !executionAllowed} className="rounded-lg border border-current px-4 py-2 text-xs font-bold disabled:opacity-30">{armed ? 'DISARM' : 'ARM 即時監控'}</button></div></div>

    <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex items-center gap-2 font-bold"><Database size={16}/> API / WebSocket</div><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{([['twelve','Twelve Data'],['finnhub','Finnhub'],['massive','Massive'],['fmp','FMP'],['fred','FRED']] as const).map(([k,l]) => <label key={k} className="field-label">{l}<input type="password" className="field-input" value={keys[k]} onChange={e => setKeys(p => ({ ...p, [k]: e.target.value }))}/></label>)}<label className="field-label">Alpaca Key ID<input type="password" className="field-input" value={alpaca.keyId} onChange={e => setAlpaca(p => ({ ...p, keyId: e.target.value }))}/></label><label className="field-label">Alpaca Secret<input type="password" className="field-input" value={alpaca.secret} onChange={e => setAlpaca(p => ({ ...p, secret: e.target.value }))}/></label></div><div className="mt-3 grid grid-cols-3 gap-3 max-w-xl"><label className="field-label">帳戶 USD<input className="field-input" type="number" value={account} onChange={e => setAccount(Number(e.target.value)||0)}/></label><label className="field-label">單筆風險 %<input className="field-input" type="number" step="0.1" value={riskPct} onChange={e => setRiskPct(Number(e.target.value)||0)}/></label><label className="field-label">最大資金 %<input className="field-input" type="number" value={maxAlloc} onChange={e => setMaxAlloc(Number(e.target.value)||0)}/></label></div></div>

    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200/80"><AlertTriangle size={15} className="mr-2 inline"/>「多 / 空」是當日動態結果，不是股票永久標籤。排名只在 hard filters 後有意義；槓桿 ETF 若 spread 過大、即時報價不新鮮或流動性不足，程式會降級為 AVOID。</div>
  </div></div>;
}
