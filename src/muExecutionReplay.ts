import type { MuBacktestSetupName, MuLocalBacktestResult } from './muLocalBacktest';

export interface MuExecutionTrade {
  date: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  entryMinute: number;
  stop: number;
  target: number;
  exit: number;
  exitMinute: number;
  outcome: 'TARGET' | 'STOP' | 'STOP_SAME_MINUTE' | 'TIME';
  grossPct: number;
  netPct: number;
  r: number;
  mfePct: number;
  maePct: number;
}

export interface MuExecutionStats {
  n: number;
  winRate: number | null;
  avgNetPct: number | null;
  medianNetPct: number | null;
  avgR: number | null;
  profitFactor: number | null;
  targetRate: number | null;
  stopRate: number | null;
  timeExitRate: number | null;
  maxDrawdownR: number | null;
}

export interface MuExecutionSetupResult {
  name: MuBacktestSetupName;
  side: 'LONG' | 'SHORT';
  horizonMinutes: 15 | 30 | 60;
  trainEventsRequested: number;
  testEventsRequested: number;
  trainEventsUsable: number;
  testEventsUsable: number;
  calibratedStopPct: number | null;
  targetPct: number | null;
  baseline: MuExecutionStats;
  stress: MuExecutionStats;
  gates: Record<string, boolean>;
  executionValidated: boolean;
  testTrades: MuExecutionTrade[];
}

export interface MuExecutionReplayResult {
  generatedAt: string;
  source: 'Massive 1-minute adjusted aggregates';
  parentBacktestGeneratedAt: string;
  entryPolicy: string;
  calibrationPolicy: string;
  baselineCostBpsSide: number;
  stressCostBpsSide: number;
  status: 'EXECUTION_VALIDATED' | 'NO_EXECUTION_VALIDATED';
  setups: MuExecutionSetupResult[];
}

type OneMinuteBar = { t:number; o:number; h:number; l:number; c:number; v:number; date:string; minute:number };
type EventDiagnostic = { date:string; entry:number; entryMinute:number; bars:OneMinuteBar[]; mfePct:number; maePct:number };

const OPEN = 570;
const CLOSE = 960;
const ENTRY_NOT_BEFORE = 601; // 10:01 ET: one full minute after the 30m setup is observable.
const sleep = (ms:number) => new Promise(r => window.setTimeout(r, ms));
const median = (a:number[]) => { const x=a.filter(Number.isFinite).sort((a,b)=>a-b); if(!x.length)return null; const m=Math.floor(x.length/2); return x.length%2?x[m]:(x[m-1]+x[m])/2; };
const quantile = (a:number[], q:number) => { const x=a.filter(Number.isFinite).sort((m,n)=>m-n); if(!x.length)return null; const p=(x.length-1)*q, lo=Math.floor(p), hi=Math.ceil(p); if(lo===hi)return x[lo]; return x[lo]+(x[hi]-x[lo])*(p-lo); };
const mean = (a:number[]) => a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const clamp = (x:number, lo:number, hi:number) => Math.min(hi, Math.max(lo, x));

const ny = (ms:number) => {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const g=(t:string)=>p.find(x=>x.type===t)?.value??'';
  const hour=Number(g('hour')), minute=Number(g('minute'));
  return {date:`${g('year')}-${g('month')}-${g('day')}`,minute:hour*60+minute};
};

async function getJson(url:string, apiKey:string){
  for(let attempt=1;attempt<=6;attempt++){
    const u=new URL(url); if(!u.searchParams.has('apiKey'))u.searchParams.set('apiKey',apiKey);
    const r=await fetch(u.toString(),{headers:{Accept:'application/json'}});
    if(r.ok)return r.json();
    const text=await r.text();
    if(attempt===6 || ![429,500,502,503,504].includes(r.status))throw new Error(`Massive HTTP ${r.status}: ${text.slice(0,180)}`);
    await sleep(Math.min(5000, 700*attempt));
  }
}

const groupDatesByMonth = (dates:string[]) => {
  const groups=new Map<string,string[]>();
  for(const d of [...new Set(dates)].sort()){
    const key=d.slice(0,7); if(!groups.has(key))groups.set(key,[]); groups.get(key)!.push(d);
  }
  return groups;
};

