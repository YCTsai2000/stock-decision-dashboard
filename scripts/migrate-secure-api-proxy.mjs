import fs from 'node:fs/promises';

const replaceOnce = (text, from, to, label) => {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`Migration anchor not found: ${label}`);
  return text.replace(from, to);
};

// dataLayer.ts
{
  const path = 'src/dataLayer.ts';
  let s = await fs.readFile(path, 'utf8');
  s = replaceOnce(
    s,
    "} from './types';\n",
    "} from './types';\nimport { effectiveApiKey, routeApiRequest } from './apiProxy';\n",
    'dataLayer import',
  );
  s = replaceOnce(
    s,
    "const cleanKey = (value: string | undefined) => (value ?? '').trim();",
    "const cleanKey = (value: string | undefined) => effectiveApiKey(value);",
    'dataLayer cleanKey',
  );
  s = replaceOnce(
    s,
    "return await fetch(url, { ...init, signal: controller.signal });",
    "return await fetch(routeApiRequest(url), { ...init, signal: controller.signal });",
    'dataLayer routed fetch',
  );
  await fs.writeFile(path, s);
}

// intradayCanonical.ts
{
  const path = 'src/intradayCanonical.ts';
  let s = await fs.readFile(path, 'utf8');
  s = replaceOnce(
    s,
    "} from './intradayCore';\n",
    "} from './intradayCore';\nimport { effectiveApiKey, routeApiRequest } from './apiProxy';\n",
    'intraday canonical import',
  );
  s = replaceOnce(
    s,
    "const cleanKey = (value: string | undefined) => (value ?? '').trim();",
    "const cleanKey = (value: string | undefined) => effectiveApiKey(value);",
    'intraday canonical cleanKey',
  );
  s = replaceOnce(
    s,
    "const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });",
    "const response = await fetch(routeApiRequest(url), { headers: { Accept: 'application/json' }, signal: controller.signal });",
    'intraday canonical routed fetch',
  );
  await fs.writeFile(path, s);
}

// App.tsx
{
  const path = 'src/App.tsx';
  let s = await fs.readFile(path, 'utf8');
  s = replaceOnce(
    s,
    "} from './dataLayer';\n",
    "} from './dataLayer';\nimport { hasProviderAccess, isApiProxyConfigured } from './apiProxy';\n",
    'App proxy import',
  );
  s = replaceOnce(
    s,
    "  const [countdown, setCountdown] = useState(REFRESH_SECONDS);\n",
    "  const [countdown, setCountdown] = useState(REFRESH_SECONDS);\n  const proxyEnabled = isApiProxyConfigured();\n",
    'App proxy flag',
  );
  s = replaceOnce(
    s,
    "    if (!keysRef.current.finnhub.trim() && !keysRef.current.massive.trim()) return;",
    "    if (!hasProviderAccess(keysRef.current, ['finnhub', 'massive'])) return;",
    'App quote access guard',
  );
  s = replaceOnce(
    s,
    "  const providerCount = Object.values(keys).filter(value => value.trim()).length;",
    "  const providerCount = proxyEnabled ? 5 : Object.values(keys).filter(value => value.trim()).length;",
    'App provider count',
  );
  const oldSettings = `        {settingsOpen && (\n          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">\n            <div className="flex items-start gap-2 mb-4">\n              <ShieldAlert size={17} className="text-amber-400 mt-0.5" />\n              <div className="text-xs text-slate-400 leading-relaxed">API Key 只存於你目前瀏覽器的 localStorage，不會寫進 GitHub repository。GitHub Pages 是純前端，任何放進原始碼或 Vite 環境變數的秘密都可能被訪客看到，因此本專案刻意不把 Key 打包進網站。</div>\n            </div>\n            <ProviderSettings keys={keys} setKeys={setKeys} onClearCache={handleClearCache} />\n          </section>\n        )}`;
  const newSettings = `        {settingsOpen && (\n          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">\n            {proxyEnabled ? (\n              <div className="flex flex-col gap-3">\n                <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">\n                  <ShieldAlert size={17} className="text-emerald-300 mt-0.5" />\n                  <div className="text-xs text-emerald-100 leading-relaxed"><strong>Secure API Proxy 已啟用。</strong> Massive / Twelve Data / Finnhub / FMP / FRED 的秘密金鑰由伺服器端管理，這個瀏覽器不需要再輸入 API Key，也不會把 Key 打包進 GitHub Pages。</div>\n                </div>\n                <button onClick={handleClearCache} className="self-start text-xs border border-slate-700 hover:border-rose-500/50 hover:text-rose-300 rounded-lg px-3 py-2 transition-colors">清除資料快取</button>\n              </div>\n            ) : (\n              <>\n                <div className="flex items-start gap-2 mb-4">\n                  <ShieldAlert size={17} className="text-amber-400 mt-0.5" />\n                  <div className="text-xs text-slate-400 leading-relaxed">尚未設定 Secure API Proxy，因此暫時使用瀏覽器 localStorage 模式。API Key 不會寫進 repository，但換瀏覽器時仍需重新輸入。</div>\n                </div>\n                <ProviderSettings keys={keys} setKeys={setKeys} onClearCache={handleClearCache} />\n              </>\n            )}\n          </section>\n        )}`;
  s = replaceOnce(s, oldSettings, newSettings, 'App settings proxy UI');
  await fs.writeFile(path, s);
}

