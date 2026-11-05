import { chatJSON } from '../llm.js';
import { getConfig } from '../config.js';
import { createCache } from '../cache.js';
import { Usage } from '../usage.js';
import { TitenError, ErrorCodes } from '../errors.js';
import * as realSources from '../sources/index.js';
import { numberSources, resolveSourceIds, UNTRUSTED_NOTE, str, arr, requireFields, gather } from './common.js';

export const TREND_TTL_MS = 6 * 60 * 60 * 1000;
export const trendsCacheKey = (region) => `trends:v1:${region}`;

// Which country feeds make up each region. "global" mixes several.
export const REGIONS = {
  global: { trends: ['US', 'GB', 'IN', 'BR', 'DE', 'JP', 'ID', 'NG'], news: ['us', 'gb', 'in'] },
  us: { trends: ['US'], news: ['us'] },
  gb: { trends: ['GB'], news: ['gb'] },
  in: { trends: ['IN'], news: ['in'] },
  ca: { trends: ['CA'], news: ['ca'] },
  au: { trends: ['AU'], news: ['au'] },
  br: { trends: ['BR'], news: ['br'] },
  de: { trends: ['DE'], news: ['de'] },
  fr: { trends: ['FR'], news: ['fr'] },
  jp: { trends: ['JP'], news: ['jp'] },
  id: { trends: ['ID'], news: ['id'] },
  ng: { trends: ['NG'], news: ['ng'] },
  sg: { trends: ['SG'], news: ['sg'] },
};

export const CATEGORIES = ['Tech', 'AI', 'Business', 'Markets', 'Politics', 'World', 'Science', 'Health', 'Sports', 'Entertainment', 'Gaming', 'Culture', 'Other'];

function hostLabel(url, fallback) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return fallback;
  }
}

async function collectSignals(region, sources, signal) {
  const cfg = REGIONS[region];
  const tasks = {};
  for (const geo of cfg.trends) tasks[`trends_${geo}`] = () => sources.trendingSearches(geo, { limit: region === 'global' ? 12 : 20, signal });
  for (const ed of cfg.news) tasks[`news_${ed}`] = () => sources.topStories({ region: ed, limit: region === 'global' ? 15 : 25, signal });
  tasks.hn = () => sources.hnTopStories({ limit: 25, signal });
  tasks.github = () => sources.githubTrending({ limit: 12, signal });

  const { data, failed } = await gather(tasks);
  const items = [];
  for (const [key, list] of Object.entries(data)) {
    if (key.startsWith('trends_')) {
      const geo = key.slice(7);
      for (const t of list) {
        const top = t.news[0];
        items.push({
          kind: 'search',
          region: geo,
          title: top ? `${t.query} — ${top.title}` : t.query,
          url: top?.url || `https://trends.google.com/trending?geo=${geo}`,
          source: top?.source || 'Google Trends',
          meta: `${t.traffic} searches in ${geo}`,
        });
      }
    } else if (key.startsWith('news_')) {
      for (const n of list) items.push({ kind: 'news', region: key.slice(5).toUpperCase(), title: n.title, url: n.url, source: n.source, meta: n.source });
    } else if (key === 'hn') {
      // Label HN items by the site they link to (the story), not "Hacker News".
      for (const h of list) items.push({ kind: 'tech', region: 'WEB', title: h.title, url: h.url, source: hostLabel(h.url, 'Hacker News'), meta: `${h.points} points, ${h.comments} comments on Hacker News` });
    } else if (key === 'github') {
      for (const g of list) items.push({ kind: 'dev', region: 'WEB', title: `${g.repo}: ${g.description}`.slice(0, 200), url: g.url, source: 'GitHub', meta: `${g.starsToday} stars today${g.language ? `, ${g.language}` : ''}` });
    }
  }
  return { items, failed };
}

