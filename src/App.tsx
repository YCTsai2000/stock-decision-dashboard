import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart2,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  Gauge,
  Layers,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  WalletCards,
  Zap,
} from 'lucide-react';
import type {
  ApiKeys,
  CompanyProfileInfo,
  EarningsInfo,
  MacroSnapshot,
  MarketCapInfo,
  QuoteInfo,
  SecFundamentalsInfo,
  SourceMeta,
  StockDataPoint,
} from './types';
import {
  MARKET_BENCHMARKS,
  STRATEGY_CONFIGS,
  calculateATR,
  calculateAvgVolume,
  calculateMA,
  calculateRelativeStrength,
  calculateRSI,
  calculateSimpleATR,
  calculateVolumeQuality,
  clamp,
  classifyStock,
  evaluateMarketRegime,
  findNearestSwingHigh,
  formatCompactMoney,
  formatMarketCap,
  formatMoney,
  getRecentHigh,
  getRecentLow,
  getSectorEtf,
  type MarketRegime,
} from './analysis';
import {
  clearDataCache,
  fetchCompanyProfileAndMarketCap,
  fetchHistoricalData,
  fetchMacroSnapshot,
  fetchNextEarnings,
  fetchQuote,
  fetchSecFundamentals,
  hasAnyHistoricalPriceKey,
} from './dataLayer';
import { hasProviderAccess, isApiProxyConfigured } from './apiProxy';

const REFRESH_SECONDS = 300;
const MAX_SYMBOLS = 8;
const DEFAULT_SYMBOLS = ['DELL', 'NVDA', 'AAPL', 'TSM'];
const EMPTY_KEYS: ApiKeys = { massive: '', finnhub: '', fmp: '', twelve: '', fred: '' };

interface Condition {
  name: string;
  met: boolean;
  desc: string;
}

interface StockCardProps {
  symbol: string;
  data: StockDataPoint[] | undefined;
  priceSource?: SourceMeta | null;
  quote?: QuoteInfo;
  qqqData: StockDataPoint[] | undefined;
  sectorEtf: string;
  sectorData: StockDataPoint[] | undefined;
  marketRegime: MarketRegime;
  marketCapInfo?: MarketCapInfo;
  profileInfo?: CompanyProfileInfo;
  earningsInfo?: EarningsInfo;
  secInfo?: SecFundamentalsInfo;
  accountSizeUsd: number;
  riskPct: number;
  maxAllocationPct: number;
  error?: string;
  onRemove: (symbol: string) => void;
}

const loadStoredKeys = (): ApiKeys => {
  if (typeof window === 'undefined') return EMPTY_KEYS;
  try {
    const raw = localStorage.getItem('stockDecisionApiKeys');
    if (!raw) return EMPTY_KEYS;
    return { ...EMPTY_KEYS, ...(JSON.parse(raw) as Partial<ApiKeys>) };
  } catch {
    return EMPTY_KEYS;
  }
};

const loadStoredSymbols = (): string[] => {
  if (typeof window === 'undefined') return DEFAULT_SYMBOLS;
  try {
    const raw = localStorage.getItem('stockDecisionSymbols');
    if (!raw) return DEFAULT_SYMBOLS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed.slice(0, MAX_SYMBOLS) : DEFAULT_SYMBOLS;
  } catch {
    return DEFAULT_SYMBOLS;
  }
};

const formatProviderTime = (source?: SourceMeta | null) => {
  if (!source?.updatedAt) return '';
  return new Date(source.updatedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const SourceBadge = ({ source }: { source?: SourceMeta | null }) => {
  if (!source) return <span className="text-[10px] text-slate-600">source —</span>;
  const official = source.provider === 'SEC' || source.provider === 'FRED';
  const cls = official
    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
    : source.provider === 'Cache'
      ? 'bg-slate-700/40 border-slate-600 text-slate-400'
      : 'bg-sky-500/10 border-sky-500/25 text-sky-300';
  return (
    <span title={`${source.note ?? ''} ${formatProviderTime(source)}`} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${cls}`}>
      <Database size={9} /> {source.provider}{source.cached ? ' cache' : ''}
    </span>
  );
};

const ProviderSettings = ({
  keys,
  setKeys,
  onClearCache,
}: {
  keys: ApiKeys;
  setKeys: React.Dispatch<React.SetStateAction<ApiKeys>>;
  onClearCache: () => void;
}) => {
  const rows: Array<{ key: keyof ApiKeys; label: string; role: string; priority: string }> = [
    { key: 'massive', label: 'Massive', role: '歷史 OHLCV 主來源', priority: '日 K / SPY / QQQ / 產業 ETF' },
    { key: 'finnhub', label: 'Finnhub', role: '報價與事件主來源', priority: 'Quote / Profile / Earnings' },
    { key: 'fmp', label: 'FMP', role: '公司資料備援', priority: 'Market Cap / Sector / Earnings fallback' },
    { key: 'twelve', label: 'Twelve Data', role: '歷史價格備援', priority: 'Massive 失敗時自動接手' },
    { key: 'fred', label: 'FRED', role: '官方總經資料', priority: '10Y / 2Y / CPI' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
      {rows.map(row => (
        <div key={row.key} className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
          <div className="flex justify-between items-start gap-2 mb-2">
            <div>
              <div className="font-bold text-slate-200 text-sm flex items-center gap-2">
                {row.label}
                <span className={`h-2 w-2 rounded-full ${keys[row.key].trim() ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">{row.role}</div>
            </div>
          </div>
          <input
            type="password"
            value={keys[row.key]}
            onChange={e => setKeys(prev => ({ ...prev, [row.key]: e.target.value }))}
            placeholder={`${row.label} API Key`}
            autoComplete="off"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
          />
          <div className="text-[10px] text-slate-600 mt-2">{row.priority}</div>
        </div>
      ))}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 flex flex-col justify-between">
        <div>
          <div className="font-bold text-slate-200 text-sm">SEC EDGAR</div>
          <div className="text-[10px] text-slate-500 mt-1">不需要 API Key。嘗試直接讀取官方 Company Facts；若瀏覽器 CORS / SEC 存取政策阻擋，會自動標示不可用，不影響技術分析。</div>
        </div>
        <button onClick={onClearCache} className="mt-3 text-xs border border-slate-700 hover:border-rose-500/50 hover:text-rose-300 rounded-lg px-3 py-2 transition-colors">
          清除資料快取
        </button>
      </div>
    </div>
  );
};

