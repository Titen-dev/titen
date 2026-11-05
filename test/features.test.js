import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTrends } from '../core/features/trends.js';
import { getBrief, WEB_TOPICS } from '../core/features/brief.js';
import { getTldr } from '../core/features/tldr.js';
import { checkScam } from '../core/features/scam.js';
import { ChatAgent } from '../core/agent.js';
import { chat, chatJSON, checkKey } from '../core/llm.js';
import { webSearch } from '../core/sources/webSearch.js';
import { Usage } from '../core/usage.js';
import { TitenError } from '../core/errors.js';
import { startMockOpenRouter, testConfig, toolCall, lastUserText, systemText, fakeSources } from './helpers/mock.js';

// The handler is swapped per test.
let handler = () => ({ content: '{}' });
let mock;
before(async () => {
  mock = await startMockOpenRouter((body, req) => handler(body, req));
});
after(() => mock.close());

const cfg = (extra) => testConfig(mock.url, extra);

// ---------- llm layer ----------

test('chat maps 401 and 402 to clear errors', async () => {
  handler = () => ({ status: 401, error: 'bad key' });
  await assert.rejects(chat({ config: cfg(), messages: [] }), (e) => e instanceof TitenError && e.code === 'BAD_KEY');
  handler = () => ({ status: 402, error: 'no money' });
  await assert.rejects(chat({ config: cfg(), messages: [] }), (e) => e.code === 'NO_CREDIT');
});

test('chat without a key fails before any request', async () => {
  const before = mock.requests.length;
  await assert.rejects(chat({ config: cfg({ apiKey: '' }), messages: [] }), (e) => e.code === 'NO_KEY');
  assert.equal(mock.requests.length, before);
});

test('chat sends model, auth and asks for usage; usage is summed', async () => {
  handler = () => ({ content: 'hi' });
  const usage = new Usage();
  await chat({ config: cfg(), messages: [{ role: 'user', content: 'x' }], usage });
  const req = mock.requests.at(-1);
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'test/model');
  assert.deepEqual(req.body.usage, { include: true });
  assert.equal(usage.toJSON().cost, 0.0001);
});

test('chatJSON retries once on bad JSON, then succeeds', async () => {
  let n = 0;
  handler = () => ({ content: n++ === 0 ? 'oops not json' : '{"ok":true}' });
  const out = await chatJSON({ config: cfg(), system: 's', user: 'u' });
  assert.deepEqual(out, { ok: true });
  assert.equal(n, 2);
});

test('chatJSON gives BAD_OUTPUT after two bad replies', async () => {
  handler = () => ({ content: 'still not json' });
  await assert.rejects(chatJSON({ config: cfg(), system: 's', user: 'u' }), (e) => e.code === 'BAD_OUTPUT');
});

test('checkKey reports key info or BAD_KEY', async () => {
  assert.equal((await checkKey('good-key', cfg())).label, 'test');
  await assert.rejects(checkKey('nope', cfg()), (e) => e.code === 'BAD_KEY');
});

test('webSearch uses the web plugin and returns deduped citations', async () => {
  handler = (body) => {
    assert.deepEqual(body.plugins, [{ id: 'web', engine: 'exa', max_results: 5 }]);
    const cite = (url) => ({ type: 'url_citation', url_citation: { url, title: 'T', content: 'c' } });
    return { content: 'Summary.', annotations: [cite('https://a.example'), cite('https://a.example'), cite('https://b.example')] };
  };
  const usage = new Usage();
  const r = await webSearch('q', { config: cfg(), usage });
  assert.equal(r.summary, 'Summary.');
  assert.deepEqual(r.sources.map((s) => s.url), ['https://a.example', 'https://b.example']);
  assert.equal(usage.webSearches, 1);
});

// ---------- features ----------

