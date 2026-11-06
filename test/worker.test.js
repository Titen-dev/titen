import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorker } from '../scripts/build-worker.mjs';
import { startMockOpenRouter, fakeSources, systemText } from './helpers/mock.js';

// Run the Cloudflare Worker's fetch handler in Node with a fake env (KV, assets, secret).
let mock;
let worker;
let resetApp;
let createKvCache;
before(async () => {
  buildWorker();
  mock = await startMockOpenRouter((body) => {
    const sys = systemText(body);
    if (/Trend Radar/.test(sys)) return { content: JSON.stringify({ topics: [1, 2, 3].map((i) => ({ title: `T${i}`, category: 'World', summary: 's', whyItMatters: 'w', sourceIds: [`S${i}`] })) }) };
    return { content: JSON.stringify({ verdict: 'likely_scam', confidence: 90, summary: 'Prize scam.', redFlags: [], whatToDo: ['Ignore'] }) };
  });
  ({ default: worker, resetApp, createKvCache } = await import('../worker/index.js'));
});
after(() => mock.close());

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v.value) : v.value;
    },
    async put(k, value, opts) {
      map.set(k, { value, opts });
    },
  };
}

function env(extra = {}) {
  resetApp();
  return {
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: mock.url,
    TITEN_CACHE: fakeKv(),
    ASSETS: { fetch: async (req) => (new URL(req.url).pathname === '/assets/titen.css' ? new Response('body{}', { headers: { 'Content-Type': 'text/css' } }) : new Response('nope', { status: 404 })) },
    __sources: fakeSources(),
    ...extra,
  };
}

const ctx = () => {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p) };
};
const call = (e, path, init) => worker.fetch(new Request(`https://titen.example.workers.dev${path}`, init), e, ctx());

test('worker serves pre-rendered pages with security headers, assets and 404', async () => {
  const e = env();
  const home = await call(e, '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Every signal/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await call(e, '/scam')).status, 200);
  assert.equal((await call(e, '/assets/titen.css')).status, 200);
  const missing = await call(e, '/nope');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Nothing is here/);
  assert.equal((await call(e, '/', { method: 'POST' })).status, 405);
});

test('worker API: health, topics, trends cached in KV, scam check, guards', async () => {
  const e = env();
  assert.deepEqual(await (await call(e, '/api/health')).json(), { ok: true });
  assert.equal((await (await call(e, '/api/topics')).json()).length, 20);

  const t = await (await call(e, '/api/trends')).json();
  assert.equal(t.topics.length, 3);
  assert.equal(t.usage, undefined);
  assert.equal(e.TITEN_CACHE.map.size, 1, 'trends stored in KV');
  const [, entry] = [...e.TITEN_CACHE.map][0];
  assert.ok(entry.opts.expirationTtl >= 6 * 3600, 'kept longer than fresh so stale can be served');

  const scam = await call(e, '/api/scam', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://titen.example.workers.dev' }, body: JSON.stringify({ text: 'You won a prize' }) });
  assert.equal(scam.status, 200);
  assert.equal((await scam.json()).verdict, 'likely_scam');

  const csrf = await call(e, '/api/scam', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(csrf.status, 403);
  const notJson = await call(e, '/api/scam', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(notJson.status, 415);
});

test('worker without a key answers with the friendly resting message', async () => {
  const e = env({ OPENROUTER_API_KEY: '' });
  const r = await call(e, '/api/scam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'RESTING');
});

test('KV cache shortens very long keys', async () => {
  const kv = fakeKv();
  const cache = createKvCache(kv);
  await cache.set(`tldr:v1:https://example.com/${'x'.repeat(900)}`, { a: 1 }, 1000);
  const [key] = kv.map.keys();
  assert.ok(key.length < 512);
  assert.deepEqual(await cache.get(`tldr:v1:https://example.com/${'x'.repeat(900)}`), { a: 1 });
});

test('www redirects to the bare domain, keeping path and query', async () => {
  const e = env();
  const r = await worker.fetch(new Request('https://www.titenhq.com/brief?x=1'), e, ctx());
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://titenhq.com/brief?x=1');
});
