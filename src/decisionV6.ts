import { buildDayTradeDecision, type DayTradeDecision, type DayTradeDecisionInput } from './intraday';
import { applyTradingProfile, type TradingProfile } from './tradingProfiles';

export const EVENT_SHORT_RULE = {
  minGapPct: 5,
  minMinute: 10 * 60 + 15,
  minRvol: 2,
  maxRelativeStrengthPct: -2,
  minShortScore: 80,
  minScoreLead: 15,
  maxBreakdownAgeMin: 5,
  maxUnderlyingStopPct: 1.5,
  riskFactor: 0.5,
} as const;

export const ADAPTIVE_LONG_RULE = {
  minLongScore: 68,
  minScoreLead: 8,
  freshBreakoutAgeMin: 10,
  secondChanceMinAgeMin: 10,
  secondChanceMaxAgeMin: 75,
  pullbackTouchAtr: 0.35,
  pullbackHoldAtr: 0.15,
  probeRiskFactor: 0.25,
  aRiskFactor: 0.5,
  aPlusRiskFactor: 1,
} as const;

export const marketRegimeRiskFactor = (mode: DayTradeDecisionInput['marketMode']): number => {
  if (mode === 'RISK_ON') return 1;
  if (mode === 'NEUTRAL') return 0.85;
  return 0.7;
};

export const decisionRiskFactor = (decision: DayTradeDecision): number => {
  if (decision.label.includes('EVENT REVERSAL')) return 0.5;
  if (decision.label.includes('B+ PROBE')) return 0.25;
  if (decision.label.includes('LONG · A Profile')) return 0.5;
  return 1;
};

export const effectiveDecisionRiskFactor = (
  decision: DayTradeDecision,
  marketMode: DayTradeDecisionInput['marketMode'],
): number => {
  const setup = decisionRiskFactor(decision);
  if (decision.direction !== 'LONG') return setup;
  return setup * marketRegimeRiskFactor(marketMode);
};

type EventShortLevels = {
  entry: number;
  stop: number;
  riskPerShare: number;
  stopPct: number;
  target1: number;
  target2: number;
};

type BreakoutContext = {
  firstBreakoutAgeMin: number | null;
  freshBreakout: boolean;
  secondChance: boolean;
};

const calculateBreakdownAgeMin = (input: DayTradeDecisionInput): number | null => {
  const m = input.metrics;
  if (m.latestMinute === null || m.orLow === null) return null;
  const firstBreak = m.sessionBars.find(bar => bar.minute >= 9 * 60 + 45 && bar.close < m.orLow!);
  if (!firstBreak) return null;
  return Math.max(0, m.latestMinute - firstBreak.minute);
};

