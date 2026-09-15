import path from 'node:path';
import { DEFAULT_END, DEFAULT_START, TICKERS, monthChunks, parseArgs, saveGzipJson } from './lib.mjs';

const args = parseArgs();
const start = String(args.start ?? DEFAULT_START);
const end = String(args.end ?? DEFAULT_END);
const tickers = String(args.tickers ?? TICKERS.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const outDir = String(args.out ?? 'research-output/mu-intraday/raw');
const apiKey = process.env.MASSIVE_API_KEY;
if (!apiKey) throw new Error('MASSIVE_API_KEY is required');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const u = new URL(url);
    if (!u.searchParams.has('apiKey')) u.searchParams.set('apiKey', apiKey);
    const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'stock-decision-dashboard-mu-research/1.0' } });
    if (r.ok) return r.json();
    const text = await r.text();
    if (attempt === 6 || ![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`Massive HTTP ${r.status}: ${text.slice(0, 300)}`);
    await sleep(800 * attempt);
  }
}

async function fetchChunk(ticker, from, to) {
  let url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  const rows = [];
  while (url) {
    const j = await getJson(url);
    for (const x of j.results ?? []) {
      if (![x.o, x.h, x.l, x.c, x.t].every(Number.isFinite)) continue;
      rows.push({ t:+x.t, o:+x.o, h:+x.h, l:+x.l, c:+x.c, v:+x.v||0, vw:Number.isFinite(x.vw)?+x.vw:null, n:Number.isFinite(x.n)?+x.n:null });
    }
    url = j.next_url ?? '';
  }
  return rows;
}

for (const ticker of tickers) {
  const byTs = new Map();
  for (const [from, to] of monthChunks(start, end)) {
    console.log(`[${ticker}] ${from} -> ${to}`);
    const rows = await fetchChunk(ticker, from, to);
    for (const r of rows) byTs.set(r.t, r);
  }
  const bars = [...byTs.values()].sort((a,b)=>a.t-b.t);
  const file = path.join(outDir, `${ticker}.json.gz`);
  await saveGzipJson(file, { ticker, start, end, source:'Massive Custom Bars 1-minute adjusted', bars });
  console.log(`[${ticker}] saved ${bars.length} bars -> ${file}`);
}
