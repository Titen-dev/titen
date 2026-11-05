// Titen website on Node.js: pages + static files here, the /api/* logic lives in web/api.js
// (shared with the Cloudflare Worker in worker/index.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../core/config.js';
import { createCache } from '../core/cache.js';
import * as realSources from '../core/sources/index.js';
import { createApi, createRateLimiter, securityHeaders, HttpError, PAGES, MAX_BODY, WEB_REGIONS } from './api.js';

export { createRateLimiter, WEB_REGIONS };

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const VIEWS_DIR = path.join(WEB_DIR, 'views');

export const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = securityHeaders(process.env.FRAME_ANCESTORS);

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

/** ES module imports inside our JS ("./app.js") get the same version stamp. */
export const versionImports = (js, dir, versions) =>
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

// ---------- helpers ----------

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

// ---------- app ----------

export function createApp({ config = getConfig(), sources = realSources, cache, trustProxy = process.env.TRUST_PROXY === '1', limiter, log = true } = {}) {
  const store = cache || createCache(config.cacheDir);
  const versions = assetVersions();
  const pages = renderPages(versions);
  const api = createApi({
    config,
    sources,
    cache: store,
    limiter: limiter || createRateLimiter(),
    onError: (req, err, e) => log && console.error(`[titen] ${req.method} ${req.path} → ${err.status} (${e.code || e.message})`),
  });

  async function route(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p.startsWith('/api/')) {
      const r = await api.handle({
        method: req.method,
        path: p,
        searchParams: url.searchParams,
        origin: req.headers.origin,
        host: req.headers.host,
        ip: clientIp(req, trustProxy),
        readJson: () => readJson(req),
      });
      return send(res, r.status, r.body, r.headers);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.');

    if (PAGES[p]) return send(res, 200, pages[PAGES[p]], { 'Cache-Control': 'no-cache' });

    // Static files from web/public (no directory traversal).
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (file.startsWith(PUBLIC_DIR + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const rel = path.relative(PUBLIC_DIR, file).split(path.sep).join('/');
      const etag = `"${versions[rel] || fs.statSync(file).mtimeMs.toString(36)}"`;
      // Versioned URLs never change content → cache for a year. Plain URLs → always revalidate.
      const cacheControl = url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      const headers = { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': cacheControl, ETag: etag };
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
      if (!res.headersSent) send(res, 500, 'Something went wrong on our side.');
      else res.end();
      if (log) console.error(`[titen] ${req.method} ${url?.pathname} → 500 (${e.message})`);
    }
  });

  return { server, cache: store, warm: () => api.warm().catch((e) => console.error('[titen] warm-up failed:', e.message)) };
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