const MacroPanel = ({ macro }: { macro: MacroSnapshot }) => {
  const tenRising = macro.tenYear !== null && macro.tenYearPrev !== null && macro.tenYear > macro.tenYearPrev;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Gauge size={18} className="text-cyan-400" />
          <div>
            <h2 className="font-bold text-slate-200">總經環境</h2>
            <p className="text-[10px] text-slate-500">總經目前作為風險背景，不直接覆蓋技術面 Hard Filter。</p>
          </div>
        </div>
        <SourceBadge source={macro.source} />
      </div>
      {macro.status === 'ok' ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="metric-box"><span>10Y</span><strong className={tenRising ? 'text-amber-300' : 'text-emerald-300'}>{macro.tenYear?.toFixed(2)}%</strong></div>
          <div className="metric-box"><span>2Y</span><strong>{macro.twoYear?.toFixed(2)}%</strong></div>
          <div className="metric-box"><span>10Y−2Y</span><strong className={(macro.yieldCurve ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{macro.yieldCurve === null ? '—' : `${macro.yieldCurve >= 0 ? '+' : ''}${macro.yieldCurve.toFixed(2)}%`}</strong></div>
          <div className="metric-box"><span>CPI YoY</span><strong>{macro.cpiYoY === null ? '—' : `${macro.cpiYoY.toFixed(2)}%`}</strong></div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">尚未取得 FRED 資料。若需要總經欄位，請在資料來源設定加入 FRED API Key。</div>
      )}
    </div>
  );
};

