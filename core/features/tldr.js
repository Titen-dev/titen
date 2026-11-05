import { chatJSON } from '../llm.js';
import { getConfig } from '../config.js';
import { createCache } from '../cache.js';
import { normalizeUrl, parsePublicUrl } from '../http.js';
import { Usage } from '../usage.js';
import * as realSources from '../sources/index.js';
import { UNTRUSTED_NOTE, str, arr, requireFields } from './common.js';

export const TLDR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHARS = 24_000; // ≈ 6k tokens of page text is plenty for a summary
const WORDS_PER_MINUTE = 230;

function validate(obj) {
  requireFields(obj, ['tldr', 'keyPoints']);
  const keyPoints = arr(obj.keyPoints).map((p) => str(p, 400)).filter(Boolean);
  if (keyPoints.length < 2) throw new Error('need at least 2 keyPoints');
  return {
    title: str(obj.title, 200),
    tldr: str(obj.tldr, 400),
    keyPoints: keyPoints.slice(0, 7),
    caveats: arr(obj.caveats).map((c) => str(c, 300)).filter(Boolean).slice(0, 4),
  };
}

async function generate(url, { usage, signal, config, sources }) {
  const page = await sources.readPage(url, { signal });
  const text = page.text.length > MAX_CHARS ? `${page.text.slice(0, MAX_CHARS)}\n[…page continues…]` : page.text;

  const out = await chatJSON({
    config,
    usage,
    signal,
    maxTokens: 2500,
    temperature: 0.2,
    system: `You are Titen's TL;DR writer. Summarize a web page for a busy global reader, in English, whatever the page language.
- title: the page's real title (clean it up if needed).
- tldr: ONE sentence with the core message.
- keyPoints: 3-7 short bullets with the most useful facts, numbers, conclusions. No filler.
- caveats: 1-4 notes on what is missing, one-sided, unproven, sponsored, or outdated. Empty array if none.
Only use what the page says. Do not add outside facts.
${UNTRUSTED_NOTE}
JSON shape: {"title":"...","tldr":"...","keyPoints":["..."],"caveats":["..."]}`,
    user: `URL: ${page.url}\nPage title: ${page.title}\n<data>\n${text}\n</data>`,
    validate,
  });

  return {
    url: page.url,
    ...out,
    title: out.title || page.title,
    words: page.words,
    readMinutesSaved: Math.max(1, Math.round(page.words / WORDS_PER_MINUTE)),
    generatedAt: new Date().toISOString(),
  };
}

/** TL;DR of any readable URL. Cached per normalized URL for 24 hours. */
export async function getTldr({ url, refresh = false, signal, config = getConfig(), cache, sources = realSources } = {}) {
  const key = normalizeUrl(url); // also validates the URL and blocks private hosts
  const target = parsePublicUrl(url).toString(); // fetch the URL as given; the normalized form is only the cache key
  const usage = new Usage();
  const store = cache || createCache(config.cacheDir);
  const { value, cached } = await store.getOrCreate(`tldr:v1:${key}`, TLDR_TTL_MS, () => generate(target, { usage, signal, config, sources }), { refresh });
  return { ...value, cached, usage: usage.toJSON() };
}
