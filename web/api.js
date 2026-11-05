// Platform-neutral web API for Titen: used by the Node server (web/server.js) and the
// Cloudflare Worker (worker/index.js). No node:http / node:fs here.
import { getTrends, trendsCacheKey } from '../core/features/trends.js';
import { getBrief, WEB_TOPICS, briefCacheKey } from '../core/features/brief.js';
import { getTldr } from '../core/features/tldr.js';
import { checkScam } from '../core/features/scam.js';
import { TitenError } from '../core/errors.js';
import { utcDate } from '../core/cache.js';

// The website shows global trends only (per-country views stay in the CLI).
export const WEB_REGIONS = ['global'];
export const PAGES = { '/': 'index', '/brief': 'brief', '/tldr': 'tldr', '/scam': 'scam', '/about': 'about' };
export const MAX_BODY = 7_500_000; // a 5 MB image is ~6.7 MB as base64

/**
 * Security headers. Nobody may frame the site unless `frameAncestors` names who may
 * (e.g. "https://huggingface.co" for Spaces, which shows apps inside an iframe).
 */
export function securityHeaders(frameAncestors = '') {
  const allowed = String(frameAncestors).split(/[\s,]+/).filter((o) => /^https:\/\/[\w.-]+$/.test(o));
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      `frame-ancestors ${allowed.length ? allowed.join(' ') : "'none'"}`,
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    ...(allowed.length ? {} : { 'X-Frame-Options': 'DENY' }),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Token bucket per IP: small bursts allowed, then about one request per `refillMs`. */
export function createRateLimiter({ capacity = 3, refillMs = 5000 } = {}) {
  const buckets = new Map();
  return {
    take(key) {
      const now = Date.now();
      if (buckets.size > 5000) {
        // Forget visitors whose bucket is full again (no timers: works on any runtime).
        for (const [k, b] of buckets) if (now - b.at > capacity * refillMs) buckets.delete(k);
      }
      const b = buckets.get(key) || { tokens: capacity, at: now };
      b.tokens = Math.min(capacity, b.tokens + (now - b.at) / refillMs);
      b.at = now;
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfter: Math.ceil(((1 - b.tokens) * refillMs) / 1000) };
    },
  };
}

/** Friendly public messages for core errors. Never leak provider details. */
export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof TitenError) {
    switch (e.code) {
      case 'BAD_INPUT':
      case 'BLOCKED_HOST':
        return new HttpError(400, e.message);
      case 'UNREADABLE':
        return new HttpError(422, e.message);
      case 'NO_CREDIT':
      case 'NO_KEY':
      case 'BAD_KEY':
        return new HttpError(503, 'Titen is resting for a moment. Please come back a little later.', { code: 'RESTING' });
      case 'RATE_LIMIT':
        return new HttpError(503, 'Titen is very busy right now. Please try again in a minute.');
      case 'TIMEOUT':
        return new HttpError(504, 'That took too long. Please try again.');
      case 'FETCH_FAILED':
        return new HttpError(502, e.message);
      default:
        return new HttpError(502, 'Titen could not finish that. Please try again.');
    }
  }
  return new HttpError(500, 'Something went wrong on our side.');
}

const publicResult = ({ usage, ...rest }) => rest; // cost info stays on the server

/**
 * The /api/* endpoints.
 * handle(req) takes a plain description of the request and returns { status, body, headers }:
 *   req = { method, path, searchParams, origin, host, ip, readJson: () => Promise<object> }
 * `waitUntil(promise)` keeps background work alive after the response (Workers need this).
 */
