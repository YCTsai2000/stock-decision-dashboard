import { useMemo, useState } from 'react';
import { Activity, RefreshCw, Trophy } from 'lucide-react';
import type { ApiKeys, HistoricalDataResult } from './types';
import { calculateMA } from './analysis';
import { fetchHistoricalData } from './dataLayer';
import { computeIntradayMetrics, fetchIntradayData } from './intraday';
import { getTradingProfile, WATCHLIST } from './tradingProfiles';
import { getExecutionForDirection, liquidityTierScore, type ExecutionSide } from './tradingInstruments';

type MarketMode = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
type RankState = 'LONG' | 'SHORT' | 'WATCH_LONG' | 'WATCH_SHORT' | 'WAIT' | 'AVOID';

interface RankingRow {
  symbol: string;
  state: RankState;
  score: number;
  directionScore: number;
  executionTicker: string | null;
  benchmark: string;
  rvol: number | null;
  rs: number | null;
  dailyBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  liquidity: string;
  reason: string;
}

interface Props {
  keys: ApiKeys;
  marketMode: MarketMode;
  onSelect: (symbol: string) => void;
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

const directionQuality = (side: ExecutionSide, longScore: number, shortScore: number) => side === 'LONG' ? longScore : shortScore;

export default function WatchlistRanker({ keys, marketMode, onSelect }: Props) {
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
    setScanning(true);
    setError('');
    setRows([]);
    const benchmarkCache = new Map<string, Awaited<ReturnType<typeof fetchIntradayData>>>();
    const nextRows: RankingRow[] = [];
    // Twelve-only free setup is intentionally conservative to reduce rate-limit failures.
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

        const price = m.currentPrice;
        const afterEntryTime = m.latestMinute !== null && m.latestMinute >= profile.minEntryMinute;
        const aboveVwap = price !== null && m.vwap !== null && price > m.vwap;
        const belowVwap = price !== null && m.vwap !== null && price < m.vwap;
        const brokeHigh = price !== null && m.orHigh !== null && m.orReady && price > m.orHigh;
        const brokeLow = price !== null && m.orLow !== null && m.orReady && price < m.orLow;
        const rvolPass = m.rvol !== null && m.rvol >= profile.minRvol;
        const longReady = afterEntryTime && rvolPass && marketMode !== 'RISK_OFF' && aboveVwap && m.vwapSlopeUp === true && m.benchmarkAboveVwap === true && (m.relativeStrengthPct ?? 0) > 0 && brokeHigh;
        const shortReady = afterEntryTime && rvolPass && marketMode !== 'RISK_ON' && dailyBias === 'SHORT' && belowVwap && m.vwapSlopeUp === false && m.benchmarkAboveVwap === false && (m.relativeStrengthPct ?? 0) < 0 && brokeLow;

        let longScore = 0;
        let shortScore = 0;
        longScore += dailyBias === 'LONG' ? 15 : dailyBias === 'NEUTRAL' ? 6 : 0;
        shortScore += dailyBias === 'SHORT' ? 15 : 0;
        longScore += marketMode === 'RISK_ON' ? 15 : marketMode === 'NEUTRAL' ? 8 : 0;
        shortScore += marketMode === 'RISK_OFF' ? 15 : marketMode === 'NEUTRAL' ? 7 : 0;
        if (aboveVwap) longScore += 15;
        if (belowVwap) shortScore += 15;
        if (m.vwapSlopeUp === true) longScore += 10;
        if (m.vwapSlopeUp === false) shortScore += 10;
        if (m.benchmarkAboveVwap === true) longScore += 10;
        if (m.benchmarkAboveVwap === false) shortScore += 10;
        if (brokeHigh) longScore += 20;
        if (brokeLow) shortScore += 20;
        const rs = m.relativeStrengthPct ?? 0;
        if (rs > 0) longScore += Math.min(15, 5 + Math.abs(rs) * 10);
        if (rs < 0) shortScore += Math.min(15, 5 + Math.abs(rs) * 10);
        const rvPts = m.rvol === null ? 0 : m.rvol >= profile.highConvictionRvol ? 15 : m.rvol >= profile.minRvol ? 10 : m.rvol >= 1 ? 4 : 0;
        longScore += rvPts;
        shortScore += rvPts;
        longScore = clamp(longScore);
        shortScore = clamp(shortScore);

        let state: RankState = 'WAIT';
        let side: ExecutionSide | null = null;
        if (m.stale || !m.marketOpen) state = 'WAIT';
        else if (longReady && longScore >= 75 && longScore - shortScore >= 12) { state = 'LONG'; side = 'LONG'; }
        else if (shortReady && shortScore >= 75 && shortScore - longScore >= 12) { state = 'SHORT'; side = 'SHORT'; }
        else if (longScore >= 65 && longScore > shortScore) { state = 'WATCH_LONG'; side = 'LONG'; }
        else if (shortScore >= 65 && shortScore > longScore) { state = 'WATCH_SHORT'; side = 'SHORT'; }

        const candidate = side ? getExecutionForDirection(symbol, side) : null;
        if ((state === 'LONG' || state === 'SHORT') && !candidate) state = 'AVOID';
        if ((state === 'LONG' || state === 'SHORT') && candidate?.liquidityTier === 'POOR') state = 'AVOID';

        const directionScore = side ? directionQuality(side, longScore, shortScore) : Math.max(longScore, shortScore);
        const liquidityPoints = candidate ? liquidityTierScore(candidate.liquidityTier) : 0;
        const rvolPoints = m.rvol === null ? 0 : Math.min(20, (m.rvol / Math.max(profile.minRvol, 1)) * 12);
        const rsPoints = m.relativeStrengthPct === null ? 0 : Math.min(15, Math.abs(m.relativeStrengthPct) * 15 + 3);
        const setupPoints = state === 'LONG' || state === 'SHORT' ? 30 : state === 'WATCH_LONG' || state === 'WATCH_SHORT' ? 15 : 0;
        const score = state === 'AVOID' || state === 'WAIT' ? clamp((directionScore * 0.25) + liquidityPoints) : clamp(setupPoints + rvolPoints + rsPoints + liquidityPoints + directionScore * 0.15);

        const reason = state === 'LONG' || state === 'SHORT'
          ? `${side} 結構成立；${profile.benchmark} 同向、RVOL ${m.rvol?.toFixed(2) ?? '—'}x、RS ${m.relativeStrengthPct?.toFixed(2) ?? '—'}%。`
          : state === 'AVOID'
            ? candidate ? `${candidate.ticker} 流動性層級 ${candidate.liquidityTier}，不適合把高技術分數直接轉成槓桿 ETF 當沖。` : '該方向目前沒有已驗證的單股槓桿 ETF。'
            : `尚未完成完整 breakout / VWAP / benchmark / Daily Bias hard filters。`;

        nextRows.push({
          symbol,
          state,
          score,
          directionScore,
          executionTicker: candidate?.ticker ?? null,
          benchmark: profile.benchmark,
          rvol: m.rvol,
          rs: m.relativeStrengthPct,
          dailyBias,
          liquidity: candidate?.liquidityTier ?? 'N/A',
          reason,
        });
        setRows([...nextRows]);
        if (gap <= 5_000) await sleep(gap);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '掃描失敗');
    } finally {
      setScanning(false);
      setProgress('');
    }
  };

  const stateClass = (state: RankState) => state === 'LONG' ? 'text-emerald-300' : state === 'SHORT' ? 'text-rose-300' : state === 'AVOID' ? 'text-amber-300' : state.startsWith('WATCH') ? 'text-cyan-300' : 'text-slate-500';

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2"><Trophy size={17} className="text-amber-300" /><h2 className="font-bold">當日當沖候選排名</h2></div>
          <p className="text-[10px] text-slate-500 mt-1">只在 hard filters 後排名；技術分數不能補掉錯誤方向。建議正常盤 OR15 完成且到各 profile 最早進場時間後使用。</p>
        </div>
        <button onClick={() => void scan()} disabled={scanning} className="inline-flex items-center gap-2 border border-amber-500/40 bg-amber-500/10 text-amber-200 rounded-lg px-3 py-2 text-xs disabled:opacity-50"><RefreshCw size={13} className={scanning ? 'animate-spin' : ''} /> {scanning ? `掃描 ${progress}` : '掃描觀察池'}</button>
      </div>
      {error ? <div className="mb-3 text-xs text-rose-300">{error}</div> : null}
      {!sorted.length ? <div className="text-xs text-slate-600 py-5 text-center"><Activity size={18} className="inline mr-2" />尚未掃描；排名會依當日資料變動，不是固定的「哪支永遠適合多或空」。</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[850px]">
            <thead className="text-slate-500 border-b border-slate-800"><tr><th className="text-left py-2">Rank</th><th className="text-left">Underlying</th><th className="text-left">方向</th><th className="text-right">Rank Score</th><th className="text-left">交易 ETF</th><th className="text-left">流動性</th><th className="text-right">RVOL</th><th className="text-right">RS</th><th className="text-left">Daily</th><th className="text-left">Benchmark</th></tr></thead>
            <tbody>{sorted.map((r, i) => <tr key={r.symbol} onClick={() => onSelect(r.symbol)} title={r.reason} className="border-b border-slate-800/60 hover:bg-slate-800/50 cursor-pointer"><td className="py-2.5 font-mono text-slate-500">#{i + 1}</td><td className="font-bold text-white">{r.symbol}</td><td className={`font-bold ${stateClass(r.state)}`}>{r.state}</td><td className="text-right font-mono font-bold">{r.score.toFixed(0)}</td><td>{r.executionTicker ?? '—'}</td><td className="text-slate-400">{r.liquidity}</td><td className="text-right font-mono">{r.rvol?.toFixed(2) ?? '—'}x</td><td className="text-right font-mono">{r.rs === null ? '—' : `${r.rs >= 0 ? '+' : ''}${r.rs.toFixed(2)}%`}</td><td>{r.dailyBias}</td><td>{r.benchmark}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
