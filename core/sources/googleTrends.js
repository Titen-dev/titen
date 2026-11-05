import { fetchText } from '../http.js';
import { xmlItems, xmlTag } from '../text.js';

export function parseTrendsRss(xml, limit = 20) {
  return xmlItems(xml)
    .slice(0, limit)
    .map((chunk) => {
      const news = xmlItems(chunk, 'ht:news_item')
        .slice(0, 2)
        .map((n) => ({
          title: xmlTag(n, 'ht:news_item_title'),
          url: xmlTag(n, 'ht:news_item_url'),
          source: xmlTag(n, 'ht:news_item_source'),
        }))
        .filter((n) => n.title && n.url);
      return {
        query: xmlTag(chunk, 'title'),
        traffic: xmlTag(chunk, 'ht:approx_traffic'),
        news,
      };
    })
    .filter((x) => x.query);
}

/** Today's trending searches for a country (ISO 3166 code, e.g. US, GB, IN). */
export async function trendingSearches(geo = 'US', { limit = 20, signal } = {}) {
  const { text } = await fetchText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo.toUpperCase())}`, { signal });
  return parseTrendsRss(text, limit);
}
