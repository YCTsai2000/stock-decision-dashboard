import { useState } from 'react';
import { Activity, CandlestickChart, Database, Gauge, LineChart } from 'lucide-react';
import App from './App';
import DayTradingAppV5 from './DayTradingAppV5';
import MuResearchPanel from './MuResearchPanel';
import MuBacktestPanel from './MuBacktestPanel';

type AppMode = 'strategic' | 'daytrade' | 'mu' | 'mu-backtest';

const readMode = (): AppMode => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'daytrade') return 'daytrade';
  if (params.get('mode') === 'mu') return 'mu';
  if (params.get('mode') === 'mu-backtest') return 'mu-backtest';
  return 'strategic';
};

export default function ModeShell() {
  const [mode, setMode] = useState<AppMode>(readMode);

  const changeMode = (next: AppMode) => {
    setMode(next);
    const url = new URL(window.location.href);
    if (next === 'strategic') url.searchParams.delete('mode');
    else url.searchParams.set('mode', next);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  };

  return (
    <>
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] flex max-w-[calc(100vw-16px)] items-center gap-1 overflow-x-auto rounded-xl border border-slate-700/80 bg-slate-950/95 p-1 shadow-2xl backdrop-blur">
        <button onClick={() => changeMode('strategic')} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'strategic' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-white'}`}><LineChart size={13} /> 日線決策</button>
        <button onClick={() => changeMode('daytrade')} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'daytrade' ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}><CandlestickChart size={13} /> 當沖模式 V6.3.4</button>
        <button onClick={() => changeMode('mu')} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'mu' ? 'bg-violet-500/15 text-violet-300 border border-violet-500/30' : 'text-slate-400 hover:text-white'}`}><Activity size={13} /> MU 即時研究</button>
        <button onClick={() => changeMode('mu-backtest')} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'mu-backtest' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-white'}`}><Database size={13} /> MU 歷史驗證</button>
        <span className="hidden xl:inline-flex shrink-0 items-center gap-1 px-2 text-[10px] text-slate-600"><Gauge size={11} /> Confirmed Entry + Rank + Live</span>
      </div>
      {mode === 'daytrade' ? <DayTradingAppV5 /> : mode === 'mu' ? <MuResearchPanel /> : mode === 'mu-backtest' ? <MuBacktestPanel /> : <App />}
    </>
  );
}
