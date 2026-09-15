import fs from 'node:fs/promises';

const sourcePath = 'src/intraday.ts';
const corePath = 'src/intradayCore.ts';
const source = await fs.readFile(sourcePath, 'utf8');

if (source.includes("from './intradayCore'")) {
  console.log('V6.3.5 canonical live migration already applied.');
  process.exit(0);
}

await fs.writeFile(corePath, source);

const barrel = `export type {
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
`;
await fs.writeFile(sourcePath, barrel);

const modePath = 'src/ModeShell.tsx';
let mode = await fs.readFile(modePath, 'utf8');
mode = mode.replace(/當沖模式 V6\.3\.4/g, '當沖模式 V6.3.5');
mode = mode.replace(/當沖模式 V6\.3 Adaptive/g, '當沖模式 V6.3.5');
await fs.writeFile(modePath, mode);

const canonicalWorkflowPath = '.github/workflows/backtest-v634-canonical-1m.yml';
try {
  let workflow = await fs.readFile(canonicalWorkflowPath, 'utf8');
  workflow = workflow.replace(/^name: V6\.3\.4 canonical 1m backtest/m, 'name: V6.3.5 canonical 1m backtest');
  await fs.writeFile(canonicalWorkflowPath, workflow);
} catch {}

console.log('Applied V6.3.5 canonical live migration.');
