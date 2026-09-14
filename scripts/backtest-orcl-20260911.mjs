import fs from 'node:fs/promises';

const DATE = '2026-09-11';
const OPEN = 570, CLOSE = 960, OR_END = 585;
const PROFILE = { benchmark: 'IGV', minEntryMinute: 600, minRvol: 1.2, highConvictionRvol: 1.5, minStopAtr: 0.65, target1R: 1.75, target2R: 2.0 };
const ACCOUNT = 15000, RISK_PCT = 0.5, MAX_ALLOC = 25;
const MIN_SCORE = 75, MIN_LEAD = 12;

const sum = a => a.reduce((x,y)=>x+y,0);
const mean = a => a.length ? sum(a)/a.length : 0;
const clamp = (x,a=0,b=100) => Math.min(Math.max(x,a),b);
const epoch = s => Math.floor(new Date(`${s}T00:00:00Z`).getTime()/1000);

function nyParts(ms){
  const p = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const g=t=>p.find(x=>x.type===t)?.value??'';
  const time=`${g('hour')}:${g('minute')}`; const [h,m]=time.split(':').map(Number);
  return {date:`${g('year')}-${g('month')}-${g('day')}`,time,minute:h*60+m};
}

async function yahoo(symbol, interval, from, to){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${epoch(from)}&period2=${epoch(to)}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 stock-decision-dashboard-backtest','Accept':'application/json'}});
  if(!r.ok) throw new Error(`${symbol} ${interval}: HTTP ${r.status}`);
  const j=await r.json(); const x=j?.chart?.result?.[0]; if(!x) throw new Error(`${symbol}: ${j?.chart?.error?.description??'no data'}`);
  const q=x.indicators?.quote?.[0]??{}, adj=x.indicators?.adjclose?.[0]?.adjclose??[];
  const out=[];
  for(let i=0;i<(x.timestamp??[]).length;i++){
    const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i],v=q.volume?.[i];
    if(![o,h,l,c].every(Number.isFinite)) continue;
    const p=nyParts(x.timestamp[i]*1000);
    out.push({...p,epoch:x.timestamp[i]*1000,open:+o,high:+h,low:+l,close:+c,adjClose:Number.isFinite(adj[i])?+adj[i]:+c,volume:Number.isFinite(v)?+v:0});
  }
  return out.sort((a,b)=>a.epoch-b.epoch);
}

