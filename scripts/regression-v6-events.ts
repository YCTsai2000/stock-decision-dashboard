import fs from 'node:fs/promises';
import { buildProfiledDayTradeDecision, EVENT_SHORT_RULE } from '../src/decisionV6';
import { computeIntradayMetrics, getSessionPhase, type IntradayBar, type DayTradeDecisionInput } from '../src/intraday';
import { getTradingProfile, WATCHLIST, type TradingProfile } from '../src/tradingProfiles';

const FROM = '2026-07-17';
const TO = '2026-09-15';
const DAILY_FROM = '2026-03-01';
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const REGRESSION_SYMBOLS = [...WATCHLIST, 'ANET'];

type RawBar = IntradayBar & { epoch: number };
type DailyBar = { date: string; close: number };

const epoch = (s: string) => Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);
const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0;
const ma = (xs: number[], n: number) => xs.length >= n ? mean(xs.slice(-n)) : null;
const profileFor = (symbol:string):TradingProfile => symbol === 'ANET'
  ? { ...getTradingProfile(symbol), family:'HARDWARE', label:'Networking / AI Infrastructure regression proxy', benchmark:'XLK', secondaryBenchmark:'QQQ', minStopAtr:.65 }
  : getTradingProfile(symbol);

function nyParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  const time = `${get('hour')}:${get('minute')}`;
  const [h,m] = time.split(':').map(Number);
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time, minute: h * 60 + m };
}

async function yahoo5m(symbol: string): Promise<RawBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${epoch(FROM)}&period2=${epoch(TO)}&interval=5m&includePrePost=false&events=div%2Csplits`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 stock-dashboard-v6-regression', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${symbol} 5m HTTP ${r.status}`);
  const j:any = await r.json(); const x = j?.chart?.result?.[0];
  if (!x) throw new Error(`${symbol} 5m no data`);
  const q = x.indicators?.quote?.[0] ?? {}; const out: RawBar[] = [];
  for (let i=0;i<(x.timestamp ?? []).length;i++) {
    const o=q.open?.[i], h=q.high?.[i], l=q.low?.[i], c=q.close?.[i], v=q.volume?.[i];
    if (![o,h,l,c].every(Number.isFinite)) continue;
    const p = nyParts(x.timestamp[i] * 1000);
    if (p.minute < OPEN || p.minute >= CLOSE) continue;
    out.push({ ...p, epoch:x.timestamp[i]*1000, open:+o, high:+h, low:+l, close:+c, volume:Number(v)||0 });
  }
  return out.sort((a,b)=>a.epoch-b.epoch);
}

async function yahooDaily(symbol: string): Promise<DailyBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${epoch(DAILY_FROM)}&period2=${epoch(TO)}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 stock-dashboard-v6-regression', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${symbol} 1d HTTP ${r.status}`);
  const j:any = await r.json(); const x=j?.chart?.result?.[0]; if(!x) throw new Error(`${symbol} 1d no data`);
  const q=x.indicators?.quote?.[0] ?? {}; const out:DailyBar[]=[];
  for(let i=0;i<(x.timestamp??[]).length;i++) {
    const c=q.close?.[i]; if(!Number.isFinite(c)) continue;
    out.push({ date:new Date(x.timestamp[i]*1000).toISOString().slice(0,10), close:+c });
  }
  return out;
}

const group = (bars:RawBar[]) => {
  const m = new Map<string,RawBar[]>();
  for (const b of bars) { if(!m.has(b.date)) m.set(b.date,[]); m.get(b.date)!.push(b); }
  return m;
};

function dailyBias(daily:DailyBar[], date:string): 'LONG'|'SHORT'|'NEUTRAL' {
  const p=daily.filter(x=>x.date<date).map(x=>x.close); if(p.length<60) return 'NEUTRAL';
  const c=p.at(-1)!, m20=ma(p,20), m60=ma(p,60);
  return c>(m20??Infinity) && (m20??0)>(m60??Infinity) ? 'LONG' : c<(m20??-Infinity) && (m20??Infinity)<(m60??-Infinity) ? 'SHORT' : 'NEUTRAL';
}

function marketMode(spy:DailyBar[], qqq:DailyBar[], date:string): 'RISK_ON'|'NEUTRAL'|'RISK_OFF' {
  const s=spy.filter(x=>x.date<date).map(x=>x.close), q=qqq.filter(x=>x.date<date).map(x=>x.close);
  if(s.length<50||q.length<50) return 'NEUTRAL';
  const sc=s.at(-1)!, qc=q.at(-1)!, s20=ma(s,20)!, s50=ma(s,50)!, q20=ma(q,20)!, q50=ma(q,50)!;
  if(sc>s20&&s20>s50&&qc>q20&&q20>q50) return 'RISK_ON';
  if(sc<s20&&s20<s50&&qc<q20&&q20<q50) return 'RISK_OFF';
  return 'NEUTRAL';
}

