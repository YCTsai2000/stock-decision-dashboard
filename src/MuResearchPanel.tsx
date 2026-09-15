import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Database, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import type { ApiKeys } from './types';
import { fetchIntradayData, getNewYorkClock, type IntradayFetchResult } from './intraday';
import { computeMuBehavior, type MuCheckpoint } from './muBehavior';

const EMPTY_KEYS: ApiKeys = { massive: '', finnhub: '', fmp: '', twelve: '', fred: '' };
const REFRESH_MS = 180_000;

const loadKeys = (): ApiKeys => {
  try {
    const raw = localStorage.getItem('stockDecisionApiKeys');
    return raw ? { ...EMPTY_KEYS, ...JSON.parse(raw) } : EMPTY_KEYS;
  } catch { return EMPTY_KEYS; }
};

const pct = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const ratio = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`;
const num = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);

const CheckpointCard = ({ cp }: { cp: MuCheckpoint }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
    <div className="mb-2 flex items-center justify-between">
      <div className="text-xs font-black text-slate-200">OPEN +{cp.minutes}m</div>
      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cp.ready ? 'border-emerald-500/30 text-emerald-300' : 'border-slate-700 text-slate-600'}`}>{cp.ready ? 'READY' : 'WAIT'}</span>
    </div>
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
      <span className="text-slate-500">Open→Now</span><span className="text-right font-mono">{pct(cp.retOpenPct)}</span>
      <span className="text-slate-500">Gap Hold</span><span className="text-right font-mono">{ratio(cp.gapHold)}</span>
      <span className="text-slate-500">VWAP dist</span><span className={`text-right font-mono ${(cp.distVwapPct ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{pct(cp.distVwapPct)}</span>
      <span className="text-slate-500">RS vs basket</span><span className={`text-right font-mono ${(cp.rsPct ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{pct(cp.rsPct)}</span>
      <span className="text-slate-500">RVOL</span><span className="text-right font-mono">{cp.rvol == null ? '—' : `${cp.rvol.toFixed(2)}x`}</span>
    </div>
  </div>
);

export default function MuResearchPanel() {
  const [keys] = useState<ApiKeys>(loadKeys);
  const [feeds, setFeeds] = useState<Record<string, IntradayFetchResult | null>>({ MU:null, SOXX:null, NVDA:null, QQQ:null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const providerReady = Boolean(keys.twelve.trim() || keys.massive.trim() || keys.finnhub.trim());

  const refresh = useCallback(async () => {
    if (!providerReady) {
      setError('請先回到「當沖模式」設定 Twelve Data、Massive 或 Finnhub API Key；MU 研究模式會共用同一組瀏覽器設定。');
      return;
    }
    setLoading(true); setError('');
    try {
      const symbols = ['MU','SOXX','NVDA','QQQ'] as const;
      const results = await Promise.all(symbols.map(s => fetchIntradayData(s, keys)));
      const next: Record<string, IntradayFetchResult | null> = {};
      symbols.forEach((s, i) => { next[s] = results[i]; });
      setFeeds(next);
      const failures = symbols.flatMap((s, i) => results[i].bars ? [] : [`${s}: ${results[i].errors.join(' / ') || 'no bars'}`]);
      if (failures.length) setError(failures.join(' ｜ '));
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失敗');
    } finally { setLoading(false); }
  }, [keys, providerReady]);

  useEffect(() => {
    if (!providerReady) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [providerReady, refresh]);

  const behavior = useMemo(() => computeMuBehavior(
    feeds.MU?.bars ?? null,
    [feeds.SOXX?.bars ?? null, feeds.NVDA?.bars ?? null, feeds.QQQ?.bars ?? null],
  ), [feeds]);

  const tone = behavior.direction === 'LONG_WATCH'
    ? 'border-emerald-500/40 bg-emerald-500/10'
    : behavior.direction === 'SHORT_WATCH'
      ? 'border-rose-500/40 bg-rose-500/10'
      : behavior.direction === 'NO_TRADE'
        ? 'border-slate-700 bg-slate-900/60'
        : 'border-amber-500/30 bg-amber-500/5';
  const Icon = behavior.direction === 'LONG_WATCH' ? TrendingUp : behavior.direction === 'SHORT_WATCH' ? TrendingDown : Activity;
  const clock = getNewYorkClock();
  const rs5 = behavior.checkpoints.m5.rsPct, rs15 = behavior.checkpoints.m15.rsPct, rs30 = behavior.checkpoints.m30.rsPct;
  const rsSlope = rs5 != null && rs30 != null ? rs30 - rs5 : null;
  const staleSession = behavior.sessionDate !== null && behavior.sessionDate !== clock.date;

  return (
    <div className="min-h-screen bg-slate-950 px-4 pb-12 pt-16 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <section className="mb-4 rounded-2xl border border-cyan-500/20 bg-slate-900/70 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-300">MU Intraday Behavior Lab</div>
              <h1 className="mt-1 text-2xl font-black">Micron 專屬當沖行為判讀</h1>
              <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">只研究 MU。核心不是 RSI/MACD，而是 Gap、Gap Hold、VWAP reclaim、RVOL，以及 MU 相對 SOXX + NVDA + QQQ 的 RS5→RS15→RS30 變化。目前只輸出 WATCH / WAIT，不覆寫正式 V6 下單訊號。</p>
            </div>
            <button onClick={() => void refresh()} disabled={loading || !providerReady} className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-bold text-cyan-200 disabled:opacity-40">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''}/>{loading ? '更新中' : '更新 MU 行為'}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
            {['MU','SOXX','NVDA','QQQ'].map(s => <span key={s} className={`rounded-full border px-2 py-1 ${feeds[s]?.bars ? 'border-emerald-500/30 text-emerald-300' : 'border-slate-700 text-slate-500'}`}>{s} · {feeds[s]?.source?.provider ?? 'NO DATA'}</span>)}
            <span className="rounded-full border border-amber-500/30 px-2 py-1 text-amber-300">Evidence: PROVISIONAL 5m</span>
            <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-400">40-session recent study</span>
          </div>
          {lastRefresh ? <div className="mt-2 text-[10px] text-slate-600">最後更新：{lastRefresh.toLocaleTimeString()} · 資料 Session：{behavior.sessionDate ?? '—'}</div> : null}
          {error ? <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div> : null}
          {staleSession ? <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200"><AlertTriangle size={13} className="mr-1 inline"/>目前最新分鐘資料不是今天（ET {clock.date}），只能回顧，禁止視為即時進場訊號。</div> : null}
        </section>

        <section className={`mb-4 rounded-2xl border p-5 ${tone}`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Current MU research state</div>
              <div className="mt-1 flex items-center gap-2"><Icon size={22}/><span className="text-2xl font-black">{behavior.label}</span></div>
              <div className="mt-1 text-xs text-slate-400">{behavior.state} · {behavior.direction} · Confidence {behavior.confidence}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right text-xs">
              <div><div className="text-[10px] text-slate-500">Gap</div><div className="font-mono font-bold">{pct(behavior.gapPct)}</div></div>
              <div><div className="text-[10px] text-slate-500">Current RS</div><div className="font-mono font-bold">{pct(behavior.current.rsPct)}</div></div>
              <div><div className="text-[10px] text-slate-500">RS 5→30</div><div className="font-mono font-bold">{rsSlope == null ? '—' : `${rsSlope >= 0 ? '+' : ''}${rsSlope.toFixed(2)}pp`}</div></div>
              <div><div className="text-[10px] text-slate-500">VWAP dist</div><div className="font-mono font-bold">{pct(behavior.current.distVwapPct)}</div></div>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">{behavior.reason}</p>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/40 p-3"><div className="text-[10px] uppercase text-rose-300">失效條件</div><div className="mt-1 text-xs text-slate-300">{behavior.invalidation}</div></div>
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/40 p-3"><div className="text-[10px] uppercase text-cyan-300">下一個確認</div><div className="mt-1 text-xs text-slate-300">{behavior.nextConfirmation}</div></div>
          </div>
        </section>

        <section className="mb-4 grid gap-3 md:grid-cols-3">
          <CheckpointCard cp={behavior.checkpoints.m5}/>
          <CheckpointCard cp={behavior.checkpoints.m15}/>
          <CheckpointCard cp={behavior.checkpoints.m30}/>
        </section>

        <section className="mb-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Database size={15}/> 目前研究證據</div>
            <div className="space-y-3 text-xs text-slate-400">
              <div className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300"/><span><b className="text-white">Reversal Long</b>：近期 5 個樣本，品質分數 73/100；目前最值得擴大驗證，但仍未達 production 樣本門檻。</span></div>
              <div className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300"/><span><b className="text-white">Failed Breakout Short</b>：近期 4 個候選、3 次方向正確；失敗案例顯示 RS 在 30m 回升時必須取消空方 thesis。</span></div>
              <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300"/><span><b className="text-white">Gap-and-Go</b> 只有 2 個候選；<b className="text-white">Trend Breakdown</b> 只有 3 個候選。現在只能當提示，不能據此估計可靠勝率。</span></div>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="mb-3 text-sm font-bold">Production Gate</div>
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm font-black text-rose-200">NO DEPLOY — 尚未通過長期 1m out-of-sample</div>
            <div className="mt-3 text-xs leading-relaxed text-slate-400">正式升級前要求：至少 20 個 setup 樣本、train ≥12、test ≥6、test PF ≥1.15、10 bps/side 壓力成本後仍為正，且跨時段穩定。Yahoo 近期 5m 資料永遠只能是 provisional；Massive 1m 或等級相當資料通過後才允許改寫 V6 hard gate。</div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-500">
          <AlertTriangle size={14} className="mr-2 inline text-amber-300"/>這是決策輔助，不是獲利保證。研究模式刻意把「有方向的觀察」與「已驗證可交易訊號」分開；沒有完整確認時，NO TRADE 是正常輸出。
        </section>
      </div>
    </div>
  );
}