const calculateBreakoutContext = (input: DayTradeDecisionInput, atr: number): BreakoutContext => {
  const m = input.metrics;
  const latest = m.sessionBars.at(-1);
  if (!latest || m.orHigh === null || m.vwap === null || !m.orReady) {
    return { firstBreakoutAgeMin: null, freshBreakout: false, secondChance: false };
  }

  const firstBreakoutIndex = m.sessionBars.findIndex(bar => bar.minute >= 9 * 60 + 45 && bar.close > m.orHigh!);
  if (firstBreakoutIndex < 0) {
    return { firstBreakoutAgeMin: null, freshBreakout: false, secondChance: false };
  }

  const firstBreakout = m.sessionBars[firstBreakoutIndex];
  const age = Math.max(0, latest.minute - firstBreakout.minute);
  const freshBreakout = age <= ADAPTIVE_LONG_RULE.freshBreakoutAgeMin;
  if (age < ADAPTIVE_LONG_RULE.secondChanceMinAgeMin || age > ADAPTIVE_LONG_RULE.secondChanceMaxAgeMin) {
    return { firstBreakoutAgeMin: age, freshBreakout, secondChance: false };
  }

  const between = m.sessionBars.slice(firstBreakoutIndex + 1, -1);
  const pullbackHeld = between.some(bar => (
    bar.low <= m.orHigh! + atr * ADAPTIVE_LONG_RULE.pullbackTouchAtr
    && bar.close >= m.orHigh! - atr * ADAPTIVE_LONG_RULE.pullbackHoldAtr
  ));
  const previous = m.sessionBars.at(-2);
  const turnedBackUp = Boolean(
    previous
    && latest.close > previous.close
    && latest.close > latest.open
    && latest.close > m.orHigh
    && latest.close > m.vwap
  );

  return {
    firstBreakoutAgeMin: age,
    freshBreakout,
    secondChance: pullbackHeld && turnedBackUp,
  };
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

const buildAdaptiveLongDecision = (
  input: DayTradeDecisionInput,
  base: DayTradeDecision,
  profile: TradingProfile,
): DayTradeDecision | null => {
  const m = input.metrics;
  const price = m.currentPrice;
  const minute = m.latestMinute;
  const rvol = m.rvol;
  const rs = m.relativeStrengthPct;
  if (base.hardBlock || price === null || price <= 0 || minute === null || rvol === null || rs === null) return null;
  if (minute < profile.minEntryMinute || rvol < profile.probeMinRvol) return null;
  if (!m.orReady || m.orHigh === null || m.vwap === null) return null;
  if (!(price > m.vwap && m.vwapSlopeUp === true && m.benchmarkAboveVwap === true && rs > 0 && price > m.orHigh)) return null;
  if (base.longScore < ADAPTIVE_LONG_RULE.minLongScore || base.longScore - base.shortScore < ADAPTIVE_LONG_RULE.minScoreLead) return null;

  const atr = m.intradayAtr ?? Math.max(price * 0.002, 0.01);
  const breakout = calculateBreakoutContext(input, atr);
  if (!breakout.freshBreakout && !breakout.secondChance) return null;

  const entry = price;
  const candidates = [
    m.vwap - atr * 0.25,
    m.orHigh - atr * 0.20,
    m.recentLow !== null ? m.recentLow - atr * 0.10 : null,
  ].filter((v): v is number => v !== null && v < entry);
  const structural = candidates.length ? Math.max(...candidates) : entry - atr * 0.5;
  const coreStop = Math.max(0.01, Math.min(structural, entry - atr * 0.35));
  const stop = Math.max(0.01, Math.min(coreStop, entry - atr * profile.minStopAtr));
  const riskPerShare = Math.max(0.01, entry - stop);
  const target1 = entry + riskPerShare * profile.target1R;
  const target2 = entry + riskPerShare * profile.target2R;

  const grade = rvol >= profile.highConvictionRvol ? 'A+' : rvol >= profile.minRvol ? 'A' : 'B+';
  const setupFactor = grade === 'A+' ? ADAPTIVE_LONG_RULE.aPlusRiskFactor : grade === 'A' ? ADAPTIVE_LONG_RULE.aRiskFactor : ADAPTIVE_LONG_RULE.probeRiskFactor;
  const regimeFactor = marketRegimeRiskFactor(input.marketMode);
  const baseRiskBudget = input.accountSizeUsd * (input.riskPerTradePct / 100);
  const adjustedBudget = baseRiskBudget * setupFactor * regimeFactor * base.phaseFactor;
  const riskBudget = Math.min(adjustedBudget, base.remainingDailyRiskUsd);
  const maxRiskShares = Math.floor(Math.max(0, riskBudget) / riskPerShare);
  const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / entry);
  const suggestedShares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));
  const entryStyle = breakout.secondChance ? 'SECOND-CHANCE reclaim' : 'fresh OR15 breakout';
  const label = grade === 'A+'
    ? `LONG · A+ Profile${breakout.secondChance ? ' · 2ND CHANCE' : ''}`
    : grade === 'A'
      ? `LONG · A Profile${breakout.secondChance ? ' · 2ND CHANCE' : ''}`
      : `LONG · B+ PROBE${breakout.secondChance ? ' · 2ND CHANCE' : ''}`;

  return {
    ...base,
    direction: 'LONG',
    label,
    reason: `V6.3 Adaptive：${profile.label}，${entryStyle}；Price > VWAP、VWAP slope ↑、${profile.benchmark} > VWAP、RS ${rs.toFixed(2)}% > 0。RVOL ${rvol.toFixed(2)}x → ${grade}；Setup risk ${Math.round(setupFactor * 100)}% × Regime ${input.marketMode} ${Math.round(regimeFactor * 100)}% × Session ${Math.round(base.phaseFactor * 100)}%。Market Regime 不再一票否決，只調整部位。`,
    entry,
    stop,
    target1,
    target2,
    riskPerShare,
    suggestedShares,
    suggestedRiskUsd: suggestedShares * riskPerShare,
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
  const breakdownAgeMin = calculateBreakdownAgeMin(input);
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
    && breakdownAgeMin !== null && breakdownAgeMin <= EVENT_SHORT_RULE.maxBreakdownAgeMin
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
  const breakdownAgeMin = calculateBreakdownAgeMin(input) ?? 0;
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
    reason: `V6.3 事件反轉：Gap ${m.gapPct?.toFixed(2)}%、RVOL ${m.rvol?.toFixed(2)}x、RS ${m.relativeStrengthPct?.toFixed(2)}%；OR15 Low 為新鮮跌破（Age ${breakdownAgeMin}m ≤ ${EVENT_SHORT_RULE.maxBreakdownAgeMin}m），且 VWAP / Benchmark 同步轉弱；原型股技術 Stop ${stopPct.toFixed(2)}% ≤ ${EVENT_SHORT_RULE.maxUnderlyingStopPct.toFixed(1)}%。Daily LONG 僅在此極端條件下被覆寫，事件單使用一般風險的 50%，再乘 Session factor。`,
    entry,
    stop,
    target1,
    target2,
    riskPerShare,
    suggestedShares,
    suggestedRiskUsd: suggestedShares * riskPerShare,
  };
};

