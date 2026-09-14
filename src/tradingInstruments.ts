export interface TradingInstrument {
  underlying: string;
  execution: string;
  leverage: number;
  longOnly: boolean;
  label: string;
}

const LEVERAGED_EXECUTION: Record<string, TradingInstrument> = {
  NVDA: { underlying: 'NVDA', execution: 'NVDX', leverage: 2, longOnly: true, label: 'T-REX 2X Long NVDA' },
  LITE: { underlying: 'LITE', execution: 'LITX', leverage: 2, longOnly: true, label: 'Tradr 2X Long LITE' },
  ORCL: { underlying: 'ORCL', execution: 'ORCX', leverage: 2, longOnly: true, label: 'Defiance 2X Long ORCL' },
  TSLA: { underlying: 'TSLA', execution: 'TSLL', leverage: 2, longOnly: true, label: 'Direxion 2X Long TSLA' },
  MU: { underlying: 'MU', execution: 'MUU', leverage: 2, longOnly: true, label: 'Direxion 2X Long MU' },
  SNDK: { underlying: 'SNDK', execution: 'SNXX', leverage: 2, longOnly: true, label: 'Tradr 2X Long SNDK' },
  DELL: { underlying: 'DELL', execution: 'DLLL', leverage: 2, longOnly: true, label: 'GraniteShares 2X Long DELL' },
};

export const getTradingInstrument = (symbol: string): TradingInstrument => {
  const upper = symbol.trim().toUpperCase();
  return LEVERAGED_EXECUTION[upper] ?? {
    underlying: upper,
    execution: upper,
    leverage: 1,
    longOnly: false,
    label: 'Direct underlying execution',
  };
};

export const hasLeveragedExecution = (symbol: string) => getTradingInstrument(symbol).execution !== getTradingInstrument(symbol).underlying;

export const executionMappings = LEVERAGED_EXECUTION;
