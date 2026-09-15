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
  secondChanceMinAgeMin: 10,
  secondChanceMaxAgeMin: 75,
  pullbackTouchAtr: 0.35,
  pullbackHoldAtr: 0.15,
  probeRiskFactor: 0.25,
  aRiskFactor: 0.5,
  aPlusRiskFactor: 1,
  coreStartMinute: 10 * 60 + 15,
  coreEndMinute: 11 * 60,
  continuationEndMinute: 12 * 60,
  earlyAlignedAPlusFactor: 0.5,
  alignedContinuationFactor: 0.75,
} as const;

export const marketRegimeRiskFactor = (mode: DayTradeDecisionInput['marketMode']): number => {
  if (mode === 'RISK_ON') return 1;
  if (mode === 'NEUTRAL') return 0.85;
  return 0.7;
};

const labelRegimeFactor = (decision: DayTradeDecision): number => {
  if (decision.direction !== 'LONG') return 1;
  if (decision.label.includes('RISK_OFF')) return 0.7;
  if (decision.label.includes('NEUTRAL')) return 0.85;
  return 1;
};

const labelTimingFactor = (decision: DayTradeDecision): number => {
  if (decision.label.includes('EARLY ALIGNED')) return ADAPTIVE_LONG_RULE.earlyAlignedAPlusFactor;
  if (decision.label.includes('ALIGNED CONTINUATION')) return ADAPTIVE_LONG_RULE.alignedContinuationFactor;
  return 1;
};

export const decisionRiskFactor = (decision: DayTradeDecision): number => {
  if (decision.label.includes('EVENT REVERSAL')) return 0.5;
  const setup = decision.label.includes('B+ PROBE') ? ADAPTIVE_LONG_RULE.probeRiskFactor
    : decision.label.includes('LONG · A Profile') ? ADAPTIVE_LONG_RULE.aRiskFactor
      : ADAPTIVE_LONG_RULE.aPlusRiskFactor;
  return setup * labelTimingFactor(decision) * labelRegimeFactor(decision);
};

export const effectiveDecisionRiskFactor = (
  decision: DayTradeDecision,
  _marketMode: DayTradeDecisionInput['marketMode'],
): number => decisionRiskFactor(decision);

type EventShortLevels = {
  entry: number;
  stop: number;
  riskPerShare: number;
  stopPct: number;
  target1: number;
  target2: number;
};

const calculateBreakdownAgeMin = (input: DayTradeDecisionInput): number | null => {
  const m = input.metrics;
  if (m.latestMinute === null || m.orLow === null) return null;
  const firstBreak = m.sessionBars.find(bar => bar.minute >= 9 * 60 + 45 && bar.close < m.orLow!);
  if (!firstBreak) return null;
  return Math.max(0, m.latestMinute - firstBreak.minute);
};

const isSecondChanceLong = (input: DayTradeDecisionInput, atr: number): boolean => {
  const m = input.metrics;
  const latest = m.sessionBars.at(-1);
  if (!latest || m.orHigh === null || m.vwap === null || !m.orReady) return false;
  const firstBreakoutIndex = m.sessionBars.findIndex(bar => bar.minute >= 9 * 60 + 45 && bar.close > m.orHigh!);
  if (firstBreakoutIndex < 0) return false;
  const age = Math.max(0, latest.minute - m.sessionBars[firstBreakoutIndex].minute);
  if (age < ADAPTIVE_LONG_RULE.secondChanceMinAgeMin || age > ADAPTIVE_LONG_RULE.secondChanceMaxAgeMin) return false;
  const between = m.sessionBars.slice(firstBreakoutIndex + 1, -1);
  const pullbackHeld = between.some(bar => (
    bar.low <= m.orHigh! + atr * ADAPTIVE_LONG_RULE.pullbackTouchAtr
    && bar.close >= m.orHigh! - atr * ADAPTIVE_LONG_RULE.pullbackHoldAtr
  ));
  const previous = m.sessionBars.at(-2);
  return Boolean(
    pullbackHeld
    && previous
    && latest.close > previous.close
    && latest.close > latest.open
    && latest.close > m.orHigh
    && latest.close > m.vwap
  );
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

const resizeLongDecision = (
  input: DayTradeDecisionInput,
  decision: DayTradeDecision,
  setupFactor: number,
): DayTradeDecision => {
  if (decision.entry === null || decision.riskPerShare === null || decision.riskPerShare <= 0) return decision;
  const regimeFactor = marketRegimeRiskFactor(input.marketMode);
  const riskBudget = Math.min(
    input.accountSizeUsd * (input.riskPerTradePct / 100) * setupFactor * regimeFactor * decision.phaseFactor,
    decision.remainingDailyRiskUsd,
  );
  const maxRiskShares = Math.floor(Math.max(0, riskBudget) / decision.riskPerShare);
  const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / decision.entry);
  const suggestedShares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));
  return {
    ...decision,
    suggestedShares,
    suggestedRiskUsd: suggestedShares * decision.riskPerShare,
  };
};

