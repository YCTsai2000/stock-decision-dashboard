import { buildDayTradeDecision, type DayTradeDecision, type DayTradeDecisionInput } from './intraday';
import { applyTradingProfile, type TradingProfile } from './tradingProfiles';

export const EVENT_SHORT_RULE = {
  minGapPct: 5,
  minMinute: 10 * 60 + 15,
  minRvol: 2,
  maxRelativeStrengthPct: -2,
  minShortScore: 80,
  minScoreLead: 15,
  maxUnderlyingStopPct: 1.5,
  riskFactor: 0.5,
} as const;

type EventShortLevels = {
  entry: number;
  stop: number;
  riskPerShare: number;
  stopPct: number;
  target1: number;
  target2: number;
};

const calculateEventShortLevels = (
  input: DayTradeDecisionInput,
  profile: TradingProfile,
): EventShortLevels | null => {
  const m = input.metrics;
  const entry = m.currentPrice;
  if (entry === null || entry <= 0) return null;
  const atr = m.intradayAtr ?? Math.max(entry * 0.002, 0.01);
  const candidates = [
    m.vwap !== null ? m.vwap + atr * 0.25 : null,
    m.orLow !== null ? m.orLow + atr * 0.20 : null,
    m.recentHigh !== null ? m.recentHigh + atr * 0.10 : null,
  ].filter((v): v is number => v !== null && v > entry);
  const structural = candidates.length ? Math.min(...candidates) : entry + atr * 0.5;
  const stop = Math.max(entry + atr * profile.minStopAtr, structural);
  const riskPerShare = Math.max(0.01, stop - entry);
  const stopPct = (riskPerShare / entry) * 100;
  return {
    entry,
    stop,
    riskPerShare,
    stopPct,
    target1: entry - riskPerShare * profile.target1R,
    target2: entry - riskPerShare * profile.target2R,
  };
};

export const isEventShortOverride = (
  input: DayTradeDecisionInput,
  base: DayTradeDecision,
  profile: TradingProfile,
) => {
  const m = input.metrics;
  const price = m.currentPrice;
  const levels = calculateEventShortLevels(input, profile);
  return base.hardBlock === null
    && input.dailyBias === 'LONG'
    && input.marketMode !== 'RISK_ON'
    && m.gapPct !== null && m.gapPct >= EVENT_SHORT_RULE.minGapPct
    && m.latestMinute !== null && m.latestMinute >= EVENT_SHORT_RULE.minMinute
    && m.rvol !== null && m.rvol >= EVENT_SHORT_RULE.minRvol
    && price !== null && m.vwap !== null && price < m.vwap
    && m.vwapSlopeUp === false
    && m.benchmarkAboveVwap === false
    && m.relativeStrengthPct !== null && m.relativeStrengthPct <= EVENT_SHORT_RULE.maxRelativeStrengthPct
    && m.orReady && m.orLow !== null && price < m.orLow
    && base.shortScore >= EVENT_SHORT_RULE.minShortScore
    && base.shortScore - base.longScore >= EVENT_SHORT_RULE.minScoreLead
    && levels !== null && levels.stopPct <= EVENT_SHORT_RULE.maxUnderlyingStopPct;
};

const buildEventShortDecision = (
  input: DayTradeDecisionInput,
  base: DayTradeDecision,
  profile: TradingProfile,
): DayTradeDecision => {
  const m = input.metrics;
  const levels = calculateEventShortLevels(input, profile)!;
  const { entry, stop, riskPerShare, stopPct, target1, target2 } = levels;
  const baseRiskBudget = input.accountSizeUsd * (input.riskPerTradePct / 100) * EVENT_SHORT_RULE.riskFactor;
  const timeAdjustedBudget = baseRiskBudget * base.phaseFactor;
  const riskBudget = Math.min(timeAdjustedBudget, base.remainingDailyRiskUsd);
  const maxRiskShares = Math.floor(Math.max(0, riskBudget) / riskPerShare);
  const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / entry);
  const suggestedShares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));

  return {
    ...base,
    direction: 'SHORT',
    label: 'SHORT · EVENT REVERSAL',
    reason: `V6 事件反轉：Gap ${m.gapPct?.toFixed(2)}%、RVOL ${m.rvol?.toFixed(2)}x、RS ${m.relativeStrengthPct?.toFixed(2)}%，且跌破 OR15 Low / VWAP、Benchmark 同步轉弱；原型股技術 Stop ${stopPct.toFixed(2)}% ≤ ${EVENT_SHORT_RULE.maxUnderlyingStopPct.toFixed(1)}%。Daily LONG 僅在此極端條件下被覆寫，事件單使用一般風險的 50%。`,
    entry,
    stop,
    target1,
    target2,
    riskPerShare,
    suggestedShares,
    suggestedRiskUsd: suggestedShares * riskPerShare,
  };
};

export const buildProfiledDayTradeDecision = (
  input: DayTradeDecisionInput,
  profile: TradingProfile,
): DayTradeDecision => {
  const base = buildDayTradeDecision(input);
  const normal = applyTradingProfile(input, base, profile);
  if (normal.hardBlock || normal.direction !== 'WAIT') return normal;
  if (!isEventShortOverride(input, base, profile)) return normal;
  return buildEventShortDecision(input, base, profile);
};