const pauseNormalShort = (decision: DayTradeDecision): DayTradeDecision => ({
  ...decision,
  direction: 'WAIT',
  label: 'WATCH · NORMAL SHORT RESEARCH',
  reason: `V6.3：一般 Short 子模型仍只觀察，不實際進場；只有嚴格 Event Reversal Short 可以進場。原訊號：${decision.reason}`,
  entry: null,
  stop: null,
  target1: null,
  target2: null,
  riskPerShare: null,
  suggestedShares: 0,
  suggestedRiskUsd: 0,
});

const blockLegacyLong = (decision: DayTradeDecision, profile: TradingProfile): DayTradeDecision => ({
  ...decision,
  direction: 'WAIT',
  label: 'WATCH · V6.3 ENTRY TIMING',
  reason: `V6.3：${profile.label} 的舊版 Long 條件雖成立，但目前既不是 breakout 後 ${ADAPTIVE_LONG_RULE.freshBreakoutAgeMin} 分鐘內的新鮮訊號，也沒有形成可辨識的 Second-Chance reclaim，因此不追價。`,
  entry: null,
  stop: null,
  target1: null,
  target2: null,
  riskPerShare: null,
  suggestedShares: 0,
  suggestedRiskUsd: 0,
});

export const buildProfiledDayTradeDecision = (
  input: DayTradeDecisionInput,
  profile: TradingProfile,
): DayTradeDecision => {
  const base = buildDayTradeDecision(input);
  const normal = applyTradingProfile(input, base, profile);
  if (normal.hardBlock) return normal;

  const adaptiveLong = buildAdaptiveLongDecision(input, base, profile);
  if (adaptiveLong) return adaptiveLong;

  if (normal.direction === 'SHORT') return pauseNormalShort(normal);
  if (isEventShortOverride(input, base, profile)) return buildEventShortDecision(input, base, profile);
  if (normal.direction === 'LONG') return blockLegacyLong(normal, profile);
  return normal;
};
