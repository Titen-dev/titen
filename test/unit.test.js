import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeEntities, htmlToText, countWords } from '../core/text.js';
import { isPrivateHost, normalizeUrl, parsePublicUrl } from '../core/http.js';
import { extractUrls, extractPhones, registrableDomain, detectImpersonation, analyzeUrl } from '../core/domains.js';
import { createCache, msUntilUtcMidnight } from '../core/cache.js';
import { extractJSON } from '../core/llm.js';
import { parseNewsRss } from '../core/sources/googleNews.js';
import { parseTrendsRss } from '../core/sources/googleTrends.js';
import { parseGithubTrending } from '../core/sources/githubTrending.js';
import { isUnreadableSite } from '../core/sources/fetchPage.js';
import { numberSources, resolveSourceIds } from '../core/features/common.js';
import { calculate } from '../core/agent.js';
import { validateImageDataUrl } from '../core/features/scam.js';
import { tmpDir } from './helpers/mock.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('decodeEntities handles named, numeric and CDATA', () => {
  assert.equal(decodeEntities('A &amp; B &#39;x&#39; &#x263A; <![CDATA[raw]]>'), "A & B 'x' ☺ raw");
});

test('htmlToText drops scripts/nav and prefers <article>', () => {
  const html = '<html><head><title>T &amp; t</title></head><body><nav>menu</nav><article><h1>Head</h1><p>Hello <b>world</b></p><script>bad()</script></article><footer>foot</footer></body></html>';
  const { title, text } = htmlToText(html);
  assert.equal(title, 'T & t');
  assert.match(text, /Head\nHello world/);
  assert.doesNotMatch(text, /menu|bad\(\)|foot/);
  assert.equal(countWords(text), 3);
});

test('isPrivateHost blocks local and private ranges', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.1.1', '169.254.169.254', '[::1]', 'printer.local', '100.64.0.1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'news.ycombinator.com']) assert.equal(isPrivateHost(h), false, h);
});

test('parsePublicUrl adds https and rejects bad input', () => {
  assert.equal(parsePublicUrl('example.com/a').toString(), 'https://example.com/a');
  assert.throws(() => parsePublicUrl('ftp://x.com'), { code: 'BAD_INPUT' });
  assert.throws(() => parsePublicUrl('http://127.0.0.1:3000'), { code: 'BLOCKED_HOST' });
  assert.throws(() => parsePublicUrl(''), { code: 'BAD_INPUT' });
});

test('normalizeUrl strips tracking, www, hash and trailing slash', () => {
  assert.equal(normalizeUrl('https://www.Example.com/path/?utm_source=x&b=2&a=1#top'), 'https://example.com/path/?a=1&b=2');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/x/'), 'https://example.com/x');
});

test('extractUrls finds links and bare domains but not emails or file names', () => {
  const urls = extractUrls('Pay at dhl-redelivery.top/pay now! Or https://bit.ly/abc. Mail me at a@b.com, see photo.png');
  assert.deepEqual(urls, ['https://dhl-redelivery.top/pay', 'https://bit.ly/abc']);
});

test('extractPhones finds international numbers', () => {
  assert.deepEqual(extractPhones('Call +1 (555) 123-4567 or 0812 3456 7890 today'), ['+15551234567', '081234567890']);
});

test('registrableDomain handles multi-part suffixes', () => {
  assert.equal(registrableDomain('login.secure.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.shop.tokopedia.com'), 'tokopedia.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
});

test('detectImpersonation catches look-alikes without false alarms', () => {
  assert.equal(detectImpersonation('paypa1.com')?.brand, 'paypal');
  assert.equal(detectImpersonation('paypal-login-secure.com')?.brand, 'paypal');
  assert.equal(detectImpersonation('amaz0n.co')?.brand, 'amazon');
  assert.equal(detectImpersonation('netflixsupport.com')?.brand, 'netflix');
  assert.equal(detectImpersonation('dhl-delivery.top')?.brand, 'dhl');
  assert.equal(detectImpersonation('paypal.com.verify-account.xyz')?.brand, 'paypal');
  assert.equal(detectImpersonation('www.paypal.com'), null);
  assert.equal(detectImpersonation('applebees.com'), null);
  assert.equal(detectImpersonation('groups.google.com'), null);
  assert.equal(detectImpersonation('example.org'), null);
});

test('analyzeUrl lists offline red flags', () => {
  const a = analyzeUrl('http://paypa1-verify.xyz/login');
  assert.equal(a.domain, 'paypa1-verify.xyz');
  assert.ok(a.flags.some((f) => f.includes('.xyz')));
  assert.ok(a.flags.some((f) => f.includes('HTTPS')));
  assert.ok(a.flags.some((f) => f.includes('impersonation')));
  assert.ok(analyzeUrl('https://bit.ly/x').flags.some((f) => f.includes('shortener')));
  assert.deepEqual(analyzeUrl('https://www.wikipedia.org/').flags, []);
});

test('cache: TTL, refresh and single-flight', async () => {
  const cache = createCache(tmpDir());
  let calls = 0;
  const make = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { n: calls };
  };
  const [a, b] = await Promise.all([cache.getOrCreate('k', 10_000, make), cache.getOrCreate('k', 10_000, make)]);
  assert.equal(calls, 1);
  assert.deepEqual(a.value, b.value);
  const c = await cache.getOrCreate('k', 10_000, make);
  assert.equal(c.cached, true);
  const d = await cache.getOrCreate('k', 10_000, make, { refresh: true });
  assert.equal(d.cached, false);
  assert.equal(calls, 2);
  await cache.set('old', 1, -1);
  assert.equal(await cache.get('old'), undefined);
});

