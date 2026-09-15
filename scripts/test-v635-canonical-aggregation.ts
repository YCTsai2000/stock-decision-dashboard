import { aggregateCanonicalFiveMinuteBars } from '../src/intraday';
import type { IntradayBar } from '../src/intraday';

const bar = (date: string, minute: number, close = 100): IntradayBar => ({
  date,
  time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
  minute,
  open: close - 0.1,
  high: close + 0.2,
  low: close - 0.2,
  close,
  volume: 1000,
});

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const historical = [570, 571, 572, 574].map((m, i) => bar('2026-09-11', m, 100 + i));
const historicalOut = aggregateCanonicalFiveMinuteBars(historical, {
  date: '2026-09-14', time: '10:00', minute: 600, weekday: 'Mon',
});
assert(historicalOut.length === 1, 'Historical completed bucket should tolerate one missing 1m print.');

const fourLive = [595, 596, 597, 598].map((m, i) => bar('2026-09-14', m, 110 + i));
const fourLiveOut = aggregateCanonicalFiveMinuteBars(fourLive, {
  date: '2026-09-14', time: '10:00', minute: 600, weekday: 'Mon',
});
assert(fourLiveOut.length === 0, 'Live bucket must not be exposed when provider has only four 1m bars.');

const fiveLive = [595, 596, 597, 598, 599].map((m, i) => bar('2026-09-14', m, 120 + i));
const tooEarlyOut = aggregateCanonicalFiveMinuteBars(fiveLive, {
  date: '2026-09-14', time: '09:59', minute: 599, weekday: 'Mon',
});
assert(tooEarlyOut.length === 0, 'Live bucket must not be exposed before its five-minute close time.');

const completedOut = aggregateCanonicalFiveMinuteBars(fiveLive, {
  date: '2026-09-14', time: '10:00', minute: 600, weekday: 'Mon',
});
assert(completedOut.length === 1, 'Live bucket should be exposed only after all five 1m bars are present and time has closed.');
assert(completedOut[0].minute === 595, 'Canonical bucket should retain its opening minute label.');
assert(completedOut[0].volume === 5000, 'Canonical bucket volume should sum all five 1m bars.');

console.log('V6.3.5 canonical aggregation tests passed.');
