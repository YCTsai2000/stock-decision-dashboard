import { useMemo, useState } from 'react';
import { Activity, RefreshCw, Trophy } from 'lucide-react';
import type { ApiKeys, HistoricalDataResult } from './types';
import type { AlpacaLiveSnapshot } from './alpacaStream';
import { calculateMA } from './analysis';
import { fetchHistoricalData } from './dataLayer';
import { computeIntradayMetrics, fetchIntradayData, type IntradayFetchResult } from './intraday';
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

const directionQuality = (side: ExecutionSide, longScore: number, shortScore: number) => side === 'LONG' ? longScore : shortScore;

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

export default function WatchlistRanker({ keys, marketMode, onSelect, liveBySymbol }: Props) {
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

        const longReady = afterEntryTime && rvolPass && marketMode !== 'RISK_OFF'
          && aboveVwap && m.vwapSlopeUp === true && m.benchmarkAboveVwap === true
          && (m.relativeStrengthPct ?? 0) > 0 && brokeHigh;

        const shortReady = afterEntryTime && rvolPass && marketMode !== 'RISK_ON'
          && dailyBias === 'SHORT' && belowVwap && m.vwapSlopeUp === false
          && m.benchmarkAboveVwap === false && (m.relativeStrengthPct ?? 0) < 0 && brokeLow;

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
        longScore = clamp(longScore + rvPts);
        shortScore = clamp(shortScore + rvPts);

        let state: RankState = 'WAIT';
        let side: ExecutionSide | null = null;

        if (m.stale || !m.marketOpen) state = 'WAIT';
        else if (longReady && longScore >= 75 && longScore - shortScore >= 12) { state = 'LONG'; side = 'LONG'; }
        else if (shortReady && shortScore >= 75 && shortScore - longScore >= 12) { state = 'SHORT'; side = 'SHORT'; }
        else if (longScore >= 65 && longScore > shortScore) { state = 'WATCH_LONG'; side = 'LONG'; }
        else if (shortScore >= 65 && shortScore > longScore) { state = 'WATCH_SHORT'; side = 'SHORT'; }

        const candidate = side ? getExecutionForDirection(symbol, side) : null;

        let etfIntraday: IntradayFetchResult | null = null;
        if (candidate) {
          try {
            etfIntraday = await fetchIntradayData(candidate.ticker, keys);
            if (gap > 5_000) await sleep(gap);
          } catch {
            etfIntraday = null;
          }
        }

        const dollarVolume = candidate ? currentSessionDollarVolume(etfIntraday, m.sessionDate) : null;
        const spreadPct = candidate ? liveSpreadPct(liveBySymbol[candidate.ticker]) : null;

        const directionScore = side ? directionQuality(side, longScore, shortScore) : Math.max(longScore, shortScore);
        const rvolPoints = m.rvol === null ? 0 : Math.min(20, (m.rvol / Math.max(profile.minRvol, 1)) * 12);
        const rsPoints = m.relativeStrengthPct === null ? 0 : Math.min(15, Math.abs(m.relativeStrengthPct) * 15 + 3);
        const setupBonus = state === 'LONG' || state === 'SHORT' ? 40 : state === 'WATCH_LONG' || state === 'WATCH_SHORT' ? 20 : 0;
        const setupScore = clamp(setupBonus + rvolPoints + rsPoints + directionScore * 0.25);
        const executionScore = candidate ? clamp(dollarVolumeScore(dollarVolume) + spreadScore(spreadPct)) : 0;

        const spreadTooWide = spreadPct !== null && spreadPct > 0.50;
        const dollarVolumeTooLow = dollarVolume !== null && dollarVolume < 1_000_000;
        const staticLiquidityPoor = candidate?.liquidityTier === 'POOR';

        if ((state === 'LONG' || state === 'SHORT') && (!candidate || staticLiquidityPoor || spreadTooWide || dollarVolumeTooLow)) {
          state = 'AVOID';
        }

        let score = clamp(setupScore * 0.70 + executionScore * 0.30);
        if (state === 'WAIT') score = clamp(setupScore * 0.35 + executionScore * 0.15);
        if (state === 'AVOID') score = Math.min(39, score);

        const executionText = candidate
          ? `${candidate.ticker}：Dollar Vol ${formatDollarVolume(dollarVolume)}，Spread ${spreadPct === null ? '未確認' : `${spreadPct.toFixed(3)}%`}，Execution ${executionScore.toFixed(0)}/100`
          : '該方向沒有已驗證的槓桿 ETF';

        const reason = state === 'LONG' || state === 'SHORT'
          ? `${side} 結構成立；${profile.benchmark} 同向、RVOL ${m.rvol?.toFixed(2) ?? '—'}x、RS ${m.relativeStrengthPct?.toFixed(2) ?? '—'}%。${executionText}。`
          : state === 'AVOID'
            ? `${executionText}；即使技術 setup 成立，執行品質不足，因此降級 AVOID。`
            : `尚未完成完整 hard filters。${candidate ? ` ${executionText}。` : ''}`;

        nextRows.push({
          symbol,
          state,
          score,
          setupScore,
          executionScore,
          directionScore,
          executionTicker: candidate?.ticker ?? null,
          benchmark: profile.benchmark,
          rvol: m.rvol,
          rs: m.relativeStrengthPct,
          dailyBias,
          dollarVolume,
          spreadPct,
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

  const stateClass = (state: RankState) => state === 'LONG'
    ? 'text-emerald-300'
    : state === 'SHORT'
      ? 'text-rose-300'
      : state === 'AVOID'
        ? 'text-amber-300'
        : state.startsWith('WATCH')
          ? 'text-cyan-300'
          : 'text-slate-500';

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2"><Trophy size={17} className="text-amber-300" /><h2 className="font-bold">當日當沖候選排名</h2></div>
          <p className="text-[10px] text-slate-500 mt-1">總分 = Setup 70% + Execution 30%；Execution = 當日 ETF Dollar Volume 60% + Alpaca IEX 即時 Spread 40%。Spread &gt; 0.5% 或當日 Dollar Volume &lt; $1M 的已成立訊號會降級 AVOID。</p>
        </div>
        <button onClick={() => void scan()} disabled={scanning} className="inline-flex items-center gap-2 border border-amber-500/40 bg-amber-500/10 text-amber-200 rounded-lg px-3 py-2 text-xs disabled:opacity-50"><RefreshCw size={13} className={scanning ? 'animate-spin' : ''} /> {scanning ? `掃描 ${progress}` : '掃描觀察池'}</button>
      </div>

      {error ? <div className="mb-3 text-xs text-rose-300">{error}</div> : null}

      {!sorted.length ? (
        <div className="text-xs text-slate-600 py-5 text-center"><Activity size={18} className="inline mr-2" />尚未掃描；Dollar Volume 取該 ETF 當日 5 分 K 累計成交額，Spread 取 Alpaca IEX 即時 Bid/Ask。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1120px]">
            <thead className="text-slate-500 border-b border-slate-800">
              <tr><th className="text-left py-2">Rank</th><th className="text-left">Underlying</th><th className="text-left">方向</th><th className="text-right">總分</th><th className="text-right">Setup</th><th className="text-right">Execution</th><th className="text-left">交易 ETF</th><th className="text-right">Dollar Vol</th><th className="text-right">Spread</th><th className="text-right">RVOL</th><th className="text-right">RS</th><th className="text-left">Daily</th><th className="text-left">Benchmark</th></tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.symbol} onClick={() => onSelect(r.symbol)} title={r.reason} className="border-b border-slate-800/60 hover:bg-slate-800/50 cursor-pointer">
                  <td className="py-2.5 font-mono text-slate-500">#{i + 1}</td><td className="font-bold text-white">{r.symbol}</td><td className={`font-bold ${stateClass(r.state)}`}>{r.state}</td><td className="text-right font-mono font-bold text-white">{r.score.toFixed(0)}</td><td className="text-right font-mono">{r.setupScore.toFixed(0)}</td><td className="text-right font-mono">{r.executionScore.toFixed(0)}</td><td>{r.executionTicker ?? '—'}</td><td className="text-right font-mono">{formatDollarVolume(r.dollarVolume)}</td><td className="text-right font-mono">{r.spreadPct === null ? '—' : `${r.spreadPct.toFixed(3)}%`}</td><td className="text-right font-mono">{r.rvol?.toFixed(2) ?? '—'}x</td><td className="text-right font-mono">{r.rs === null ? '—' : `${r.rs >= 0 ? '+' : ''}${r.rs.toFixed(2)}%`}</td><td>{r.dailyBias}</td><td>{r.benchmark}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
