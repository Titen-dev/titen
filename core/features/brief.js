import { chatJSON } from '../llm.js';
import { getConfig } from '../config.js';
import { createCache, msUntilUtcMidnight, utcDate } from '../cache.js';
import { Usage } from '../usage.js';
import { TitenError, ErrorCodes } from '../errors.js';
import * as realSources from '../sources/index.js';
import { numberSources, resolveSourceIds, UNTRUSTED_NOTE, str, arr, requireFields } from './common.js';

// Fixed topic list for the website (shared cache per topic per day).
export const WEB_TOPICS = [
  { id: 'ai', label: 'AI', query: 'artificial intelligence' },
  { id: 'tech', label: 'Tech', query: 'technology' },
  { id: 'startups', label: 'Startups', query: 'startup funding' },
  { id: 'crypto', label: 'Crypto', query: 'cryptocurrency bitcoin' },
  { id: 'business', label: 'Business', query: 'business' },
  { id: 'markets', label: 'Markets', query: 'stock market' },
  { id: 'science', label: 'Science', query: 'science research' },
  { id: 'space', label: 'Space', query: 'space exploration NASA SpaceX' },
  { id: 'health', label: 'Health', query: 'health medicine' },
  { id: 'climate', label: 'Climate', query: 'climate change' },
  { id: 'world', label: 'World politics', query: 'world politics' },
  { id: 'football', label: 'Football', query: 'football soccer' },
  { id: 'basketball', label: 'Basketball', query: 'NBA basketball' },
  { id: 'f1', label: 'F1', query: 'Formula 1' },
  { id: 'gaming', label: 'Gaming', query: 'video games' },
  { id: 'movies', label: 'Movies & TV', query: 'movies TV series' },
  { id: 'music', label: 'Music', query: 'music' },
  { id: 'security', label: 'Cybersecurity', query: 'cybersecurity' },
  { id: 'programming', label: 'Programming', query: 'programming software development' },
  { id: 'ev', label: 'Electric vehicles', query: 'electric vehicles' },
];

export const briefCacheKey = (query) => `brief:v1:${normalizeTopic(query)}:${utcDate()}`;

export function normalizeTopic(topic) {
  return String(topic || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function makeValidator(sources) {
  return (obj) => {
    requireFields(obj, ['headline', 'bullets']);
    const bullets = arr(obj.bullets)
      .map((b) => ({ text: str(b.text, 400), sources: resolveSourceIds(b.sourceIds, sources, 3) }))
      .filter((b) => b.text && b.sources.length);
    if (bullets.length < 2) throw new Error('need at least 2 bullets, each with valid sourceIds');
    return { headline: str(obj.headline, 160), bullets: bullets.slice(0, 7), outlook: str(obj.outlook, 300) };
  };
}

async function generate(topic, label, topicId, { usage, signal, config, sources }) {
  let items = (await sources.searchNews(topic, { region: 'us', when: '2d', limit: 20, signal, topicId }).catch(() => [])).map((n) => ({
    title: n.title,
    url: n.url,
    source: n.source,
    meta: `${n.source}${n.publishedAt ? `, ${n.publishedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
  }));

  // Thin news day or niche topic: one paid web search to fill the gap.
  if (items.length < 4) {
    const web = await sources.webSearch(`${topic} latest news this week`, { usage, signal, config }).catch(() => null);
    if (web) items = items.concat(web.sources.map((s) => ({ title: s.title, url: s.url, source: new URL(s.url).hostname, meta: s.snippet })));
  }
  if (items.length < 2) throw new TitenError(ErrorCodes.FETCH_FAILED, `Not enough recent news found for "${label}". Try a broader topic.`);

  const numbered = numberSources(items);
  const list = numbered.map((s) => `${s.id} ${s.title} (${s.meta})`).join('\n');
  const body = await chatJSON({
    config,
    usage,
    signal,
    maxTokens: 1500,
    temperature: 0.2,
    system: `You are Titen's Daily Brief writer. Summarize the last ~48 hours of news on one topic for a busy global reader.
- headline: the single most important development, as a short sentence.
- bullets: 3-6 distinct developments, most important first, each 1-2 sentences, concrete (names, numbers, dates) and neutral.
- Every bullet cites 1-3 sourceIds from the list. Only use ids that exist. Skip items that are off-topic or duplicates.
- outlook: one line on what to watch next (or "" if nothing clear).
${UNTRUSTED_NOTE}
JSON shape: {"headline":"...","bullets":[{"text":"...","sourceIds":["S1"]}],"outlook":"..."}`,
    user: `Topic: ${label}\nToday (UTC): ${utcDate()}\n<data>\n${list}\n</data>`,
    validate: makeValidator(numbered),
  });

  return { topic: label, date: utcDate(), generatedAt: new Date().toISOString(), ...body };
}

/**
 * Daily Brief for any topic (CLI) or a fixed topic id (web: pass topicId).
 * Cached per topic per UTC day.
 */
export async function getBrief({ topic, topicId, refresh = false, signal, config = getConfig(), cache, sources = realSources } = {}) {
  let query;
  let label;
  if (topicId) {
    const t = WEB_TOPICS.find((x) => x.id === topicId);
    if (!t) throw new TitenError(ErrorCodes.BAD_INPUT, `Unknown topic "${topicId}".`);
    query = t.query;
    label = t.label;
  } else {
    query = normalizeTopic(topic);
    label = String(topic || '').trim().slice(0, 80);
    if (query.length < 2) throw new TitenError(ErrorCodes.BAD_INPUT, 'Please give a topic, e.g. titen brief "electric cars".');
  }

  // Known topics (also typed in the CLI, e.g. "AI") get curated publisher feeds as a fallback source.
  const feedTopicId = topicId || WEB_TOPICS.find((t) => [t.id, t.label, t.query].map(normalizeTopic).includes(normalizeTopic(topic)))?.id;

  const usage = new Usage();
  const store = cache || createCache(config.cacheDir);
  const key = briefCacheKey(query);
  const { value, cached } = await store.getOrCreate(key, msUntilUtcMidnight(), () => generate(query, label, feedTopicId, { usage, signal, config, sources }), { refresh });
  return { ...value, cached, usage: usage.toJSON() };
}
