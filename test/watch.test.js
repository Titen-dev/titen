import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval, formatInterval, nextDelay, normalizeText, lineDiff, newItems, looksLikeUrl, hashText } from '../core/watch/text.js';
import { createWatcher } from '../core/watch/index.js';
import { startMockOpenRouter, testConfig, fakeSources, systemText, lastUserText, tmpDir } from './helpers/mock.js';

// ---------- unit ----------

test('parseInterval and formatInterval', () => {
  assert.equal(parseInterval('30m'), 30 * 60_000);
  assert.equal(parseInterval('6h'), 6 * 3_600_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.equal(parseInterval('1.5h'), 5_400_000);
  assert.equal(parseInterval(undefined), 6 * 3_600_000);
  assert.throws(() => parseInterval('5m'), { code: 'BAD_INPUT' });
  assert.throws(() => parseInterval('soon'), { code: 'BAD_INPUT' });
  assert.equal(formatInterval(6 * 3_600_000), '6h');
  assert.equal(formatInterval(90 * 60_000), '90m');
});

test('nextDelay backs off on failures, capped at a day', () => {
  const h = 3_600_000;
  assert.equal(nextDelay(h, 0), h);
  assert.equal(nextDelay(h, 1), 2 * h);
  assert.equal(nextDelay(h, 3), 8 * h);
  assert.equal(nextDelay(6 * h, 10), 24 * h);
});

test('normalizeText drops clocks, dates and counters but keeps real content', () => {
  const a = normalizeText('Price: $499\nUpdated 5 minutes ago\n12,345 views\nPosted 2026-11-05T10:00:00Z\nNov 5, 2026 · 10:42 AM');
  const b = normalizeText('Price: $499\nUpdated 2 hours ago\n12,999 views\nPosted 2026-11-06T11:00:00Z\nNov 6, 2026 · 9:01 PM');
  assert.equal(hashText(a), hashText(b));
  assert.match(a, /Price: \$499/);
  assert.notEqual(normalizeText('Price: $499'), normalizeText('Price: $449'));
});

test('lineDiff lists added and removed lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd\ne');
  assert.deepEqual(d.added, ['d', 'e']);
  assert.deepEqual(d.removed, ['b']);
  assert.equal(d.addedCount, 2);
});

test('newItems tracks seen headlines', () => {
  const first = newItems([{ title: 'One!' }, { title: 'Two' }]);
  assert.equal(first.fresh.length, 2);
  const second = newItems([{ title: 'one' }, { title: 'Three' }], first.seen);
  assert.deepEqual(second.fresh.map((x) => x.title), ['Three']);
  assert.equal(newItems([{ title: 'x' }], Array.from({ length: 600 }, (_, i) => `k${i}`)).seen.length, 500);
});

test('looksLikeUrl separates links from topics', () => {
  assert.equal(looksLikeUrl('example.com/a'), true);
  assert.equal(looksLikeUrl('https://store.example.com/p/1?x=2'), true);
  assert.equal(looksLikeUrl('GTA 6 release'), false);
  assert.equal(looksLikeUrl('AI'), false);
});

// ---------- integration ----------

let mode = { page: 'meaningful', topic: [1] };
let llmCalls = 0;
let mock;
before(async () => {
  mock = await startMockOpenRouter((body) => {
    llmCalls++;
    const sys = systemText(body);
    if (/watch a web page/.test(sys)) {
      assert.match(lastUserText(body), /LINES ADDED/);
      return { content: JSON.stringify(mode.page === 'meaningful' ? { meaningful: true, summary: 'The price dropped from $499 to $449.' } : { meaningful: false, summary: '' }) };
    }
    return { content: JSON.stringify({ relevant: mode.topic, summary: mode.topic.length ? 'Rockstar confirmed a new trailer date.' : '' }) };
  });
});
after(() => mock.close());

function setup(extra = {}) {
  let clock = Date.parse('2026-11-05T00:00:00Z');
  const page = { text: 'Super Phone\nPrice: $499\nIn stock\nUpdated 3 minutes ago' };
  let news = [{ title: 'GTA 6 pre-load date', url: 'https://n.example/1', source: 'A' }];
  const notes = [];
  const sources = fakeSources({
    readPage: async (url) => ({ url, title: 'Super Phone · Shop', text: page.text, words: 50 }),
    searchNews: async () => news,
    ...extra,
  });
  const w = createWatcher({
    home: tmpDir(),
    config: testConfig(mock.url),
    sources,
    now: () => clock,
    notify: async (n) => {
      notes.push(n);
      return true;
    },
  });
  return { w, page, notes, setNews: (n) => (news = n), tick: (ms) => (clock += ms) };
}

