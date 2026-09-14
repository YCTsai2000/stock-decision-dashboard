import { useMemo, useState } from 'react';
import { Activity, RefreshCw, Trophy } from 'lucide-react';
import type { ApiKeys, HistoricalDataResult } from './types';
import type { AlpacaLiveSnapshot } from './alpacaStream';
import { calculateMA } from './analysis';
import { fetchHistoricalData } from './dataLayer';
import { computeIntradayMetrics, fetchIntradayData, type DayTradeDecisionInput, type IntradayFetchResult } from './intraday';
import { buildProfiledDayTradeDecision } from './decisionV6';
import { getTradingProfile, WATCHLIST } from './tradingProfiles';
import { getExecutionForDirection, type ExecutionSide } from './tradingInstruments';

type MarketMode = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
type RankState = 'LONG' | 'SHORT' | 'WATCH_LONG' | 'WATCH_SHORT' | 'WAIT' | 'AVOID';

interface RankingRow {
  symbol: string;
  state: RankState;
  score: number;
  setupScore: number;
  executionScore: number;
  directionScore: number;
  executionTicker: string | null;
  benchmark: string;
  rvol: number | null;
  rs: number | null;
  dailyBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  dollarVolume: number | null;
  spreadPct: number | null;
  eventOverride: boolean;
  reason: string;
}

interface Props {
  keys: ApiKeys;
  marketMode: MarketMode;
  onSelect: (symbol: string) => void;
  liveBySymbol: Record<string, AlpacaLiveSnapshot>;
}

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));

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

