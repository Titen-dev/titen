import { fetchText } from '../http.js';
import { xmlItems, xmlTag } from '../text.js';

// Google News edition parameters per region.
export const NEWS_EDITIONS = {
  us: 'hl=en-US&gl=US&ceid=US:en',
  gb: 'hl=en-GB&gl=GB&ceid=GB:en',
  in: 'hl=en-IN&gl=IN&ceid=IN:en',
  ca: 'hl=en-CA&gl=CA&ceid=CA:en',
  au: 'hl=en-AU&gl=AU&ceid=AU:en',
  ng: 'hl=en-NG&gl=NG&ceid=NG:en',
  sg: 'hl=en-SG&gl=SG&ceid=SG:en',
  br: 'hl=pt-BR&gl=BR&ceid=BR:pt-419',
  de: 'hl=de&gl=DE&ceid=DE:de',
  fr: 'hl=fr&gl=FR&ceid=FR:fr',
  jp: 'hl=ja&gl=JP&ceid=JP:ja',
  id: 'hl=id&gl=ID&ceid=ID:id',
};

export function parseNewsRss(xml, limit = 20) {
  return xmlItems(xml)
    .slice(0, limit)
    .map((chunk) => {
      const source = xmlTag(chunk, 'source');
      let title = xmlTag(chunk, 'title');
      // Google appends " - Source Name" to titles; drop it since we keep source separately.
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
      const pub = xmlTag(chunk, 'pubDate');
      return {
        title,
        url: xmlTag(chunk, 'link'),
        source,
        publishedAt: pub ? new Date(pub).toISOString() : null,
      };
    })
    .filter((x) => x.title && x.url);
}

/** Search Google News. `when` like "1d" / "2d" / "7d" limits recency. */
export async function searchNews(query, { region = 'us', limit = 15, when, signal } = {}) {
  const q = when ? `${query} when:${when}` : query;
  const edition = NEWS_EDITIONS[region] || NEWS_EDITIONS.us;
  const { text } = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${edition}`, { signal });
  return parseNewsRss(text, limit);
}

export async function topStories({ region = 'us', limit = 20, signal } = {}) {
  const edition = NEWS_EDITIONS[region] || NEWS_EDITIONS.us;
  const { text } = await fetchText(`https://news.google.com/rss?${edition}`, { signal });
  return parseNewsRss(text, limit);
}