async function fetchMu1mForEventDates(dates:string[],apiKey:string,onProgress?:(s:string)=>void){
  const wanted=new Set(dates), out=new Map<string,OneMinuteBar[]>();
  const groups=groupDatesByMonth(dates);
  let groupIndex=0;
  for(const [month,ds] of groups){
    groupIndex++;
    const from=ds[0],to=ds.at(-1)!;
    onProgress?.(`MU 1m ${month} (${groupIndex}/${groups.size}) · ${from} → ${to}`);
    let url=`https://api.massive.com/v2/aggs/ticker/MU/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
    while(url){
      const j=await getJson(url,apiKey);
      for(const x of j.results??[]){
        if(![x.o,x.h,x.l,x.c,x.t].every(Number.isFinite))continue;
        const p=ny(Number(x.t));
        if(!wanted.has(p.date) || p.minute<OPEN || p.minute>=CLOSE)continue;
        if(!out.has(p.date))out.set(p.date,[]);
        out.get(p.date)!.push({t:Number(x.t),o:+x.o,h:+x.h,l:+x.l,c:+x.c,v:+x.v||0,...p});
      }
      url=j.next_url??'';
    }
    await sleep(150);
  }
  for(const bars of out.values())bars.sort((a,b)=>a.t-b.t);
  return out;
}

function diagnostic(date:string,bars:OneMinuteBar[]|undefined,horizon:15|30|60,side:'LONG'|'SHORT'):EventDiagnostic|null{
  if(!bars?.length)return null;
  const entryBar=bars.find(b=>b.minute>=ENTRY_NOT_BEFORE);
  if(!entryBar)return null;
  const path=bars.filter(b=>b.minute>=entryBar.minute&&b.minute<entryBar.minute+horizon);
  if(path.length<Math.max(5,Math.floor(horizon*0.75)))return null;
  const entry=entryBar.o;
  const hi=Math.max(...path.map(b=>b.h)),lo=Math.min(...path.map(b=>b.l));
  const mfePct=side==='LONG'?(hi/entry-1)*100:(entry/lo-1)*100;
  const maePct=side==='LONG'?(lo/entry-1)*100:(entry/hi-1)*100;
  return{date,entry,entryMinute:entryBar.minute,bars:path,mfePct,maePct};
}

function simulate(d:EventDiagnostic,side:'LONG'|'SHORT',stopPct:number,targetPct:number,costBpsSide:number):MuExecutionTrade{
  const stop=side==='LONG'?d.entry*(1-stopPct/100):d.entry*(1+stopPct/100);
  const target=side==='LONG'?d.entry*(1+targetPct/100):d.entry*(1-targetPct/100);
  let exit=d.bars.at(-1)!.c,exitMinute=d.bars.at(-1)!.minute,outcome:MuExecutionTrade['outcome']='TIME';
  for(const b of d.bars){
    const stopHit=side==='LONG'?b.l<=stop:b.h>=stop;
    const targetHit=side==='LONG'?b.h>=target:b.l<=target;
    if(stopHit){exit=stop;exitMinute=b.minute;outcome=targetHit?'STOP_SAME_MINUTE':'STOP';break;}
    if(targetHit){exit=target;exitMinute=b.minute;outcome='TARGET';break;}
  }
  const grossPct=(side==='LONG'?(exit/d.entry-1):(d.entry/exit-1))*100;
  const netPct=grossPct-(2*costBpsSide/100);
  return{date:d.date,side,entry:d.entry,entryMinute:d.entryMinute,stop,target,exit,exitMinute,outcome,grossPct,netPct,r:netPct/stopPct,mfePct:d.mfePct,maePct:d.maePct};
}

function stats(trades:MuExecutionTrade[]):MuExecutionStats{
  if(!trades.length)return{n:0,winRate:null,avgNetPct:null,medianNetPct:null,avgR:null,profitFactor:null,targetRate:null,stopRate:null,timeExitRate:null,maxDrawdownR:null};
  const sorted=[...trades].sort((a,b)=>a.date.localeCompare(b.date)),nets=sorted.map(x=>x.netPct),rs=sorted.map(x=>x.r),wins=nets.filter(x=>x>0),losses=nets.filter(x=>x<0),gw=wins.reduce((a,b)=>a+b,0),gl=-losses.reduce((a,b)=>a+b,0);
  let equity=0,peak=0,maxDd=0; for(const r of rs){equity+=r;peak=Math.max(peak,equity);maxDd=Math.min(maxDd,equity-peak);}
  return{n:sorted.length,winRate:wins.length/sorted.length,avgNetPct:mean(nets),medianNetPct:median(nets),avgR:mean(rs),profitFactor:gl>0?gw/gl:gw>0?99:null,targetRate:sorted.filter(x=>x.outcome==='TARGET').length/sorted.length,stopRate:sorted.filter(x=>x.outcome==='STOP'||x.outcome==='STOP_SAME_MINUTE').length/sorted.length,timeExitRate:sorted.filter(x=>x.outcome==='TIME').length/sorted.length,maxDrawdownR:maxDd};
}

export async function runMuExecutionValidation(opts:{apiKey:string;backtest:MuLocalBacktestResult;baselineCostBpsSide?:number;stressCostBpsSide?:number;onProgress?:(text:string)=>void;}):Promise<MuExecutionReplayResult>{
  const apiKey=opts.apiKey.trim(); if(!apiKey)throw new Error('Massive API key is required');
  const candidates=opts.backtest.setups.filter(x=>x.structureValidated);
  if(!candidates.length)throw new Error('沒有通過 5 分鐘 STRUCTURE_VALIDATED 的 setup；不應進行 1 分鐘 execution 最佳化。');
  const allDates=[...new Set(candidates.flatMap(x=>[...(x.trainDates??[]),...(x.testDates??[])]))].sort();
  if(!allDates.length)throw new Error('這份舊回測結果沒有事件日期。請先重新執行 5 分鐘長期回測。');
  const oneMinute=await fetchMu1mForEventDates(allDates,apiKey,opts.onProgress);
  const baseline=opts.baselineCostBpsSide??opts.backtest.baselineCostBpsSide??5;
  const stress=opts.stressCostBpsSide??opts.backtest.stressCostBpsSide??10;
  const results:MuExecutionSetupResult[]=[];

  for(const setup of candidates){
    opts.onProgress?.(`${setup.name}: 1m execution calibration`);
    const train=(setup.trainDates??[]).map(d=>diagnostic(d,oneMinute.get(d),setup.chosenHorizon,setup.side)).filter((x):x is EventDiagnostic=>Boolean(x));
    const test=(setup.testDates??[]).map(d=>diagnostic(d,oneMinute.get(d),setup.chosenHorizon,setup.side)).filter((x):x is EventDiagnostic=>Boolean(x));
    const adverse=train.map(x=>Math.abs(Math.min(0,x.maePct))).filter(Number.isFinite);
    const q75=quantile(adverse,0.75);
    const stopPct=q75==null?null:clamp(q75,0.35,3.0);
    const targetPct=stopPct==null?null:stopPct*1.5;
    if(stopPct==null||targetPct==null){
      results.push({name:setup.name,side:setup.side,horizonMinutes:setup.chosenHorizon,trainEventsRequested:setup.trainDates?.length??0,testEventsRequested:setup.testDates?.length??0,trainEventsUsable:train.length,testEventsUsable:test.length,calibratedStopPct:null,targetPct:null,baseline:stats([]),stress:stats([]),gates:{structureValidated:true,enoughTrain1m:false,enoughTest1m:false,testPositive:false,testPF:false,testAvgR:false,stressPositive:false},executionValidated:false,testTrades:[]});
      continue;
    }
    const baseTrades=test.map(x=>simulate(x,setup.side,stopPct,targetPct,baseline));
    const stressTrades=test.map(x=>simulate(x,setup.side,stopPct,targetPct,stress));
    const baseStats=stats(baseTrades),stressStats=stats(stressTrades);
    const gates={structureValidated:setup.structureValidated,enoughTrain1m:train.length>=12,enoughTest1m:test.length>=6,testPositive:(baseStats.avgNetPct??-99)>0,testPF:(baseStats.profitFactor??0)>=1.15,testAvgR:(baseStats.avgR??-99)>0,stressPositive:(stressStats.avgNetPct??-99)>0};
    results.push({name:setup.name,side:setup.side,horizonMinutes:setup.chosenHorizon,trainEventsRequested:setup.trainDates?.length??0,testEventsRequested:setup.testDates?.length??0,trainEventsUsable:train.length,testEventsUsable:test.length,calibratedStopPct:stopPct,targetPct,baseline:baseStats,stress:stressStats,gates,executionValidated:Object.values(gates).every(Boolean),testTrades:baseTrades});
  }

  return{generatedAt:new Date().toISOString(),source:'Massive 1-minute adjusted aggregates',parentBacktestGeneratedAt:opts.backtest.generatedAt,entryPolicy:'Setup confirmed on completed first 30m; enter at the first available 1m open at or after 10:01 ET (one-minute execution delay).',calibrationPolicy:'Stop distance = 75th percentile of TRAIN adverse excursion, clamped to 0.35%–3.0%; target fixed at 1.5R. TEST data never selects stop, target or horizon. Same-minute stop+target is scored as STOP.',baselineCostBpsSide:baseline,stressCostBpsSide:stress,status:results.some(x=>x.executionValidated)?'EXECUTION_VALIDATED':'NO_EXECUTION_VALIDATED',setups:results};
}
