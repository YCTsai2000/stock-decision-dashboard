import type { CompanyProfileInfo, MarketCapInfo, StockDataPoint } from './types';

export type StockTier = 'MEGA' | 'LARGE' | 'GROWTH';
export type MarketMode = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export interface StrategyConfig {
  label: string;
  shortLabel: string;
  volumeMultiplier: number;
  breakoutVolumeMultiplier: number;
  rsiMin: number;
  rsiMax: number;
  maxExtensionATR: number;
  maxTechnicalRiskPct: number;
  atrStopBuffer: number;
}

export interface MarketRegime {
  mode: MarketMode;
  label: string;
  score: number;
  reason: string;
}

export const MARKET_BENCHMARKS = ['SPY', 'QQQ'];

export const STRATEGY_CONFIGS: Record<StockTier, StrategyConfig> = {
  MEGA: {
    label: '巨型權值股', shortLabel: '巨型權值', volumeMultiplier: 1.15, breakoutVolumeMultiplier: 1.25,
    rsiMin: 55, rsiMax: 72, maxExtensionATR: 1.35, maxTechnicalRiskPct: 0.06, atrStopBuffer: 0.35,
  },
  LARGE: {
    label: '大型股', shortLabel: '大型股', volumeMultiplier: 1.30, breakoutVolumeMultiplier: 1.45,
    rsiMin: 57, rsiMax: 74, maxExtensionATR: 1.15, maxTechnicalRiskPct: 0.075, atrStopBuffer: 0.45,
  },
  GROWTH: {
    label: '中小型／高波動股', shortLabel: '中小型', volumeMultiplier: 1.55, breakoutVolumeMultiplier: 1.75,
    rsiMin: 60, rsiMax: 76, maxExtensionATR: 0.95, maxTechnicalRiskPct: 0.09, atrStopBuffer: 0.60,
  },
};

const SECTOR_ETF_MAP: Record<string, string> = {
  technology: 'XLK', 'information technology': 'XLK', financials: 'XLF', 'financial services': 'XLF',
  healthcare: 'XLV', 'health care': 'XLV', 'consumer cyclical': 'XLY', 'consumer discretionary': 'XLY',
  'consumer defensive': 'XLP', 'consumer staples': 'XLP', industrials: 'XLI', energy: 'XLE', utilities: 'XLU',
  'real estate': 'XLRE', materials: 'XLB', 'basic materials': 'XLB', 'communication services': 'XLC', communications: 'XLC',
};

const SYMBOL_SECTOR_ETF_OVERRIDES: Record<string, string> = {
  NVDA: 'SOXX', AMD: 'SOXX', INTC: 'SOXX', MU: 'SOXX', AVGO: 'SOXX', MRVL: 'SOXX', ARM: 'SOXX', TSM: 'SOXX',
  AMAT: 'SOXX', LRCX: 'SOXX', KLAC: 'SOXX', QCOM: 'SOXX', TXN: 'SOXX',
  AAPL: 'XLK', MSFT: 'XLK', ORCL: 'XLK', DELL: 'XLK', SNDK: 'XLK', LITE: 'XLK', COHR: 'XLK',
  META: 'XLC', GOOGL: 'XLC', GOOG: 'XLC', NFLX: 'XLC',
  AMZN: 'XLY', TSLA: 'XLY',
};

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const formatMarketCap = (value: number | null): string => {
  if (!value || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
};

export const formatMoney = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
};

