export type MuBacktestSetupName = 'REVERSAL_LONG' | 'FAILED_BREAKOUT_SHORT' | 'TREND_BREAKDOWN_SHORT' | 'GAP_GO_LONG';

export interface MuBacktestStats {
  n: number;
  winRate: number | null;
  avgNetPct: number | null;
  medianNetPct: number | null;
  profitFactor: number | null;
}

export interface MuBacktestSetupResult {
  name: MuBacktestSetupName;
  side: 'LONG' | 'SHORT';
  chosenHorizon: 15 | 30 | 60;
  all: MuBacktestStats;
  train: MuBacktestStats;
  test: MuBacktestStats;
  stress: MuBacktestStats;
  allDates: string[];
  trainDates: string[];
  testDates: string[];
  gates: Record<string, boolean>;
  structureValidated: boolean;
}

export interface MuLocalBacktestResult {
  generatedAt: string;
  source: 'Massive 5-minute adjusted aggregates';
  start: string;
  end: string;
  sessions: number;
  splitDate: string;
  baselineCostBpsSide: number;
  stressCostBpsSide: number;
  status: 'STRUCTURE_VALIDATED' | 'NO_VALIDATED_SETUP';
  setups: MuBacktestSetupResult[];
}

type RawBar = { t:number; o:number; h:number; l:number; c:number; v:number; date:string; minute:number };
type Daily = Record<string, number | string | null> & { date:string };

const OPEN = 570;
const CLOSE = 960;
const sleep = (ms:number) => new Promise(r => window.setTimeout(r, ms));
const iso = (d:Date) => d.toISOString().slice(0,10);
const addDays = (s:string, days:number) => { const d=new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return iso(d); };
const pct = (end:number|null,start:number|null) => end!=null&&start!=null&&start>0 ? (end/start-1)*100 : null;
const median = (a:number[]) => { const x=a.filter(Number.isFinite).sort((a,b)=>a-b); if(!x.length)return null; const m=Math.floor(x.length/2); return x.length%2?x[m]:(x[m-1]+x[m])/2; };
const mean = (a:number[]) => a.length?a.reduce((x,y)=>x+y,0)/a.length:null;

const ny = (ms:number) => {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const g=(t:string)=>p.find(x=>x.type===t)?.value??'';
  const hour=Number(g('hour')), minute=Number(g('minute'));
  return {date:`${g('year')}-${g('month')}-${g('day')}`,minute:hour*60+minute};
};

const monthChunks = (start:string,end:string) => {
  const out:Array<[string,string]>=[]; let cur=start;
  while(cur<=end){
    const d=new Date(`${cur}T00:00:00Z`), n=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));
    const monthEnd=iso(new Date(n.getTime()-86400000)); const stop=monthEnd<end?monthEnd:end;
    out.push([cur,stop]); cur=addDays(stop,1);
  }
  return out;
};

async function getJson(url:string, apiKey:string){
  for(let attempt=1;attempt<=5;attempt++){
    const u=new URL(url); if(!u.searchParams.has('apiKey'))u.searchParams.set('apiKey',apiKey);
    const r=await fetch(u.toString(),{headers:{Accept:'application/json'}});
    if(r.ok)return r.json();
    const text=await r.text();
    if(attempt===5 || ![429,500,502,503,504].includes(r.status))throw new Error(`Massive HTTP ${r.status}: ${text.slice(0,180)}`);
    await sleep(500*attempt);
  }
}

