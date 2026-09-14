export type ExecutionSide = 'LONG' | 'SHORT';
export type LiquidityTier = 'EXCELLENT' | 'GOOD' | 'MARGINAL' | 'POOR' | 'VERIFY';

export interface LeveragedExecution {
  ticker: string;
  leverage: number;
  side: ExecutionSide;
  label: string;
  liquidityTier: LiquidityTier;
  baselineVolume?: number;
  baselineDate?: string;
  note?: string;
}

export interface TradingInstrument {
  underlying: string;
  longExecution: LeveragedExecution | null;
  shortExecution: LeveragedExecution | null;
}

// Liquidity snapshot is a routing aid, not a permanent ranking. The live app must still check quote freshness and spread.
// Baseline volumes use the most recently verified completed session where available (2026-09-11).
const EXECUTION_MAP: Record<string, TradingInstrument> = {
  NVDA: {
    underlying: 'NVDA',
    longExecution: { ticker: 'NVDL', leverage: 2, side: 'LONG', label: 'GraniteShares 2x Long NVDA', liquidityTier: 'EXCELLENT', baselineVolume: 8_826_984, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'NVD', leverage: -2, side: 'SHORT', label: 'GraniteShares 2x Short NVDA', liquidityTier: 'EXCELLENT', baselineVolume: 74_575_000, baselineDate: '2026-09-11' },
  },
  AMD: {
    underlying: 'AMD',
    longExecution: { ticker: 'AMDL', leverage: 2, side: 'LONG', label: 'GraniteShares 2x Long AMD', liquidityTier: 'GOOD', baselineVolume: 1_825_000, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'DAMD', leverage: -2, side: 'SHORT', label: 'Defiance 2X Short AMD', liquidityTier: 'GOOD', baselineVolume: 1_819_000, baselineDate: '2026-09-11' },
  },
  LITE: {
    underlying: 'LITE',
    longExecution: { ticker: 'LITX', leverage: 2, side: 'LONG', label: 'Tradr 2X Long LITE', liquidityTier: 'GOOD', baselineVolume: 2_420_000, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'LITZ', leverage: -2, side: 'SHORT', label: 'Tradr 2X Short LITE', liquidityTier: 'GOOD', baselineVolume: 3_700_000, baselineDate: '2026-09-11' },
  },
  ORCL: {
    underlying: 'ORCL',
    longExecution: { ticker: 'ORCU', leverage: 2, side: 'LONG', label: 'Direxion Daily ORCL Bull 2X', liquidityTier: 'EXCELLENT', baselineVolume: 17_111_000, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'ORCZ', leverage: -2, side: 'SHORT', label: 'Tradr 2X Short ORCL', liquidityTier: 'MARGINAL', baselineVolume: 999_520, baselineDate: '2026-09-11' },
  },
  RMBS: {
    underlying: 'RMBS',
    longExecution: { ticker: 'RMBX', leverage: 2, side: 'LONG', label: 'Tradr 2X Long RMBS', liquidityTier: 'POOR', baselineVolume: 7_631, baselineDate: '2026-08-06', note: 'Very low historical liquidity; require live spread/volume confirmation.' },
    shortExecution: null,
  },
  CRM: {
    underlying: 'CRM',
    longExecution: { ticker: 'CRMG', leverage: 2, side: 'LONG', label: 'Leverage Shares 2X Long CRM', liquidityTier: 'MARGINAL', baselineVolume: 1_049_000, baselineDate: '2026-09-11' },
    shortExecution: null,
  },
  TSLA: {
    underlying: 'TSLA',
    longExecution: { ticker: 'TSLL', leverage: 2, side: 'LONG', label: 'Direxion Daily TSLA Bull 2X', liquidityTier: 'EXCELLENT', baselineVolume: 50_390_000, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'TSDD', leverage: -2, side: 'SHORT', label: 'GraniteShares 2x Short TSLA', liquidityTier: 'EXCELLENT', baselineVolume: 5_834_467, baselineDate: '2026-09-11' },
  },
  SPCX: {
    underlying: 'SPCX',
    longExecution: { ticker: 'SPCH', leverage: 2, side: 'LONG', label: 'Leverage Shares 2X Long SPCX', liquidityTier: 'EXCELLENT', baselineVolume: 25_195_000, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'SSPC', leverage: -2, side: 'SHORT', label: 'Leverage Shares 2X Short SPCX', liquidityTier: 'EXCELLENT', baselineVolume: 9_195_000, baselineDate: '2026-09-11' },
  },
  MU: {
    underlying: 'MU',
    longExecution: { ticker: 'MUU', leverage: 2, side: 'LONG', label: 'Direxion Daily MU Bull 2X', liquidityTier: 'EXCELLENT', baselineVolume: 15_953_261, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'MUZ', leverage: -2, side: 'SHORT', label: 'Defiance 2X Short MU', liquidityTier: 'EXCELLENT', baselineVolume: 8_429_197, baselineDate: '2026-09-11' },
  },
  SNDK: {
    underlying: 'SNDK',
    longExecution: { ticker: 'SNXX', leverage: 2, side: 'LONG', label: 'Tradr 2X Long SNDK', liquidityTier: 'EXCELLENT', baselineVolume: 56_391_166, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'SNDQ', leverage: -2, side: 'SHORT', label: 'Tradr 2X Short SNDK', liquidityTier: 'EXCELLENT', baselineVolume: 24_260_000, baselineDate: '2026-09-11' },
  },
  AVGO: {
    underlying: 'AVGO',
    longExecution: { ticker: 'AVL', leverage: 2, side: 'LONG', label: 'Direxion Daily AVGO Bull 2X', liquidityTier: 'MARGINAL', baselineVolume: 572_587, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'AVGS', leverage: -2, side: 'SHORT', label: 'GraniteShares 2x Short AVGO', liquidityTier: 'VERIFY', note: 'Active -2x vehicle verified; current live liquidity must pass spread/volume gate.' },
  },
  DELL: {
    underlying: 'DELL',
    longExecution: { ticker: 'DLLL', leverage: 2, side: 'LONG', label: 'GraniteShares 2x Long DELL', liquidityTier: 'GOOD', baselineVolume: 3_111_784, baselineDate: '2026-09-11' },
    shortExecution: { ticker: 'DLLS', leverage: -2, side: 'SHORT', label: 'GraniteShares 2x Short DELL', liquidityTier: 'VERIFY', note: 'Active -2x vehicle verified; current live liquidity must pass spread/volume gate.' },
  },
};

export const getTradingInstrument = (symbol: string): TradingInstrument => {
  const upper = symbol.trim().toUpperCase();
  return EXECUTION_MAP[upper] ?? { underlying: upper, longExecution: null, shortExecution: null };
};

export const getExecutionForDirection = (symbol: string, direction: 'LONG' | 'SHORT' | 'WAIT') => {
  const instrument = getTradingInstrument(symbol);
  if (direction === 'LONG') return instrument.longExecution;
  if (direction === 'SHORT') return instrument.shortExecution;
  return null;
};

export const getAllExecutionTickers = (symbol: string) => {
  const instrument = getTradingInstrument(symbol);
  return [instrument.longExecution?.ticker, instrument.shortExecution?.ticker].filter((v): v is string => Boolean(v));
};

export const liquidityTierScore = (tier: LiquidityTier): number => ({ EXCELLENT: 20, GOOD: 16, MARGINAL: 10, VERIFY: 6, POOR: 2 }[tier]);

export const executionMappings = EXECUTION_MAP;
