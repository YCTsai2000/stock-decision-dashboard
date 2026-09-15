import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Play, ShieldCheck, TimerReset, XCircle } from 'lucide-react';
import type { ApiKeys } from './types';
import { runMuLocalBacktest, type MuLocalBacktestResult, type MuBacktestSetupResult } from './muLocalBacktest';
import { runMuExecutionValidation, type MuExecutionReplayResult, type MuExecutionSetupResult } from './muExecutionReplay';

const EMPTY_KEYS: ApiKeys = { massive:'', finnhub:'', fmp:'', twelve:'', fred:'' };
const loadKeys=():ApiKeys=>{try{const raw=localStorage.getItem('stockDecisionApiKeys');return raw?{...EMPTY_KEYS,...JSON.parse(raw)}:EMPTY_KEYS;}catch{return EMPTY_KEYS;}};
const pct=(v:number|null,digits=3)=>v==null||!Number.isFinite(v)?'—':`${v>=0?'+':''}${v.toFixed(digits)}%`;
const rate=(v:number|null)=>v==null||!Number.isFinite(v)?'—':`${(v*100).toFixed(1)}%`;
const ratio=(v:number|null)=>v==null||!Number.isFinite(v)?'—':v.toFixed(2);

const SetupCard=({x}:{x:MuBacktestSetupResult})=><div className={`rounded-2xl border p-4 ${x.structureValidated?'border-emerald-500/40 bg-emerald-500/10':'border-slate-800 bg-slate-900/60'}`}>
  <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-black">{x.name}</div><div className="mt-1 text-[10px] text-slate-500">{x.side} · setup confirm +30m · horizon {x.chosenHorizon}m</div></div>{x.structureValidated?<span className="rounded-full border border-emerald-500/40 px-2 py-1 text-[10px] text-emerald-300">STRUCTURE PASS</span>:<span className="rounded-full border border-slate-700 px-2 py-1 text-[10px] text-slate-500">NOT VALIDATED</span>}</div>
  <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
    <div><div className="text-[10px] text-slate-500">All N</div><div className="font-mono font-bold">{x.all.n}</div></div>
    <div><div className="text-[10px] text-slate-500">Test N</div><div className="font-mono font-bold">{x.test.n}</div></div>
    <div><div className="text-[10px] text-slate-500">Test win</div><div className="font-mono font-bold">{rate(x.test.winRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Test PF</div><div className="font-mono font-bold">{ratio(x.test.profitFactor)}</div></div>
    <div><div className="text-[10px] text-slate-500">Train avg net</div><div className="font-mono">{pct(x.train.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Test avg net</div><div className={`font-mono ${(x.test.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.test.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Stress avg net</div><div className={`font-mono ${(x.stress.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.stress.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Median net</div><div className="font-mono">{pct(x.test.medianNetPct)}</div></div>
  </div>
  <div className="mt-4 grid grid-cols-2 gap-1 text-[10px]">{Object.entries(x.gates).map(([k,v])=><div key={k} className={`flex items-center gap-1 ${v?'text-emerald-300':'text-slate-600'}`}>{v?<CheckCircle2 size={11}/>:<XCircle size={11}/>} {k}</div>)}</div>
</div>;

const ExecutionCard=({x}:{x:MuExecutionSetupResult})=><div className={`rounded-2xl border p-4 ${x.executionValidated?'border-cyan-500/40 bg-cyan-500/10':'border-slate-800 bg-slate-900/60'}`}>
  <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-black">{x.name} · 1m execution</div><div className="mt-1 text-[10px] text-slate-500">{x.side} · horizon {x.horizonMinutes}m · entry ≥10:01 ET</div></div><span className={`rounded-full border px-2 py-1 text-[10px] ${x.executionValidated?'border-cyan-500/40 text-cyan-300':'border-slate-700 text-slate-500'}`}>{x.executionValidated?'EXECUTION PASS':'EXECUTION FAIL'}</span></div>
  <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
    <div><div className="text-[10px] text-slate-500">Stop</div><div className="font-mono font-bold">{pct(x.calibratedStopPct,2)}</div></div>
    <div><div className="text-[10px] text-slate-500">Target</div><div className="font-mono font-bold">{pct(x.targetPct,2)}</div></div>
    <div><div className="text-[10px] text-slate-500">Test usable</div><div className="font-mono font-bold">{x.testEventsUsable}/{x.testEventsRequested}</div></div>
    <div><div className="text-[10px] text-slate-500">Test win</div><div className="font-mono font-bold">{rate(x.baseline.winRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Avg net</div><div className={`font-mono ${(x.baseline.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.baseline.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Avg R</div><div className="font-mono">{ratio(x.baseline.avgR)}</div></div>
    <div><div className="text-[10px] text-slate-500">PF</div><div className="font-mono">{ratio(x.baseline.profitFactor)}</div></div>
    <div><div className="text-[10px] text-slate-500">Max DD</div><div className="font-mono text-rose-300">{x.baseline.maxDrawdownR==null?'—':`${x.baseline.maxDrawdownR.toFixed(2)}R`}</div></div>
    <div><div className="text-[10px] text-slate-500">Target hit</div><div className="font-mono">{rate(x.baseline.targetRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Stop hit</div><div className="font-mono">{rate(x.baseline.stopRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Time exit</div><div className="font-mono">{rate(x.baseline.timeExitRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Stress avg</div><div className={`font-mono ${(x.stress.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.stress.avgNetPct)}</div></div>
  </div>
  <div className="mt-4 grid grid-cols-2 gap-1 text-[10px]">{Object.entries(x.gates).map(([k,v])=><div key={k} className={`flex items-center gap-1 ${v?'text-cyan-300':'text-slate-600'}`}>{v?<CheckCircle2 size={11}/>:<XCircle size={11}/>} {k}</div>)}</div>
</div>;

export default function MuBacktestPanel(){
  const keys=useMemo(loadKeys,[]); const [years,setYears]=useState<1|2>(1); const [running,setRunning]=useState(false); const [executionRunning,setExecutionRunning]=useState(false); const [progress,setProgress]=useState(''); const [error,setError]=useState('');
  const [result,setResult]=useState<MuLocalBacktestResult|null>(()=>{try{const x=localStorage.getItem('muLocalBacktestResult');return x?JSON.parse(x):null;}catch{return null;}});
  const [execution,setExecution]=useState<MuExecutionReplayResult|null>(()=>{try{const x=localStorage.getItem('muExecutionReplayResult');return x?JSON.parse(x):null;}catch{return null;}});
  const structurePass=Boolean(result?.setups.some(x=>x.structureValidated));
  const hasEventDates=Boolean(result?.setups.some(x=>x.structureValidated&&(x.trainDates?.length??0)>0&&(x.testDates?.length??0)>0));

  const run=async()=>{if(!keys.massive.trim()){setError('需要 Massive API Key。請先在當沖模式的 API 設定中輸入；Key 只從瀏覽器直接送往 Massive，不會寫入 GitHub。');return;}setRunning(true);setError('');setProgress('5m 結構驗證初始化…');try{const r=await runMuLocalBacktest({apiKey:keys.massive,years,onProgress:setProgress});setResult(r);setExecution(null);localStorage.setItem('muLocalBacktestResult',JSON.stringify(r));localStorage.removeItem('muExecutionReplayResult');setProgress('5m 結構驗證完成');}catch(e){setError(e instanceof Error?e.message:'歷史驗證失敗');}finally{setRunning(false);}};
  const runExecution=async()=>{if(!keys.massive.trim()||!result)return;if(!hasEventDates){setError('這份舊的 5m 回測結果沒有事件日期；請先重新執行一次 1 年/2 年長期回測。');return;}setExecutionRunning(true);setError('');setProgress('1m execution replay 初始化…');try{const r=await runMuExecutionValidation({apiKey:keys.massive,backtest:result,onProgress:setProgress});setExecution(r);localStorage.setItem('muExecutionReplayResult',JSON.stringify(r));setProgress('1m execution replay 完成');}catch(e){setError(e instanceof Error?e.message:'1m execution replay 失敗');}finally{setExecutionRunning(false);}};

  return <div className="min-h-screen bg-slate-950 px-4 pb-12 pt-16 text-slate-100"><div className="mx-auto max-w-6xl">
    <section className="mb-4 rounded-2xl border border-violet-500/20 bg-slate-900/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div><div className="text-xs font-bold uppercase tracking-[.2em] text-violet-300">MU Two-stage Historical Validation</div><h1 className="mt-1 text-2xl font-black">MU 結構回測 → 1m 執行重播</h1><p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">第一層用 MU、SOXX、NVDA、QQQ 的 5 分 K 驗證 Gap/VWAP/RS 結構。只有通過 out-of-sample gate 的 setup 才進第二層；第二層只抓候選月份的 MU 1 分 K，檢查實際進場、停損、1.5R 目標、交易成本與 same-minute ambiguity。</p></div>
        <div className="flex flex-wrap items-center gap-2"><select value={years} onChange={e=>setYears(Number(e.target.value) as 1|2)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"><option value={1}>1 年</option><option value={2}>2 年</option></select><button onClick={()=>void run()} disabled={running||executionRunning||!keys.massive.trim()} className="inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-xs font-bold text-violet-200 disabled:opacity-40"><Play size={13}/>{running?'5m 回測中':'① 執行 5m 長期驗證'}</button><button onClick={()=>void runExecution()} disabled={!structurePass||!hasEventDates||running||executionRunning||!keys.massive.trim()} className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-bold text-cyan-200 disabled:opacity-30"><TimerReset size={13}/>{executionRunning?'1m 重播中':'② 執行 1m Execution'}</button></div></div>
      <div className="mt-3 text-[10px] text-slate-500">Massive Key：{keys.massive.trim()?'已在本機設定':'未設定'} · Baseline cost 5 bps/side · Stress 10 bps/side · 1m entry 延遲至 ≥10:01 ET</div>{progress?<div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-cyan-300">{progress}</div>:null}{error?<div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div>:null}
    </section>

    {result?<><section className={`mb-4 rounded-2xl border p-5 ${result.status==='STRUCTURE_VALIDATED'?'border-emerald-500/40 bg-emerald-500/10':'border-amber-500/30 bg-amber-500/5'}`}><div className="flex items-center gap-2">{result.status==='STRUCTURE_VALIDATED'?<ShieldCheck className="text-emerald-300"/>:<AlertTriangle className="text-amber-300"/>}<div><div className="text-xl font-black">Stage 1 · {result.status}</div><div className="mt-1 text-xs text-slate-400">{result.start} → {result.end} · {result.sessions} sessions · OOS split {result.splitDate}</div></div></div><p className="mt-3 text-xs text-slate-400">STRUCTURE_VALIDATED 只代表 5 分鐘型態在長期資料與交易成本後有 edge。未通過的 setup 不進 1m execution replay，避免對沒有 edge 的策略繼續調停損。</p></section><section className="grid gap-4 lg:grid-cols-2">{result.setups.map(x=><SetupCard key={x.name} x={x}/>)}</section></>:<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><Database size={18} className="mb-2 text-slate-500"/><div className="font-bold">尚無長期 Massive 回測結果</div><p className="mt-2 text-xs text-slate-500">先設定 Massive Key，再執行 1 年或 2 年驗證。結果只儲存在瀏覽器 localStorage。</p></section>}

    {execution?<section className="mt-5"><div className={`mb-4 rounded-2xl border p-5 ${execution.status==='EXECUTION_VALIDATED'?'border-cyan-500/40 bg-cyan-500/10':'border-rose-500/30 bg-rose-500/5'}`}><div className="flex items-center gap-2">{execution.status==='EXECUTION_VALIDATED'?<ShieldCheck className="text-cyan-300"/>:<AlertTriangle className="text-rose-300"/>}<div><div className="text-xl font-black">Stage 2 · {execution.status}</div><div className="mt-1 text-xs text-slate-400">Train MAE Q75 → Stop；Target 固定 1.5R；Test 不調參；同分鐘 Stop+Target 算 Stop。</div></div></div></div><div className="grid gap-4 lg:grid-cols-2">{execution.setups.map(x=><ExecutionCard key={x.name} x={x}/>)}</div></section>:null}

    <section className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-100/80"><AlertTriangle size={14} className="mr-2 inline"/>Production Gate：只有 <b>STRUCTURE_VALIDATED + EXECUTION_VALIDATED</b> 都通過的 setup，才有資格進下一步 live paper/replay。這頁的目的不是把每套策略調成獲利，而是讓不穩健的策略盡早被淘汰。</section>
  </div></div>;
}