const currentSessionDollarVolume = (result: IntradayFetchResult | null, expectedDate: string | null): number | null => {
  const bars = result?.bars;
  if (!bars?.length || !expectedDate) return null;
  const sameDay = bars.filter(b => b.date === expectedDate && b.minute >= 9 * 60 + 30 && b.minute < 16 * 60);
  if (!sameDay.length) return null;
  const value = sameDay.reduce((sum, b) => sum + b.close * b.volume, 0);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const liveSpreadPct = (live: AlpacaLiveSnapshot | undefined): number | null => {
  const bid = live?.bid;
  const ask = live?.ask;
  if (bid == null || ask == null || bid <= 0 || ask <= bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
};

const dollarVolumeScore = (value: number | null): number => {
  if (value == null) return 0;
  if (value >= 500_000_000) return 60;
  if (value >= 250_000_000) return 56;
  if (value >= 100_000_000) return 50;
  if (value >= 50_000_000) return 44;
  if (value >= 20_000_000) return 36;
  if (value >= 10_000_000) return 30;
  if (value >= 5_000_000) return 22;
  if (value >= 2_000_000) return 14;
  if (value >= 1_000_000) return 8;
  return 2;
};

const spreadScore = (value: number | null): number => {
  if (value == null) return 8;
  if (value <= 0.03) return 40;
  if (value <= 0.05) return 38;
  if (value <= 0.10) return 34;
  if (value <= 0.15) return 29;
  if (value <= 0.25) return 22;
  if (value <= 0.35) return 14;
  if (value <= 0.50) return 6;
  return 0;
};

const formatDollarVolume = (value: number | null) => {
  if (value == null) return '—';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
};

export default function WatchlistRankerV6({ keys, marketMode, onSelect, liveBySymbol }: Props) {
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const sorted = useMemo(() => [...rows].sort((a, b) => b.score - a.score), [rows]);

  const scan = async () => {
    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) {
      setError('至少需要 Twelve Data、Massive 或 Finnhub 其中一組 Key 才能掃描。');
      return;
    }

    setScanning(true); setError(''); setRows([]);
    const benchmarkCache = new Map<string, Awaited<ReturnType<typeof fetchIntradayData>>>();
    const nextRows: RankingRow[] = [];
    const gap = keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim() ? 20_000 : 1_200;

    try {
      for (let i = 0; i < WATCHLIST.length; i++) {
        const symbol = WATCHLIST[i];
        const profile = getTradingProfile(symbol);
        setProgress(`${i + 1}/${WATCHLIST.length} · ${symbol}`);

        let benchmarkResult = benchmarkCache.get(profile.benchmark);
        if (!benchmarkResult) {
          benchmarkResult = await fetchIntradayData(profile.benchmark, keys);
          benchmarkCache.set(profile.benchmark, benchmarkResult);
          if (gap > 5_000) await sleep(gap);
        }

        const intradayResult = await fetchIntradayData(symbol, keys);
        if (gap > 5_000) await sleep(gap);
        const dailyResult = await fetchHistoricalData(symbol, keys);
        const dailyBias = getDailyBias(dailyResult);
        const m = computeIntradayMetrics(intradayResult.bars, benchmarkResult.bars);

        const decisionInput: DayTradeDecisionInput = {
          metrics: m,
          dailyBias,
          marketMode,
          accountSizeUsd: 100_000,
          riskPerTradePct: 0.5,
          dailyMaxLossPct: 1.5,
          realizedPnlUsd: 0,
          maxAllocationPct: 25,
          bid: null,
          ask: null,
          hasCatalyst: false,
        };
        const decision = buildProfiledDayTradeDecision(decisionInput, profile);
        const eventOverride = decision.label.includes('EVENT REVERSAL');

        let state: RankState = 'WAIT';
        let side: ExecutionSide | null = null;
        if (m.stale || !m.marketOpen) state = 'WAIT';
        else if (decision.direction === 'LONG') { state = 'LONG'; side = 'LONG'; }
        else if (decision.direction === 'SHORT') { state = 'SHORT'; side = 'SHORT'; }
        else if (decision.longScore >= 65 && decision.longScore > decision.shortScore) { state = 'WATCH_LONG'; side = 'LONG'; }
        else if (decision.shortScore >= 65 && decision.shortScore > decision.longScore) { state = 'WATCH_SHORT'; side = 'SHORT'; }

        const candidate = side ? getExecutionForDirection(symbol, side) : null;
        let etfIntraday: IntradayFetchResult | null = null;
        if (candidate) {
          try {
            etfIntraday = await fetchIntradayData(candidate.ticker, keys);
            if (gap > 5_000) await sleep(gap);
          } catch { etfIntraday = null; }
        }

        const dollarVolume = candidate ? currentSessionDollarVolume(etfIntraday, m.sessionDate) : null;
        const spreadPct = candidate ? liveSpreadPct(liveBySymbol[candidate.ticker]) : null;
        const directionScore = side === 'LONG' ? decision.longScore : side === 'SHORT' ? decision.shortScore : Math.max(decision.longScore, decision.shortScore);
        const rvolPoints = m.rvol === null ? 0 : Math.min(20, (m.rvol / Math.max(profile.minRvol, 1)) * 12);
        const rsPoints = m.relativeStrengthPct === null ? 0 : Math.min(15, Math.abs(m.relativeStrengthPct) * 15 + 3);
        const setupBonus = state === 'LONG' || state === 'SHORT' ? 40 : state === 'WATCH_LONG' || state === 'WATCH_SHORT' ? 20 : 0;
        const eventBonus = eventOverride ? 5 : 0;
        const setupScore = clamp(setupBonus + eventBonus + rvolPoints + rsPoints + directionScore * 0.25);
        const executionScore = candidate ? clamp(dollarVolumeScore(dollarVolume) + spreadScore(spreadPct)) : 0;

        const spreadTooWide = spreadPct !== null && spreadPct > 0.50;
        const dollarVolumeTooLow = dollarVolume !== null && dollarVolume < 1_000_000;
        const staticLiquidityPoor = candidate?.liquidityTier === 'POOR';
        if ((state === 'LONG' || state === 'SHORT') && (!candidate || staticLiquidityPoor || spreadTooWide || dollarVolumeTooLow)) state = 'AVOID';

        let score = clamp(setupScore * 0.70 + executionScore * 0.30);
        if (state === 'WAIT') score = clamp(setupScore * 0.35 + executionScore * 0.15);
        if (state === 'AVOID') score = Math.min(39, score);

        const executionText = candidate
          ? `${candidate.ticker}：Dollar Vol ${formatDollarVolume(dollarVolume)}，Spread ${spreadPct === null ? '未確認' : `${spreadPct.toFixed(3)}%`}，Execution ${executionScore.toFixed(0)}/100`
          : '該方向沒有已驗證的槓桿 ETF';
        const reason = `${decision.reason} ${executionText}。`;

        nextRows.push({ symbol, state, score, setupScore, executionScore, directionScore, executionTicker: candidate?.ticker ?? null, benchmark: profile.benchmark, rvol: m.rvol, rs: m.relativeStrengthPct, dailyBias, dollarVolume, spreadPct, eventOverride, reason });
        setRows([...nextRows]);
        if (gap <= 5_000) await sleep(gap);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '掃描失敗');
    } finally {
      setScanning(false); setProgress('');
    }
  };

  const stateClass = (state: RankState) => state === 'LONG' ? 'text-emerald-300' : state === 'SHORT' ? 'text-rose-300' : state === 'AVOID' ? 'text-amber-300' : state.startsWith('WATCH') ? 'text-cyan-300' : 'text-slate-500';

  return <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-4">
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
      <div>
        <div className="flex items-center gap-2"><Trophy size={17} className="text-amber-300" /><h2 className="font-bold">當日當沖候選排名 · V6 Unified</h2></div>
        <p className="text-[10px] text-slate-500 mt-1">排名與個股頁共用同一套 Decision Engine；總分 = Setup 70% + Execution 30%。EVENT REVERSAL 只在極端跳空反轉條件成立時啟用。</p>
      </div>
      <button onClick={() => void scan()} disabled={scanning} className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50 inline-flex items-center gap-2">
        {scanning ? <RefreshCw size={14} className="animate-spin" /> : <Activity size={14} />} {scanning ? progress || '掃描中' : '掃描觀察池'}
      </button>
    </div>
    {error ? <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div> : null}
    <div className="overflow-x-auto">
      <table className="min-w-[1050px] w-full text-xs">
        <thead className="text-slate-500"><tr className="border-b border-slate-800"><th className="py-2 text-left">#</th><th className="text-left">標的</th><th className="text-left">狀態</th><th>總分</th><th>Setup</th><th>Exec</th><th className="text-left">ETF</th><th>Dollar Vol</th><th>Spread</th><th>RVOL</th><th>RS</th><th className="text-left">Bias / Bench</th></tr></thead>
        <tbody>{sorted.map((row, idx) => <tr key={row.symbol} onClick={() => onSelect(row.symbol)} className="border-b border-slate-900 hover:bg-slate-800/40 cursor-pointer">
          <td className="py-2 text-slate-500">{idx + 1}</td><td className="font-bold text-white">{row.symbol}{row.eventOverride ? <span className="ml-1 rounded bg-fuchsia-500/20 px-1 text-[9px] text-fuchsia-300">EVENT</span> : null}</td><td className={`font-bold ${stateClass(row.state)}`}>{row.state}</td><td className="text-center font-mono font-bold">{row.score.toFixed(0)}</td><td className="text-center font-mono">{row.setupScore.toFixed(0)}</td><td className="text-center font-mono">{row.executionScore.toFixed(0)}</td><td>{row.executionTicker ?? '—'}</td><td className="text-center">{formatDollarVolume(row.dollarVolume)}</td><td className="text-center">{row.spreadPct == null ? '—' : `${row.spreadPct.toFixed(3)}%`}</td><td className="text-center">{row.rvol?.toFixed(2) ?? '—'}</td><td className="text-center">{row.rs?.toFixed(2) ?? '—'}%</td><td>{row.dailyBias} / {row.benchmark}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {sorted.length ? <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[10px] leading-relaxed text-slate-400"><span className="font-bold text-slate-200">#1 原因：</span> {sorted[0].reason}</div> : null}
  </div>;
}
