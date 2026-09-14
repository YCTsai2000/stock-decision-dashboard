import fs from 'node:fs/promises';

const path = 'src/DayTradingAppV5.tsx';
let s = await fs.readFile(path, 'utf8');

const replacements = [
  [
`import {
  buildDayTradeDecision, computeIntradayMetrics, fetchIntradayData, getNewYorkClock, getSessionPhase,
  type DayTradeDecisionInput, type IntradayFetchResult, type SessionPhase,
} from './intraday';`,
`import {
  computeIntradayMetrics, fetchIntradayData, getNewYorkClock, getSessionPhase,
  type DayTradeDecisionInput, type IntradayFetchResult, type SessionPhase,
} from './intraday';
import { buildProfiledDayTradeDecision } from './decisionV6';`
  ],
  [
`import { applyTradingProfile, getTradingProfile, WATCHLIST } from './tradingProfiles';`,
`import { getTradingProfile, WATCHLIST } from './tradingProfiles';`
  ],
  [
`import WatchlistRanker from './WatchlistRanker';`,
`import WatchlistRanker from './WatchlistRankerV6';`
  ],
  [
`const decision = useMemo(() => applyTradingProfile(decisionInput, buildDayTradeDecision(decisionInput), profile), [decisionInput, profile]);`,
`const decision = useMemo(() => buildProfiledDayTradeDecision(decisionInput, profile), [decisionInput, profile]);`
  ],
  [
`const sharesRisk = etfRiskPerShare ? Math.floor((account * riskPct / 100) / etfRiskPerShare) : 0;`,
`const eventRiskFactor = decision.label.includes('EVENT REVERSAL') ? 0.5 : 1;
  const sharesRisk = etfRiskPerShare ? Math.floor((account * riskPct / 100 * eventRiskFactor) / etfRiskPerShare) : 0;`
  ],
];

for (const [from, to] of replacements) {
  if (!s.includes(from)) throw new Error(`Expected production patch target not found:\n${from}`);
  s = s.replace(from, to);
}

await fs.writeFile(path, s);
console.log('Applied V6 production patch to DayTradingAppV5.tsx');
