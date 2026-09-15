import path from 'node:path';
import {
  DEFAULT_END, DEFAULT_START, OPEN_MINUTE, TICKERS,
  closeOf, groupByDate, highOf, loadGzipJson, lowOf, mean, median,
  pct, premarketBars, regularBars, std, sumVolume, weightedVwap,
  windowBars, futureWindow, writeCsv, writeJson, parseArgs, summarizeDirectional
} from './lib.mjs';

const args=parseArgs();
const rawDir=String(args.raw ?? 'research-output/mu-intraday/raw');
const outDir=String(args.out ?? 'research-output/mu-intraday/results');
const tickers=String(args.tickers ?? TICKERS.join(',')).split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
const evalEnds={5:OPEN_MINUTE+4,15:OPEN_MINUTE+14,30:OPEN_MINUTE+29};

function sliceStats(day, endMinute){
  const bars=windowBars(day,OPEN_MINUTE,endMinute+1);
  if(!bars.length)return{};
  const close=closeOf(bars), open=bars[0].o, high=highOf(bars), low=lowOf(bars), vwap=weightedVwap(bars);
  return {close,open,high,low,volume:sumVolume(bars),vwap,distVwap:pct(close,vwap),retOpen:pct(close,open)};
}
function fwd(day,endMinute,h){
  const base=windowBars(day,OPEN_MINUTE,endMinute+1).at(-1);
  const w=futureWindow(day,endMinute,h);
  if(!base||!w.length)return {ret:null,mfe:null,mae:null};
  const end=w.at(-1).c;
  return {ret:pct(end,base.c),mfe:pct(highOf(w),base.c),mae:pct(lowOf(w),base.c)};
}
function dailyRows(raw,ticker){
  const map=groupByDate(raw),dates=[...map.keys()].sort(),out=[]; let prev=null;
  for(const date of dates){
    const day=map.get(date),reg=regularBars(day); if(reg.length<30)continue;
    const pm=premarketBars(day),open=reg[0].o,close=reg.at(-1).c,high=highOf(reg),low=lowOf(reg);
    const row={ticker,date,prevClose:prev?.close??null,prevHigh:prev?.high??null,open,high,low,close,dailyReturn:prev?pct(close,prev.close):null,gap:prev?pct(open,prev.close):null,pmClose:closeOf(pm),pmHigh:highOf(pm),pmLow:lowOf(pm),pmVolume:sumVolume(pm)};
    for(const [k,end] of Object.entries(evalEnds)){
      const s=sliceStats(day,end); row[`close${k}`]=s.close??null; row[`high${k}`]=s.high??null; row[`low${k}`]=s.low??null; row[`vol${k}`]=s.volume??null; row[`vwap${k}`]=s.vwap??null; row[`distVwap${k}`]=s.distVwap??null; row[`retOpen${k}`]=s.retOpen??null;
      row[`retPrev${k}`]=prev&&s.close?pct(s.close,prev.close):null;
      row[`gapHold${k}`]=prev&&row.gap&&Math.abs(row.gap)>1e-6?(s.close-prev.close)/(open-prev.close):null;
      for(const h of [5,15,30,60]){const z=fwd(day,end,h);row[`fwd${h}From${k}`]=z.ret;row[`mfe${h}From${k}`]=z.mfe;row[`mae${h}From${k}`]=z.mae;}
    }
    out.push(row); prev={close,high};
  }
  for(let i=0;i<out.length;i++){
    const hist=out.slice(Math.max(0,i-20),i);
    for(const k of [5,15,30]){const base=median(hist.map(x=>x[`vol${k}`]));out[i][`rvol${k}`]=base&&out[i][`vol${k}`]?out[i][`vol${k}`]/base:null;}
    out[i].retStd20=std(hist.map(x=>x.dailyReturn));
  }
  return out;
}

