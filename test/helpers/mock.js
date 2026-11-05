import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Local stand-in for OpenRouter. `handler(body, req)` returns either a message object
 * ({ content, tool_calls, annotations }) or { status, error } to simulate failures.
 */
export async function startMockOpenRouter(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body, headers: req.headers });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/key')) {
        if (req.headers.authorization === 'Bearer good-key') return send(200, { data: { label: 'test', limit: 10, usage: 2.5 } });
        return send(401, { error: { message: 'No auth credentials found', code: 401 } });
      }
      try {
        const out = await handler(body, req);
        if (out?.status) return send(out.status, { error: { message: out.error || 'error', code: out.status } });
        send(200, {
          choices: [{ message: { role: 'assistant', content: out.content ?? '', ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}), ...(out.annotations ? { annotations: out.annotations } : {}) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
        });
      } catch (e) {
        send(500, { error: { message: e.message } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

export function tmpDir(prefix = 'titen-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(baseUrl, extra = {}) {
  return { apiKey: 'test-key', model: 'test/model', baseUrl, searchEngine: 'exa', cacheDir: tmpDir(), ...extra };
}

/** Fake data sources (no network). `calls` records what features asked for. */
export function fakeSources(overrides = {}) {
  const calls = { domainAge: [], webSearch: [], readPage: [] };
  return {
    calls,
    trendingSearches: async (geo) => [{ query: `trend-${geo}`, traffic: '100K+', news: [{ title: `Story in ${geo}`, url: `https://news.example/${geo}`, source: 'Example News' }] }],
    topStories: async ({ region }) => Array.from({ length: 12 }, (_, i) => ({ title: `Top ${region} ${i}`, url: `https://top.example/${region}/${i}`, source: 'Wire' })),
    hnTopStories: async () => [{ title: 'Show HN: thing', url: 'https://hn.example/1', points: 300, comments: 80 }],
    githubTrending: async () => [{ repo: 'acme/rocket', url: 'https://github.com/acme/rocket', description: 'fast', language: 'Rust', starsToday: 900 }],
    searchNews: async (q) => Array.from({ length: 6 }, (_, i) => ({ title: `${q} news ${i}`, url: `https://n.example/${i}`, source: 'Paper', publishedAt: '2026-11-05T01:00:00.000Z' })),
    readPage: async (url) => {
      calls.readPage.push(url);
      return { url, title: 'An article', text: 'word '.repeat(460), words: 460 };
    },
    domainAge: async (d) => {
      calls.domainAge.push(d);
      return d.endsWith('.top') ? { ageDays: 3, registeredAt: '2026-11-02T00:00:00.000Z', found: true } : { ageDays: 4000, registeredAt: '2015-01-01T00:00:00.000Z', found: true };
    },
    webSearch: async (q) => {
      calls.webSearch.push(q);
      return { query: q, summary: 'Several reports call this a scam.', sources: [{ title: 'Report', url: 'https://reports.example/1', snippet: '' }] };
    },
    ...overrides,
  };
}

export const toolCall =(id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

export const lastUserText = (body) => {
  const m = [...body.messages].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
};

export const systemText = (body) => body.messages.find((m) => m.role === 'system')?.content || '';
