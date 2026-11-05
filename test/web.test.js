import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createRateLimiter, renderPages } from '../web/server.js';
import { createCache } from '../core/cache.js';
import { trendsCacheKey } from '../core/features/trends.js';
import { startMockOpenRouter, testConfig, fakeSources, systemText, tmpDir } from './helpers/mock.js';

const TOPICS_JSON = JSON.stringify({ topics: [1, 2, 3].map((i) => ({ title: `Topic ${i}`, category: 'World', summary: 's', whyItMatters: 'w', sourceIds: [`S${i}`] })) });
const BRIEF_JSON = JSON.stringify({ headline: 'H', bullets: [{ text: 'a', sourceIds: ['S1'] }, { text: 'b', sourceIds: ['S2'] }] });
const TLDR_JSON = JSON.stringify({ title: 'T', tldr: 'One line.', keyPoints: ['a', 'b'], caveats: [] });
const SCAM_JSON = JSON.stringify({ verdict: 'suspicious', confidence: 60, summary: 'Hmm.', redFlags: [], whatToDo: ['Verify'] });

let mode = 'ok';
let mock;
before(async () => {
  mock = await startMockOpenRouter((body) => {
    if (mode === 'broke') return { status: 402 };
    const sys = systemText(body);
    if (/Trend Radar/.test(sys)) return { content: TOPICS_JSON };
    if (/Daily Brief/.test(sys)) return { content: BRIEF_JSON };
    if (/TL;DR/.test(sys)) return { content: TLDR_JSON };
    return { content: SCAM_JSON };
  });
});
after(() => mock.close());

async function startApp(opts = {}) {
  const config = testConfig(mock.url);
  const cache = createCache(tmpDir());
  const app = createApp({ config, sources: fakeSources(), cache, log: false, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = (path, init = {}) => fetch(base + path, init);
  const post = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { app, cache, base, req, post, close: () => new Promise((r) => app.server.close(r)) };
}

test('pages render fully with nav state and security headers', async () => {
  const pages = renderPages();
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /\{\{/, `${name} has leftover template tags`);
    assert.match(html, /<title>[^<]+<\/title>/);
  }
  assert.match(pages.scam, /data-nav="scam" aria-current="page"/);
  const s = await startApp();
  try {
    const r = await s.req('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await s.req('/missing')).status, 404);
    assert.equal((await s.req('/assets/titen.css')).status, 200);
    assert.equal((await s.req('/assets/%2e%2e/%2e%2e/package.json')).status, 404);
  } finally {
    await s.close();
  }
});

test('FRAME_ANCESTORS allows one embedder (Hugging Face) and drops X-Frame-Options', async () => {
  const { execFile } = await import('node:child_process');
  const script = `
    const { createApp } = await import(${JSON.stringify(new URL('../web/server.js', import.meta.url).href)});
    const app = createApp({ log: false });
    app.server.listen(0, '127.0.0.1', async () => {
      const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/');
      console.log(JSON.stringify({ csp: r.headers.get('content-security-policy'), xfo: r.headers.get('x-frame-options') }));
      app.server.close();
    });`;
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FRAME_ANCESTORS: 'https://huggingface.co', OPENROUTER_API_KEY: 'x' } }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))))
  );
  assert.match(out.csp, /frame-ancestors https:\/\/huggingface\.co/);
  assert.equal(out.xfo, null);
});

test('assets are versioned so browsers never use stale CSS/JS', async () => {
  const pages = renderPages();
  assert.match(pages.index, /href="\/assets\/titen\.css\?v=[0-9a-f]{10}"/);
  assert.match(pages.index, /src="\/assets\/home\.js\?v=[0-9a-f]{10}"/);
  assert.match(pages.index, /href="\/favicon\.svg\?v=[0-9a-f]{10}"/);
  const s = await startApp();
  try {
    const css = pages.index.match(/\/assets\/titen\.css\?v=[0-9a-f]+/)[0];
    const r = await s.req(css);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /immutable/);
    const plain = await s.req('/assets/titen.css');
    assert.equal(plain.headers.get('cache-control'), 'no-cache');
    const again = await s.req('/assets/titen.css', { headers: { 'If-None-Match': plain.headers.get('etag') } });
    assert.equal(again.status, 304);
    const homeJs = await (await s.req('/assets/home.js')).text();
    assert.match(homeJs, /from '\.\/app\.js\?v=[0-9a-f]{10}'/);
  } finally {
    await s.close();
  }
});