export function createApi({ config, sources, cache, limiter = createRateLimiter(), waitUntil = (p) => p, onError } = {}) {
  const deps = { config, sources, cache };
  // Today's counters for the live process panel (in memory; reset at UTC midnight or restart).
  const freshStats = () => ({ day: utcDate(), briefs: 0, tldrs: 0, scamChecks: 0, flagged: 0, lastBrief: null, lastScamAt: null });
  let stats = freshStats();
  const bump = (k, extra = {}) => {
    if (stats.day !== utcDate()) stats = freshStats();
    stats[k] += 1;
    Object.assign(stats, extra);
  };
  const refreshing = new Set();

  function rateLimit(req) {
    const r = limiter.take(req.ip || 'unknown');
    if (!r.ok) throw new HttpError(429, `Easy there. Try again in ${r.retryAfter} second${r.retryAfter === 1 ? '' : 's'}.`, { retryAfter: r.retryAfter });
  }

  async function trends(req) {
    const region = (req.searchParams.get('region') || 'global').toLowerCase();
    if (!WEB_REGIONS.includes(region)) throw new HttpError(400, 'Unknown region.');
    const entry = await cache.peek(trendsCacheKey(region));
    if (entry && entry.expires > Date.now()) return { ...entry.value, cached: true };
    if (entry) {
      // Stale: answer instantly, refresh in the background (once).
      if (!refreshing.has(region)) {
        refreshing.add(region);
        waitUntil(
          getTrends({ region, refresh: true, ...deps })
            .catch(() => {})
            .finally(() => refreshing.delete(region))
        );
      }
      return { ...entry.value, cached: true, stale: true };
    }
    if (!cache.isInflight(trendsCacheKey(region))) rateLimit(req);
    return publicResult(await getTrends({ region, ...deps }));
  }

  async function brief(req, id) {
    const topic = WEB_TOPICS.find((t) => t.id === id);
    if (!topic) throw new HttpError(404, 'Unknown topic.');
    const hit = await cache.get(briefCacheKey(topic.query));
    if (hit) return { ...hit, id, cached: true };
    if (!cache.isInflight(briefCacheKey(topic.query))) rateLimit(req);
    const r = await getBrief({ topicId: id, ...deps });
    if (!r.cached) bump('briefs', { lastBrief: { topic: topic.label, at: new Date().toISOString() } });
    return { ...publicResult(r), id };
  }

  async function status() {
    const entry = await cache.peek(trendsCacheKey('global'));
    const t = entry?.value;
    return {
      model: config.model,
      radar: t ? { generatedAt: t.generatedAt, signalCount: t.signalCount, topics: t.topics.length, feedCounts: t.feedCounts || null, stale: entry.expires <= Date.now() } : null,
      today: { briefs: stats.briefs, tldrs: stats.tldrs, scamChecks: stats.scamChecks, flagged: stats.flagged, lastBrief: stats.lastBrief, lastScamAt: stats.lastScamAt },
      feeds: ['Google Trends', 'Google News', 'Hacker News', 'GitHub'],
    };
  }

  async function route(req) {
    const p = req.path;
    // CSRF guard: a browser POST from another site carries a foreign Origin.
    if (req.method === 'POST' && req.origin) {
      let sameHost = false;
      try {
        sameHost = new URL(req.origin).host === req.host;
      } catch {
        /* malformed origin */
      }
      if (!sameHost) throw new HttpError(403, 'Cross-site requests are not allowed.');
    }
    if (req.method === 'GET' && p === '/api/health') return { ok: true };
    if (req.method === 'GET' && p === '/api/status') return status();
    if (req.method === 'GET' && p === '/api/topics') return WEB_TOPICS.map(({ id, label }) => ({ id, label }));
    if (req.method === 'GET' && p === '/api/trends') return trends(req);
    if (req.method === 'GET' && p.startsWith('/api/brief/')) return brief(req, decodeURIComponent(p.slice(11)));
    if (req.method === 'POST' && p === '/api/tldr') {
      const body = await req.readJson();
      rateLimit(req);
      const r = await getTldr({ url: String(body.url || ''), ...deps });
      bump('tldrs');
      return publicResult(r);
    }
    if (req.method === 'POST' && p === '/api/scam') {
      const body = await req.readJson();
      rateLimit(req);
      const r = await checkScam({
        text: typeof body.text === 'string' ? body.text : '',
        url: typeof body.url === 'string' ? body.url : '',
        imageDataUrl: typeof body.imageDataUrl === 'string' && body.imageDataUrl ? body.imageDataUrl : undefined,
        config,
        sources,
      });
      bump('scamChecks', { lastScamAt: new Date().toISOString() });
      if (r.verdict === 'likely_scam') stats.flagged += 1;
      return publicResult(r);
    }
    throw new HttpError(404, 'Not found.');
  }

  async function handle(req) {
    try {
      return { status: 200, body: await route(req), headers: {} };
    } catch (e) {
      const err = toHttpError(e);
      if (err.status >= 500) onError?.(req, err, e);
      return {
        status: err.status,
        body: { error: err.message, ...(err.extra.code ? { code: err.extra.code } : {}) },
        headers: err.extra.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {},
      };
    }
  }

  return { handle, warm: () => getTrends({ region: 'global', ...deps }) };
}
