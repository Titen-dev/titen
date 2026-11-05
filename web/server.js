import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, getTrends, getBrief, getTldr, checkScam, WEB_TOPICS, TitenError, createCache } from '../core/index.js';
import { trendsCacheKey } from '../core/features/trends.js';
import { briefCacheKey } from '../core/features/brief.js';
import { utcDate } from '../core/cache.js';
import * as realSources from '../core/sources/index.js';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const VIEWS_DIR = path.join(WEB_DIR, 'views');

// The website shows global trends only (per-country views stay in the CLI).
export const WEB_REGIONS = ['global'];
const PAGES = { '/': 'index', '/brief': 'brief', '/tldr': 'tldr', '/scam': 'scam', '/about': 'about' };
const MAX_BODY = 7_500_000; // a 5 MB image is ~6.7 MB as base64

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ---------- asset versions (cache busting) ----------
// Every CSS/JS/icon URL gets ?v=<content hash>, so browsers can cache forever and
// still pick up a new file the moment its content changes.

export function assetVersions() {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (TYPES[path.extname(e.name)]) {
        const rel = path.relative(PUBLIC_DIR, full).split(path.sep).join('/');
        out[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
      }
    }
  };
  walk(PUBLIC_DIR);
  return out;
}

const versioned = (html, versions) =>
  html.replace(/(href|src)="\/([^"?#]+\.(?:css|js|svg))"/g, (m, attr, rel) => (versions[rel] ? `${attr}="/${rel}?v=${versions[rel]}"` : m));

// ES module imports inside our JS ("./app.js") get the same version stamp.
const versionImports = (js, dir, versions) =>
  js.replace(/(from\s+|import\s*\(\s*)(['"])\.\/([\w.-]+\.js)\2/g, (m, pre, q, file) => {
    const v = versions[`${dir}/${file}`];
    return v ? `${pre}${q}./${file}?v=${v}${q}` : m;
  });

// ---------- pages (tiny templating: layout + partials + page meta) ----------

export function renderPages(versions = assetVersions()) {
  const read = (f) => fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8');
  const layout = read('layout.html');
  const partials = {
    header: read('partials/header.html'),
    footer: read('partials/footer.html'),
    mark: read('partials/mark.svg'),
    globe: read('partials/globe.svg'),
    waluku: read('partials/waluku.svg'),
  };
  // Partials may contain partials (header → mark), so expand until nothing changes.
  const fill = (s) => {
    for (let i = 0; i < 4 && /\{\{>/.test(s); i++) s = s.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_, name) => partials[name] ?? '');
    return s;
  };

  const pages = {};
  for (const name of [...Object.values(PAGES), '404']) {
    const src = read(`${name}.html`);
    const meta = Object.fromEntries([...(src.match(/<!--meta([\s\S]*?)-->/)?.[1] || '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const body = src.replace(/<!--meta[\s\S]*?-->\s*/, '');
    const scripts = (meta.scripts || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => `<script type="module" src="/assets/${s}"></script>`).join('\n');
    let html = layout
      .replace('{{content}}', () => fill(body))
      .replace(/\{\{title\}\}/g, meta.title || 'Titen')
      .replace(/\{\{description\}\}/g, meta.description || 'Titen reads the signs of the world.')
      .replace(/\{\{page\}\}/g, name)
      .replace('{{scripts}}', scripts);
    html = fill(html).replace(`data-nav="${name}"`, `data-nav="${name}" aria-current="page"`);
    pages[name] = versioned(html, versions);
  }
  return pages;
}

// ---------- rate limiting (token bucket per IP) ----------

export function createRateLimiter({ capacity = 3, refillMs = 5000 } = {}) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.at > capacity * refillMs) buckets.delete(k);
  }, 60_000);
  timer.unref();
  return {
    take(key) {
      const now = Date.now();
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

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Behind a host's proxy (Render, Cloudflare) the visitor's IP arrives in a header.
// Prefer headers the edge sets itself; X-Forwarded-For can be partly client-supplied.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']) {
      const v = String(req.headers[h] || '').trim();
      if (v) return v;
    }
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'Send JSON.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'That is too large. Images must be under 5 MB.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

/** Friendly public messages for core errors. Never leak provider details. */
function toHttpError(e) {
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

// ---------- app ----------

export function createApp({ config = getConfig(), sources = realSources, cache, trustProxy = process.env.TRUST_PROXY === '1', limiter, log = true } = {}) {
  const store = cache || createCache(config.cacheDir);
  const limit = limiter || createRateLimiter();
  const versions = assetVersions();
  const pages = renderPages(versions);
  const deps = { config, sources, cache: store };
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
    const r = limit.take(clientIp(req, trustProxy));
    if (!r.ok) throw new HttpError(429, `Easy there. Try again in ${r.retryAfter} second${r.retryAfter === 1 ? '' : 's'}.`, { retryAfter: r.retryAfter });
  }

  async function trends(req, url) {
    const region = (url.searchParams.get('region') || 'global').toLowerCase();
    if (!WEB_REGIONS.includes(region)) throw new HttpError(400, 'Unknown region.');
    const entry = await store.peek(trendsCacheKey(region));
    if (entry && entry.expires > Date.now()) return { ...entry.value, cached: true };
    if (entry) {
      // Stale: answer instantly, refresh in the background (once).
      if (!refreshing.has(region)) {
        refreshing.add(region);
        getTrends({ region, refresh: true, ...deps })
          .catch(() => {})
          .finally(() => refreshing.delete(region));
      }
      return { ...entry.value, cached: true, stale: true };
    }
    if (!store.isInflight(trendsCacheKey(region))) rateLimit(req);
    return publicResult(await getTrends({ region, ...deps }));
  }

  async function brief(req, id) {
    const topic = WEB_TOPICS.find((t) => t.id === id);
    if (!topic) throw new HttpError(404, 'Unknown topic.');
    const hit = await store.get(briefCacheKey(topic.query));
    if (hit) return { ...hit, id, cached: true };
    if (!store.isInflight(briefCacheKey(topic.query))) rateLimit(req);
    const r = await getBrief({ topicId: id, ...deps });
    if (!r.cached) bump('briefs', { lastBrief: { topic: topic.label, at: new Date().toISOString() } });
    return { ...publicResult(r), id };
  }

  async function status() {
    const entry = await store.peek(trendsCacheKey('global'));
    const t = entry?.value;
    return {
      model: config.model,
      radar: t ? { generatedAt: t.generatedAt, signalCount: t.signalCount, topics: t.topics.length, feedCounts: t.feedCounts || null, stale: entry.expires <= Date.now() } : null,
      today: { briefs: stats.briefs, tldrs: stats.tldrs, scamChecks: stats.scamChecks, flagged: stats.flagged, lastBrief: stats.lastBrief, lastScamAt: stats.lastScamAt },
      feeds: ['Google Trends', 'Google News', 'Hacker News', 'GitHub'],
    };
  }

  async function route(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p.startsWith('/api/')) {
      // CSRF guard: a browser POST from another site carries a foreign Origin.
      if (req.method === 'POST' && req.headers.origin) {
        let sameHost = false;
        try {
          sameHost = new URL(req.headers.origin).host === req.headers.host;
        } catch {
          /* malformed origin */
        }
        if (!sameHost) throw new HttpError(403, 'Cross-site requests are not allowed.');
      }
      if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && p === '/api/status') return send(res, 200, await status());
      if (req.method === 'GET' && p === '/api/topics') return send(res, 200, WEB_TOPICS.map(({ id, label }) => ({ id, label })));
      if (req.method === 'GET' && p === '/api/trends') return send(res, 200, await trends(req, url));
      if (req.method === 'GET' && p.startsWith('/api/brief/')) return send(res, 200, await brief(req, decodeURIComponent(p.slice(11))));
      if (req.method === 'POST' && p === '/api/tldr') {
        const body = await readJson(req);
        rateLimit(req);
        const r = await getTldr({ url: String(body.url || ''), ...deps });
        bump('tldrs');
        return send(res, 200, publicResult(r));
      }
      if (req.method === 'POST' && p === '/api/scam') {
        const body = await readJson(req);
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
        return send(res, 200, publicResult(r));
      }
      throw new HttpError(404, 'Not found.');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');

    if (PAGES[p]) return send(res, 200, pages[PAGES[p]], { 'Cache-Control': 'no-cache' });

    // Static files from web/public (no directory traversal).
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (file.startsWith(PUBLIC_DIR + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const rel = path.relative(PUBLIC_DIR, file).split(path.sep).join('/');
      const etag = `"${versions[rel] || fs.statSync(file).mtimeMs.toString(36)}"`;
      // Versioned URLs never change content → cache for a year. Plain URLs → always revalidate.
      const cache = url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      const headers = { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': cache, ETag: etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      if (rel.endsWith('.js')) return res.end(versionImports(fs.readFileSync(file, 'utf8'), path.posix.dirname(rel), versions));
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, pages['404']);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    // Access log without any user content.
    if (log) res.on('finish', () => console.log(`${req.method} ${url?.pathname || req.url} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      url = new URL(req.url, 'http://localhost');
      await route(req, res, url);
    } catch (e) {
      const err = toHttpError(e);
      const headers = err.extra.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
      if (!res.headersSent) {
        if (url?.pathname.startsWith('/api/')) send(res, err.status, { error: err.message, ...(err.extra.code ? { code: err.extra.code } : {}) }, headers);
        else send(res, err.status, err.message);
      } else res.end();
      if (log && err.status >= 500) console.error(`[titen] ${req.method} ${url?.pathname} → ${err.status} (${e.code || e.message})`);
    }
  });

  return { server, cache: store, warm: () => getTrends({ region: 'global', ...deps }).catch((e) => console.error('[titen] warm-up failed:', e.message)) };
}

// Run directly: node web/server.js [--open]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const app = createApp();
  app.server.listen(port, host, async () => {
    const url = `http://localhost:${port}`;
    console.log(`Titen web is running at ${url}`);
    if (!getConfig().apiKey) console.log('Warning: no OpenRouter API key (set OPENROUTER_API_KEY or run titen setup).');
    if (process.argv.includes('--open')) {
      const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      if (fs.existsSync(chrome)) (await import('node:child_process')).spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref();
    }
    if (process.env.WARM_TRENDS !== '0') app.warm();
  });
  app.server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Titen already running? Open http://localhost:${port}` : e.message);
    process.exit(1);
  });
}