test('trends: generates, caches, serves stale instantly and refreshes in the background', async () => {
  const s = await startApp();
  try {
    const first = await (await s.req('/api/trends')).json();
    assert.equal(first.topics.length, 3);
    assert.equal(first.usage, undefined, 'cost info must not be public');
    const second = await (await s.req('/api/trends')).json();
    assert.equal(second.cached, true);

    await s.cache.set(trendsCacheKey('global'), { ...first, topics: first.topics.slice(0, 1) }, -1000); // expired
    const stale = await (await s.req('/api/trends')).json();
    assert.equal(stale.stale, true);
    assert.equal(stale.topics.length, 1);
    await new Promise((r) => setTimeout(r, 150));
    const fresh = await (await s.req('/api/trends')).json();
    assert.equal(fresh.topics.length, 3);
    assert.equal((await s.req('/api/trends?region=mars')).status, 400);
  } finally {
    await s.close();
  }
});

test('topics, briefs and status', async () => {
  const s = await startApp();
  try {
    const topics = await (await s.req('/api/topics')).json();
    assert.equal(topics.length, 20);
    assert.deepEqual(Object.keys(topics[0]), ['id', 'label']);
    const b = await (await s.req('/api/brief/ai')).json();
    assert.equal(b.headline, 'H');
    assert.equal(b.id, 'ai');
    assert.equal((await (await s.req('/api/brief/ai')).json()).cached, true);
    assert.equal((await s.req('/api/brief/nope')).status, 404);
    const st = await (await s.req('/api/status')).json();
    assert.equal(st.today.briefs, 1);
  } finally {
    await s.close();
  }
});

test('tldr and scam endpoints, including a screenshot', async () => {
  const s = await startApp({ limiter: createRateLimiter({ capacity: 10 }) });
  try {
    const t = await s.post('/api/tldr', { url: 'https://example.com/a' });
    assert.equal(t.status, 200);
    assert.equal((await t.json()).tldr, 'One line.');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const sc = await s.post('/api/scam', { text: '', url: '', imageDataUrl: `data:image/png;base64,${png}` });
    assert.equal(sc.status, 200);
    const body = await sc.json();
    assert.equal(body.verdict, 'suspicious');
    assert.equal(body.usage, undefined);
    assert.equal((await s.post('/api/scam', {})).status, 400);
    assert.equal((await s.post('/api/tldr', { url: 'http://10.0.0.1/' })).status, 400);
  } finally {
    await s.close();
  }
});

test('CSRF guard, JSON only, body size limit', async () => {
  const s = await startApp();
  try {
    assert.equal((await s.post('/api/tldr', { url: 'https://example.com' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.req('/api/tldr', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const big = JSON.stringify({ text: 'x'.repeat(8_000_000) });
    const r = await s.post('/api/scam', big).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
  } finally {
    await s.close();
  }
});

test('rate limit answers 429 with Retry-After', async () => {
  const s = await startApp({ limiter: createRateLimiter({ capacity: 1, refillMs: 60_000 }) });
  try {
    assert.equal((await s.post('/api/tldr', { url: 'https://example.com/1' })).status, 200);
    const r = await s.post('/api/tldr', { url: 'https://example.com/2' });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally {
    await s.close();
  }
});

test('out of credit shows a friendly resting message', async () => {
  const s = await startApp();
  mode = 'broke';
  try {
    const r = await s.post('/api/scam', { text: 'hello there' });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, 'RESTING');
    assert.match(body.error, /resting/);
  } finally {
    mode = 'ok';
    await s.close();
  }
});
