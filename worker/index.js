// Titen website on Cloudflare Workers.
// Static files (CSS, JS, icons) are served by Workers Static Assets from worker/public;
// pages are pre-rendered by scripts/build-worker.mjs; /api/* is the same code as the Node server.
import PAGES_HTML from './generated/pages.js';
import { createApi, createRateLimiter, securityHeaders, HttpError, PAGES, MAX_BODY } from '../web/api.js';
import { createCacheWith, createMemoryCache } from '../core/cache.js';
import { DEFAULT_MODEL } from '../core/config.js';
import * as sources from '../core/sources/index.js';

/** Workers KV as cache storage. Entries outlive their freshness so stale trends can be shown instantly. */
export function createKvCache(kv) {
  const kvKey = (key) => (key.length > 400 ? `${key.slice(0, 200)}#${hash(key)}` : key); // KV keys max 512 bytes
  return createCacheWith({
    read: (key) => kv.get(kvKey(key), 'json'),
    write: (key, entry, ttlMs) => kv.put(kvKey(key), JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000) * 4) }),
  });
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// One app per isolate (Workers reuse isolates between requests).
let app;
function getApp(env) {
  if (app) return app;
  const config = {
    apiKey: String(env.OPENROUTER_API_KEY || '').trim(),
    model: env.TITEN_MODEL || DEFAULT_MODEL,
    baseUrl: String(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    searchEngine: env.TITEN_SEARCH_ENGINE || 'exa',
  };
  const cache = env.TITEN_CACHE ? createKvCache(env.TITEN_CACHE) : createMemoryCache();
  const headers = securityHeaders(env.FRAME_ANCESTORS);
  let waitUntil = (p) => p;
  const api = createApi({
    config,
    sources: env.__sources || sources, // tests may inject fake sources
    cache,
    limiter: createRateLimiter(),
    waitUntil: (p) => waitUntil(p),
    onError: (req, err, e) => console.error(`[titen] ${req.method} ${req.path} → ${err.status} (${e.code || e.message})`),
  });
  app = { api, headers, setWaitUntil: (fn) => (waitUntil = fn) };
  return app;
}

/** For tests: start fresh with a new env. */
export function resetApp() {
  app = undefined;
}

async function readJson(request) {
  if (!String(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) throw new HttpError(413, 'That is too large. Images must be under 5 MB.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That is too large. Images must be under 5 MB.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function respond(status, body, headers, extra = {}) {
  const isJson = typeof body !== 'string';
  return new Response(isJson ? JSON.stringify(body) : body, {
    status,
    headers: {
      ...headers,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // One canonical address: www.titenhq.com → titenhq.com (keeps path and query).
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    const { api, headers, setWaitUntil } = getApp(env);
    setWaitUntil((p) => ctx.waitUntil(p));
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p.startsWith('/api/')) {
      const r = await api.handle({
        method: request.method,
        path: p,
        searchParams: url.searchParams,
        origin: request.headers.get('origin') || undefined,
        host: url.host,
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        readJson: () => readJson(request), // HttpErrors (413/415/400) pass through api.handle unchanged
      });
      return respond(r.status, r.body, headers, r.headers);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, 'Method not allowed.', headers);
    if (PAGES[p]) return respond(200, PAGES_HTML[PAGES[p]], headers, { 'Cache-Control': 'no-cache' });

    // Anything else: a static file if one exists, otherwise the 404 page.
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    return respond(404, PAGES_HTML['404'], headers);
  },
};
