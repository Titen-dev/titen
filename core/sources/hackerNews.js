import { fetchJSON } from '../http.js';

const API = 'https://hacker-news.firebaseio.com/v0';

export async function hnTopStories({ limit = 30, signal } = {}) {
  const ids = (await fetchJSON(`${API}/topstories.json`, { signal })).slice(0, limit);
  const items = await Promise.all(
    ids.map((id) => fetchJSON(`${API}/item/${id}.json`, { signal, timeoutMs: 10_000 }).catch(() => null))
  );
  return items
    .filter((it) => it && it.title && !it.dead && !it.deleted)
    .map((it) => ({
      title: it.title,
      url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      discussionUrl: `https://news.ycombinator.com/item?id=${it.id}`,
      points: it.score || 0,
      comments: it.descendants || 0,
    }));
}
