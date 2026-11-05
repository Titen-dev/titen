import { chat } from '../llm.js';
import { getConfig } from '../config.js';

/**
 * Web search through OpenRouter's web plugin (≈ $0.007 per search with Exa).
 * Returns a short summary plus the cited sources.
 */
export async function webSearch(query, { maxResults = 5, usage, signal, config = getConfig() } = {}) {
  const data = await chat({
    config,
    usage,
    signal,
    maxTokens: 900,
    plugins: [{ id: 'web', engine: config.searchEngine, max_results: Math.min(Math.max(maxResults, 1), 10) }],
    messages: [
      {
        role: 'user',
        content: `Search the web for: ${query}\n\nWrite a short factual summary of what the results say, with dates and numbers when available. Only use information from the results.`,
      },
    ],
  });
  if (usage) usage.webSearches += 1;

  const msg = data.choices[0].message;
  const seen = new Set();
  const sources = (msg.annotations || [])
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url, snippet: (a.url_citation.content || '').replace(/\s+/g, ' ').slice(0, 300) }))
    .filter((s) => !seen.has(s.url) && seen.add(s.url));

  return { query, summary: msg.content || '', sources };
}
