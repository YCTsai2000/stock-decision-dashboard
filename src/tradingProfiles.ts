import type { DayTradeDecision, DayTradeDecisionInput } from './intraday';

export type ProfileFamily = 'SEMICONDUCTOR' | 'SOFTWARE' | 'OPTICAL' | 'EV_GROWTH' | 'HARDWARE' | 'SPACE_IPO' | 'DEFAULT';

export interface TradingProfile {
  symbol: string;
  family: ProfileFamily;
  label: string;
  benchmark: string;
  secondaryBenchmark: string;
  minEntryMinute: number;
  minRvol: number;
  highConvictionRvol: number;
  minStopAtr: number;
  target1R: number;
  target2R: number;
  breakoutOnly: boolean;
  shortRequiresDailyShort: boolean;
  experimental?: boolean;
  note: string;
}

const BASE: Omit<TradingProfile, 'symbol' | 'family' | 'label' | 'benchmark' | 'secondaryBenchmark' | 'note'> = {
  minEntryMinute: 10 * 60,
  minRvol: 1.2,
  highConvictionRvol: 1.5,
  minStopAtr: 0.65,
  target1R: 1.75,
  target2R: 2.0,
  breakoutOnly: true,
  shortRequiresDailyShort: true,
};

const make = (profile: Partial<TradingProfile> & Pick<TradingProfile, 'symbol' | 'family' | 'label' | 'benchmark' | 'secondaryBenchmark' | 'note'>): TradingProfile => ({
  ...BASE,
  ...profile,
});

export const WATCHLIST = ['NVDA', 'AMD', 'LITE', 'ORCL', 'RMBS', 'CRM', 'TSLA', 'SPCX', 'MU', 'SNDK', 'AVGO', 'DELL'];

const PROFILES: Record<string, TradingProfile> = {
  NVDA: make({ symbol: 'NVDA', family: 'SEMICONDUCTOR', label: 'AI GPU / Semiconductor', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: '以 SOXX 做產業 RS，QQQ 作市場成長股背景。' }),
  AMD: make({ symbol: 'AMD', family: 'SEMICONDUCTOR', label: 'CPU / GPU / Semiconductor', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: '半導體波動較高；優先要求量能與 OR15 真突破。' }),
  AVGO: make({ symbol: 'AVGO', family: 'SEMICONDUCTOR', label: 'AI Networking / Semiconductor', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: '以 SOXX 為主，避免只因 QQQ 上漲就誤判個股相對強勢。' }),
  MU: make({ symbol: 'MU', family: 'SEMICONDUCTOR', label: 'Memory Semiconductor', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: '記憶體循環股，盤中 RS 以 SOXX 為主要比較。' }),
  SNDK: make({ symbol: 'SNDK', family: 'SEMICONDUCTOR', label: 'NAND / Storage', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: '儲存／記憶體題材，先用 SOXX 作可交易的產業 proxy。' }),
  RMBS: make({ symbol: 'RMBS', family: 'SEMICONDUCTOR', label: 'Memory Interface / Semiconductor IP', benchmark: 'SOXX', secondaryBenchmark: 'QQQ', note: 'IP 商業模式不同，但短線風險因子仍較接近半導體族群。' }),
  ORCL: make({ symbol: 'ORCL', family: 'SOFTWARE', label: 'Enterprise Software / Cloud', benchmark: 'IGV', secondaryBenchmark: 'QQQ', note: '以 IGV 判斷軟體族群同步性，QQQ 作次要市場背景。' }),
  CRM: make({ symbol: 'CRM', family: 'SOFTWARE', label: 'Enterprise SaaS', benchmark: 'IGV', secondaryBenchmark: 'QQQ', note: '軟體股應優先相對 IGV，而不是只與半導體／整體 Nasdaq 比。' }),
  LITE: make({ symbol: 'LITE', family: 'OPTICAL', label: 'Optical / Photonics', benchmark: 'XLK', secondaryBenchmark: 'QQQ', note: '目前用 XLK 作 sector proxy；未來可再加入 COHR/CIEN peer basket。' }),
  DELL: make({ symbol: 'DELL', family: 'HARDWARE', label: 'AI Infrastructure / Enterprise Hardware', benchmark: 'XLK', secondaryBenchmark: 'QQQ', note: 'DELL 以 XLK 作硬體/科技 sector proxy，QQQ 作次要 AI 成長市場背景。' }),
  TSLA: make({ symbol: 'TSLA', family: 'EV_GROWTH', label: 'EV / High-beta Growth', benchmark: 'XLY', secondaryBenchmark: 'QQQ', minStopAtr: 0.75, note: 'TSLA 高波動，停損下限提高到 0.75 ATR；XLY 為主要 sector proxy。' }),
  SPCX: make({ symbol: 'SPCX', family: 'SPACE_IPO', label: 'Space / New Listing', benchmark: 'XAR', secondaryBenchmark: 'QQQ', minRvol: 1.5, highConvictionRvol: 2.0, minStopAtr: 0.8, minEntryMinute: 10 * 60 + 15, experimental: true, note: '上市歷史較短，長週期統計不足；採較嚴格 RVOL、ATR 與 10:15 後條件，屬實驗型 profile。' }),
};