function makeValidator(sources) {
  return (obj) => {
    requireFields(obj, ['topics']);
    const topics = arr(obj.topics)
      .map((t) => ({
        title: str(t.title, 120),
        category: CATEGORIES.includes(t.category) ? t.category : 'Other',
        summary: str(t.summary, 600),
        whyItMatters: str(t.whyItMatters, 400),
        momentum: ['rising', 'hot', 'steady'].includes(t.momentum) ? t.momentum : 'hot',
        regions: arr(t.regions).map((r) => str(r, 10).toUpperCase()).filter(Boolean).slice(0, 8),
        sources: resolveSourceIds(t.sourceIds, sources, 4),
      }))
      .filter((t) => t.title && t.summary && t.sources.length);
    if (topics.length < 3) throw new Error(`only ${topics.length} usable topics; need at least 3, each with valid sourceIds from the list`);
    return topics.slice(0, 12);
  };
}

async function generate(region, { usage, signal, config, sources }) {
  const { items, failed } = await collectSignals(region, sources, signal);
  if (items.length < 10) throw new TitenError(ErrorCodes.FETCH_FAILED, 'Could not collect enough trend signals right now. Please try again shortly.');

  const numbered = numberSources(items);
  const list = numbered.map((s) => `${s.id} [${s.kind}/${s.region}] ${s.title} (${s.meta})`).join('\n');

  const topics = await chatJSON({
    config,
    usage,
    signal,
    maxTokens: 3500,
    temperature: 0.3,
    system: `You are Titen's Trend Radar editor. Titen reads the signs of the world the way "ilmu titen" reads nature: by careful observation.
From the numbered signals (search trends, top news, Hacker News, GitHub), find the 8-10 most important things happening right now.
- Merge signals about the same story into one topic. Prefer stories that show up in several signals or regions.
- Write in clear, neutral, global English. No hype, no speculation beyond the signals.
- Describe the story itself for a worldwide reader. Do not write about search interest, search volume or which countries searched for it.
- category must be one of: ${CATEGORIES.join(', ')}.
- momentum: "hot" (everywhere right now), "rising" (fast growing), or "steady".
- regions: country codes or "WEB" taken from the signals.
- sourceIds: 1-4 ids from the list that support the topic. Only use ids that exist.
${UNTRUSTED_NOTE}

JSON shape:
{"topics":[{"title":"short headline","category":"...","summary":"2-3 sentences: what happened","whyItMatters":"1-2 sentences","momentum":"hot","regions":["US"],"sourceIds":["S3","S17"]}]}
Order topics from most to least important.`,
    user: `Signals collected ${new Date().toISOString()}:\n<data>\n${list}\n</data>`,
    validate: makeValidator(numbered),
  });

  const feedCounts = { trends: 0, news: 0, hn: 0, github: 0 };
  for (const it of items) feedCounts[{ search: 'trends', news: 'news', tech: 'hn', dev: 'github' }[it.kind]] += 1;

  return {
    region,
    generatedAt: new Date().toISOString(),
    signalCount: items.length,
    feedCounts,
    unavailableSources: failed,
    topics,
  };
}

/**
 * Trend Radar. Cached per region for 6 hours (shared by everyone).
 * Returns { region, generatedAt, signalCount, topics[], cached, usage }.
 */
export async function getTrends({ region = 'global', refresh = false, signal, config = getConfig(), cache, sources = realSources } = {}) {
  const r = String(region).toLowerCase();
  if (!REGIONS[r]) throw new TitenError(ErrorCodes.BAD_INPUT, `Unknown region "${region}". Use one of: ${Object.keys(REGIONS).join(', ')}.`);
  const usage = new Usage();
  const store = cache || createCache(config.cacheDir);
  const { value, cached } = await store.getOrCreate(trendsCacheKey(r), TREND_TTL_MS, () => generate(r, { usage, signal, config, sources }), { refresh });
  return { ...value, cached, usage: usage.toJSON() };
}
