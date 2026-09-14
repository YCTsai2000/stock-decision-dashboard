import fs from 'node:fs/promises';

const OPEN=570,CLOSE=960,OR_END=585;
const FROM='2026-07-17',TO='2026-09-12',DAILY_FROM='2025-11-01';
const COST_BPS_PER_SIDE=2,MIN_SCORE=80,MIN_LEAD=15;
const HOLDOUT='ORCL';
const SYMBOLS={
  NVDA:'SOXX',AMD:'SOXX',LITE:'XLK',TSLA:'XLY',MU:'SOXX',SNDK:'SOXX',AVGO:'SOXX',DELL:'XLK',ORCL:'IGV'
};
const DEV_SYMBOLS=Object.keys(SYMBOLS).filter(s=>s!==HOLDOUT);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sum=a=>a.reduce((x,y)=>x+y,0),mean=a=>a.length?sum(a)/a.length:0,clamp=(x,a=0,b=100)=>Math.min(b,Math.max(a,x));
const epoch=s=>Math.floor(new Date(`${s}T00:00:00Z`).getTime()/1000);

function ny(ms){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const g=t=>p.find(x=>x.type===t)?.value??'';const time=`${g('hour')}:${g('minute')}`,[h,m]=time.split(':').map(Number);
  return{date:`${g('year')}-${g('month')}-${g('day')}`,time,minute:h*60+m};
}
async function yahoo(symbol,interval,from,to){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${epoch(from)}&period2=${epoch(to)}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  for(let attempt=1;attempt<=4;attempt++){
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 stock-decision-dashboard-event-optimizer','Accept':'application/json'}});
    if(r.ok){
      const j=await r.json(),x=j?.chart?.result?.[0];if(!x)throw new Error(`${symbol} ${interval}: no chart result`);
      const q=x.indicators?.quote?.[0]??{},out=[];
      for(let i=0;i<(x.timestamp??[]).length;i++){
        const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i],v=q.volume?.[i];
        if(![o,h,l,c].every(Number.isFinite))continue;
        const p=ny(x.timestamp[i]*1000);out.push({...p,epoch:x.timestamp[i]*1000,open:+o,high:+h,low:+l,close:+c,volume:Number.isFinite(v)?+v:0});
      }
      return out.sort((a,b)=>a.epoch-b.epoch);
    }
    if(attempt===4)throw new Error(`${symbol} ${interval}: HTTP ${r.status}`);
    await sleep(700*attempt);
  }
}
const reg=a=>a.filter(b=>b.minute>=OPEN&&b.minute<CLOSE);
function byDate(a){const m=new Map();for(const b of a){if(!m.has(b.date))m.set(b.date,[]);m.get(b.date).push(b)}for(const v of m.values())v.sort((a,b)=>a.epoch-b.epoch);return m}
function ma(a,n){return a.length<n?null:mean(a.slice(-n).map(x=>x.close))}
function dailyBias(d,date){const p=d.filter(x=>x.date<date);if(p.length<60)return'NEUTRAL';const c=p.at(-1).close,m20=ma(p,20),m60=ma(p,60);return c>m20&&m20>m60?'LONG':c<m20&&m20<m60?'SHORT':'NEUTRAL'}
function prevClose(d,date){const p=d.filter(x=>x.date<date);return p.length?p.at(-1).close:null}
function marketMode(spy,qqq,date){const s=spy.filter(x=>x.date<date),q=qqq.filter(x=>x.date<date);if(s.length<50||q.length<50)return'NEUTRAL';const sc=s.at(-1).close,qc=q.at(-1).close,s20=ma(s,20),s50=ma(s,50),q20=ma(q,20),q50=ma(q,50);if(sc>s20&&s20>s50&&qc>q20&&q20>q50)return'RISK_ON';if(sc<s20&&s20<s50&&qc<q20&&q20<q50)return'RISK_OFF';return'NEUTRAL'}
function vwapSeries(a){let pv=0,v=0;return a.map(b=>{const t=(b.high+b.low+b.close)/3;if(b.volume>0){pv+=t*b.volume;v+=b.volume}return v?pv/v:b.close})}
function atr(a,n=14){if(a.length<=n)return Math.max(a.at(-1).close*.002,.01);const s=a.slice(-(n+1)),tr=[];for(let i=1;i<s.length;i++)tr.push(Math.max(s[i].high-s[i].low,Math.abs(s[i].high-s[i-1].close),Math.abs(s[i].low-s[i-1].close)));return mean(tr)}
function rvol(map,dates,date,min){const prior=dates.filter(d=>d<date).slice(-10);if(prior.length<3)return null;const cur=sum((map.get(date)||[]).filter(b=>b.minute>=OPEN&&b.minute<=min).map(b=>b.volume));const hist=prior.map(d=>sum((map.get(d)||[]).filter(b=>b.minute>=OPEN&&b.minute<=min).map(b=>b.volume))).filter(x=>x>0);return hist.length>=3?cur/mean(hist):null}
function bench(day,min){const a=day.filter(b=>b.minute>=OPEN&&b.minute<=min);if(!a.length)return null;const vs=vwapSeries(a),vw=vs.at(-1);return{ret:(a.at(-1).close/a[0].open-1)*100,above:a.at(-1).close>vw}}
function metric(prefix,oh,ol,rv,bm){const price=prefix.at(-1).close,vs=vwapSeries(prefix),vw=vs.at(-1),A=atr(prefix),recent=prefix.slice(-4);return{minute:prefix.at(-1).minute,time:prefix.at(-1).time,price,vwap:vw,slope:vs.length>=4?vs.at(-1)>vs.at(-4):null,atr:A,above:price>vw,below:price<vw,brokeHigh:price>oh,brokeLow:price<ol,rs:bm?(price/prefix[0].open-1)*100-bm.ret:null,rv,benchAbove:bm?.above??null,recentLow:Math.min(...recent.map(x=>x.low)),recentHigh:Math.max(...recent.map(x=>x.high)),orHigh:oh,orLow:ol}}
function scores(m,bias,market){let L=(bias==='LONG'?10:bias==='NEUTRAL'?5:0)+(market==='RISK_ON'?15:market==='NEUTRAL'?8:0),S=(bias==='SHORT'?10:bias==='NEUTRAL'?3:0)+(market==='RISK_OFF'?15:market==='NEUTRAL'?5:0);if(m.benchAbove===true)L+=15;if(m.benchAbove===false)S+=15;if(m.above)L+=12;if(m.below)S+=12;if(m.slope===true)L+=8;if(m.slope===false)S+=8;if(m.brokeHigh)L+=20;if(m.brokeLow)S+=20;const rv=m.rv??0,vp=rv>=2?10:rv>=1.5?8:rv>=1.2?6:rv>=1?3:0;L+=vp;S+=vp;const rs=m.rs;if(rs!=null){if(rs>=.5)L+=10;else if(rs>=.2)L+=7;else if(rs>0)L+=4;if(rs<=-.5)S+=10;else if(rs<=-.2)S+=7;else if(rs<0)S+=4}return{L:clamp(L),S:clamp(S)}}
function stats(t){const r=t.map(x=>x.netR),w=r.filter(x=>x>0),l=r.filter(x=>x<0),profit=sum(w),loss=-sum(l);let eq=0,peak=0,dd=0;for(const x of r){eq+=x;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq)}return{trades:t.length,winRate:t.length?w.length/t.length*100:0,avgR:mean(r),totalR:sum(r),profitFactor:loss?profit/loss:(profit>0?99:null),maxDrawdownR:dd}}
function perSymbol(t){return Object.fromEntries([...new Set(t.map(x=>x.symbol))].sort().map(s=>[s,stats(t.filter(x=>x.symbol===s))]))}
function simulateShort(day,index,s,cfg,costBps=COST_BPS_PER_SIDE){const entry=day[index].open,a=s.atr,c=[s.vwap+a*.25,s.orLow+a*.2,s.recentHigh+a*.1].filter(v=>v>entry),struct=c.length?Math.min(...c):entry+a*.5,stop=Math.max(entry+a*cfg.stopAtr,struct),risk=Math.max(.01,stop-entry),target=entry-cfg.targetR*risk;let exit=day.at(-1).close,outcome='EOD',exitTime=day.at(-1).time;for(let j=index;j<day.length;j++){const b=day[j];if(b.high>=stop){exit=stop;outcome='STOP';exitTime=b.time;break}if(b.low<=target){exit=target;outcome='TARGET';exitTime=b.time;break}}const grossR=(entry-exit)/risk,costR=(entry*(costBps*2/10000))/risk;return{entry,entryTime:day[index].time,stop,target,risk,exit,exitTime,outcome,grossR,netR:grossR-costR}}

