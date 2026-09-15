import type { ApiKeys } from './types';

const rawBase = String(import.meta.env.VITE_API_PROXY_BASE ?? '').trim();
export const API_PROXY_BASE = rawBase.replace(/\/+$/, '');

const SECRET_QUERY_KEYS = ['apikey', 'api_key', 'token', 'apiKey'];
const PROXY_PLACEHOLDER = '__SERVER_SECRET__';

const ALLOWED_HOSTS = new Set([
  'api.massive.com',
  'api.twelvedata.com',
  'finnhub.io',
  'financialmodelingprep.com',
  'api.stlouisfed.org',
  'www.sec.gov',
  'data.sec.gov',
]);

export const isApiProxyConfigured = () => Boolean(API_PROXY_BASE);

/**
 * Keeps the existing provider/fallback logic intact. When the server-side proxy
 * is configured, missing browser keys become a harmless placeholder. The
 * placeholder is stripped before the request leaves the browser.
 */
export const effectiveApiKey = (value: string | undefined) => {
  const key = (value ?? '').trim();
  if (key) return key;
  return isApiProxyConfigured() ? PROXY_PLACEHOLDER : '';
};

export const hasProviderAccess = (keys: ApiKeys, providers: Array<keyof ApiKeys>) => (
  isApiProxyConfigured() || providers.some(provider => Boolean((keys[provider] ?? '').trim()))
);

export const routeApiRequest = (url: string) => {
  if (!isApiProxyConfigured()) return url;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }

  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) return url;

  for (const key of SECRET_QUERY_KEYS) target.searchParams.delete(key);
  const proxy = new URL(`${API_PROXY_BASE}/proxy`);
  proxy.searchParams.set('url', target.toString());
  return proxy.toString();
};