async function fetchTicker5m(ticker:string,start:string,end:string,apiKey:string,onProgress?:(s:string)=>void){
  const byTs=new Map<number,RawBar>();
  for(const [from,to] of monthChunks(start,end)){
    onProgress?.(`${ticker} ${from} → ${to}`);
    let url=`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/5/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
    while(url){
      const j=await getJson(url,apiKey);
      for(const x of j.results??[]){
        if(![x.o,x.h,x.l,x.c,x.t].every(Number.isFinite))continue;
        const p=ny(Number(x.t));
        byTs.set(Number(x.t),{t:Number(x.t),o:+x.o,h:+x.h,l:+x.l,c:+x.c,v:+x.v||0,...p});
      }
      url=j.next_url??'';
    }
    await sleep(120);
  }
  return [...byTs.values()].sort((a,b)=>a.t-b.t);
}

const group = (bars:RawBar[]) => { const m=new Map<string,RawBar[]>(); for(const b of bars){if(!m.has(b.date))m.set(b.date,[]);m.get(b.date)!.push(b);} for(const x of m.values())x.sort((a,b)=>a.minute-b.minute); return m; };
const reg=(x:RawBar[])=>x.filter(b=>b.minute>=OPEN&&b.minute<CLOSE);
const vwap=(x:RawBar[])=>{let pv=0,v=0;for(const b of x){if(b.v<=0)continue;pv+=((b.h+b.l+b.c)/3)*b.v;v+=b.v;}return v>0?pv/v:x.at(-1)?.c??null;};
const vol=(x:RawBar[])=>x.reduce((s,b)=>s+b.v,0);

function dailyRows(bars:RawBar[]){
  const map=group(bars), dates=[...map.keys()].sort(), out:Daily[]=[]; let prevClose:number|null=null;
  for(const date of dates){
    const day=reg(map.get(date)??[]); if(day.length<18)continue;
    const open=day[0].o, close=day.at(-1)!.c;
    const row:Daily={date,open,close,prevClose,gap:prevClose!=null?pct(open,prevClose):null};
    for(const [mins,n] of [[5,1],[15,3],[30,6]] as const){
      const s=day.slice(0,n); if(s.length<n)continue; const c=s.at(-1)!.c, vw=vwap(s);
      row[`close${mins}`]=c; row[`retOpen${mins}`]=pct(c,open); row[`retPrev${mins}`]=prevClose!=null?pct(c,prevClose):null;
      row[`gapHold${mins}`]=prevClose!=null&&Math.abs(open-prevClose)>1e-9?(c-prevClose)/(open-prevClose):null;
      row[`distVwap${mins}`]=pct(c,vw); row[`vol${mins}`]=vol(s);
    }
    const entry30=day[5]?.c??null;
    for(const h of [15,30,60] as const){
      const barsAhead=h/5; const exit=day[5+barsAhead]?.c??null; row[`fwd${h}From30`]=entry30!=null&&exit!=null?pct(exit,entry30):null;
    }
    out.push(row); prevClose=close;
  }
  for(let i=0;i<out.length;i++){
    const hist=out.slice(Math.max(0,i-20),i);
    for(const mins of [5,15,30] as const){const b=median(hist.map(x=>Number(x[`vol${mins}`])).filter(Number.isFinite)); const cv=Number(out[i][`vol${mins}`]); out[i][`rvol${mins}`]=b&&Number.isFinite(cv)?cv/b:null;}
  }
  return out;
}

function mergeMuPeers(mu:Daily[], peerRows:Daily[][]){
  const peerMaps=peerRows.map(rows=>new Map(rows.map(r=>[r.date,r])));
  return mu.map(r=>{
    const z:Daily={...r};
    for(const mins of [5,15,30] as const){
      const vals=peerMaps.map(m=>Number(m.get(r.date)?.[`retPrev${mins}`])).filter(Number.isFinite);
      const pr=mean(vals); const mr=Number(r[`retPrev${mins}`]);
      z[`peerRet${mins}`]=pr; z[`rs${mins}`]=pr!=null&&Number.isFinite(mr)?mr-pr:null;
    }
    return z;
  });
}

const rules:Array<{name:MuBacktestSetupName;side:'LONG'|'SHORT';test:(r:Daily)=>boolean}>=[
  {name:'REVERSAL_LONG',side:'LONG',test:r=>Number(r.gap)<=-1&&Number(r.retOpen30)>0&&Number(r.distVwap30)>0&&Number(r.rs30)-Number(r.rs5)>=1&&Number(r.retOpen30)>=1},
  {name:'FAILED_BREAKOUT_SHORT',side:'SHORT',test:r=>Number(r.gap)>=1&&Number(r.gapHold15)<0.70&&Number(r.distVwap15)<0&&Number(r.rs15)<0&&Number(r.distVwap30)<0&&Number(r.gapHold30)<0&&Number(r.rs30)<Number(r.rs15)},
  {name:'TREND_BREAKDOWN_SHORT',side:'SHORT',test:r=>Number(r.gap)<=-1&&Number(r.retOpen15)<0&&Number(r.distVwap15)<0&&Number(r.rs15)<=-2.5&&Number(r.distVwap30)<0&&Number(r.rs30)<=Number(r.rs15)},
  {name:'GAP_GO_LONG',side:'LONG',test:r=>Number(r.gap)>=1&&Number(r.gapHold15)>=0.70&&Number(r.distVwap15)>0&&Number(r.rs15)>0&&Number(r.rvol15)>=1.2&&Number(r.distVwap30)>0&&Number(r.rs30)>=Number(r.rs15)},
];

function stats(rows:Daily[],side:'LONG'|'SHORT',h:15|30|60,costBpsSide:number):MuBacktestStats{
  const rtCost=2*costBpsSide/100;
  const x=rows.map(r=>Number(r[`fwd${h}From30`])).filter(Number.isFinite).map(v=>(side==='SHORT'?-v:v)-rtCost);
  if(!x.length)return{n:0,winRate:null,avgNetPct:null,medianNetPct:null,profitFactor:null};
  const wins=x.filter(v=>v>0),losses=x.filter(v=>v<0),gw=wins.reduce((a,b)=>a+b,0),gl=-losses.reduce((a,b)=>a+b,0);
  return{n:x.length,winRate:wins.length/x.length,avgNetPct:mean(x),medianNetPct:median(x),profitFactor:gl>0?gw/gl:gw>0?99:null};
}

export async function runMuLocalBacktest(opts:{apiKey:string;years?:1|2;baselineCostBpsSide?:number;stressCostBpsSide?:number;onProgress?:(text:string)=>void;}):Promise<MuLocalBacktestResult>{
  const apiKey=opts.apiKey.trim(); if(!apiKey)throw new Error('Massive API key is required');
  const years=opts.years??1, baseline=opts.baselineCostBpsSide??5, stress=opts.stressCostBpsSide??10;
  const end=iso(new Date()), start=addDays(end,-365*years);
  const symbols=['MU','SOXX','NVDA','QQQ']; const data:Record<string,RawBar[]>={};
  for(const s of symbols)data[s]=await fetchTicker5m(s,start,end,apiKey,opts.onProgress);
  const rows=mergeMuPeers(dailyRows(data.MU),[dailyRows(data.SOXX),dailyRows(data.NVDA),dailyRows(data.QQQ)]);
  if(rows.length<30)throw new Error(`可用交易日只有 ${rows.length}，不足以進行長期驗證。`);
  const splitDate=rows[Math.floor(rows.length*0.70)]?.date??rows.at(-1)!.date;
  const results:MuBacktestSetupResult[]=rules.map(rule=>{
    const hits=rows.filter(rule.test),train=hits.filter(x=>x.date<splitDate),test=hits.filter(x=>x.date>=splitDate);
    const choices=([15,30,60] as const).map(h=>({h,s:stats(train,rule.side,h,baseline)}));
    choices.sort((a,b)=>((b.s.avgNetPct??-999)*Math.sqrt(Math.max(1,b.s.n)))-((a.s.avgNetPct??-999)*Math.sqrt(Math.max(1,a.s.n))));
    const h=choices[0]?.h??30,all=stats(hits,rule.side,h,baseline),tr=stats(train,rule.side,h,baseline),te=stats(test,rule.side,h,baseline),st=stats(test,rule.side,h,stress);
    const gates={enoughAll:all.n>=20,enoughTrain:tr.n>=12,enoughTest:te.n>=6,trainPositive:(tr.avgNetPct??-99)>0,testPositive:(te.avgNetPct??-99)>0,testPF:(te.profitFactor??0)>=1.15,stressPositive:(st.avgNetPct??-99)>0};
    return{name:rule.name,side:rule.side,chosenHorizon:h,all,train:tr,test:te,stress:st,allDates:hits.map(x=>x.date),trainDates:train.map(x=>x.date),testDates:test.map(x=>x.date),gates,structureValidated:Object.values(gates).every(Boolean)};
  });
  return{generatedAt:new Date().toISOString(),source:'Massive 5-minute adjusted aggregates',start,end,sessions:rows.length,splitDate,baselineCostBpsSide:baseline,stressCostBpsSide:stress,status:results.some(x=>x.structureValidated)?'STRUCTURE_VALIDATED':'NO_VALIDATED_SETUP',setups:results};
}
