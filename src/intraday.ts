export type {
  IntradayProvider,
  DayTradeDirection,
  SessionPhase,
  IntradayBar,
  IntradaySource,
  IntradayFetchResult,
  IntradayMetrics,
  DayTradeDecisionInput,
  DayTradeDecision,
} from './intradayCore';

export {
  getNewYorkClock,
  getSessionPhase,
  computeIntradayMetrics,
  buildDayTradeDecision,
} from './intradayCore';

// V6.3.5 canonical live data contract: provider 1m -> local completed 5m aggregation.
export { fetchIntradayData, aggregateCanonicalFiveMinuteBars } from './intradayCanonical';