const reg=a=>a.filter(b=>b.minute>=OPEN&&b.minute<CLOSE);
function byDate(a){const m=new Map();for(const b of a){if(!m.has(b.date))m.set(b.date,[]);m.get(b.date).push(b)}for(const x of m.values())x.sort((a,b)=>a.epoch-b.epoch);return m}
function ma(a,n){return a.length<n?null:mean(a.slice(-n).map(x=>x.close))}
function dailyBias(d){const p=d.filter(x=>x.date<DATE);if(p.length<60)return'NEUTRAL';const c=p.at(-1).close,m20=ma(p,20),m60=ma(p,60);return c>m20&&m20>m60?'LONG':c<m20&&m20<m60?'SHORT':'NEUTRAL'}
function marketMode(spy,qqq){const s=spy.filter(x=>x.date<DATE),q=qqq.filter(x=>x.date<DATE);if(s.length<50||q.length<50)return'NEUTRAL';const sc=s.at(-1).close,qc=q.at(-1).close,s20=ma(s,20),s50=ma(s,50),q20=ma(q,20),q50=ma(q,50);if(sc>s20&&s20>s50&&qc>q20&&q20>q50)return'RISK_ON';if(sc<s20&&s20<s50&&qc<q20&&q20<q50)return'RISK_OFF';return'NEUTRAL'}
function vwapSeries(a){let pv=0,v=0;return a.map(b=>{const t=(b.high+b.low+b.close)/3;if(b.volume>0){pv+=t*b.volume;v+=b.volume}return v?pv/v:b.close})}
function atr(a,n=14){if(a.length<=n)return null;const s=a.slice(-(n+1)),tr=[];for(let i=1;i<s.length;i++)tr.push(Math.max(s[i].high-s[i].low,Math.abs(s[i].high-s[i-1].close),Math.abs(s[i].low-s[i-1].close)));return mean(tr)}
function rvol(map,dates,date,min){const prior=dates.filter(d=>d<date).slice(-10);if(prior.length<3)return null;const cur=sum((map.get(date)||[]).filter(b=>b.minute>=OPEN&&b.minute<=min).map(b=>b.volume));const hist=prior.map(d=>sum((map.get(d)||[]).filter(b=>b.minute>=OPEN&&b.minute<=min).map(b=>b.volume))).filter(x=>x>0);return hist.length>=3?cur/mean(hist):null}
function bench(day,min){const x=day.filter(b=>b.minute>=OPEN&&b.minute<=min);if(!x.length)return{ret:null,above:null,vwap:null};const vs=vwapSeries(x),vw=vs.at(-1);return{ret:(x.at(-1).close/x[0].open-1)*100,above:x.at(-1).close>vw,vwap:vw}}
function metric(prefix, oh, ol, rv, bm){const p=prefix.at(-1).close,vs=vwapSeries(prefix),vw=vs.at(-1),a=atr(prefix)??Math.max(p*.002,.01);const rs=bm.ret==null?null:(p/prefix[0].open-1)*100-bm.ret;const recent=prefix.slice(-4);return{minute:prefix.at(-1).minute,time:prefix.at(-1).time,price:p,vwap:vw,slope:vs.length>=4?vs.at(-1)>vs.at(-4):null,atr:a,above:p>vw,below:p<vw,brokeHigh:p>oh,brokeLow:p<ol,rs,rv,benchmarkAboveVwap:bm.above,recentLow:Math.min(...recent.map(b=>b.low)),recentHigh:Math.max(...recent.map(b=>b.high))}}
function scores(m,bias,market){let L=0,S=0;L+=bias==='LONG'?15:bias==='NEUTRAL'?6:0;S+=bias==='SHORT'?15:0;L+=market==='RISK_ON'?15:market==='NEUTRAL'?8:0;S+=market==='RISK_OFF'?15:market==='NEUTRAL'?7:0;if(m.above)L+=15;if(m.below)S+=15;if(m.slope===true)L+=10;if(m.slope===false)S+=10;if(m.benchmarkAboveVwap===true)L+=10;if(m.benchmarkAboveVwap===false)S+=10;if(m.brokeHigh)L+=20;if(m.brokeLow)S+=20;const rs=m.rs??0;if(rs>0)L+=Math.min(15,5+Math.abs(rs)*10);if(rs<0)S+=Math.min(15,5+Math.abs(rs)*10);const rv=m.rv??0,rvPts=rv>=PROFILE.highConvictionRvol?15:rv>=PROFILE.minRvol?10:rv>=1?4:0;return{L:clamp(L+rvPts),S:clamp(S+rvPts)}}
function direction(m,bias,market){const {L,S}=scores(m,bias,market);const longReady=m.minute>=PROFILE.minEntryMinute&&(m.rv??0)>=PROFILE.minRvol&&market!=='RISK_OFF'&&m.above&&m.slope===true&&m.benchmarkAboveVwap===true&&(m.rs??0)>0&&m.brokeHigh;const shortReady=m.minute>=PROFILE.minEntryMinute&&(m.rv??0)>=PROFILE.minRvol&&market!=='RISK_ON'&&bias==='SHORT'&&m.below&&m.slope===false&&m.benchmarkAboveVwap===false&&(m.rs??0)<0&&m.brokeLow;let dir='WAIT';if(longReady&&L>=MIN_SCORE&&L-S>=MIN_LEAD)dir='LONG';else if(shortReady&&S>=MIN_SCORE&&S-L>=MIN_LEAD)dir='SHORT';return{...m,L,S,dir,longReady,shortReady}}
function levels(s,entry){const a=s.atr;if(s.dir==='LONG'){const c=[s.vwap-a*.25,s.orHigh-a*.2,s.recentLow-a*.1].filter(v=>v<entry);const structural=c.length?Math.max(...c):entry-a*.5;const stop=Math.max(.01,Math.min(structural,entry-a*PROFILE.minStopAtr));return{stop,risk:entry-stop}}const c=[s.vwap+a*.25,s.orLow+a*.2,s.recentHigh+a*.1].filter(v=>v>entry);const structural=c.length?Math.min(...c):entry+a*.5;const stop=Math.max(entry+a*PROFILE.minStopAtr,structural);return{stop,risk:stop-entry}}
function replay(day,startIndex,s){const entry=day[startIndex].open,l=levels(s,entry),tp1=s.dir==='LONG'?entry+PROFILE.target1R*l.risk:entry-PROFILE.target1R*l.risk,tp2=s.dir==='LONG'?entry+PROFILE.target2R*l.risk:entry-PROFILE.target2R*l.risk;const run=(target)=>{for(let j=startIndex;j<day.length;j++){const b=day[j];if(s.dir==='LONG'){if(b.low<=l.stop)return{outcome:'STOP',exit:l.stop,time:b.time,index:j,r:-1};if(b.high>=target)return{outcome:'TARGET',exit:target,time:b.time,index:j,r:(target-entry)/l.risk}}else{if(b.high>=l.stop)return{outcome:'STOP',exit:l.stop,time:b.time,index:j,r:-1};if(b.low<=target)return{outcome:'TARGET',exit:target,time:b.time,index:j,r:(entry-target)/l.risk}}}const ex=day.at(-1).close;return{outcome:'EOD',exit:ex,time:day.at(-1).time,index:day.length-1,r:s.dir==='LONG'?(ex-entry)/l.risk:(entry-ex)/l.risk}};return{entry,entryTime:day[startIndex].time,stop:l.stop,risk:l.risk,tp1,tp2,toTP1:run(tp1),toTP2:run(tp2)}}
function etfApprox(dayMap,entryTime,exitTime){const d=dayMap.get(DATE)||[];const en=d.find(b=>b.time===entryTime)??d.find(b=>b.minute>=Number(entryTime.slice(0,2))*60+Number(entryTime.slice(3,5)));const ex=d.find(b=>b.time===exitTime)??d.filter(b=>b.minute<=Number(exitTime.slice(0,2))*60+Number(exitTime.slice(3,5))).at(-1);if(!en||!ex)return null;return{entry:en.open,exit:ex.close,returnPct:(ex.close/en.open-1)*100,entryTime:en.time,exitTime:ex.time}}