const pauseLong = (decision: DayTradeDecision, reason: string): DayTradeDecision => ({
  ...decision,
  direction: 'WAIT',
  label: 'WATCH · V6.3.3 LONG FILTER',
  reason,
  entry: null,
  stop: null,
  target1: null,
  target2: null,
  riskPerShare: null,
  suggestedShares: 0,
  suggestedRiskUsd: 0,
});

const tagNormalLong = (
  input: DayTradeDecisionInput,
  normal: DayTradeDecision,
  timingTag = '',
  timingFactor = 1,
): DayTradeDecision => {
  const isAPlus = normal.label.includes('A+ Profile');
  const setupFactor = isAPlus ? ADAPTIVE_LONG_RULE.aPlusRiskFactor : ADAPTIVE_LONG_RULE.aRiskFactor;
  const regimeFactor = marketRegimeRiskFactor(input.marketMode);
  const resized = resizeLongDecision(input, normal, setupFactor * timingFactor);
  const suffix = timingTag ? ` · ${timingTag}` : '';
  return {
    ...resized,
    label: `${normal.label} · ${input.marketMode}${suffix}`,
    reason: `${normal.reason} V6.3.3：Setup risk ${Math.round(setupFactor * 100)}% × Timing ${Math.round(timingFactor * 100)}% × Regime ${Math.round(regimeFactor * 100)}% × Session ${Math.round(normal.phaseFactor * 100)}%。`,
  };
};

const applyNormalLongTimingPolicy = (
  input: DayTradeDecisionInput,
  normal: DayTradeDecision,
): DayTradeDecision => {
  const minute = input.metrics.latestMinute;
  if (minute === null) return pauseLong(normal, 'V6.3.3：缺少盤中時間，僅觀察。');
  const isAPlus = normal.label.includes('A+ Profile');

  if (minute < ADAPTIVE_LONG_RULE.coreStartMinute) {
    if (isAPlus && input.dailyBias === 'LONG') {
      return tagNormalLong(input, normal, 'EARLY ALIGNED', ADAPTIVE_LONG_RULE.earlyAlignedAPlusFactor);
    }
    return pauseLong(normal, 'V6.3.3：09:50–10:15 ET 為價格發現期；只有 Daily LONG 的 A+ 可用半風險試單，其餘等待核心窗口。');
  }

  if (minute < ADAPTIVE_LONG_RULE.coreEndMinute) {
    if (input.dailyBias === 'SHORT') {
      return pauseLong(normal, 'V6.3.3：10:15–11:00 ET 雖為核心窗口，但 Daily Bias = SHORT，LONG 不逆日線趨勢。');
    }
    return tagNormalLong(input, normal);
  }

  if (minute < ADAPTIVE_LONG_RULE.continuationEndMinute) {
    if (input.dailyBias !== 'LONG') {
      return pauseLong(normal, 'V6.3.3：11:00–12:00 ET 僅保留 Daily LONG 的趨勢延續單。');
    }
    return tagNormalLong(input, normal, 'ALIGNED CONTINUATION', ADAPTIVE_LONG_RULE.alignedContinuationFactor);
  }

  return pauseLong(normal, 'V6.3.3：12:00 ET 後 LONG 新倉暫停；樣本顯示午盤後新突破的假突破成本偏高。');
};

