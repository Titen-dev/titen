import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeed, TOPIC_FEEDS } from '../core/sources/feeds.js';
import { WEB_TOPICS } from '../core/features/brief.js';

const fixture = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('parseFeed reads RSS 2.0 (CDATA, guid links, skips items without links)', () => {
  const items = parseFeed(fixture('rss.xml'), 'Pub');
  assert.deepEqual(items.map((i) => i.title), ['RSS story one', 'RSS story two']);
  assert.equal(items[0].url, 'https://rss.example/1');
  assert.equal(items[0].publishedAt, '2026-11-05T09:00:00.000Z');
  assert.equal(items[0].source, 'Pub');
  assert.equal(items[1].url, 'https://rss.example/2');
});

test('parseFeed reads Atom', () => {
  const items = parseFeed(fixture('atom.xml'), 'Atomic');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Atom & story one');
  assert.equal(items[0].url, 'https://atom.example/1');
  assert.equal(items[0].summary, 'First summary');
  assert.equal(items[1].publishedAt, '2026-11-04T10:00:00.000Z');
});

test('every web topic has at least two curated feeds', () => {
  for (const t of WEB_TOPICS) assert.ok((TOPIC_FEEDS[t.id] || []).length >= 2, `${t.id} needs feeds`);
});

test('readPage turns "blocked" HTTP answers into a friendly UNREADABLE error', async () => {
  const { readPage } = await import('../core/sources/fetchPage.js');
  // Simulate a publisher that refuses server-side readers.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('denied', { status: 403 });
  try {
    await assert.rejects(readPage('https://blocked.example/story'), (e) => e.code === 'UNREADABLE' && /doesn't allow automated readers/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});