test('trends: builds topics with real source links only, then serves from cache', async () => {
  let llmCalls = 0;
  handler = (body) => {
    llmCalls++;
    assert.match(lastUserText(body), /S1 \[search\/US\]/);
    return {
      content: JSON.stringify({
        topics: [
          { title: 'A', category: 'Tech', summary: 's', whyItMatters: 'w', momentum: 'hot', regions: ['us'], sourceIds: ['S1', 'S999'] },
          { title: 'B', category: 'Nope', summary: 's', whyItMatters: 'w', momentum: 'weird', sourceIds: ['S2'] },
          { title: 'C', category: 'AI', summary: 's', whyItMatters: 'w', sourceIds: ['S3'] },
          { title: 'D', category: 'AI', summary: 's', whyItMatters: 'w', sourceIds: [] },
        ],
      }),
    };
  };
  const config = cfg();
  const sources = fakeSources();
  const r = await getTrends({ region: 'global', config, sources });
  assert.equal(r.cached, false);
  assert.equal(r.topics.length, 3); // D dropped: no valid source
  assert.deepEqual(r.topics[0].sources, [{ title: 'trend-US — Story in US', url: 'https://news.example/US', source: 'Example News' }]);
  assert.equal(r.topics[1].category, 'Other');
  assert.equal(r.topics[1].momentum, 'hot');
  assert.deepEqual(r.topics[0].regions, ['US']);
  assert.ok(r.usage.cost > 0);

  const again = await getTrends({ region: 'global', config, sources });
  assert.equal(again.cached, true);
  assert.equal(llmCalls, 1);
});

test('trends: survives a failing feed and rejects unknown regions', async () => {
  handler = () => ({ content: JSON.stringify({ topics: [1, 2, 3].map((i) => ({ title: `T${i}`, category: 'World', summary: 's', whyItMatters: 'w', sourceIds: [`S${i}`] })) }) });
  const sources = fakeSources({ githubTrending: async () => { throw new Error('down'); } });
  const r = await getTrends({ region: 'us', config: cfg(), sources });
  assert.deepEqual(r.unavailableSources, ['github']);
  await assert.rejects(getTrends({ region: 'mars', config: cfg(), sources }), (e) => e.code === 'BAD_INPUT');
});