test('cache: a failed generation is not stored', async () => {
  const cache = createCache(tmpDir());
  await assert.rejects(cache.getOrCreate('x', 10_000, async () => { throw new Error('boom'); }));
  assert.equal(await cache.get('x'), undefined);
});

test('msUntilUtcMidnight is within a day', () => {
  const ms = msUntilUtcMidnight(new Date('2026-11-05T23:30:00Z'));
  assert.equal(ms, 30 * 60 * 1000);
});

test('extractJSON tolerates fences and chatter', () => {
  assert.deepEqual(extractJSON('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('here {"b":{"c":2}} done'), { b: { c: 2 } });
  assert.throws(() => extractJSON('no json'));
});

test('parseNewsRss reads Google News RSS', () => {
  const items = parseNewsRss(fixture('news.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Big AI lab releases new model');
  assert.equal(items[0].source, 'The Verge');
  assert.equal(items[1].title, 'Markets rally & oil falls');
  assert.equal(items[2].title, 'Storm hits coast');
  assert.equal(items[0].publishedAt, '2026-11-05T03:00:00.000Z');
});

test('parseTrendsRss reads Google Trends RSS', () => {
  const items = parseTrendsRss(fixture('trends.xml'));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    query: 'world cup draw',
    traffic: '500K+',
    news: [
      { title: 'World Cup draw: groups revealed', url: 'https://example.com/wc', source: 'ESPN' },
      { title: 'Second story', url: 'https://example.com/wc2', source: 'BBC' },
    ],
  });
  assert.deepEqual(items[1].news, []);
});

test('parseGithubTrending reads the trending page', () => {
  const repos = parseGithubTrending(fixture('github.html'));
  assert.equal(repos.length, 2);
  assert.deepEqual(repos[0], { repo: 'acme/rocket', url: 'https://github.com/acme/rocket', description: 'A fast & tiny rocket engine', language: 'Rust', starsToday: 1234 });
  assert.equal(repos[1].starsToday, 56);
});

test('isUnreadableSite', () => {
  assert.equal(isUnreadableSite('www.tiktok.com'), true);
  assert.equal(isUnreadableSite('mobile.twitter.com'), true);
  assert.equal(isUnreadableSite('example.com'), false);
});

test('source ids resolve only to real sources', () => {
  const src = numberSources([{ title: 'A', url: 'https://a' }, { title: 'B', url: 'https://b' }]);
  assert.deepEqual(resolveSourceIds(['s2', 'S9', 'S2', 'S1'], src), [{ title: 'B', url: 'https://b' }, { title: 'A', url: 'https://a' }]);
  assert.deepEqual(resolveSourceIds('S1', src), []);
});

test('calculate is exact and refuses code', () => {
  assert.equal(calculate('2^10 + sqrt(16)'), 1028);
  assert.equal(calculate('1e3 / 4'), 250);
  assert.throws(() => calculate('process.exit()'));
  assert.throws(() => calculate('constructor'));
});

test('validateImageDataUrl checks type and magic bytes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.match(validateImageDataUrl(`data:image/png;base64,${png.toString('base64')}`), /^data:image\/png;base64,/);
  assert.throws(() => validateImageDataUrl(`data:image/jpeg;base64,${png.toString('base64')}`), { code: 'BAD_INPUT' });
  assert.throws(() => validateImageDataUrl('data:text/html;base64,PGgxPg=='), { code: 'BAD_INPUT' });
});
