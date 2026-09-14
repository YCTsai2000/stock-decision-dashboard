export interface StockDataPoint {
  price: number;
  open?: number;
  high: number;
  low: number;
  volume: number;
  time: number;
}

export type DataProviderName = 'Massive' | 'Twelve Data' | 'Finnhub' | 'FMP' | 'FRED' | 'SEC' | 'Cache' | 'Proxy';

export interface SourceMeta {
  provider: DataProviderName;
  updatedAt: number;
  cached?: boolean;
  note?: string;
}

export interface HistoricalDataResult {
  data: StockDataPoint[] | null;
  source: SourceMeta | null;
  errors: string[];
}

export interface QuoteInfo {
  price: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  updatedAt: number | null;
  source: SourceMeta | null;
}

export interface MarketCapInfo {
  value: number | null;
  source: SourceMeta | null;
}

export interface CompanyProfileInfo {
  name: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  country: string | null;
  source: SourceMeta | null;
}

export interface EarningsInfo {
  nextDate: string | null;
  time: string | null;
  daysUntil: number | null;
  source: SourceMeta | null;
}

export interface SecFundamentalsInfo {
  cik: string | null;
  filingDate: string | null;
  form: string | null;
  revenue: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  source: SourceMeta | null;
  status: 'ok' | 'unavailable' | 'not-found';
}

export interface MacroSnapshot {
  tenYear: number | null;
  tenYearPrev: number | null;
  twoYear: number | null;
  twoYearPrev: number | null;
  yieldCurve: number | null;
  cpi: number | null;
  cpiYoY: number | null;
  updatedAt: number | null;
  source: SourceMeta | null;
  status: 'ok' | 'unavailable';
}

export interface ApiKeys {
  massive: string;
  finnhub: string;
  fmp: string;
  twelve: string;
  fred: string;
}

export interface ProviderAvailability {
  massive: boolean;
  finnhub: boolean;
  fmp: boolean;
  twelve: boolean;
  fred: boolean;
  sec: boolean;
}