test('brief: bullets cite resolved sources; fixed topic ids work', async () => {
  handler = (body) => {
    assert.match(lastUserText(body), /Topic: AI/);
    return { content: JSON.stringify({ headline: 'H', bullets: [{ text: 'one', sourceIds: ['S1'] }, { text: 'two', sourceIds: ['S2', 'S3'] }, { text: 'bad', sourceIds: ['S77'] }], outlook: 'next' }) };
  };
  const r = await getBrief({ topicId: 'ai', config: cfg(), sources: fakeSources() });
  assert.equal(r.topic, 'AI');
  assert.equal(r.bullets.length, 2);
  assert.equal(r.bullets[1].sources.length, 2);
  assert.equal(WEB_TOPICS.length, 20);
  await assert.rejects(getBrief({ topicId: 'nope', config: cfg() }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(getBrief({ topic: ' ', config: cfg() }), (e) => e.code === 'BAD_INPUT');
});

test('brief: thin news triggers exactly one web search', async () => {
  handler = () => ({ content: JSON.stringify({ headline: 'H', bullets: [{ text: 'a', sourceIds: ['S1'] }, { text: 'b', sourceIds: ['S2'] }] }) });
  const sources = fakeSources({ searchNews: async () => [{ title: 'only one', url: 'https://n.example/1', source: 'P' }] });
  await getBrief({ topic: 'tiny niche', config: cfg(), sources });
  assert.equal(sources.calls.webSearch.length, 1);
});

test('tldr: summarizes, caches by normalized URL, computes minutes saved', async () => {
  let n = 0;
  handler = () => {
    n++;
    return { content: JSON.stringify({ title: 'Clean title', tldr: 'One line.', keyPoints: ['a', 'b', 'c'], caveats: ['sponsored'] }) };
  };
  const config = cfg();
  const sources = fakeSources();
  const r = await getTldr({ url: 'https://www.example.com/post?utm_source=x', config, sources });
  assert.equal(r.tldr, 'One line.');
  assert.equal(r.readMinutesSaved, 2);
  assert.equal(sources.calls.readPage[0], 'https://www.example.com/post?utm_source=x'); // fetched as given
  const again = await getTldr({ url: 'https://example.com/post', config, sources });
  assert.equal(again.cached, true);
  assert.equal(n, 1);
});

test('tldr: unreadable pages fail clearly without calling the AI', async () => {
  const before = mock.requests.length;
  await assert.rejects(getTldr({ url: 'https://x.com/someone/status/1', config: cfg() }), (e) => e.code === 'UNREADABLE');
  await assert.rejects(getTldr({ url: 'http://192.168.1.1/admin', config: cfg() }), (e) => e.code === 'BLOCKED_HOST');
  assert.equal(mock.requests.length, before);
});

test('scam: pre-checks links, lets the model call tools once, returns calibrated verdict', async () => {
  let step = 0;
  handler = (body) => {
    step++;
    assert.match(systemText(body), /Scam Check/);
    if (step === 1) {
      const facts = lastUserText(body);
      assert.match(facts, /dhl-redelivery\.top/);
      assert.match(facts, /registered only 3 day/);
      return { tool_calls: [toolCall('c1', 'search_scam_reports', { query: 'dhl-redelivery.top' }), toolCall('c2', 'check_link', { url: 'paypa1.com' })] };
    }
    if (step === 2) return { tool_calls: [toolCall('c3', 'search_scam_reports', { query: 'again' })] };
    const toolMsgs = body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.some((t) => t.includes('Search already used once')));
    return { content: JSON.stringify({ verdict: 'likely_scam', confidence: 140, summary: 'Fake DHL fee.', redFlags: ['Brand new domain', { flag: 'Urgency', evidence: '"today"' }], whatToDo: ['Do not pay'] }) };
  };
  const sources = fakeSources();
  const r = await checkScam({ text: 'DHL: your parcel is held. Pay $1.99 today at dhl-redelivery.top/pay', config: cfg(), sources });
  assert.equal(r.verdict, 'likely_scam');
  assert.equal(r.confidence, 100);
  assert.deepEqual(r.redFlags[0], { flag: 'Brand new domain', evidence: '' });
  assert.equal(sources.calls.webSearch.length, 1);
  assert.deepEqual(r.checks.links.map((l) => l.domain), ['dhl-redelivery.top', 'paypa1.com']);
  assert.equal(r.checks.links[1].impersonates, 'paypal');
  assert.match(r.disclaimer, /can be wrong/);
});

test('scam: sends screenshots as an image part and validates input', async () => {
  handler = (body) => {
    const parts = body.messages[1].content;
    assert.ok(Array.isArray(parts));
    assert.equal(parts[1].type, 'image_url');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    return { content: '{"verdict":"suspicious","confidence":55,"summary":"Unclear.","redFlags":[],"whatToDo":["Verify"]}' };
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const r = await checkScam({ imageDataUrl: `data:image/png;base64,${png}`, config: cfg(), sources: fakeSources() });
  assert.equal(r.verdict, 'suspicious');
  await assert.rejects(checkScam({ config: cfg() }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(checkScam({ imagePath: 'nope.gif', config: cfg() }), (e) => e.code === 'BAD_INPUT');
});

test('scam: invalid verdict gets one fix attempt', async () => {
  let n = 0;
  handler = () => ({ content: n++ === 0 ? '{"verdict":"maybe","summary":"x"}' : '{"verdict":"looks_safe","confidence":70,"summary":"ok"}' });
  const r = await checkScam({ text: 'Hi, lunch tomorrow at 12?', config: cfg(), sources: fakeSources() });
  assert.equal(r.verdict, 'looks_safe');
  assert.equal(n, 2);
});

test('chat agent: runs tools in a loop and keeps history valid on failure', async () => {
  let step = 0;
  handler = (body) => {
    step++;
    if (step === 1) return { tool_calls: [toolCall('t1', 'calculator', { expression: '6*7' })] };
    const tool = body.messages.find((m) => m.role === 'tool');
    return { content: `The answer is ${tool.content}.` };
  };
  const agent = new ChatAgent({ config: cfg(), sources: fakeSources() });
  const events = [];
  const answer = await agent.send('what is 6*7?', { onEvent: (e) => events.push(e.type) });
  assert.equal(answer, 'The answer is 42.');
  assert.deepEqual(events, ['tool_start', 'tool_end']);
  assert.equal(agent.messages.length, 4);

  handler = () => ({ status: 402 });
  await assert.rejects(agent.send('again'), (e) => e.code === 'NO_CREDIT');
  assert.equal(agent.messages.length, 4); // failed turn rolled back
});