// DayTradingAppV5.tsx
{
  const path = 'src/DayTradingAppV5.tsx';
  let s = await fs.readFile(path, 'utf8');
  s = replaceOnce(
    s,
    "import WatchlistRanker from './WatchlistRankerV6';\n",
    "import WatchlistRanker from './WatchlistRankerV6';\nimport { hasProviderAccess, isApiProxyConfigured } from './apiProxy';\n",
    'DayTrading proxy import',
  );
  s = replaceOnce(
    s,
    "  const [maxAlloc, setMaxAlloc] = useState(riskDefaults.maxAlloc);\n",
    "  const [maxAlloc, setMaxAlloc] = useState(riskDefaults.maxAlloc);\n  const proxyEnabled = isApiProxyConfigured();\n",
    'DayTrading proxy flag',
  );
  s = s.replace(
    "if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) {",
    "if (!hasProviderAccess(keys, ['twelve', 'massive', 'finnhub'])) {",
  );
  s = s.replace(
    "      setError('請先在頂端設定區填入 Twelve Data、Massive 或 Finnhub 至少一組 Key。');",
    "      setError('尚未設定 Secure API Proxy，且瀏覽器中也沒有 Twelve Data、Massive 或 Finnhub Key。');",
  );
  s = s.replace(
    "    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) return;",
    "    if (!hasProviderAccess(keys, ['twelve', 'massive', 'finnhub'])) return;",
  );
  s = replaceOnce(
    s,
    "  const providerReady = Boolean(keys.twelve.trim() || keys.massive.trim() || keys.finnhub.trim());",
    "  const providerReady = hasProviderAccess(keys, ['twelve', 'massive', 'finnhub']);",
    'DayTrading provider ready',
  );
  const oldApiBlock = `          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">\n            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-300"><KeyRound size={14}/> 2. 市場資料 API</div>\n            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">\n              {([['twelve','Twelve Data'],['finnhub','Finnhub'],['massive','Massive'],['fmp','FMP'],['fred','FRED']] as const).map(([k,l]) => <label key={k} className="field-label">{l}<input type="password" className="field-input" value={keys[k]} onChange={e => setKeys(p => ({ ...p, [k]: e.target.value }))}/></label>)}\n            </div>\n            <div className="mt-2 text-[10px] text-slate-600">當沖最低建議：Twelve Data + Alpaca；其餘 API 作備援、公司資料與總經補充。</div>\n          </div>`;
  const newApiBlock = `          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">\n            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-300"><KeyRound size={14}/> 2. 市場資料 API</div>\n            {proxyEnabled ? (\n              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">Secure API Proxy 已連線。Twelve Data / Finnhub / Massive / FMP / FRED 金鑰由伺服器端 Secrets 管理，不需要在此頁重複貼上。</div>\n            ) : (\n              <>\n                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">\n                  {([['twelve','Twelve Data'],['finnhub','Finnhub'],['massive','Massive'],['fmp','FMP'],['fred','FRED']] as const).map(([k,l]) => <label key={k} className="field-label">{l}<input type="password" className="field-input" value={keys[k]} onChange={e => setKeys(p => ({ ...p, [k]: e.target.value }))}/></label>)}\n                </div>\n                <div className="mt-2 text-[10px] text-slate-600">尚未設定 Proxy 時才使用瀏覽器 API Key fallback。</div>\n              </>\n            )}\n          </div>`;
  s = replaceOnce(s, oldApiBlock, newApiBlock, 'DayTrading API block');
  s = s.replace(
    'API Key 會自動儲存於本機瀏覽器；Alpaca Secret 使用 sessionStorage。完整分析前請先確認 Market Data 與 Alpaca Live 狀態。',
    "{proxyEnabled ? '市場資料 API Key 由 Secure Proxy 管理；Alpaca Secret 仍使用 sessionStorage。' : '市場資料 API Key 暫存於本機瀏覽器；Alpaca Secret 使用 sessionStorage。'}",
  );
  await fs.writeFile(path, s);
}

// WatchlistRankerV6.tsx
{
  const path = 'src/WatchlistRankerV6.tsx';
  let s = await fs.readFile(path, 'utf8');
  s = replaceOnce(
    s,
    "import { getExecutionForDirection, type ExecutionSide } from './tradingInstruments';\n",
    "import { getExecutionForDirection, type ExecutionSide } from './tradingInstruments';\nimport { hasProviderAccess, isApiProxyConfigured } from './apiProxy';\n",
    'Ranker proxy import',
  );
  s = s.replace(
    "    if (!keys.twelve.trim() && !keys.massive.trim() && !keys.finnhub.trim()) {",
    "    if (!hasProviderAccess(keys, ['twelve', 'massive', 'finnhub'])) {",
  );
  s = s.replace(
    "    const pace = keys.twelve.trim() ? TWELVE_PACE_MS : FALLBACK_PACE_MS;",
    "    const pace = (isApiProxyConfigured() || keys.twelve.trim()) ? TWELVE_PACE_MS : FALLBACK_PACE_MS;",
  );
  await fs.writeFile(path, s);
}

console.log('Secure API proxy migration applied.');