const buildAdaptiveProbeLong = (
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
  if (minute < profile.minEntryMinute || rvol < profile.probeMinRvol || rvol >= profile.minRvol) return null;
  if (!m.orReady || m.orHigh === null || m.vwap === null) return null;
  if (!(price > m.vwap && m.vwapSlopeUp === true && m.benchmarkAboveVwap === true && rs > 0 && price > m.orHigh)) return null;
  if (base.longScore < ADAPTIVE_LONG_RULE.minLongScore || base.longScore - base.shortScore < ADAPTIVE_LONG_RULE.minScoreLead) return null;

  const inCore = minute >= ADAPTIVE_LONG_RULE.coreStartMinute && minute < ADAPTIVE_LONG_RULE.coreEndMinute;
  const inContinuation = minute >= ADAPTIVE_LONG_RULE.coreEndMinute && minute < ADAPTIVE_LONG_RULE.continuationEndMinute;
  if (inCore && input.dailyBias === 'SHORT') return null;
  if (inContinuation && input.dailyBias !== 'LONG') return null;
  if (!inCore && !inContinuation) return null;
  const timingFactor = inContinuation ? ADAPTIVE_LONG_RULE.alignedContinuationFactor : 1;
  const timingTag = inContinuation ? ' · ALIGNED CONTINUATION' : '';

  const atr = m.intradayAtr ?? Math.max(price * 0.002, 0.01);
  if (!isSecondChanceLong(input, atr)) return null;

  const entry = price;
  const candidates = [
    m.vwap - atr * 0.25,
    m.orHigh - atr * 0.20,
    m.recentLow !== null ? m.recentLow - atr * 0.10 : null,
  ].filter((v): v is number => v !== null && v < entry);
  const structural = candidates.length ? Math.max(...candidates) : entry - atr * 0.5;
  const stop = Math.max(0.01, Math.min(structural, entry - atr * profile.minStopAtr));
  const riskPerShare = Math.max(0.01, entry - stop);
  const target1 = entry + riskPerShare * profile.target1R;
  const target2 = entry + riskPerShare * profile.target2R;
  const regimeFactor = marketRegimeRiskFactor(input.marketMode);
  const riskBudget = Math.min(
    input.accountSizeUsd * (input.riskPerTradePct / 100) * ADAPTIVE_LONG_RULE.probeRiskFactor * timingFactor * regimeFactor * base.phaseFactor,
    base.remainingDailyRiskUsd,
  );
  const maxRiskShares = Math.floor(Math.max(0, riskBudget) / riskPerShare);
  const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / entry);
  const suggestedShares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));

  return {
    ...base,
    direction: 'LONG',
    label: `LONG · B+ PROBE · ${input.marketMode} · 2ND CHANCE${timingTag}`,
    reason: `V6.3.3 Probe：${profile.label} 首次突破後回測 OR15 並重新轉強；Price > VWAP、VWAP slope ↑、${profile.benchmark} > VWAP、RS ${rs.toFixed(2)}% > 0。RVOL ${rvol.toFixed(2)}x 尚未達 A 門檻，因此用 25% Probe risk × Timing ${Math.round(timingFactor * 100)}% × Regime ${Math.round(regimeFactor * 100)}% × Session ${Math.round(base.phaseFactor * 100)}%。`,
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
    reason: `V6.3.3 事件反轉：Gap ${m.gapPct?.toFixed(2)}%、RVOL ${m.rvol?.toFixed(2)}x、RS ${m.relativeStrengthPct?.toFixed(2)}%；OR15 Low 新鮮跌破（Age ${breakdownAgeMin}m ≤ ${EVENT_SHORT_RULE.maxBreakdownAgeMin}m），且 VWAP / Benchmark 同步轉弱；原型股 Stop ${stopPct.toFixed(2)}% ≤ ${EVENT_SHORT_RULE.maxUnderlyingStopPct.toFixed(1)}%。事件單使用 50% risk，再乘 Session factor。`,
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
  reason: `V6.3.3：一般 Short 子模型仍只觀察；只有嚴格 Event Reversal Short 可以進場。原訊號：${decision.reason}`,
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

  if (normal.direction === 'SHORT') return pauseNormalShort(normal);
  if (isEventShortOverride(input, base, profile)) return buildEventShortDecision(input, base, profile);
  if (normal.direction === 'LONG') return applyNormalLongTimingPolicy(input, normal);

  const probe = buildAdaptiveProbeLong(input, base, profile);
  if (probe) return probe;
  return normal;
};