const StockCard = ({
  symbol,
  data,
  priceSource,
  quote,
  qqqData,
  sectorEtf,
  sectorData,
  marketRegime,
  marketCapInfo,
  profileInfo,
  earningsInfo,
  secInfo,
  accountSizeUsd,
  riskPct,
  maxAllocationPct,
  error,
  onRemove,
}: StockCardProps) => {
  if (!data || data.length < 60) {
    return (
      <div className="bg-slate-800/80 rounded-2xl p-5 border border-slate-700 flex flex-col justify-center items-center min-h-[360px] relative">
        <button onClick={() => onRemove(symbol)} className="absolute top-4 right-4 text-slate-500 hover:text-rose-400"><Trash2 size={18} /></button>
        <Activity className="text-slate-600 animate-pulse mb-3" size={32} />
        <h3 className="text-xl font-bold text-slate-300 mb-1">{symbol}</h3>
        <p className="text-slate-500 text-sm text-center">{error || '載入中或日 K 資料不足（至少需要 60 個交易日）...'}</p>
      </div>
    );
  }

  const currentData = data[data.length - 1];
  const prevData = data[data.length - 2];
  const dailyClose = currentData.price;
  const executionPrice = quote?.price && quote.price > 0 ? quote.price : dailyClose;
  const dailyChange = dailyClose - prevData.price;
  const dailyPct = (dailyChange / prevData.price) * 100;
  const displayChange = quote?.change ?? dailyChange;
  const displayPct = quote?.changePct ?? dailyPct;
  const isUp = displayChange >= 0;

  const ma10 = calculateMA(data, 10)!;
  const ma20 = calculateMA(data, 20)!;
  const ma60 = calculateMA(data, 60)!;
  const avgVol20 = calculateAvgVolume(data, 20)!;
  const rsi14 = calculateRSI(data, 14)!;
  const atr14 = calculateATR(data, 14)!;
  const atr5Simple = calculateSimpleATR(data, 5) ?? atr14;
  const atr20Simple = calculateSimpleATR(data, 20) ?? atr14;
  const atrContractionRatio = atr20Simple > 0 ? atr5Simple / atr20Simple : 1;
  const volumeRatio = avgVol20 > 0 ? currentData.volume / avgVol20 : 0;
  const volumeQuality = calculateVolumeQuality(data, 20) ?? 1;

  const classification = classifyStock(data, marketCapInfo);
  const config = STRATEGY_CONFIGS[classification.tier];
  const prior20High = getRecentHigh(data, 20, true);
  const recent10Low = getRecentLow(data, 10, true);
  const extensionATR = atr14 > 0 ? (executionPrice - ma10) / atr14 : 0;

  const trendHealthy = executionPrice > ma20 && ma20 > ma60;
  const shortMomentum = ma10 > ma20;
  const volumeHealthy = volumeRatio >= config.volumeMultiplier;
  const rsiHealthy = rsi14 >= config.rsiMin && rsi14 <= config.rsiMax;
  const notOverextended = extensionATR <= config.maxExtensionATR;
  const breakout = dailyClose > prior20High && volumeRatio >= config.breakoutVolumeMultiplier;
  const pullback = executionPrice >= ma20 && executionPrice <= ma10 + atr14 * 0.45 && shortMomentum;
  const pullbackOnLightVolume = pullback && volumeRatio <= 1.05;
  const volatilityContracting = atrContractionRatio <= 0.85;

  const sectorPrice = sectorData?.[sectorData.length - 1]?.price ?? null;
  const sectorMa20 = calculateMA(sectorData, 20);
  const sectorMa60 = calculateMA(sectorData, 60);
  const sectorTrendHealthy = sectorPrice !== null && sectorMa20 !== null && sectorMa60 !== null
    ? sectorPrice > sectorMa20 && sectorMa20 > sectorMa60
    : false;

  const rs20Market = calculateRelativeStrength(data, qqqData, 20);
  const rs60Market = calculateRelativeStrength(data, qqqData, 60);
  const rs20Sector = calculateRelativeStrength(data, sectorData, 20);

  const entryLower = breakout ? prior20High : Math.max(ma20, ma10 - atr14 * 0.50);
  const entryUpper = breakout ? prior20High + atr14 * 0.60 : ma10 + atr14 * 0.45;
  const referenceEntry = clamp(executionPrice, entryLower, Math.max(entryLower, entryUpper));
  const nearEntryZone = executionPrice >= entryLower && executionPrice <= entryUpper;
  const stopFromMA = ma20 - atr14 * config.atrStopBuffer;
  const stopFromSwing = recent10Low - atr14 * 0.20;
  const technicalStop = Math.max(0.01, Math.min(stopFromMA, stopFromSwing));
  const riskPerShare = Math.max(0.01, referenceEntry - technicalStop);
  const technicalRiskPct = riskPerShare / referenceEntry;
  const riskTooWide = technicalRiskPct > config.maxTechnicalRiskPct;
  const nearestResistance = findNearestSwingHigh(data, referenceEntry, 120, 2);
  const rewardRiskToResistance = nearestResistance ? (nearestResistance - referenceEntry) / riskPerShare : 2.5;
  const rrTooLow = nearestResistance !== null && rewardRiskToResistance < 1.5;
  const takeProfit1 = referenceEntry + riskPerShare * 1.5;
  const takeProfit2 = referenceEntry + riskPerShare * 2.5;

  const earningsDays = earningsInfo?.daysUntil ?? null;
  const earningsVerified = Boolean(earningsInfo?.nextDate && earningsInfo?.source);
  const earningsHardBlock = earningsVerified && earningsDays !== null && earningsDays <= 2;
  const earningsCaution = earningsVerified && earningsDays !== null && earningsDays >= 3 && earningsDays <= 7;

  const marketScore = marketRegime.score;
  const sectorScore = sectorTrendHealthy ? 10 : (sectorData ? 3 : 5);
  let relativeStrengthScore = 0;
  if ((rs20Market ?? -999) > 0) relativeStrengthScore += 5;
  if ((rs60Market ?? -999) > 0) relativeStrengthScore += 5;
  if ((rs20Sector ?? -999) > 0) relativeStrengthScore += 5;
  const trendScore = (trendHealthy ? 10 : 0) + (shortMomentum ? 5 : 0);
  const volumeScore = (volumeHealthy ? 5 : 0) + (volumeQuality >= 1.10 ? 5 : 0);
  const rsiScore = rsiHealthy ? 5 : 0;
  const setupScore = (volatilityContracting ? 4 : 0) + ((breakout || pullbackOnLightVolume) ? 6 : 0);
  const entryScore = nearEntryZone ? 10 : (notOverextended ? 4 : 0);
  const rrScore = rewardRiskToResistance >= 2.5 ? 10 : rewardRiskToResistance >= 2 ? 8 : rewardRiskToResistance >= 1.5 ? 5 : 0;
  const rawScore = marketScore + sectorScore + relativeStrengthScore + trendScore + volumeScore + rsiScore + setupScore + entryScore + rrScore;
  const eventPenalty = earningsCaution ? 8 : 0;
  const totalScore = Math.max(0, Math.min(100, rawScore - eventPenalty));
  const grade = totalScore >= 85 ? 'A' : totalScore >= 70 ? 'B' : totalScore >= 55 ? 'C' : 'D';
  const gradeLabel = grade === 'A' ? 'A級機會' : grade === 'B' ? 'B級機會' : grade === 'C' ? '觀察名單' : '暫避';

  const tooExtended = !notOverextended || rsi14 > config.rsiMax;
  const hardBlock = earningsHardBlock || marketRegime.mode === 'RISK_OFF' || !trendHealthy || riskTooWide || rrTooLow;
  const setupReady = breakout || pullbackOnLightVolume;
  const tradeEligible = !hardBlock && !tooExtended && nearEntryZone && setupReady && (grade === 'A' || grade === 'B');

  let signalText = '';
  let signalSubtext = '';
  let signalColor = '';
  let signalBg = '';
  let SignalIcon = Activity;

  if (earningsHardBlock) {
    signalText = '財報事件：暫停建立新倉';
    signalSubtext = `距離財報約 ${earningsDays} 天，跳空風險大於技術停損可控制範圍。`;
    signalColor = 'text-rose-400'; signalBg = 'bg-rose-500/10 border-rose-500/30'; SignalIcon = CalendarDays;
  } else if (marketRegime.mode === 'RISK_OFF') {
    signalText = '大盤 Risk-Off：暫不逆勢進場';
    signalSubtext = marketRegime.reason;
    signalColor = 'text-rose-400'; signalBg = 'bg-rose-500/10 border-rose-500/30'; SignalIcon = ShieldAlert;
  } else if (!trendHealthy) {
    signalText = '個股趨勢失效：不進場';
    signalSubtext = '執行價格／20MA／60MA 尚未形成健康中期多頭。';
    signalColor = 'text-rose-400'; signalBg = 'bg-rose-500/10 border-rose-500/30'; SignalIcon = ShieldAlert;
  } else if (riskTooWide) {
    signalText = '停損距離過大：放棄此價位';
    signalSubtext = `技術風險約 ${(technicalRiskPct * 100).toFixed(1)}%，超過 ${config.shortLabel} ${(config.maxTechnicalRiskPct * 100).toFixed(1)}% 上限。`;
    signalColor = 'text-rose-300'; signalBg = 'bg-rose-500/10 border-rose-500/30'; SignalIcon = ShieldAlert;
  } else if (rrTooLow) {
    signalText = '風報比不足：等待更低進場點';
    signalSubtext = `上方最近阻力約 $${nearestResistance?.toFixed(2)}，Reward/Risk 僅 ${rewardRiskToResistance.toFixed(2)}。`;
    signalColor = 'text-rose-300'; signalBg = 'bg-rose-500/10 border-rose-500/30'; SignalIcon = Target;
  } else if (tooExtended) {
    signalText = '動能強但過熱：等待拉回';
    signalSubtext = `目前距 10MA 約 ${extensionATR.toFixed(2)} ATR，不建議追價。`;
    signalColor = 'text-amber-400'; signalBg = 'bg-amber-500/10 border-amber-500/30'; SignalIcon = Clock;
  } else if (tradeEligible && breakout) {
    signalText = `${gradeLabel} · 突破型進場`;
    signalSubtext = '大盤／產業／相對強弱通過，前一完整日 K 已突破前高並有量能確認。';
    signalColor = 'text-emerald-400'; signalBg = 'bg-emerald-500/10 border-emerald-500/30'; SignalIcon = Zap;
  } else if (tradeEligible && pullbackOnLightVolume) {
    signalText = `${gradeLabel} · 縮量回踩進場`;
    signalSubtext = '多頭結構未破且回踩縮量，風報比通常優於追突破。';
    signalColor = 'text-emerald-400'; signalBg = 'bg-emerald-500/10 border-emerald-500/30'; SignalIcon = Zap;
  } else if (grade === 'A' || grade === 'B') {
    signalText = `${gradeLabel} · 等待價格進入交易區`;
    signalSubtext = '整體品質合格，但尚未出現可執行的突破／縮量回踩。';
    signalColor = 'text-amber-400'; signalBg = 'bg-amber-500/10 border-amber-500/30'; SignalIcon = Activity;
  } else {
    signalText = `${gradeLabel} · 暫不進場`;
    signalSubtext = '條件仍有缺口，等待市場、產業或個股結構改善。';
    signalColor = 'text-slate-400'; signalBg = 'bg-slate-700/30 border-slate-700'; SignalIcon = Clock;
  }

  const riskBudget = Math.max(0, accountSizeUsd * (riskPct / 100));
  const allocationBudget = Math.max(0, accountSizeUsd * (maxAllocationPct / 100));
  const sharesByRisk = Math.floor(riskBudget / riskPerShare);
  const sharesByAllocation = Math.floor(allocationBudget / Math.max(referenceEntry, 0.01));
  const baseMaxShares = Math.max(0, Math.min(sharesByRisk, sharesByAllocation));
  let positionFactor = grade === 'A' ? 1 : grade === 'B' ? 0.65 : 0;
  if (marketRegime.mode === 'NEUTRAL') positionFactor *= 0.70;
  if (earningsCaution) positionFactor *= 0.50;
  if (!tradeEligible) positionFactor = 0;
  const suggestedShares = Math.floor(baseMaxShares * positionFactor);
  const suggestedPositionValue = suggestedShares * referenceEntry;
  const suggestedMaxLoss = suggestedShares * riskPerShare;

  const coreConditions: Condition[] = [
    { name: '大盤環境', met: marketRegime.mode !== 'RISK_OFF', desc: marketRegime.reason },
    { name: `產業 ${sectorEtf}`, met: sectorTrendHealthy, desc: `${sectorEtf} 價格 > 20MA 且 20MA > 60MA。` },
    { name: '相對強勢', met: (rs20Market ?? -1) > 0 && (rs20Sector ?? -1) > 0, desc: '20 日表現同時優於 QQQ 與產業 ETF。' },
    { name: '量價品質', met: volumeQuality >= 1.10, desc: `近 20 日上漲日／下跌日平均量比 ${volumeQuality.toFixed(2)}。` },
    { name: '波動收縮', met: volatilityContracting, desc: `短 ATR / 20日 ATR = ${atrContractionRatio.toFixed(2)}；≤ 0.85 視為收縮。` },
    { name: '風報比', met: rewardRiskToResistance >= 1.5, desc: `最近上方阻力推估 Reward/Risk = ${rewardRiskToResistance.toFixed(2)}。` },
  ];

  const scoreColor = totalScore >= 85 ? 'text-emerald-300' : totalScore >= 70 ? 'text-lime-300' : totalScore >= 55 ? 'text-amber-300' : 'text-slate-400';
  const tierBadgeClass = classification.tier === 'MEGA'
    ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
    : classification.tier === 'LARGE'
      ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
      : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  const gradeClass = grade === 'A'
    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
    : grade === 'B'
      ? 'bg-lime-500/10 border-lime-500/30 text-lime-300'
      : grade === 'C'
        ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
        : 'bg-slate-700/40 border-slate-600 text-slate-400';

  const earningsText = earningsVerified
    ? `${earningsInfo?.nextDate}${earningsInfo?.time ? ` ${earningsInfo.time}` : ''} · ${earningsDays}天`
    : '未取得／方案未開放';

  return (
    <div className={`rounded-2xl p-5 border shadow-lg relative group ${tradeEligible ? 'bg-slate-800 border-emerald-500/40 shadow-emerald-900/10' : 'bg-slate-800 border-slate-700'}`}>
      <button onClick={() => onRemove(symbol)} className="absolute top-4 right-4 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={18} /></button>

      <div className="flex justify-between items-start gap-3 mb-3 pr-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-2xl font-bold text-white tracking-wider">{symbol}</h3>
            <span className={`text-[10px] px-2 py-1 rounded-full border font-bold ${tierBadgeClass}`}>{config.label}{classification.isProxy ? '＊' : ''}</span>
            <span className={`text-[10px] px-2 py-1 rounded-full border font-black ${gradeClass}`}>{grade} · {totalScore}</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-1 truncate max-w-[260px]">{profileInfo?.name || classification.reason}</div>
          <div className="flex gap-1.5 mt-2 flex-wrap"><SourceBadge source={priceSource} /><SourceBadge source={profileInfo?.source} /></div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-bold ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>${executionPrice.toFixed(2)}</div>
          <div className={`flex items-center justify-end text-sm font-medium ${isUp ? 'text-emerald-500' : 'text-rose-500'}`}>
            {isUp ? <TrendingUp size={14} className="mr-1" /> : <TrendingDown size={14} className="mr-1" />}
            {displayChange >= 0 ? '+' : ''}{displayChange.toFixed(2)} ({displayPct >= 0 ? '+' : ''}{displayPct.toFixed(2)}%)
          </div>
          {quote?.source && <div className="mt-1"><SourceBadge source={quote.source} /></div>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] mb-4">
        <div className={`rounded-lg border p-2 ${marketRegime.mode === 'RISK_ON' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : marketRegime.mode === 'RISK_OFF' ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' : 'bg-amber-500/10 border-amber-500/20 text-amber-300'}`}>
          <div className="font-bold flex items-center gap-1"><Gauge size={12} /> {marketRegime.label}</div><div className="opacity-70 mt-0.5">市場 {marketScore}/15</div>
        </div>
        <div className={`rounded-lg border p-2 ${earningsHardBlock ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' : earningsCaution ? 'bg-amber-500/10 border-amber-500/20 text-amber-300' : 'bg-slate-900 border-slate-700 text-slate-300'}`}>
          <div className="font-bold flex items-center gap-1"><CalendarDays size={12} /> 財報</div><div className="opacity-80 mt-0.5">{earningsText}</div>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        {coreConditions.map(condition => (
          <div key={condition.name} className="flex items-center justify-between bg-slate-900/60 p-2 rounded-lg text-sm group/tooltip relative">
            <span className="text-slate-300 flex items-center gap-1 cursor-help">{condition.name}
              <div className="absolute bottom-full left-0 mb-1 hidden group-hover/tooltip:block w-64 bg-slate-700 text-xs text-slate-200 p-2 rounded shadow-xl z-20">{condition.desc}</div>
            </span>
            {condition.met ? <span className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-xs font-bold border border-emerald-500/30">通過</span> : <span className="text-slate-500 text-xs bg-slate-800 px-2 py-0.5 rounded">未通過</span>}
          </div>
        ))}
      </div>

      <div className={`p-3 mb-4 rounded-lg border ${signalBg} ${signalColor}`}>
        <div className="flex items-center gap-2"><SignalIcon size={18} className={signalColor.includes('emerald') ? 'animate-pulse' : ''} /><span className="text-sm font-bold tracking-wide">{signalText}</span></div>
        <p className="text-[11px] opacity-80 mt-1 pl-6">{signalSubtext}</p>
      </div>

      <div className="bg-slate-950/60 border border-slate-700 rounded-xl p-3 mb-4">
        <div className="text-xs font-bold text-slate-300 mb-2 flex items-center justify-between"><span className="flex items-center gap-1"><Target size={13} /> 交易計畫</span><span className="text-slate-500 font-normal">ATR(14) {atr14.toFixed(2)}</span></div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-slate-900 rounded-lg p-2"><div className="text-slate-500">進場觀察區</div><div className="text-white font-mono font-bold mt-0.5">${entryLower.toFixed(2)}–${entryUpper.toFixed(2)}</div></div>
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-2"><div className="text-rose-300">技術停損</div><div className="text-rose-300 font-mono font-bold mt-0.5">${technicalStop.toFixed(2)}</div></div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2"><div className="text-emerald-300">TP1 · 1.5R</div><div className="text-emerald-300 font-mono font-bold mt-0.5">${takeProfit1.toFixed(2)}</div></div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2"><div className="text-emerald-300">TP2 · 2.5R</div><div className="text-emerald-300 font-mono font-bold mt-0.5">${takeProfit2.toFixed(2)}</div></div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-500 mt-2 pt-2 border-t border-slate-800">
          <div className="flex justify-between"><span>上方阻力</span><span className="text-slate-300 font-mono">{nearestResistance ? `$${nearestResistance.toFixed(2)}` : '無明顯阻力'}</span></div>
          <div className="flex justify-between"><span>Reward/Risk</span><span className={rewardRiskToResistance >= 2 ? 'text-emerald-300 font-mono' : 'text-amber-300 font-mono'}>{rewardRiskToResistance.toFixed(2)}</span></div>
        </div>
      </div>

      <div className="bg-slate-950/60 border border-slate-700 rounded-xl p-3 mb-4">
        <div className="text-xs font-bold text-slate-300 mb-2 flex items-center gap-1"><WalletCards size={13} /> 部位控制</div>
        {suggestedShares > 0 ? (
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-slate-900 rounded-lg p-2"><div className="text-slate-500">建議股數</div><div className="text-white font-bold font-mono">{suggestedShares} 股</div></div>
            <div className="bg-slate-900 rounded-lg p-2"><div className="text-slate-500">約投入</div><div className="text-white font-bold font-mono">{formatMoney(suggestedPositionValue)}</div></div>
            <div className="col-span-2 text-[10px] text-slate-500">停損觸發時預估損失約 <span className="text-rose-300">{formatMoney(suggestedMaxLoss)}</span>；已套用 {riskPct.toFixed(2)}% 單筆風險與 {maxAllocationPct.toFixed(0)}% 個股上限。</div>
          </div>
        ) : <div className="text-[11px] text-slate-500">目前訊號不允許建立新倉，因此不配置股數。</div>}
      </div>

      {secInfo?.status === 'ok' && (
        <div className="bg-slate-950/60 border border-slate-700 rounded-xl p-3 mb-4">
          <div className="flex items-center justify-between mb-2"><div className="text-xs font-bold text-slate-300 flex items-center gap-1"><Layers size={13} /> SEC 官方基本面</div><SourceBadge source={secInfo.source} /></div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <div className="flex justify-between"><span>Revenue*</span><span className="text-white font-mono">{formatCompactMoney(secInfo.revenue)}</span></div>
            <div className="flex justify-between"><span>Net Income*</span><span className="text-white font-mono">{formatCompactMoney(secInfo.netIncome)}</span></div>
            <div className="flex justify-between"><span>OCF*</span><span className="text-white font-mono">{formatCompactMoney(secInfo.operatingCashFlow)}</span></div>
            <div className="flex justify-between"><span>FCF*</span><span className={(secInfo.freeCashFlow ?? 0) >= 0 ? 'text-emerald-300 font-mono' : 'text-rose-300 font-mono'}>{formatCompactMoney(secInfo.freeCashFlow)}</span></div>
          </div>
          <div className="text-[9px] text-slate-600 mt-2">* 取 SEC Company Facts 中最新可辨識 10-Q/10-K fact；不同公司 XBRL 標籤與期間可能不同，目前不納入 100 分評分。{secInfo.filingDate ? ` Filing ${secInfo.filingDate} · ${secInfo.form ?? ''}` : ''}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400 border-t border-slate-700 pt-3">
        <div className="flex justify-between"><span>RSI(14)</span><span className="text-white font-mono">{rsi14.toFixed(1)}</span></div>
        <div className="flex justify-between"><span>量比</span><span className="text-white font-mono">{volumeRatio.toFixed(2)}x</span></div>
        <div className="flex justify-between"><span>量價品質</span><span className="text-white font-mono">{volumeQuality.toFixed(2)}</span></div>
        <div className="flex justify-between"><span>ATR收縮</span><span className="text-white font-mono">{atrContractionRatio.toFixed(2)}</span></div>
        <div className="flex justify-between"><span>RS20 vs QQQ</span><span className={(rs20Market ?? 0) > 0 ? 'text-emerald-300 font-mono' : 'text-rose-300 font-mono'}>{rs20Market === null ? '—' : `${rs20Market > 0 ? '+' : ''}${rs20Market.toFixed(1)}%`}</span></div>
        <div className="flex justify-between"><span>RS60 vs QQQ</span><span className={(rs60Market ?? 0) > 0 ? 'text-emerald-300 font-mono' : 'text-rose-300 font-mono'}>{rs60Market === null ? '—' : `${rs60Market > 0 ? '+' : ''}${rs60Market.toFixed(1)}%`}</span></div>
        <div className="flex justify-between"><span>RS20 vs {sectorEtf}</span><span className={(rs20Sector ?? 0) > 0 ? 'text-emerald-300 font-mono' : 'text-rose-300 font-mono'}>{rs20Sector === null ? '—' : `${rs20Sector > 0 ? '+' : ''}${rs20Sector.toFixed(1)}%`}</span></div>
        <div className="flex justify-between"><span>距10MA</span><span className="text-white font-mono">{extensionATR.toFixed(2)} ATR</span></div>
        <div className="flex justify-between col-span-2 mt-1 pt-1 border-t border-slate-800/60"><span>產業</span><span className="text-white font-mono text-right">{profileInfo?.sector ?? 'Profile fallback'}{profileInfo?.industry ? ` · ${profileInfo.industry}` : ''}</span></div>
        <div className="flex justify-between col-span-2"><span>市值</span><span className="text-white font-mono">{marketCapInfo?.value ? `${formatMarketCap(marketCapInfo.value)} · ${marketCapInfo.source?.provider ?? ''}` : '流動性代理'}</span></div>
      </div>
    </div>
  );
};

export default function App() {
  const [symbols, setSymbols] = useState<string[]>(loadStoredSymbols);
  const [stockData, setStockData] = useState<Record<string, StockDataPoint[]>>({});
  const [priceSources, setPriceSources] = useState<Record<string, SourceMeta | null>>({});
  const [quotes, setQuotes] = useState<Record<string, QuoteInfo>>({});
  const [marketCapData, setMarketCapData] = useState<Record<string, MarketCapInfo>>({});
  const [profileData, setProfileData] = useState<Record<string, CompanyProfileInfo>>({});
  const [earningsData, setEarningsData] = useState<Record<string, EarningsInfo>>({});
  const [secData, setSecData] = useState<Record<string, SecFundamentalsInfo>>({});
  const [macro, setMacro] = useState<MacroSnapshot>({ tenYear: null, tenYearPrev: null, twoYear: null, twoYearPrev: null, yieldCurve: null, cpi: null, cpiYoY: null, updatedAt: null, source: null, status: 'unavailable' });
  const [dataErrors, setDataErrors] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<ApiKeys>(loadStoredKeys);
  const [newSymbol, setNewSymbol] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(() => !hasAnyHistoricalPriceKey(loadStoredKeys()));
  const [isUpdating, setIsUpdating] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  const proxyEnabled = isApiProxyConfigured();

  const [accountSizeUsd, setAccountSizeUsd] = useState(() => Number(localStorage.getItem('tradeAccountSizeUsd') || 15000));
  const [riskPct, setRiskPct] = useState(() => Number(localStorage.getItem('tradeRiskPct') || 1));
  const [maxAllocationPct, setMaxAllocationPct] = useState(() => Number(localStorage.getItem('tradeMaxAllocationPct') || 25));

  const abortRef = useRef<AbortController | null>(null);
  const symbolsRef = useRef(symbols);
  const keysRef = useRef(keys);
  const profileRef = useRef(profileData);

  useEffect(() => {
    symbolsRef.current = symbols;
    keysRef.current = keys;
    profileRef.current = profileData;
  }, [symbols, keys, profileData]);

  useEffect(() => {
    localStorage.setItem('stockDecisionApiKeys', JSON.stringify(keys));
    localStorage.setItem('stockDecisionSymbols', JSON.stringify(symbols));
    localStorage.setItem('tradeAccountSizeUsd', String(accountSizeUsd));
    localStorage.setItem('tradeRiskPct', String(riskPct));
    localStorage.setItem('tradeMaxAllocationPct', String(maxAllocationPct));
  }, [keys, symbols, accountSizeUsd, riskPct, maxAllocationPct]);

  const requiredSectorEtfs = useCallback((list: string[], profiles: Record<string, CompanyProfileInfo>) => (
    Array.from(new Set(list.map(symbol => getSectorEtf(symbol, profiles[symbol])).filter(etf => !MARKET_BENCHMARKS.includes(etf))))
  ), []);

  const loadPriceTargets = useCallback(async (targets: string[], force: boolean, signal: AbortSignal) => {
    const unique = Array.from(new Set(targets.map(s => s.toUpperCase())));
    const nextErrors: Record<string, string> = {};

    await Promise.all(unique.map(async symbol => {
      const result = await fetchHistoricalData(symbol, keysRef.current, { force, signal });
      if (result.data) {
        setStockData(prev => ({ ...prev, [symbol]: result.data! }));
        setPriceSources(prev => ({ ...prev, [symbol]: result.source }));
      } else {
        nextErrors[symbol] = result.errors.join(' → ') || '沒有可用的歷史價格來源';
      }
    }));

    if (Object.keys(nextErrors).length) setDataErrors(prev => ({ ...prev, ...nextErrors }));
  }, []);

  const loadQuotes = useCallback(async (list: string[], signal?: AbortSignal) => {
    if (!hasProviderAccess(keysRef.current, ['finnhub', 'massive'])) return;
    await Promise.all(list.map(async symbol => {
      try {
        const quote = await fetchQuote(symbol, keysRef.current, signal);
        if (quote.price) setQuotes(prev => ({ ...prev, [symbol]: quote }));
      } catch { /* quote is supplemental */ }
    }));
  }, []);

  const loadMetadata = useCallback(async (list: string[], force: boolean, signal: AbortSignal) => {
    await Promise.all(list.map(async symbol => {
      const [bundle, earnings, sec] = await Promise.all([
        fetchCompanyProfileAndMarketCap(symbol, keysRef.current, { force, signal }),
        fetchNextEarnings(symbol, keysRef.current, { force, signal }),
        fetchSecFundamentals(symbol, { force, signal }),
      ]);
      setProfileData(prev => ({ ...prev, [symbol]: bundle.profile }));
      setMarketCapData(prev => ({ ...prev, [symbol]: bundle.marketCap }));
      setEarningsData(prev => ({ ...prev, [symbol]: earnings }));
      setSecData(prev => ({ ...prev, [symbol]: sec }));
    }));
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (!hasAnyHistoricalPriceKey(keysRef.current)) {
      setErrorMsg('請至少設定 Massive、Twelve Data 或可用的 Finnhub 歷史 K 線 Key，才能進行技術分析。');
      setSettingsOpen(true);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsUpdating(true);
    setErrorMsg('');
    if (force) setDataErrors({});

    try {
      const list = symbolsRef.current;
      const firstEtfs = requiredSectorEtfs(list, profileRef.current);
      await Promise.all([
        loadPriceTargets([...list, ...MARKET_BENCHMARKS, ...firstEtfs], force, controller.signal),
        loadMetadata(list, force, controller.signal),
        fetchMacroSnapshot(keysRef.current, { force, signal: controller.signal }).then(setMacro),
        loadQuotes(list, controller.signal),
      ]);

      if (controller.signal.aborted) return;
      const updatedEtfs = requiredSectorEtfs(list, profileRef.current);
      const missingEtfs = updatedEtfs.filter(etf => !stockData[etf]);
      if (missingEtfs.length) await loadPriceTargets(missingEtfs, force, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setErrorMsg(error instanceof Error ? error.message : '資料同步失敗');
    } finally {
      if (abortRef.current === controller) setIsUpdating(false);
      setCountdown(REFRESH_SECONDS);
    }
  }, [loadMetadata, loadPriceTargets, loadQuotes, requiredSectorEtfs, stockData]);

  useEffect(() => {
    const timer = window.setTimeout(() => refreshAll(false), 250);
    return () => { window.clearTimeout(timer); abortRef.current?.abort(); };
  }, [symbols, keys.massive, keys.twelve, keys.finnhub, keys.fmp, keys.fred, refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          loadQuotes(symbolsRef.current);
          return REFRESH_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loadQuotes]);

  const marketRegime = useMemo(() => evaluateMarketRegime(stockData.SPY, stockData.QQQ), [stockData.SPY, stockData.QQQ]);

  const handleAddSymbol = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const clean = newSymbol.trim().toUpperCase();
    if (!clean) return;
    if (symbols.includes(clean)) { setErrorMsg('該股票已在監控清單中'); return; }
    if (symbols.length >= MAX_SYMBOLS) { setErrorMsg(`目前設定最多同時分析 ${MAX_SYMBOLS} 檔，避免免費 API 額度過快耗盡。`); return; }
    if (!/^[A-Z0-9.-]{1,12}$/.test(clean)) { setErrorMsg('股票代號格式不正確'); return; }
    setSymbols(prev => [...prev, clean]);
    setNewSymbol(''); setErrorMsg('');
  };

  const handleRemoveSymbol = (symbol: string) => {
    setSymbols(prev => prev.filter(item => item !== symbol));
  };

  const handleClearCache = () => {
    clearDataCache();
    setErrorMsg('已清除 API 資料快取；按「重新分析」可強制抓取最新資料。');
  };

  const providerCount = proxyEnabled ? 5 : Object.values(keys).filter(value => value.trim()).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 selection:bg-emerald-500/30">
      <div className="max-w-[1600px] mx-auto space-y-5">
        <header className="flex flex-col xl:flex-row justify-between items-start xl:items-end pb-4 border-b border-slate-800 gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400 flex items-center gap-3">
              <BarChart2 size={32} className="text-emerald-400" /> 多來源交易決策系統
            </h1>
            <p className="text-slate-400 mt-2 text-sm max-w-4xl">Massive / Twelve Data 提供日 K，Finnhub / FMP 補事件與公司資料，FRED / SEC 補官方總經與財報 facts。分析採 100 分制 + Hard Filter + ATR 風控 + Position Sizing。</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setSettingsOpen(v => !v)} className="bg-slate-900 border border-slate-800 hover:border-slate-600 px-3 py-2 rounded-xl text-xs flex items-center gap-2">
              <Settings2 size={15} /> API 設定 <span className="text-emerald-400">{providerCount}</span>{settingsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <button onClick={() => refreshAll(true)} disabled={isUpdating} className="bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-2">
              <RefreshCw size={15} className={isUpdating ? 'animate-spin' : ''} /> {isUpdating ? '同步中' : '重新分析'}
            </button>
            <div className="bg-slate-900 border border-slate-800 px-3 py-2 rounded-xl text-xs flex items-center gap-2"><Clock size={15} /><span>{isUpdating ? '同步資料中' : `Quote ${countdown}s`}</span></div>
          </div>
        </header>

        {settingsOpen && (
          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
            {proxyEnabled ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <ShieldAlert size={17} className="text-emerald-300 mt-0.5" />
                  <div className="text-xs text-emerald-100 leading-relaxed"><strong>Secure API Proxy 已啟用。</strong> Massive / Twelve Data / Finnhub / FMP / FRED 的秘密金鑰由伺服器端管理，這個瀏覽器不需要再輸入 API Key，也不會把 Key 打包進 GitHub Pages。</div>
                </div>
                <button onClick={handleClearCache} className="self-start text-xs border border-slate-700 hover:border-rose-500/50 hover:text-rose-300 rounded-lg px-3 py-2 transition-colors">清除資料快取</button>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2 mb-4">
                  <ShieldAlert size={17} className="text-amber-400 mt-0.5" />
                  <div className="text-xs text-slate-400 leading-relaxed">尚未設定 Secure API Proxy，因此暫時使用瀏覽器 localStorage 模式。API Key 不會寫進 repository，但換瀏覽器時仍需重新輸入。</div>
                </div>
                <ProviderSettings keys={keys} setKeys={setKeys} onClearCache={handleClearCache} />
              </>
            )}
          </section>
        )}

        <div className={`rounded-xl border p-3 text-xs ${marketRegime.mode === 'RISK_ON' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : marketRegime.mode === 'RISK_OFF' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
          <strong>{marketRegime.label}</strong> — {marketRegime.reason}
        </div>

        <MacroPanel macro={macro} />

        <section className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3"><WalletCards size={18} className="text-violet-400" /><h2 className="font-bold">風險與資金設定</h2></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="field-label">美股帳戶資金（USD）<input type="number" min="0" value={accountSizeUsd} onChange={e => setAccountSizeUsd(Math.max(0, Number(e.target.value) || 0))} className="field-input" /></label>
            <label className="field-label">單筆最大風險（%）<input type="number" min="0.1" max="10" step="0.1" value={riskPct} onChange={e => setRiskPct(clamp(Number(e.target.value) || 1, 0.1, 10))} className="field-input" /></label>
            <label className="field-label">單一標的資金上限（%）<input type="number" min="1" max="100" step="1" value={maxAllocationPct} onChange={e => setMaxAllocationPct(clamp(Number(e.target.value) || 25, 1, 100))} className="field-input" /></label>
          </div>
        </section>

        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          <form onSubmit={handleAddSymbol} className="w-full md:w-auto flex gap-2">
            <input value={newSymbol} onChange={e => setNewSymbol(e.target.value)} placeholder="輸入美股代號，如 ORCL、LITE、MU" className="w-full md:w-72 bg-slate-900 border border-slate-700 rounded-xl py-2 px-4 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
            <button type="submit" disabled={!newSymbol.trim()} className="bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-800 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2"><Plus size={18} /><span className="hidden sm:inline">新增</span></button>
          </form>
          <div className="flex gap-2 text-sm text-slate-400 items-center bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800"><Activity size={16} /> 監控 <strong className="text-white">{symbols.length}</strong> / {MAX_SYMBOLS}</div>
        </div>

        {errorMsg && <div className="bg-rose-500/10 border border-rose-500/40 text-rose-300 px-4 py-3 rounded-xl flex items-start gap-2 text-sm"><AlertCircle size={16} className="mt-0.5 shrink-0" />{errorMsg}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5 min-h-[300px]">
          {symbols.map(symbol => {
            const sectorEtf = getSectorEtf(symbol, profileData[symbol]);
            return (
              <StockCard
                key={symbol}
                symbol={symbol}
                data={stockData[symbol]}
                priceSource={priceSources[symbol]}
                quote={quotes[symbol]}
                qqqData={stockData.QQQ}
                sectorEtf={sectorEtf}
                sectorData={stockData[sectorEtf] ?? stockData.QQQ}
                marketRegime={marketRegime}
                marketCapInfo={marketCapData[symbol]}
                profileInfo={profileData[symbol]}
                earningsInfo={earningsData[symbol]}
                secInfo={secData[symbol]}
                accountSizeUsd={accountSizeUsd}
                riskPct={riskPct}
                maxAllocationPct={maxAllocationPct}
                error={dataErrors[symbol]}
                onRemove={handleRemoveSymbol}
              />
            );
          })}
        </div>

        <footer className="text-center text-[11px] text-slate-500 pt-6 mt-8 border-t border-slate-800/50 space-y-1">
          <p>技術評分以日 K 為核心；Finnhub / Massive Quote 主要用於「現在是否落在進場區」與畫面報價，不會把未完成的盤中 K 線假裝成完整日 K。</p>
          <p>SEC Company Facts 的 XBRL 標籤與期間可能因公司而異，因此第一版只展示、不納入 100 分評分。所有訊號皆為研究與風險管理輔助，不是保證報酬的投資建議。</p>
        </footer>
      </div>
    </div>
  );
}