const all={};
for(const t of tickers){const j=await loadGzipJson(path.join(rawDir,`${t}.json.gz`));all[t]=dailyRows(j.bars,t);console.log(`${t}: ${all[t].length} sessions`);}
if(!all.MU)throw new Error('MU raw data is required');
const peerNames=tickers.filter(x=>x!=='MU'); const peerMaps=Object.fromEntries(peerNames.map(t=>[t,new Map(all[t].map(r=>[r.date,r]))]));
const rows=all.MU.map(mu=>{
  const r={...mu};
  for(const k of [5,15,30]){
    const peers=peerNames.map(t=>peerMaps[t].get(mu.date)?.[`retPrev${k}`]).filter(Number.isFinite);
    r[`peerRet${k}`]=mean(peers); r[`rs${k}`]=Number.isFinite(mu[`retPrev${k}`])&&Number.isFinite(r[`peerRet${k}`])?mu[`retPrev${k}`]-r[`peerRet${k}`]:null;
  }
  const thr=Math.max(0.05,1.5*(mu.retStd20??0));
  r.bigUp=Number.isFinite(mu.dailyReturn)&&mu.dailyReturn>=thr;
  r.bigDown=Number.isFinite(mu.dailyReturn)&&mu.dailyReturn<=-thr;
  r.reversalLong=Number.isFinite(mu.gap)&&mu.gap<=-0.01&&mu.close>mu.open&&mu.prevClose&&mu.close>mu.prevClose;
  const breakoutLevel=Math.max(mu.pmHigh??-Infinity,mu.prevHigh??-Infinity);
  r.failedBreakout=Number.isFinite(mu.gap)&&mu.gap>=0.01&&Number.isFinite(mu.high15)&&mu.high15>breakoutLevel&&mu.close15<mu.open&&mu.close<mu.open;
  return r;
});

const setupDefs=[
  {name:'gap_go_long_15',side:'LONG',entry:'15',test:r=>r.gap>=0.01&&r.gapHold5>=0.70&&r.distVwap15>0&&r.rs15>0&&(r.rvol15??0)>=1.2},
  {name:'failed_breakout_short_15',side:'SHORT',entry:'15',test:r=>r.gap>=0.01&&r.gapHold5<0.70&&r.distVwap15<0&&r.rs15<0},
  {name:'reversal_long_30',side:'LONG',entry:'30',test:r=>r.gap<=-0.01&&r.close30>r.open&&r.distVwap30>0&&r.rs30>r.rs5},
  {name:'trend_breakdown_short_15',side:'SHORT',entry:'15',test:r=>r.gap<=-0.01&&r.close15<r.open&&r.distVwap15<0&&r.rs15<0},
];
const dates=rows.map(r=>r.date); const splitDate=dates[Math.floor(dates.length*0.7)]??'';
const setupResults=[]; const events=[];
for(const s of setupDefs){
  const hits=rows.filter(s.test); for(const h of hits)events.push({setup:s.name,side:s.side,entryMinutes:s.entry,date:h.date,gap:h.gap,rs15:h.rs15,rs30:h.rs30,rvol15:h.rvol15,rvol30:h.rvol30,fwd30:h[`fwd30From${s.entry}`],mfe30:h[`mfe30From${s.entry}`],mae30:h[`mae30From${s.entry}`]});
  const summarize=x=>summarizeDirectional(x,`fwd30From${s.entry}`,s.side,`mfe30From${s.entry}`,`mae30From${s.entry}`);
  setupResults.push({name:s.name,side:s.side,entryMinutes:Number(s.entry),all:summarize(hits),train:summarize(hits.filter(x=>x.date<splitDate)),test:summarize(hits.filter(x=>x.date>=splitDate))});
}

const labelSummary={};
for(const label of ['bigUp','bigDown','reversalLong','failedBreakout']){
  const x=rows.filter(r=>r[label]); labelSummary[label]={n:x.length,avgGap:mean(x.map(r=>r.gap)),avgRet5:mean(x.map(r=>r.retPrev5)),avgRet15:mean(x.map(r=>r.retPrev15)),avgRet30:mean(x.map(r=>r.retPrev30)),avgRs5:mean(x.map(r=>r.rs5)),avgRs15:mean(x.map(r=>r.rs15)),avgRs30:mean(x.map(r=>r.rs30)),avgRvol15:mean(x.map(r=>r.rvol15)),avgDailyReturn:mean(x.map(r=>r.dailyReturn))};
}

await writeCsv(path.join(outDir,'mu_daily_features.csv'),rows);
await writeCsv(path.join(outDir,'setup_events.csv'),events);
await writeJson(path.join(outDir,'summary.json'),{generatedAt:new Date().toISOString(),source:'Massive 1-minute adjusted aggregate bars',sample:{start:rows[0]?.date??DEFAULT_START,end:rows.at(-1)?.date??DEFAULT_END,sessions:rows.length,splitDate},definitions:{bigMove:'abs daily return >= max(5%, 1.5 × prior-20-session daily-return stdev)',reversalLong:'gap <= -1%, close > open, close > prior close',failedBreakout:'gap >= +1%, first-15m high breaks max(premarket high, prior-day high), first-15m close < open, daily close < open'},labelSummary,setupResults});
console.log(JSON.stringify({sample:{sessions:rows.length,splitDate},labelSummary,setupResults},null,2));