await fs.mkdir('backtest-output-v6-regression',{recursive:true});
const [spyDaily,qqqDaily]=await Promise.all([yahooDaily('SPY'),yahooDaily('QQQ')]);
const benchSymbols=[...new Set(REGRESSION_SYMBOLS.map(s=>profileFor(s).benchmark))];
const benchMaps=new Map<string,Map<string,RawBar[]>>();
for(const b of benchSymbols) {
  try { benchMaps.set(b,group(await yahoo5m(b))); } catch(e) { console.warn('benchmark skip',b,e); }
}

const events:any[]=[]; const candidateDays:any[]=[]; const skipped:any[]=[];
for(const symbol of REGRESSION_SYMBOLS) {
  const profile=profileFor(symbol); const benchMap=benchMaps.get(profile.benchmark); if(!benchMap){skipped.push({symbol,reason:'benchmark unavailable'});continue;}
  try {
    const [bars,daily]=await Promise.all([yahoo5m(symbol),yahooDaily(symbol)]); const map=group(bars); const dates=[...map.keys()].sort();
    for(let di=1;di<dates.length;di++) {
      const date=dates[di], day=map.get(date)!, prev=map.get(dates[di-1])!, benchDay=benchMap.get(date)??[];
      if(day.length<30||prev.length<30||benchDay.length<30) continue;
      const bias=dailyBias(daily,date), market=marketMode(spyDaily,qqqDaily,date);
      const gapPct=(day[0].open/prev.at(-1)!.close-1)*100;
      if(bias==='LONG'&&market!=='RISK_ON'&&gapPct>=1.5) candidateDays.push({symbol,date,gapPct,bias,market});
      let event:any=null;
      for(let i=0;i<day.length;i++) {
        const bar=day[i]; if(bar.minute<9*60+45) continue;
        const priorDates=dates.slice(Math.max(0,di-10),di);
        const stockHistory:IntradayBar[]=[];
        for(const d of priorDates) stockHistory.push(...(map.get(d)??[]));
        stockHistory.push(...day.slice(0,i+1));
        const benchHistory:IntradayBar[]=[];
        for(const d of priorDates) benchHistory.push(...(benchMap.get(d)??[]));
        benchHistory.push(...benchDay.filter(x=>x.minute<=bar.minute));
        const m=computeIntradayMetrics(stockHistory,benchHistory);
        m.stale=false; m.marketOpen=true; m.phase=getSessionPhase(bar.minute,'Mon');
        const input:DayTradeDecisionInput={metrics:m,dailyBias:bias,marketMode:market,accountSizeUsd:100000,riskPerTradePct:.5,dailyMaxLossPct:1.5,realizedPnlUsd:0,maxAllocationPct:25,bid:null,ask:null,hasCatalyst:false};
        const decision=buildProfiledDayTradeDecision(input,profile);
        if(decision.label.includes('EVENT REVERSAL')) {
          const stopPct=decision.entry&&decision.stop?Math.abs(decision.stop-decision.entry)/decision.entry*100:null;
          event={symbol,date,time:bar.time,gapPct:m.gapPct,rvol:m.rvol,rs:m.relativeStrengthPct,longScore:decision.longScore,shortScore:decision.shortScore,entry:decision.entry,stop:decision.stop,stopPct,target1:decision.target1,target2:decision.target2,suggestedRiskUsd:decision.suggestedRiskUsd,market,bias,benchmark:profile.benchmark};
          break;
        }
      }
      if(event) events.push(event);
    }
  } catch(e) { skipped.push({symbol,reason:e instanceof Error?e.message:String(e)}); }
}

const orcl=events.find(x=>x.symbol==='ORCL'&&x.date==='2026-09-11');
const anet=events.find(x=>x.symbol==='ANET'&&x.date==='2026-08-05');
const assertions={
  orclSep11Detected:Boolean(orcl),
  orclNotBefore1015:Boolean(orcl && orcl.time>='10:15'),
  anetAug05Filtered:!anet,
  allEventsRespectGap:events.every(x=>(x.gapPct??0)>=5),
  allEventsRespectRvol:events.every(x=>(x.rvol??0)>=2),
  allEventsRespectRs:events.every(x=>(x.rs??0)<=-2),
  allEventsRespectStopWidth:events.every(x=>(x.stopPct??Infinity)<=EVENT_SHORT_RULE.maxUnderlyingStopPct+1e-9),
  allEventRiskHalf:events.every(x=>(x.suggestedRiskUsd??Infinity)<=250.01),
};
const pass=Object.values(assertions).every(Boolean);
const result={range:{from:FROM,to:TO},symbols:REGRESSION_SYMBOLS,benchmarks:benchSymbols,candidateDays:candidateDays.length,eventCount:events.length,events,assertions,pass,skipped};
await fs.writeFile('backtest-output-v6-regression/result.json',JSON.stringify(result,null,2));
await fs.writeFile('backtest-output-v6-regression/events.csv',['symbol,date,time,gapPct,rvol,rs,longScore,shortScore,entry,stop,stopPct,target1,target2,riskUsd',...events.map(x=>[x.symbol,x.date,x.time,x.gapPct,x.rvol,x.rs,x.longScore,x.shortScore,x.entry,x.stop,x.stopPct,x.target1,x.target2,x.suggestedRiskUsd].join(','))].join('\n'));
console.log(JSON.stringify(result,null,2));
if(!pass) process.exit(1);
