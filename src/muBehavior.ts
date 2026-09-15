import type { IntradayBar } from './intraday';

export type MuBehaviorState =
  | 'PREMARKET'
  | 'OPENING_DISCOVERY'
  | 'GAP_GO_WATCH'
  | 'FAILED_BREAKOUT_WATCH'
  | 'REVERSAL_WATCH'
  | 'TREND_BREAKDOWN_WATCH'
  | 'NO_TRADE';

export type MuWatchDirection = 'LONG_WATCH' | 'SHORT_WATCH' | 'WAIT' | 'NO_TRADE';

export interface MuCheckpoint {
  minutes: 5 | 15 | 30;
  ready: boolean;
  close: number | null;
  retOpenPct: number | null;
  retPrevPct: number | null;
  gapHold: number | null;
  vwap: number | null;
  distVwapPct: number | null;
  peerReturnPct: number | null;
  rsPct: number | null;
  rvol: number | null;
}

export interface MuBehaviorResult {
  sessionDate: string | null;
  previousClose: number | null;
  sessionOpen: number | null;
  gapPct: number | null;
  state: MuBehaviorState;
  direction: MuWatchDirection;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  evidenceTier: 'PROVISIONAL_RECENT_5M';
  label: string;
  reason: string;
  invalidation: string;
  nextConfirmation: string;
  checkpoints: { m5: MuCheckpoint; m15: MuCheckpoint; m30: MuCheckpoint };
  current: {
    price: number | null;
    minute: number | null;
    vwap: number | null;
    distVwapPct: number | null;
    rsPct: number | null;
  };
  research: {
    sampleSessions: 40;
    reversalSample: 5;
    reversalScore: 73;
    failedBreakoutSample: 4;
    failedBreakoutRecentWinRate: number;
    deployable: false;
  };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

const regularDates = (bars: IntradayBar[]) => [...new Set(
  bars.filter(b => b.minute >= OPEN && b.minute < CLOSE).map(b => b.date),
)].sort();

const regularFor = (bars: IntradayBar[], date: string) => bars
  .filter(b => b.date === date && b.minute >= OPEN && b.minute < CLOSE)
  .sort((a, b) => a.minute - b.minute);

const pct = (end: number | null, start: number | null) => (
  end !== null && start !== null && Number.isFinite(end) && Number.isFinite(start) && start > 0
    ? ((end / start) - 1) * 100
    : null
);

const vwap = (bars: IntradayBar[]) => {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (!Number.isFinite(b.volume) || b.volume <= 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : bars.at(-1)?.close ?? null;
};

const sumVolume = (bars: IntradayBar[]) => bars.reduce((s, b) => s + (Number(b.volume) || 0), 0);

const firstNBars = (bars: IntradayBar[], n: number) => bars.slice(0, n);

const alignedPeerReturn = (
  peerBars: IntradayBar[][],
  sessionDate: string,
  n: number,
) => {
  const returns = peerBars.map(all => {
    const dates = regularDates(all);
    const currentDate = dates.includes(sessionDate) ? sessionDate : null;
    const previousDate = currentDate ? dates.filter(d => d < currentDate).at(-1) ?? null : null;
    if (!currentDate || !previousDate) return null;
    const current = firstNBars(regularFor(all, currentDate), n);
    const previous = regularFor(all, previousDate);
    if (current.length < n || !previous.length) return null;
    return pct(current.at(-1)!.close, previous.at(-1)!.close);
  }).filter((x): x is number => x !== null && Number.isFinite(x));
  return returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
};

const checkpointRvol = (allBars: IntradayBar[], sessionDate: string, n: number, currentVol: number) => {
  const dates = regularDates(allBars).filter(d => d < sessionDate).slice(-10);
  const vols = dates.map(d => sumVolume(firstNBars(regularFor(allBars, d), n))).filter(x => x > 0);
  if (vols.length < 3) return null;
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  return avg > 0 ? currentVol / avg : null;
};

const emptyCheckpoint = (minutes: 5 | 15 | 30): MuCheckpoint => ({
  minutes, ready: false, close: null, retOpenPct: null, retPrevPct: null, gapHold: null,
  vwap: null, distVwapPct: null, peerReturnPct: null, rsPct: null, rvol: null,
});

export const computeMuBehavior = (
  muBars: IntradayBar[] | null,
  peers: Array<IntradayBar[] | null>,
): MuBehaviorResult => {
  const base: MuBehaviorResult = {
    sessionDate: null, previousClose: null, sessionOpen: null, gapPct: null,
    state: 'NO_TRADE', direction: 'NO_TRADE', confidence: 'LOW', evidenceTier: 'PROVISIONAL_RECENT_5M',
    label: '資料不足', reason: '需要 MU 與至少一個同時段 benchmark 的 5 分 K。',
    invalidation: '—', nextConfirmation: '等待資料完整。',
    checkpoints: {m5: emptyCheckpoint(5), m15: emptyCheckpoint(15), m30: emptyCheckpoint(30)},
    current: {price: null, minute: null, vwap: null, distVwapPct: null, rsPct: null},
    research: {sampleSessions: 40, reversalSample: 5, reversalScore: 73, failedBreakoutSample: 4, failedBreakoutRecentWinRate: 0.75, deployable: false},
  };
  if (!muBars?.length) return base;

  const dates = regularDates(muBars);
  const sessionDate = dates.at(-1) ?? null;
  const previousDate = dates.at(-2) ?? null;
  if (!sessionDate || !previousDate) return base;
  const session = regularFor(muBars, sessionDate);
  const previous = regularFor(muBars, previousDate);
  if (!session.length || !previous.length) return base;

  const previousClose = previous.at(-1)!.close;
  const sessionOpen = session[0].open;
  const gapPct = pct(sessionOpen, previousClose);
  const validPeers = peers.filter((x): x is IntradayBar[] => Boolean(x?.length));

  const makeCheckpoint = (minutes: 5 | 15 | 30): MuCheckpoint => {
    const n = minutes / 5;
    const sample = firstNBars(session, n);
    if (sample.length < n) return emptyCheckpoint(minutes);
    const close = sample.at(-1)!.close;
    const cpVwap = vwap(sample);
    const retPrevPct = pct(close, previousClose);
    const retOpenPct = pct(close, sessionOpen);
    const denominator = sessionOpen - previousClose;
    const gapHold = Math.abs(denominator) > 1e-9 ? (close - previousClose) / denominator : null;
    const peerReturnPct = validPeers.length ? alignedPeerReturn(validPeers, sessionDate, n) : null;
    const rsPct = retPrevPct !== null && peerReturnPct !== null ? retPrevPct - peerReturnPct : null;
    const currentVol = sumVolume(sample);
    return {
      minutes, ready: true, close, retOpenPct, retPrevPct, gapHold, vwap: cpVwap,
      distVwapPct: pct(close, cpVwap), peerReturnPct, rsPct,
      rvol: checkpointRvol(muBars, sessionDate, n, currentVol),
    };
  };

  const m5 = makeCheckpoint(5), m15 = makeCheckpoint(15), m30 = makeCheckpoint(30);
  const current = session.at(-1)!;
  const currentVwap = vwap(session);
  const currentMuReturn = pct(current.close, previousClose);
  const currentPeerReturn = validPeers.length ? alignedPeerReturn(validPeers, sessionDate, session.length) : null;
  const currentRs = currentMuReturn !== null && currentPeerReturn !== null ? currentMuReturn - currentPeerReturn : null;

  const result: MuBehaviorResult = {
    ...base,
    sessionDate, previousClose, sessionOpen, gapPct,
    checkpoints: {m5, m15, m30},
    current: {price: current.close, minute: current.minute, vwap: currentVwap, distVwapPct: pct(current.close, currentVwap), rsPct: currentRs},
  };

  if (current.minute < OPEN) {
    return {...result, state:'PREMARKET', direction:'WAIT', label:'盤前觀察', reason:'正式盤尚未開始，不把盤前價格直接當進場訊號。', nextConfirmation:'等待 09:35 / 09:45 ET 的 Gap Hold 與 RS。'};
  }
  if (!m15.ready) {
    return {...result, state:'OPENING_DISCOVERY', direction:'WAIT', label:'開盤價格發現', reason:'前 15 分鐘尚未完成；目前只記錄 Gap Hold 與 RS，不進行型態確認。', nextConfirmation:'等待 OR15 完成。'};
  }

  const rsSlope15to30 = m30.ready && m15.rsPct !== null && m30.rsPct !== null ? m30.rsPct - m15.rsPct : null;
  const rsImprove5to30 = m30.ready && m5.rsPct !== null && m30.rsPct !== null ? m30.rsPct - m5.rsPct : null;

  if (gapPct !== null && gapPct >= 1 && m15.gapHold !== null && m15.gapHold < 0.70 && (m15.distVwapPct ?? 1) < 0 && (m15.rsPct ?? 1) < 0) {
    const confirmed = m30.ready && (m30.distVwapPct ?? 1) < 0 && (m30.gapHold ?? 1) < 0 && rsSlope15to30 !== null && rsSlope15to30 < 0;
    return {
      ...result,
      state:'FAILED_BREAKOUT_WATCH', direction:'SHORT_WATCH', confidence: confirmed ? 'MEDIUM' : 'LOW',
      label: confirmed ? '假突破持續惡化 · SHORT WATCH' : '疑似假突破 · 先等確認',
      reason: confirmed
        ? `Gap Up 後失守 VWAP，且 RS 由 15m 到 30m 再惡化 ${Math.abs(rsSlope15to30 ?? 0).toFixed(2)} 個百分點。近期 4 個候選中 3 次方向正確，但樣本仍太少。`
        : 'Gap Up 沒有延續、15m 已跌回 VWAP 下且相對市場偏弱；但歷史失敗案例顯示 RS 若在 30m 回升，空方優勢會消失。',
      invalidation:'RS30 回升至 RS15 之上，或價格重新站回 VWAP / Open。',
      nextConfirmation:'30m 要求 RS 繼續惡化、Gap Hold 轉負且仍在 VWAP 下；否則取消空方觀察。',
    };
  }

  if (gapPct !== null && gapPct <= -1 && m30.ready && (m30.retOpenPct ?? -1) > 0 && (m30.distVwapPct ?? -1) > 0 && rsImprove5to30 !== null && rsImprove5to30 > 0) {
    const strongRepair = rsImprove5to30 >= 1 && (m30.retOpenPct ?? 0) >= 1;
    return {
      ...result,
      state:'REVERSAL_WATCH', direction:'LONG_WATCH', confidence: strongRepair ? 'MEDIUM' : 'LOW',
      label: strongRepair ? 'Gap-down 修復成立 · LONG WATCH' : 'Gap-down 初步修復 · 觀察',
      reason:`30m 已收復 Open 與 VWAP，RS5→RS30 改善 ${rsImprove5to30.toFixed(2)} 個百分點。近期 Reversal 樣本 5 次、研究品質分數 73/100，是目前最值得擴大驗證的 MU setup，但尚未達 production 樣本門檻。`,
      invalidation:'跌回 VWAP 下、跌破 30m 修復低點，或 RS 再度快速轉弱。',
      nextConfirmation:'等下一個 Higher Low / 前高突破；未確認前只視為 LONG WATCH，不是追價訊號。',
    };
  }

  if (gapPct !== null && gapPct <= -1 && (m15.retOpenPct ?? 1) < 0 && (m15.distVwapPct ?? 1) < 0 && (m15.rsPct ?? 0) <= -2.5) {
    const worsening = m30.ready && m30.rsPct !== null && m15.rsPct !== null && m30.rsPct <= m15.rsPct && (m30.distVwapPct ?? 1) < 0;
    return {
      ...result,
      state:'TREND_BREAKDOWN_WATCH', direction:'SHORT_WATCH', confidence: worsening ? 'MEDIUM' : 'LOW',
      label:worsening ? '弱勢延續 · SHORT WATCH' : 'Gap-down 弱勢 · 先等延續',
      reason:`MU Gap Down 後 15m 仍在 VWAP 下，RS15 = ${(m15.rsPct ?? 0).toFixed(2)}%。近期 3 個相似樣本全數延續下跌，但樣本極小，因此只作風險方向提示。`,
      invalidation:'收復 VWAP / Open，或 RS 開始明顯改善。',
      nextConfirmation:'30m 若 RS 仍惡化且價格維持 VWAP 下，才提高空方優先級。',
    };
  }

  if (gapPct !== null && gapPct >= 1 && (m15.gapHold ?? 0) >= 0.70 && (m15.distVwapPct ?? -1) > 0 && (m15.rsPct ?? -1) > 0 && (m15.rvol ?? 0) >= 1.2) {
    const followThrough = m30.ready && (m30.distVwapPct ?? -1) > 0 && m30.rsPct !== null && m15.rsPct !== null && m30.rsPct >= m15.rsPct;
    return {
      ...result,
      state:'GAP_GO_WATCH', direction:'LONG_WATCH', confidence:'LOW',
      label:followThrough ? 'Gap-and-Go 延續 · LONG WATCH' : 'Gap Hold 強 · 但樣本不足',
      reason:'Gap 被保留、15m 在 VWAP 上、相對強勢且量能放大。近期只有 2 個候選，不能視為已驗證策略。',
      invalidation:'跌破 VWAP、Gap Hold 明顯下降，或 RS 由正轉負。',
      nextConfirmation:'要求 30m RS 不衰退並形成 Higher Low；否則不追高。',
    };
  }

  return {
    ...result,
    state:'NO_TRADE', direction:'NO_TRADE', confidence:'LOW',
    label:'沒有 MU 專屬優勢型態',
    reason:'目前沒有同時滿足 Gap、VWAP 與相對強弱結構。沒有 setup 本身就是有效訊號：避免為了交易而交易。',
    invalidation:'—', nextConfirmation:'等待下一個 5 分 K，重新評估 RS slope、VWAP 與 Gap Hold。',
  };
};