export const formatCompactMoney = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `${sign}$${(abs / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
};

export const calculateRSI = (data: StockDataPoint[] | undefined, period = 14): number | null => {
  if (!data || data.length <= period) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].price - data[i - 1].price;
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].price - data[i - 1].price;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

export const calculateMA = (data: StockDataPoint[] | undefined, period: number): number | null => {
  if (!data || data.length < period) return null;
  return data.slice(-period).reduce((sum, value) => sum + value.price, 0) / period;
};

export const calculateAvgVolume = (data: StockDataPoint[] | undefined, period: number): number | null => {
  if (!data || data.length < period) return null;
  return data.slice(-period).reduce((sum, value) => sum + value.volume, 0) / period;
};

const getTrueRanges = (data: StockDataPoint[]): number[] => {
  const result: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const prevClose = data[i - 1].price;
    result.push(Math.max(current.high - current.low, Math.abs(current.high - prevClose), Math.abs(current.low - prevClose)));
  }
  return result;
};

export const calculateATR = (data: StockDataPoint[] | undefined, period = 14): number | null => {
  if (!data || data.length <= period) return null;
  const trueRanges = getTrueRanges(data);
  if (trueRanges.length < period) return null;
  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < trueRanges.length; i++) atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  return atr;
};

export const calculateSimpleATR = (data: StockDataPoint[] | undefined, period: number): number | null => {
  if (!data || data.length <= period) return null;
  const trueRanges = getTrueRanges(data);
  if (trueRanges.length < period) return null;
  const sample = trueRanges.slice(-period);
  return sample.reduce((sum, value) => sum + value, 0) / sample.length;
};

export const calculateAverageDollarVolume = (data: StockDataPoint[] | undefined, period = 20): number | null => {
  if (!data || data.length < period) return null;
  const sample = data.slice(-period);
  return sample.reduce((sum, point) => sum + point.price * point.volume, 0) / sample.length;
};

export const calculateAnnualizedVolatility = (data: StockDataPoint[] | undefined, period = 20): number | null => {
  if (!data || data.length <= period) return null;
  const sample = data.slice(-(period + 1));
  const returns: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    if (sample[i - 1].price <= 0) continue;
    returns.push(Math.log(sample[i].price / sample[i - 1].price));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
};

export const calculateReturnPct = (data: StockDataPoint[] | undefined, period: number): number | null => {
  if (!data || data.length <= period) return null;
  const end = data[data.length - 1].price;
  const start = data[data.length - 1 - period].price;
  if (start <= 0) return null;
  return ((end / start) - 1) * 100;
};

export const calculateRelativeStrength = (stockData: StockDataPoint[] | undefined, benchmarkData: StockDataPoint[] | undefined, period: number): number | null => {
  const stockReturn = calculateReturnPct(stockData, period);
  const benchmarkReturn = calculateReturnPct(benchmarkData, period);
  if (stockReturn === null || benchmarkReturn === null) return null;
  return stockReturn - benchmarkReturn;
};

export const calculateVolumeQuality = (data: StockDataPoint[] | undefined, period = 20): number | null => {
  if (!data || data.length <= period) return null;
  const sample = data.slice(-(period + 1));
  const upVolumes: number[] = [];
  const downVolumes: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    if (sample[i].price >= sample[i - 1].price) upVolumes.push(sample[i].volume); else downVolumes.push(sample[i].volume);
  }
  if (!upVolumes.length || !downVolumes.length) return null;
  const upAvg = upVolumes.reduce((sum, value) => sum + value, 0) / upVolumes.length;
  const downAvg = downVolumes.reduce((sum, value) => sum + value, 0) / downVolumes.length;
  return downAvg > 0 ? upAvg / downAvg : null;
};

export const getRecentHigh = (data: StockDataPoint[], lookback: number, excludeCurrent = false): number => {
  const endIndex = excludeCurrent ? data.length - 1 : data.length;
  const startIndex = Math.max(0, endIndex - lookback);
  return Math.max(...data.slice(startIndex, endIndex).map(point => point.high));
};

export const getRecentLow = (data: StockDataPoint[], lookback: number, excludeCurrent = false): number => {
  const endIndex = excludeCurrent ? data.length - 1 : data.length;
  const startIndex = Math.max(0, endIndex - lookback);
  return Math.min(...data.slice(startIndex, endIndex).map(point => point.low));
};

export const findNearestSwingHigh = (data: StockDataPoint[], abovePrice: number, lookback = 120, wing = 2): number | null => {
  const start = Math.max(wing, data.length - lookback);
  const end = data.length - 1 - wing;
  const highs: number[] = [];
  for (let i = start; i <= end; i++) {
    const candidate = data[i].high;
    let isSwingHigh = true;
    for (let j = 1; j <= wing; j++) {
      if (candidate <= data[i - j].high || candidate <= data[i + j].high) { isSwingHigh = false; break; }
    }
    if (isSwingHigh && candidate > abovePrice * 1.01) highs.push(candidate);
  }
  return highs.length ? Math.min(...highs) : null;
};

export const classifyStock = (data: StockDataPoint[], marketCapInfo?: MarketCapInfo): { tier: StockTier; reason: string; isProxy: boolean } => {
  const marketCap = marketCapInfo?.value ?? null;
  if (marketCap && marketCap > 0) {
    if (marketCap >= 200_000_000_000) return { tier: 'MEGA', reason: `市值 ${formatMarketCap(marketCap)} ≥ $200B`, isProxy: false };
    if (marketCap >= 50_000_000_000) return { tier: 'LARGE', reason: `市值 ${formatMarketCap(marketCap)} ≥ $50B`, isProxy: false };
    return { tier: 'GROWTH', reason: `市值 ${formatMarketCap(marketCap)} < $50B`, isProxy: false };
  }
  const avgDollarVolume = calculateAverageDollarVolume(data, 20) ?? 0;
  const annualizedVol = calculateAnnualizedVolatility(data, 20) ?? 1;
  if (avgDollarVolume >= 1_500_000_000 && annualizedVol <= 0.75) return { tier: 'MEGA', reason: `代理：20日均美元量 ${(avgDollarVolume / 1_000_000_000).toFixed(1)}B／日`, isProxy: true };
  if (avgDollarVolume >= 400_000_000) return { tier: 'LARGE', reason: `代理：20日均美元量 ${(avgDollarVolume / 1_000_000).toFixed(0)}M／日`, isProxy: true };
  return { tier: 'GROWTH', reason: '代理：成交額較小或波動較高', isProxy: true };
};

export const getSectorEtf = (symbol: string, profileInfo?: CompanyProfileInfo): string => {
  const upper = symbol.toUpperCase();
  if (SYMBOL_SECTOR_ETF_OVERRIDES[upper]) return SYMBOL_SECTOR_ETF_OVERRIDES[upper];
  const industry = profileInfo?.industry?.toLowerCase() ?? '';
  if (industry.includes('semiconductor')) return 'SOXX';
  const sector = profileInfo?.sector?.toLowerCase() ?? '';
  return SECTOR_ETF_MAP[sector] ?? 'QQQ';
};

export const evaluateMarketRegime = (spyData: StockDataPoint[] | undefined, qqqData: StockDataPoint[] | undefined): MarketRegime => {
  if (!spyData || !qqqData || spyData.length < 50 || qqqData.length < 50) {
    return { mode: 'NEUTRAL', label: '市場資料不足', score: 8, reason: 'SPY/QQQ 資料不足，暫不做強方向判斷。' };
  }
  const spyPrice = spyData[spyData.length - 1].price;
  const qqqPrice = qqqData[qqqData.length - 1].price;
  const spy20 = calculateMA(spyData, 20)!;
  const spy50 = calculateMA(spyData, 50)!;
  const qqq20 = calculateMA(qqqData, 20)!;
  const qqq50 = calculateMA(qqqData, 50)!;
  const spyBull = spyPrice > spy20 && spy20 > spy50;
  const qqqBull = qqqPrice > qqq20 && qqq20 > qqq50;
  const spyBear = spyPrice < spy20 && spy20 < spy50;
  const qqqBear = qqqPrice < qqq20 && qqq20 < qqq50;
  if (spyBull && qqqBull) return { mode: 'RISK_ON', label: 'Risk-On', score: 15, reason: 'SPY、QQQ 均在 20MA 上方，且 20MA > 50MA。' };
  if (spyBear && qqqBear) return { mode: 'RISK_OFF', label: 'Risk-Off', score: 0, reason: 'SPY、QQQ 均跌破 20MA，且 20MA < 50MA。' };
  return { mode: 'NEUTRAL', label: 'Neutral', score: 8, reason: 'SPY 與 QQQ 趨勢不同步，降低進場部位。' };
};
