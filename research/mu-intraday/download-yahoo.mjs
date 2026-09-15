import path from 'node:path';
import { DEFAULT_END, TICKERS, addDays, assertIsoDate, parseArgs, saveGzipJson } from './lib.mjs';

const args = parseArgs();
const requestedEnd = assertIsoDate(String(args.end ?? DEFAULT_END), 'end');
const requestedStart = assertIsoDate(String(args.start ?? addDays(requestedEnd, -59)), 'start');
const minStart = addDays(requestedEnd, -59);
const start = requestedStart < minStart ? minStart : requestedStart;
const end = requestedEnd;
const tickers = String(args.tickers ?? TICKERS.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const outDir = String(args.out ?? 'research-output/mu-intraday/raw');

const epoch = s => Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);
const period2 = epoch(addDays(end, 1));

async function fetchYahoo(ticker) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set('period1', String(epoch(start)));
  url.searchParams.set('period2', String(period2));
  url.searchParams.set('interval', '5m');
  url.searchParams.set('includePrePost', 'true');
  url.searchParams.set('events', 'div,splits');
  const r = await fetch(url, {headers:{Accept:'application/json','User-Agent':'Mozilla/5.0 stock-decision-dashboard-mu-research/1.0'}});
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  const x = j?.chart?.result?.[0];
  if (!x) throw new Error(`Yahoo returned no chart data for ${ticker}`);
  const q = x.indicators?.quote?.[0] ?? {};
  const bars = [];
  for (let i = 0; i < (x.timestamp ?? []).length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o,h,l,c].every(Number.isFinite)) continue;
    // Store the five-minute bar at its completion minute so common 5/15/30m windows remain causal.
    bars.push({t: Number(x.timestamp[i]) * 1000 + 4 * 60_000, o:+o, h:+h, l:+l, c:+c, v:Number(q.volume?.[i])||0, vw:null, n:null});
  }
  return bars;
}

for (const ticker of tickers) {
  console.log(`[${ticker}] Yahoo 5m ${start} -> ${end}`);
  const bars = await fetchYahoo(ticker);
  const file = path.join(outDir, `${ticker}.json.gz`);
  await saveGzipJson(file, {ticker, start, end, source:'Yahoo Finance chart 5-minute includePrePost', intervalMinutes:5, provisional:true, bars});
  console.log(`[${ticker}] saved ${bars.length} bars -> ${file}`);
}