export const getTradingProfile = (symbol: string): TradingProfile => {
  const upper = symbol.trim().toUpperCase();
  return PROFILES[upper] ?? make({
    symbol: upper || 'UNKNOWN',
    family: 'DEFAULT',
    label: 'Default Growth / Large-cap',
    benchmark: 'QQQ',
    secondaryBenchmark: 'SPY',
    note: '尚未建立專屬產業 profile，先以 QQQ 作主要 benchmark。',
  });
};

const recomputeSizing = (input: DayTradeDecisionInput, base: DayTradeDecision, entry: number, riskPerShare: number) => {
  const riskBudget = Math.min(
    input.accountSizeUsd * (input.riskPerTradePct / 100) * base.phaseFactor,
    base.remainingDailyRiskUsd,
  );
  const maxRiskShares = Math.floor(Math.max(0, riskBudget) / riskPerShare);
  const maxAllocationShares = Math.floor((input.accountSizeUsd * (input.maxAllocationPct / 100)) / entry);
  const shares = Math.max(0, Math.min(maxRiskShares, maxAllocationShares));
  return { shares, riskUsd: shares * riskPerShare };
};

export const applyTradingProfile = (
  input: DayTradeDecisionInput,
  base: DayTradeDecision,
  profile: TradingProfile,
): DayTradeDecision => {
  if (base.hardBlock) return base;

  const m = input.metrics;
  const minute = m.latestMinute;
  const price = m.currentPrice;
  // Early in the session ATR(14) is not warmed up yet. Do not bypass the profile
  // stop floor; use the same conservative fallback as the core decision engine.
  const atr = m.intradayAtr ?? (price !== null ? Math.max(price * 0.002, 0.01) : null);
  const rvol = m.rvol;
  const brokeOrHigh = price !== null && m.orHigh !== null && m.orReady && price > m.orHigh;
  const brokeOrLow = price !== null && m.orLow !== null && m.orReady && price < m.orLow;

  const profileFailures: string[] = [];
  if (minute === null || minute < profile.minEntryMinute) profileFailures.push(`等待 ${String(Math.floor(profile.minEntryMinute / 60)).padStart(2, '0')}:${String(profile.minEntryMinute % 60).padStart(2, '0')} ET`);
  if (rvol === null || rvol < profile.minRvol) profileFailures.push(`RVOL < ${profile.minRvol.toFixed(1)}x`);

  if (base.direction === 'LONG') {
    if (profile.breakoutOnly && !brokeOrHigh) profileFailures.push('尚未真正突破 OR15 High');
  } else if (base.direction === 'SHORT') {
    if (profile.shortRequiresDailyShort && input.dailyBias !== 'SHORT') profileFailures.push('Short 僅在 Daily Bias = SHORT 時允許');
    if (!brokeOrLow) profileFailures.push('尚未跌破 OR15 Low');
  }

  if (base.direction !== 'WAIT' && profileFailures.length) {
    return {
      ...base,
      direction: 'WAIT',
      label: 'WATCH · Profile Filter',
      reason: `${profile.label}：${profileFailures.join('；')}。`,
      entry: null,
      stop: null,
      target1: null,
      target2: null,
      riskPerShare: null,
      suggestedShares: 0,
      suggestedRiskUsd: 0,
    };
  }

  if (base.direction === 'WAIT' || base.entry === null || price === null || atr === null || atr <= 0) return base;

  const entry = base.entry;
  const floorDistance = atr * profile.minStopAtr;
  let stop = base.stop;
  if (base.direction === 'LONG') {
    const maxAllowedStop = entry - floorDistance;
    stop = stop === null ? maxAllowedStop : Math.min(stop, maxAllowedStop);
  } else {
    const minAllowedStop = entry + floorDistance;
    stop = stop === null ? minAllowedStop : Math.max(stop, minAllowedStop);
  }

  const riskPerShare = Math.max(0.01, Math.abs(entry - stop));
  const target1 = base.direction === 'LONG' ? entry + riskPerShare * profile.target1R : entry - riskPerShare * profile.target1R;
  const target2 = base.direction === 'LONG' ? entry + riskPerShare * profile.target2R : entry - riskPerShare * profile.target2R;
  const sizing = recomputeSizing(input, base, entry, riskPerShare);
  const highConviction = rvol !== null && rvol >= profile.highConvictionRvol;

  return {
    ...base,
    label: highConviction ? `${base.direction} · A+ Profile` : `${base.direction} · A Profile`,
    reason: `${profile.label}：AUTO benchmark ${profile.benchmark}；RVOL ${rvol?.toFixed(2) ?? '—'}x，OR15 breakout 與 profile hard filters 通過。${highConviction ? ' 高量能達 A+ 門檻。' : ''}`,
    stop,
    target1,
    target2,
    riskPerShare,
    suggestedShares: sizing.shares,
    suggestedRiskUsd: sizing.riskUsd,
  };
};
