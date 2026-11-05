import { fetchText } from '../http.js';
import { stripTags } from '../text.js';

export function parseGithubTrending(html, limit = 15) {
  const rows = [...String(html).matchAll(/<article class="Box-row">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  return rows
    .slice(0, limit)
    .map((row) => {
      const repo = row.match(/<h2[^>]*>[\s\S]*?href="\/([^"/]+\/[^"/]+)"/)?.[1] || '';
      const description = stripTags(row.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] || '');
      const language = stripTags(row.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/)?.[1] || '');
      const starsToday = Number((row.match(/([\d,]+)\s+stars\s+today/)?.[1] || '0').replace(/,/g, ''));
      return { repo, url: `https://github.com/${repo}`, description, language, starsToday };
    })
    .filter((r) => r.repo);
}

export async function githubTrending({ limit = 15, signal } = {}) {
  const { text } = await fetchText('https://github.com/trending', { signal });
  return parseGithubTrending(text, limit);
}