test('page watch: baseline, ignores noise without AI, notifies on a real change', async () => {
  const { w, page, notes, tick } = setup();
  const watch = w.add({ target: 'https://shop.example.com/phone', every: '1h', note: 'price' });
  assert.equal(watch.type, 'page');

  llmCalls = 0;
  let [r] = await w.runDue();
  assert.equal(r.result.baseline, true);
  assert.equal(llmCalls, 0);

  // Not due yet.
  assert.equal((await w.runDue()).length, 0);

  // Only the "minutes ago" changed → no AI call, no notification.
  tick(3_600_000);
  page.text = 'Super Phone\nPrice: $499\nIn stock\nUpdated 1 hour ago';
  [r] = await w.runDue();
  assert.equal(r.result.changed, false);
  assert.equal(llmCalls, 0);

  // Real change → AI judges it meaningful → notification + log.
  tick(3_600_000);
  page.text = 'Super Phone\nPrice: $449\nIn stock\nUpdated just now';
  mode.page = 'meaningful';
  [r] = await w.runDue();
  assert.equal(r.result.meaningful, true);
  assert.equal(llmCalls, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Super Phone/);
  assert.match(notes[0].message, /\$449/);
  assert.equal(w.log()[0].summary, 'The price dropped from $499 to $449.');
  assert.ok(w.list()[0].lastChangeAt);

  // A change the AI calls trivial → no notification.
  tick(3_600_000);
  page.text = 'Super Phone\nPrice: $449\nIn stock\nNew banner: free shipping';
  mode.page = 'trivial';
  [r] = await w.runDue();
  assert.equal(r.result.changed, true);
  assert.equal(r.result.meaningful, false);
  assert.equal(notes.length, 1);
});

test('topic watch: only new, relevant headlines notify', async () => {
  const { w, notes, setNews, tick } = setup();
  w.add({ target: 'GTA 6', every: '30m' });
  let [r] = await w.runDue();
  assert.equal(r.result.baseline, true);

  tick(30 * 60_000);
  [r] = await w.runDue();
  assert.equal(r.result.changed, false, 'same headlines are not news');

  tick(30 * 60_000);
  setNews([{ title: 'GTA 6 pre-load date', url: 'https://n.example/1' }, { title: 'GTA 6 trailer 3 date confirmed', url: 'https://n.example/2', source: 'B' }]);
  mode.topic = [1];
  [r] = await w.runDue();
  assert.equal(r.result.meaningful, true);
  assert.equal(notes.length, 1);
  assert.equal(w.log()[0].items[0].url, 'https://n.example/2');

  tick(30 * 60_000);
  setNews([{ title: 'Top 10 GTA memes', url: 'https://n.example/3' }]);
  mode.topic = [];
  [r] = await w.runDue();
  assert.equal(r.result.meaningful, false);
  assert.equal(notes.length, 1);
});

test('failures are recorded and retried later with backoff', async () => {
  const { w, tick } = setup({ readPage: async () => { throw new Error('site down'); } });
  w.add({ target: 'https://down.example.com', every: '1h' });
  const [r] = await w.runDue();
  assert.match(r.error.message, /site down/);
  const saved = w.list()[0];
  assert.equal(saved.failures, 1);
  assert.equal(saved.lastError, 'site down');
  tick(3_600_000);
  assert.equal((await w.runDue()).length, 0, 'waits 2h after one failure');
  tick(3_600_000);
  assert.equal((await w.runDue()).length, 1);
});

test('add validates input; remove and list work', () => {
  const { w } = setup();
  assert.throws(() => w.add({ target: 'http://192.168.1.1/admin' }), { code: 'BLOCKED_HOST' });
  assert.throws(() => w.add({ target: 'https://x.com/someone' }), { code: 'UNREADABLE' });
  assert.throws(() => w.add({ target: '' }), { code: 'BAD_INPUT' });
  assert.throws(() => w.add({ target: 'AI', every: '1m' }), { code: 'BAD_INPUT' });
  const a = w.add({ target: 'AI regulation' });
  assert.throws(() => w.add({ target: 'ai regulation' }), /already watching/);
  w.add({ target: 'example.com' });
  assert.equal(w.list().length, 2);
  w.remove(a.id);
  assert.deepEqual(w.list().map((x) => x.target), ['https://example.com/']);
  assert.throws(() => w.remove('99'), { code: 'BAD_INPUT' });
});

test('daemon stops cleanly on abort', async () => {
  const { w } = setup();
  w.add({ target: 'AI' });
  const controller = new AbortController();
  const seen = [];
  const done = w.daemon({ signal: controller.signal, tickMs: 50, onResult: (r) => seen.push(r) });
  await new Promise((r) => setTimeout(r, 120));
  controller.abort();
  await done;
  assert.equal(seen.length, 1); // baseline once; not due again within the hour
});