async function load(){
  const data={bench:{},stocks:{},daily:{}};
  const uniqueBench=[...new Set(Object.values(SYMBOLS))];
  for(const b of uniqueBench){data.bench[b]=byDate(reg(await yahoo(b,'5m',FROM,TO)));await sleep(180)}
  const spy=await yahoo('SPY','1d',DAILY_FROM,TO),qqq=await yahoo('QQQ','1d',DAILY_FROM,TO);data.daily.SPY=spy;data.daily.QQQ=qqq;
  for(const s of Object.keys(SYMBOLS)){
    console.log('loading',s);data.stocks[s]=byDate(reg(await yahoo(s,'5m',FROM,TO)));await sleep(180);data.daily[s]=await yahoo(s,'1d',DAILY_FROM,TO);await sleep(180);
  }
  return data;
}
function buildCases(data){
  const cases=[];
  for(const [symbol,benchmark] of Object.entries(SYMBOLS)){
    const sm=data.stocks[symbol],bm=data.bench[benchmark],dates=[...sm.keys()].sort(),bdaily=data.daily[symbol];
    for(const date of dates){
      const day=sm.get(date)||[],bday=bm.get(date)||[];if(day.length<30||bday.length<30)continue;
      const bias=dailyBias(bdaily,date);if(bias!=='LONG')continue;
      const pc=prevClose(bdaily,date);if(!pc)continue;const gapPct=(day[0].open/pc-1)*100;if(gapPct<1.5)continue;
      const market=marketMode(data.daily.SPY,data.daily.QQQ,date);if(market==='RISK_ON')continue;
      const opening=day.filter(b=>b.minute>=OPEN&&b.minute<OR_END);if(opening.length<3)continue;const oh=Math.max(...opening.map(b=>b.high)),ol=Math.min(...opening.map(b=>b.low));
      const snapshots=[];
      for(let i=0;i<day.length-1;i++){
        const bar=day[i];if(bar.minute<600||bar.minute>930)continue;const prefix=day.slice(0,i+1),rv=rvol(sm,dates,date,bar.minute),bb=bench(bday,bar.minute);if(rv==null||!bb)continue;const m=metric(prefix,oh,ol,rv,bb),sc=scores(m,'NEUTRAL',market);snapshots.push({...m,...sc,index:i});
      }
      cases.push({symbol,benchmark,date,bias,market,gapPct,day,snapshots});
    }
  }
  return cases;
}
function runConfig(cases,cfg,costBps=COST_BPS_PER_SIDE){const trades=[];for(const c of cases){if(c.gapPct<cfg.gapMin)continue;let sig=null;for(const s of c.snapshots){if(s.minute<cfg.startMinute)continue;if((s.rv??0)<cfg.rvolMin)continue;if((s.rs??0)>-cfg.rsAbsMin)continue;const ready=s.below&&s.slope===false&&s.benchAbove===false&&s.brokeLow;if(!ready)continue;if(s.S<MIN_SCORE||s.S-s.L<MIN_LEAD)continue;sig=s;break}if(!sig||sig.index+1>=c.day.length)continue;const tr=simulateShort(c.day,sig.index+1,sig,cfg,costBps);trades.push({...tr,symbol:c.symbol,date:c.date,gapPct:c.gapPct,rvol:sig.rv,rs:sig.rs,signalTime:sig.time,longScore:sig.L,shortScore:sig.S})}return trades}
function robustScore(train,val){const a=stats(train),b=stats(val);if(a.trades<4||b.trades<2)return-Infinity;if(a.avgR<=0||b.avgR<=0)return-Infinity;const minAvg=Math.min(a.avgR,b.avgR),minPf=Math.min(a.profitFactor??0,b.profitFactor??0);return minAvg*100+Math.min(minPf,3)*8-(a.maxDrawdownR+b.maxDrawdownR)*1.2+Math.sqrt(a.trades+b.trades)}
function splitCases(cases){const dev=cases.filter(c=>DEV_SYMBOLS.includes(c.symbol)),dates=[...new Set(dev.map(c=>c.date))].sort(),cut=dates[Math.max(0,Math.floor(dates.length*.60)-1)]??'9999-12-31';return{cut,train:dev.filter(c=>c.date<=cut),val:dev.filter(c=>c.date>cut),holdout:cases.filter(c=>c.symbol===HOLDOUT)}}
function product(grid){const keys=Object.keys(grid),out=[];const rec=(i,x)=>{if(i===keys.length){out.push({...x});return}const k=keys[i];for(const v of grid[k])rec(i+1,{...x,[k]:v})};rec(0,{});return out}
function evaluate(configs,split){const rows=[];for(const cfg of configs){const train=runConfig(split.train,cfg),val=runConfig(split.val,cfg),score=robustScore(train,val);rows.push({cfg,score,train:stats(train),val:stats(val),trainBySymbol:perSymbol(train),valBySymbol:perSymbol(val)})}return rows.sort((a,b)=>b.score-a.score)}
function fineGrid(best){const uniq=a=>[...new Set(a.map(x=>Math.round(x*100)/100))].filter(x=>x>0);return product({gapMin:uniq([best.gapMin-.5,best.gapMin,best.gapMin+.5]),rvolMin:uniq([best.rvolMin-.25,best.rvolMin,best.rvolMin+.25]),rsAbsMin:uniq([best.rsAbsMin-.25,best.rsAbsMin,best.rsAbsMin+.25]),startMinute:uniq([best.startMinute-10,best.startMinute,best.startMinute+10]),stopAtr:uniq([best.stopAtr-.1,best.stopAtr,best.stopAtr+.1]),targetR:uniq([best.targetR-.25,best.targetR,best.targetR+.25])})}
function loso(cases,cfg){const out={};for(const s of DEV_SYMBOLS){const t=runConfig(cases.filter(c=>c.symbol!==s),cfg);out[s]=stats(t)}return out}

