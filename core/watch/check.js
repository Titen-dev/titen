import { chatJSON } from '../llm.js';
import { UNTRUSTED_NOTE, str, arr, requireFields } from '../features/common.js';
import { normalizeText, hashText, lineDiff, newItems } from './text.js';

const MAX_SNAPSHOT_CHARS = 60_000;

/**
 * Page watch. First run stores a baseline. Later runs compare the normalized text;
 * the AI is only asked when something actually changed.
 * Returns { baseline?, changed, meaningful, summary, snapshot, title, url }.
 */
export async function checkPage(watch, prev, { sources, config, usage, signal }) {
  const page = await sources.readPage(watch.target, { signal, minWords: 5 });
  const text = normalizeText(page.text).slice(0, MAX_SNAPSHOT_CHARS);
  const snapshot = { hash: hashText(text), text, title: page.title, checkedAt: new Date().toISOString() };

  if (!prev?.hash) return { baseline: true, changed: false, meaningful: false, snapshot, title: page.title, url: page.url };
  if (prev.hash === snapshot.hash) return { changed: false, meaningful: false, snapshot: { ...prev, checkedAt: snapshot.checkedAt }, title: page.title, url: page.url };

  const diff = lineDiff(prev.text || '', text);
  if (!diff.addedCount && !diff.removedCount) return { changed: false, meaningful: false, snapshot, title: page.title, url: page.url };

  const verdict = await chatJSON({
    config,
    usage,
    signal,
    maxTokens: 500,
    temperature: 0,
    system: `You watch a web page for someone and decide whether a change is worth a notification.
${watch.note ? `They told you what they care about: "${watch.note}". Only that kind of change is meaningful.` : 'Meaningful means a real content change (new article, price, status, announcement, date, availability). Ads, rotating banners, counters, cookie notices, layout or navigation shuffles are not meaningful.'}
summary: one or two plain sentences saying what changed, concrete (numbers, names). Empty if not meaningful.
${UNTRUSTED_NOTE}
JSON: {"meaningful": true|false, "summary": "..."}`,
    user: `Page: ${page.title || watch.target}\nURL: ${page.url}\n<data>\nLINES ADDED (${diff.addedCount}):\n${diff.added.join('\n') || '(none)'}\n\nLINES REMOVED (${diff.removedCount}):\n${diff.removed.join('\n') || '(none)'}\n</data>`,
    validate: (o) => {
      requireFields(o, ['meaningful']);
      return { meaningful: o.meaningful === true, summary: str(o.summary, 400) };
    },
  });

  return { changed: true, meaningful: verdict.meaningful && Boolean(verdict.summary), summary: verdict.summary, snapshot, title: page.title, url: page.url };
}

/**
 * Topic watch. Looks for news items not seen before; the AI keeps only the ones
 * that match what the person cares about and sums them up.
 * Returns { baseline?, changed, meaningful, summary, items, snapshot }.
 */
export async function checkTopic(watch, prev, { sources, config, usage, signal }) {
  const items = await sources.searchNews(watch.target, { region: 'us', when: '2d', limit: 25, signal });
  const { fresh, seen } = newItems(items, prev?.seen || []);
  const snapshot = { seen, checkedAt: new Date().toISOString() };

  if (!prev) return { baseline: true, changed: false, meaningful: false, snapshot, items: [] };
  if (!fresh.length) return { changed: false, meaningful: false, snapshot, items: [] };

  const list = fresh.slice(0, 15).map((it, i) => `${i + 1}. ${it.title} (${it.source || 'unknown'}${it.publishedAt ? `, ${it.publishedAt.slice(0, 10)}` : ''})`).join('\n');
  const verdict = await chatJSON({
    config,
    usage,
    signal,
    maxTokens: 500,
    temperature: 0,
    system: `You watch the news on a topic for someone and decide which new headlines deserve a notification.
Topic: "${watch.target}". ${watch.note ? `What they care about: "${watch.note}".` : 'They want real developments on this topic, not opinion pieces, listicles or duplicates of the same story.'}
relevant: numbers of the headlines worth telling them about (can be empty).
summary: one or two plain sentences on what is new. Empty if nothing is relevant.
${UNTRUSTED_NOTE}
JSON: {"relevant": [1, 3], "summary": "..."}`,
    user: `New headlines:\n<data>\n${list}\n</data>`,
    validate: (o) => {
      requireFields(o, ['relevant']);
      const idx = arr(o.relevant).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= Math.min(fresh.length, 15));
      return { relevant: [...new Set(idx)], summary: str(o.summary, 400) };
    },
  });

  const picked = verdict.relevant.map((n) => fresh[n - 1]);
  return { changed: true, meaningful: picked.length > 0 && Boolean(verdict.summary), summary: verdict.summary, items: picked, snapshot };
}
