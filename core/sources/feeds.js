// Official RSS/Atom feeds from established publishers. Used when Google News is not
// reachable (Google blocks most cloud/data-centre IPs, e.g. Cloudflare Workers), and
// directly on Workers. Headlines link to the publisher's own article.
import { fetchText } from '../http.js';
import { xmlItems, xmlTag, decodeEntities, stripTags } from '../text.js';

const f = (source, url) => ({ source, url });

// Top stories per news edition (mirrors the regions Trend Radar asks Google News for).
export const TOP_FEEDS = {
  us: [f('NPR', 'https://feeds.npr.org/1001/rss.xml'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml')],
  gb: [f('BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'), f('The Guardian', 'https://www.theguardian.com/world/rss')],
  in: [f('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'), f('The Hindu', 'https://www.thehindu.com/news/international/feeder/default.rss')],
};
TOP_FEEDS.default = [...TOP_FEEDS.gb, ...TOP_FEEDS.us];

// Feeds per Daily Brief topic id (see WEB_TOPICS in features/brief.js).
export const TOPIC_FEEDS = {
  ai: [f('The Guardian', 'https://www.theguardian.com/technology/artificialintelligenceai/rss'), f('TechCrunch', 'https://techcrunch.com/category/artificial-intelligence/feed/')],
  tech: [f('BBC', 'https://feeds.bbci.co.uk/news/technology/rss.xml'), f('The Guardian', 'https://www.theguardian.com/uk/technology/rss'), f('TechCrunch', 'https://techcrunch.com/feed/')],
  startups: [f('TechCrunch', 'https://techcrunch.com/category/startups/feed/'), f('Crunchbase News', 'https://news.crunchbase.com/feed/')],
  crypto: [f('CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'), f('Cointelegraph', 'https://cointelegraph.com/rss')],
  business: [f('BBC', 'https://feeds.bbci.co.uk/news/business/rss.xml'), f('The Guardian', 'https://www.theguardian.com/uk/business/rss'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml')],
  markets: [f('CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'), f('MarketWatch', 'https://feeds.marketwatch.com/marketwatch/topstories/'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml')],
  science: [f('BBC', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'), f('The Guardian', 'https://www.theguardian.com/science/rss'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml')],
  space: [f('NASA', 'https://www.nasa.gov/news-release/feed/'), f('Space.com', 'https://www.space.com/feeds/all'), f('The Guardian', 'https://www.theguardian.com/science/space/rss')],
  health: [f('BBC', 'https://feeds.bbci.co.uk/news/health/rss.xml'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml'), f('The Guardian', 'https://www.theguardian.com/society/health/rss')],
  climate: [f('The Guardian', 'https://www.theguardian.com/environment/climate-crisis/rss'), f('The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml'), f('BBC', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml')],
  world: [f('BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'), f('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'), f('The Guardian', 'https://www.theguardian.com/world/rss'), f('NPR', 'https://feeds.npr.org/1004/rss.xml')],
  football: [f('BBC Sport', 'https://feeds.bbci.co.uk/sport/football/rss.xml'), f('The Guardian', 'https://www.theguardian.com/football/rss')],
  basketball: [f('The Guardian', 'https://www.theguardian.com/sport/nba/rss'), f('BBC Sport', 'https://feeds.bbci.co.uk/sport/basketball/rss.xml')],
  f1: [f('BBC Sport', 'https://feeds.bbci.co.uk/sport/formula1/rss.xml'), f('The Guardian', 'https://www.theguardian.com/sport/formulaone/rss')],
  gaming: [f('The Guardian', 'https://www.theguardian.com/games/rss'), f('GameSpot', 'https://www.gamespot.com/feeds/news/'), f('Eurogamer', 'https://www.eurogamer.net/feed')],
  movies: [f('The Guardian', 'https://www.theguardian.com/film/rss'), f('Variety', 'https://variety.com/feed/'), f('Deadline', 'https://deadline.com/feed/')],
  music: [f('The Guardian', 'https://www.theguardian.com/music/rss'), f('Billboard', 'https://www.billboard.com/feed/'), f('Pitchfork', 'https://pitchfork.com/rss/news/')],
  security: [f('The Hacker News', 'https://feeds.feedburner.com/TheHackersNews'), f('Krebs on Security', 'https://krebsonsecurity.com/feed/')],
  programming: [f('GitHub Blog', 'https://github.blog/feed/'), f('InfoQ', 'https://feed.infoq.com/'), f('DEV', 'https://dev.to/feed')],
  ev: [f('Electrek', 'https://electrek.co/feed/'), f('InsideEVs', 'https://insideevs.com/rss/news/all/'), f('CleanTechnica', 'https://cleantechnica.com/feed/')],
};

/** Parse RSS 2.0 and Atom into { title, url, source, publishedAt, summary }. */
export function parseFeed(xml, source = '', limit = 30) {
  const isAtom = /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);
  const chunks = isAtom ? xmlItems(xml, 'entry') : xmlItems(xml, 'item');
  return chunks
    .slice(0, limit)
    .map((c) => {
      const link = isAtom
        ? decodeEntities(c.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] || c.match(/<link\b[^>]*href="([^"]+)"/)?.[1] || '')
        : xmlTag(c, 'link') || xmlTag(c, 'guid');
      const date = xmlTag(c, 'pubDate') || xmlTag(c, 'published') || xmlTag(c, 'updated') || xmlTag(c, 'dc:date');
      const d = date ? new Date(date) : null;
      return {
        title: stripTags(xmlTag(c, 'title')),
        url: link.trim(),
        source,
        publishedAt: d && !isNaN(d) ? d.toISOString() : null,
        summary: stripTags(xmlTag(c, 'description') || xmlTag(c, 'summary')).slice(0, 300),
      };
    })
    .filter((x) => x.title && /^https?:\/\//.test(x.url));
}

/** Fetch several feeds in parallel; failures are skipped. Newest first, optional age limit, deduped by title. */
export async function fetchFeeds(feeds, { limit = 20, maxAgeHours, signal } = {}) {
  const results = await Promise.allSettled(feeds.map((fd) => fetchText(fd.url, { signal, timeoutMs: 12_000, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' }).then((r) => parseFeed(r.text, fd.source))));
  const cutoff = maxAgeHours ? Date.now() - maxAgeHours * 3_600_000 : 0;
  const seen = new Set();
  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((it) => !cutoff || !it.publishedAt || new Date(it.publishedAt).getTime() >= cutoff)
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
    .filter((it) => {
      const k = it.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

export function topStoriesFromFeeds({ region = 'us', limit = 20, signal } = {}) {
  return fetchFeeds(TOP_FEEDS[region] || TOP_FEEDS.default, { limit, maxAgeHours: 48, signal });
}

/** News on a topic: the topic's own feeds when known, otherwise a keyword filter over general feeds. */
export async function searchFeeds(query, { topicId, limit = 15, signal } = {}) {
  if (topicId && TOPIC_FEEDS[topicId]) return fetchFeeds(TOPIC_FEEDS[topicId], { limit, maxAgeHours: 72, signal });
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const pool = await fetchFeeds([...TOP_FEEDS.default, ...TOPIC_FEEDS.tech, ...TOPIC_FEEDS.business, ...TOPIC_FEEDS.science], { limit: 200, maxAgeHours: 96, signal });
  return pool.filter((it) => words.some((w) => `${it.title} ${it.summary}`.toLowerCase().includes(w))).slice(0, limit);
}