await fs.mkdir('backtest-output-orcl-20260911',{recursive:true});
const from='2026-08-20',to='2026-09-12',dailyFrom='2026-03-01';
const [orcl,igv,orcu,orcz,orclDaily,spyDaily,qqqDaily]=await Promise.all([
  yahoo('ORCL','5m',from,to),yahoo('IGV','5m',from,to),yahoo('ORCU','5m',from,to).catch(()=>[]),yahoo('ORCZ','5m',from,to).catch(()=>[]),
  yahoo('ORCL','1d',dailyFrom,to),yahoo('SPY','1d',dailyFrom,to),yahoo('QQQ','1d',dailyFrom,to),
]);
const om=byDate(reg(orcl)), im=byDate(reg(igv)), orcuMap=byDate(reg(orcu)), orczMap=byDate(reg(orcz));
const day=om.get(DATE)||[], bday=im.get(DATE)||[]; if(day.length<20||bday.length<20)throw new Error(`Insufficient 5m data: ORCL ${day.length}, IGV ${bday.length}`);
const dates=[...om.keys()].sort(), bias=dailyBias(orclDaily), market=marketMode(spyDaily,qqqDaily);
const opening=day.filter(b=>b.minute>=OPEN&&b.minute<OR_END),orHigh=Math.max(...opening.map(b=>b.high)),orLow=Math.min(...opening.map(b=>b.low));
const timeline=[];let signal=null;
for(let i=0;i<day.length;i++){
  const bar=day[i]; if(bar.minute<OR_END)continue; const prefix=day.slice(0,i+1); const rv=rvol(om,dates,DATE,bar.minute); const bm=bench(bday,bar.minute); const m=metric(prefix,orHigh,orLow,rv,bm); m.orHigh=orHigh;m.orLow=orLow; const d=direction(m,bias,market); timeline.push(d); if(!signal&&d.dir!=='WAIT'&&i+1<day.length)signal={...d,index:i};
}
let trade=null;
if(signal){trade=replay(day,signal.index+1,signal);const map=signal.dir==='LONG'?orcuMap:orczMap;trade.executionTicker=signal.dir==='LONG'?'ORCU':'ORCZ';trade.etfToTP1=etfApprox(map,trade.entryTime,trade.toTP1.time);trade.etfToTP2=etfApprox(map,trade.entryTime,trade.toTP2.time)}
const snapshots=[600,615,630,660,690,720,780,840,900,930].map(min=>timeline.filter(x=>x.minute<=min).at(-1)).filter(Boolean).map(x=>({time:x.time,price:x.price,vwap:x.vwap,rvol:x.rv,rs:x.rs,benchmarkAboveVwap:x.benchmarkAboveVwap,brokeHigh:x.brokeHigh,brokeLow:x.brokeLow,longScore:x.L,shortScore:x.S,direction:x.dir}));
const result={date:DATE,taipeiWindow:'2026-09-11 21:30 to 2026-09-12 04:00',profile:{symbol:'ORCL',benchmark:'IGV',...PROFILE},dailyBias:bias,marketMode:market,day:{open:day[0].open,high:Math.max(...day.map(x=>x.high)),low:Math.min(...day.map(x=>x.low)),close:day.at(-1).close,volume:sum(day.map(x=>x.volume)),orHigh,orLow},signal:signal?{time:signal.time,direction:signal.dir,longScore:signal.L,shortScore:signal.S,price:signal.price,vwap:signal.vwap,rvol:signal.rv,rsVsIgv:signal.rs,benchmarkAboveVwap:signal.benchmarkAboveVwap,atr5m:signal.atr,recentLow:signal.recentLow,recentHigh:signal.recentHigh}:null,trade,snapshots,limitations:['Yahoo 5m OHLCV is used as historical replay source, not the live Twelve/Alpaca feed.','Historical NBBO/bid-ask spread is unavailable here, so V5 execution spread hard-filter cannot be reconstructed exactly.','ETF return is approximated from the matching 5m bar open/close; it is not a tick-level fill simulation.']};
await fs.writeFile('backtest-output-orcl-20260911/result.json',JSON.stringify(result,null,2));
await fs.writeFile('backtest-output-orcl-20260911/timeline.csv',['time,price,vwap,rvol,rs,longScore,shortScore,direction',...timeline.map(x=>[x.time,x.price,x.vwap,x.rv??'',x.rs??'',x.L,x.S,x.dir].join(','))].join('\n'));
console.log(JSON.stringify(result,null,2));
