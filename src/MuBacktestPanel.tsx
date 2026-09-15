import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Play, ShieldCheck, XCircle } from 'lucide-react';
import type { ApiKeys } from './types';
import { runMuLocalBacktest, type MuLocalBacktestResult, type MuBacktestSetupResult } from './muLocalBacktest';

const EMPTY_KEYS: ApiKeys = { massive:'', finnhub:'', fmp:'', twelve:'', fred:'' };
const loadKeys=():ApiKeys=>{try{const raw=localStorage.getItem('stockDecisionApiKeys');return raw?{...EMPTY_KEYS,...JSON.parse(raw)}:EMPTY_KEYS;}catch{return EMPTY_KEYS;}};
const pct=(v:number|null)=>v==null||!Number.isFinite(v)?'—':`${v>=0?'+':''}${v.toFixed(3)}%`;
const rate=(v:number|null)=>v==null||!Number.isFinite(v)?'—':`${(v*100).toFixed(1)}%`;

const SetupCard=({x}:{x:MuBacktestSetupResult})=><div className={`rounded-2xl border p-4 ${x.structureValidated?'border-emerald-500/40 bg-emerald-500/10':'border-slate-800 bg-slate-900/60'}`}>
  <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-black">{x.name}</div><div className="mt-1 text-[10px] text-slate-500">{x.side} · entry +30m · horizon {x.chosenHorizon}m</div></div>{x.structureValidated?<span className="rounded-full border border-emerald-500/40 px-2 py-1 text-[10px] text-emerald-300">STRUCTURE PASS</span>:<span className="rounded-full border border-slate-700 px-2 py-1 text-[10px] text-slate-500">NOT VALIDATED</span>}</div>
  <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
    <div><div className="text-[10px] text-slate-500">All N</div><div className="font-mono font-bold">{x.all.n}</div></div>
    <div><div className="text-[10px] text-slate-500">Test N</div><div className="font-mono font-bold">{x.test.n}</div></div>
    <div><div className="text-[10px] text-slate-500">Test win</div><div className="font-mono font-bold">{rate(x.test.winRate)}</div></div>
    <div><div className="text-[10px] text-slate-500">Test PF</div><div className="font-mono font-bold">{x.test.profitFactor==null?'—':x.test.profitFactor.toFixed(2)}</div></div>
    <div><div className="text-[10px] text-slate-500">Train avg net</div><div className="font-mono">{pct(x.train.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Test avg net</div><div className={`font-mono ${(x.test.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.test.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Stress avg net</div><div className={`font-mono ${(x.stress.avgNetPct??0)>0?'text-emerald-300':'text-rose-300'}`}>{pct(x.stress.avgNetPct)}</div></div>
    <div><div className="text-[10px] text-slate-500">Median net</div><div className="font-mono">{pct(x.test.medianNetPct)}</div></div>
  </div>
  <div className="mt-4 grid grid-cols-2 gap-1 text-[10px]">{Object.entries(x.gates).map(([k,v])=><div key={k} className={`flex items-center gap-1 ${v?'text-emerald-300':'text-slate-600'}`}>{v?<CheckCircle2 size={11}/>:<XCircle size={11}/>} {k}</div>)}</div>
</div>;

export default function MuBacktestPanel(){
  const keys=useMemo(loadKeys,[]); const [years,setYears]=useState<1|2>(1); const [running,setRunning]=useState(false); const [progress,setProgress]=useState(''); const [error,setError]=useState('');
  const [result,setResult]=useState<MuLocalBacktestResult|null>(()=>{try{const x=localStorage.getItem('muLocalBacktestResult');return x?JSON.parse(x):null;}catch{return null;}});
  const run=async()=>{if(!keys.massive.trim()){setError('需要 Massive API Key。請先在當沖模式的 API 設定中輸入；Key 只從瀏覽器直接送往 Massive，不會寫入 GitHub。');return;}setRunning(true);setError('');setProgress('初始化…');try{const r=await runMuLocalBacktest({apiKey:keys.massive,years,onProgress:setProgress});setResult(r);localStorage.setItem('muLocalBacktestResult',JSON.stringify(r));setProgress('完成');}catch(e){setError(e instanceof Error?e.message:'歷史驗證失敗');}finally{setRunning(false);}};
  return <div className="min-h-screen bg-slate-950 px-4 pb-12 pt-16 text-slate-100"><div className="mx-auto max-w-6xl">
    <section className="mb-4 rounded-2xl border border-violet-500/20 bg-slate-900/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div><div className="text-xs font-bold uppercase tracking-[.2em] text-violet-300">MU Local Historical Validation</div><h1 className="mt-1 text-2xl font-black">MU 長期結構回測</h1><p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">直接使用你瀏覽器內的 Massive Key 下載 MU、SOXX、NVDA、QQQ 5 分 K。先驗證 Gap/VWAP/RS 型態是否具有長期 out-of-sample edge；只有結構通過後，才值得對候選日期做 1 分鐘 execution replay。</p></div>
        <div className="flex flex-wrap items-center gap-2"><select value={years} onChange={e=>setYears(Number(e.target.value) as 1|2)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"><option value={1}>1 年</option><option value={2}>2 年</option></select><button onClick={()=>void run()} disabled={running||!keys.massive.trim()} className="inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-xs font-bold text-violet-200 disabled:opacity-40"><Play size={13}/>{running?'回測中':'執行本機回測'}</button></div></div>
      <div className="mt-3 text-[10px] text-slate-500">Massive Key：{keys.massive.trim()?'已在本機設定':'未設定'} · Baseline cost 5 bps/side · Stress 10 bps/side</div>{progress?<div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-cyan-300">{progress}</div>:null}{error?<div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div>:null}
    </section>

    {result?<><section className={`mb-4 rounded-2xl border p-5 ${result.status==='STRUCTURE_VALIDATED'?'border-emerald-500/40 bg-emerald-500/10':'border-amber-500/30 bg-amber-500/5'}`}><div className="flex items-center gap-2">{result.status==='STRUCTURE_VALIDATED'?<ShieldCheck className="text-emerald-300"/>:<AlertTriangle className="text-amber-300"/>}<div><div className="text-xl font-black">{result.status}</div><div className="mt-1 text-xs text-slate-400">{result.start} → {result.end} · {result.sessions} sessions · OOS split {result.splitDate}</div></div></div><p className="mt-3 text-xs text-slate-400">STRUCTURE_VALIDATED 只代表 5 分鐘型態在長期資料與交易成本後有統計優勢，仍不是 production signal。下一層還要以 1 分 K 檢查實際 entry、stop、MFE/MAE、same-bar ambiguity 與滑價。</p></section><section className="grid gap-4 lg:grid-cols-2">{result.setups.map(x=><SetupCard key={x.name} x={x}/>)}</section></>:<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><Database size={18} className="mb-2 text-slate-500"/><div className="font-bold">尚無長期 Massive 回測結果</div><p className="mt-2 text-xs text-slate-500">先設定 Massive Key，再執行 1 年或 2 年驗證。結果只會儲存在瀏覽器 localStorage。</p></section>}

    <section className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-100/80"><AlertTriangle size={14} className="mr-2 inline"/>此頁的價值是淘汰沒有穩健性的 setup，不是為了把每套策略調到好看。若 test、stress 或樣本數 gate 不過，結果就應該是 NO_VALIDATED_SETUP。</section>
  </div></div>;
}
