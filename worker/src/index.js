const ALLOWED = {
  'api.massive.com': {
    secret: 'MASSIVE_API_KEY',
    credentialParam: 'apiKey',
    paths: [/^\/v2\/aggs\//, /^\/v2\/snapshot\//],
  },
  'api.twelvedata.com': {
    secret: 'TWELVE_API_KEY',
    credentialParam: 'apikey',
    paths: [/^\/time_series$/],
  },
  'finnhub.io': {
    secret: 'FINNHUB_API_KEY',
    credentialParam: 'token',
    paths: [
      /^\/api\/v1\/stock\/candle$/,
      /^\/api\/v1\/quote$/,
      /^\/api\/v1\/stock\/profile2$/,
      /^\/api\/v1\/calendar\/earnings$/,
    ],
  },
  'financialmodelingprep.com': {
    secret: 'FMP_API_KEY',
    credentialParam: 'apikey',
    paths: [
      /^\/stable\/profile$/,
      /^\/api\/v3\/profile\//,
      /^\/stable\/earnings-calendar$/,
      /^\/api\/v3\/earning_calendar$/,
    ],
  },
  'api.stlouisfed.org': {
    secret: 'FRED_API_KEY',
    credentialParam: 'api_key',
    paths: [/^\/fred\/series\/observations$/],
  },
  'www.sec.gov': {
    secret: null,
    credentialParam: null,
    paths: [/^\/files\/company_tickers\.json$/],
  },
  'data.sec.gov': {
    secret: null,
    credentialParam: null,
    paths: [/^\/api\/xbrl\/companyfacts\/CIK\d{10}\.json$/],
  },
};

const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const allowedOrigin = (request, env) => {
  const origin = request.headers.get('Origin') || '';
  const configured = String(env.ALLOWED_ORIGIN || '').trim();
  if (!configured) return origin || '*';
  return origin === configured ? origin : '';
};

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(origin || 'null'),
  },
});

const cacheTtl = target => {
  if (target.hostname === 'api.twelvedata.com' && target.searchParams.get('interval') === '1min') return 15;
  if (target.hostname === 'finnhub.io' && target.pathname === '/api/v1/quote') return 10;
  if (target.hostname === 'api.massive.com' && target.pathname.includes('/range/1/minute/')) return 15;
  if (target.hostname === 'api.stlouisfed.org') return 3600;
  if (target.hostname.endsWith('sec.gov')) return 3600;
  if (target.hostname === 'financialmodelingprep.com') return 1800;
  return 300;
};

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin || 'null');
    if (!origin) return json({ error: 'Origin not allowed' }, 403, 'null');

    if (requestUrl.pathname === '/health') {
      return json({ ok: true, service: 'stock-decision-api' }, 200, origin);
    }

    if (requestUrl.pathname !== '/proxy') return json({ error: 'Not found' }, 404, origin);

    const rawTarget = requestUrl.searchParams.get('url');
    if (!rawTarget) return json({ error: 'Missing url' }, 400, origin);

    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return json({ error: 'Invalid target URL' }, 400, origin);
    }

    if (target.protocol !== 'https:') return json({ error: 'HTTPS target required' }, 400, origin);
    const policy = ALLOWED[target.hostname];
    if (!policy) return json({ error: 'Target host not allowed' }, 403, origin);
    if (!policy.paths.some(re => re.test(target.pathname))) return json({ error: 'Target path not allowed' }, 403, origin);

    for (const key of ['apikey', 'api_key', 'apiKey', 'token']) target.searchParams.delete(key);

    if (policy.secret) {
      const secretValue = String(env[policy.secret] || '').trim();
      if (!secretValue) return json({ error: `${policy.secret} is not configured on the Worker` }, 503, origin);
      target.searchParams.set(policy.credentialParam, secretValue);
    }

    const ttl = cacheTtl(target);
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => response.headers.set(k, v));
      response.headers.set('X-Proxy-Cache', 'HIT');
      return response;
    }

    const headers = new Headers({ Accept: 'application/json' });
    if (target.hostname.endsWith('sec.gov')) {
      headers.set('User-Agent', String(env.SEC_USER_AGENT || 'stock-decision-dashboard research contact'));
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), { method: 'GET', headers });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Upstream request failed' }, 502, origin);
    }

    const body = await upstream.arrayBuffer();
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    responseHeaders.set('Cache-Control', `public, max-age=${ttl}`);
    responseHeaders.set('X-Proxy-Cache', 'MISS');
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => responseHeaders.set(k, v));

    const response = new Response(body, { status: upstream.status, headers: responseHeaders });
    if (upstream.ok && ttl > 0) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
