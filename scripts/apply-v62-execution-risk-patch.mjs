import fs from 'node:fs/promises';

const path = 'src/DayTradingAppV5.tsx';
let text = await fs.readFile(path, 'utf8');

text = text.replace(
  "import { buildProfiledDayTradeDecision } from './decisionV6';",
  "import { buildProfiledDayTradeDecision, decisionRiskFactor } from './decisionV6';",
);

text = text.replace(
  "const eventRiskFactor = decision.label.includes('EVENT REVERSAL') ? 0.5 : 1;\n  const sharesRisk = etfRiskPerShare ? Math.floor((account * riskPct / 100 * eventRiskFactor) / etfRiskPerShare) : 0;",
  "const executionRiskFactor = decisionRiskFactor(decision);\n  const sharesRisk = etfRiskPerShare ? Math.floor((account * riskPct / 100 * executionRiskFactor) / etfRiskPerShare) : 0;",
);

text = text.replace('DAY TRADING V5 · SETUP FIRST', 'DAY TRADING V6.2 · ITERATIVE MODEL');

if (!text.includes('decisionRiskFactor(decision)')) {
  throw new Error('V6.2 execution risk patch did not apply');
}

await fs.writeFile(path, text);
console.log('Applied V6.2 execution risk patch');
