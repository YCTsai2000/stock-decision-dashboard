import { useState } from 'react';
import { CandlestickChart, Gauge, LineChart } from 'lucide-react';
import App from './App';
import DayTradingAppV5 from './DayTradingAppV5';

type AppMode = 'strategic' | 'daytrade';

const readMode = (): AppMode => {
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'daytrade' ? 'daytrade' : 'strategic';
};

export default function ModeShell() {
  const [mode, setMode] = useState<AppMode>(readMode);

  const changeMode = (next: AppMode) => {
    setMode(next);
    const url = new URL(window.location.href);
    if (next === 'daytrade') url.searchParams.set('mode', 'daytrade');
    else url.searchParams.delete('mode');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  };

  return (
    <>
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-950/95 p-1 shadow-2xl backdrop-blur">
        <button onClick={() => changeMode('strategic')} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'strategic' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-white'}`}><LineChart size={13} /> 日線決策</button>
        <button onClick={() => changeMode('daytrade')} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${mode === 'daytrade' ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}><CandlestickChart size={13} /> 當沖模式 V6.3.5</button>
        <span className="hidden sm:inline-flex items-center gap-1 px-2 text-[10px] text-slate-600"><Gauge size={11} /> Confirmed Entry + Rank + Live</span>
      </div>
      {mode === 'daytrade' ? <DayTradingAppV5 /> : <App />}
    </>
  );
}
