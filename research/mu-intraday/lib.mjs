import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const NY_TZ = 'America/New_York';
export const TICKERS = ['MU', 'SOXX', 'NVDA', 'QQQ'];
export const OPEN_MINUTE = 9 * 60 + 30;
export const CLOSE_MINUTE = 16 * 60;
export const PREMARKET_START = 4 * 60;

export const DEFAULT_START = '2025-09-01';
export const DEFAULT_END = '2026-09-15';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function assertIsoDate(s, name = 'date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error(`${name} must be YYYY-MM-DD: ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid ${name}: ${s}`);
  return s;
}

export function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthChunks(start, end) {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) throw new Error('start must be <= end');
  const out = [];
  let cur = start;
  while (cur <= end) {
    const d = new Date(`${cur}T00:00:00Z`);
    const firstNext = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const monthEnd = new Date(firstNext.getTime() - 86400000).toISOString().slice(0, 10);
    const chunkEnd = monthEnd < end ? monthEnd : end;
    out.push([cur, chunkEnd]);
    cur = addDays(chunkEnd, 1);
  }
  return out;
}

export function nyParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((x) => x.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    minute: hour * 60 + minute,
  };
}

export function mean(a) {
  const x = a.filter(Number.isFinite);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null;
}

export function median(a) {
  const x = a.filter(Number.isFinite).sort((a, b) => a - b);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}

export function std(a) {
  const x = a.filter(Number.isFinite);
  if (x.length < 2) return null;
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}

export function quantile(a, q) {
  const x = a.filter(Number.isFinite).sort((a, b) => a - b);
  if (!x.length) return null;
  const p = (x.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  if (lo === hi) return x[lo];
  return x[lo] + (x[hi] - x[lo]) * (p - lo);
}

export function pct(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b - 1 : null;
}

export function weightedVwap(bars) {
  let num = 0, den = 0;
  for (const b of bars) {
    const v = Number(b.v) || 0;
    if (v <= 0) continue;
    const px = Number.isFinite(b.vw) ? b.vw : (b.h + b.l + b.c) / 3;
    if (!Number.isFinite(px)) continue;
    num += px * v;
    den += v;
  }
  return den > 0 ? num / den : null;
}

export function sumVolume(bars) {
  return bars.reduce((s, b) => s + (Number(b.v) || 0), 0);
}

export function highOf(bars) {
  const x = bars.map((b) => Number(b.h)).filter(Number.isFinite);
  return x.length ? Math.max(...x) : null;
}

export function lowOf(bars) {
  const x = bars.map((b) => Number(b.l)).filter(Number.isFinite);
  return x.length ? Math.min(...x) : null;
}

export function closeOf(bars) {
  return bars.length ? Number(bars.at(-1).c) : null;
}

export function groupByDate(raw) {
  const map = new Map();
  for (const b of raw) {
    const p = nyParts(b.t);
    if (!map.has(p.date)) map.set(p.date, []);
    map.get(p.date).push({ ...b, ...p });
  }
  for (const v of map.values()) v.sort((a, b) => a.t - b.t);
  return map;
}

export function regularBars(day) {
  return day.filter((b) => b.minute >= OPEN_MINUTE && b.minute < CLOSE_MINUTE);
}

export function premarketBars(day) {
  return day.filter((b) => b.minute >= PREMARKET_START && b.minute < OPEN_MINUTE);
}

export function windowBars(day, startMinute, endExclusive) {
  return day.filter((b) => b.minute >= startMinute && b.minute < endExclusive);
}

export function futureWindow(day, evalEndMinute, horizonMinutes) {
  return day.filter((b) => b.minute > evalEndMinute && b.minute <= evalEndMinute + horizonMinutes);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function saveGzipJson(file, value) {
  await ensureDir(path.dirname(file));
  const buf = gzipSync(Buffer.from(JSON.stringify(value)));
  await fs.writeFile(file, buf);
}

export async function loadGzipJson(file) {
  const buf = await fs.readFile(file);
  return JSON.parse(gunzipSync(buf).toString('utf8'));
}

export function csvEscape(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export async function writeCsv(file, rows) {
  await ensureDir(path.dirname(file));
  if (!rows.length) {
    await fs.writeFile(file, '');
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  await fs.writeFile(file, lines.join('\n'));
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

export function directionAdjusted(value, side) {
  if (!Number.isFinite(value)) return null;
  return side === 'SHORT' ? -value : value;
}

export function summarizeDirectional(rows, returnKey, side, mfeKey = null, maeKey = null) {
  const r = rows.map((x) => directionAdjusted(x[returnKey], side)).filter(Number.isFinite);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x < 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = -losses.reduce((s, x) => s + x, 0);
  const out = {
    n: r.length,
    winRate: r.length ? wins.length / r.length : null,
    avgReturn: mean(r),
    medianReturn: median(r),
    p25Return: quantile(r, 0.25),
    p75Return: quantile(r, 0.75),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
  };
  if (mfeKey) out.avgMFE = mean(rows.map((x) => directionAdjusted(x[mfeKey], side)).filter(Number.isFinite));
  if (maeKey) out.avgMAE = mean(rows.map((x) => directionAdjusted(x[maeKey], side)).filter(Number.isFinite));
  return out;
}