await fs.mkdir('backtest-output-event-reversal',{recursive:true});
const data=await load(),cases=buildCases(data),split=splitCases(cases);
console.log('cases',cases.length,'split',split.cut,'train',split.train.length,'val',split.val.length,'holdout',split.holdout.length);
const coarse=product({gapMin:[2,3,4,5],rvolMin:[1.5,2,2.5,3],rsAbsMin:[.5,1,1.5,2],startMinute:[600,615,630],stopAtr:[.65,.8],targetR:[1.75,2]});
const coarseRows=evaluate(coarse,split),coarseBest=coarseRows.find(x=>Number.isFinite(x.score));
if(!coarseBest)throw new Error('No coarse configuration passed train/validation convergence gates');
const fine=fineGrid(coarseBest.cfg),fineRows=evaluate(fine,split),best=fineRows.find(x=>Number.isFinite(x.score))??coarseBest;
const holdoutTrades=runConfig(split.holdout,best.cfg),allDevTrades=runConfig([...split.train,...split.val],best.cfg);
const stress=[2,4,6,10].map(roundTrip=>({roundTripBps:roundTrip,trades:stats(runConfig([...split.train,...split.val],best.cfg,roundTrip/2)),holdout:stats(runConfig(split.holdout,best.cfg,roundTrip/2))}));
const nearby=fineRows.filter(x=>Number.isFinite(x.score)).slice(0,30);const positiveNearby=nearby.filter(x=>x.train.avgR>0&&x.val.avgR>0).length;
const result={generatedAt:new Date().toISOString(),method:'Two-stage coarse-to-fine event-reversal parameter study. Development symbols exclude ORCL; chronological 60/40 development split; ORCL is untouched symbol holdout. Entry is next 5m open; same-bar ambiguity is conservative stop-first; round-trip 4 bps base friction.',range:{from:FROM,to:TO},symbols:{development:DEV_SYMBOLS,holdout:HOLDOUT},eventCases:cases.map(c=>({symbol:c.symbol,date:c.date,gapPct:c.gapPct,market:c.market,snapshots:c.snapshots.length})),splitDate:split.cut,coarseCount:coarse.length,fineCount:fine.length,coarseBest,best:{...best,allDevelopment:stats(allDevTrades),allDevelopmentBySymbol:perSymbol(allDevTrades),holdout:stats(holdoutTrades),holdoutTrades,leaveOneSymbolOut:loso([...split.train,...split.val],best.cfg),stress},neighborhood:{topN:nearby.length,positiveTrainAndValidation:positiveNearby,rows:nearby},topCoarse:coarseRows.slice(0,30)};
await fs.writeFile('backtest-output-event-reversal/result.json',JSON.stringify(result,null,2));
const csv=['stage,gapMin,rvolMin,rsAbsMin,startMinute,stopAtr,targetR,trainN,trainAvgR,trainPF,valN,valAvgR,valPF,score',...coarseRows.slice(0,50).map(x=>['coarse',x.cfg.gapMin,x.cfg.rvolMin,x.cfg.rsAbsMin,x.cfg.startMinute,x.cfg.stopAtr,x.cfg.targetR,x.train.trades,x.train.avgR,x.train.profitFactor??'',x.val.trades,x.val.avgR,x.val.profitFactor??'',x.score].join(',')),...fineRows.slice(0,80).map(x=>['fine',x.cfg.gapMin,x.cfg.rvolMin,x.cfg.rsAbsMin,x.cfg.startMinute,x.cfg.stopAtr,x.cfg.targetR,x.train.trades,x.train.avgR,x.train.profitFactor??'',x.val.trades,x.val.avgR,x.val.profitFactor??'',x.score].join(','))];
await fs.writeFile('backtest-output-event-reversal/parameter-study.csv',csv.join('\n'));
console.log(JSON.stringify({best:result.best.cfg,train:result.best.train,val:result.best.val,development:result.best.allDevelopment,holdout:result.best.holdout,holdoutTrades:result.best.holdoutTrades,neighborhood:result.neighborhood,stress:result.best.stress},null,2));
