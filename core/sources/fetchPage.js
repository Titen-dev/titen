import { fetchText, parsePublicUrl } from '../http.js';
import { htmlToText, countWords } from '../text.js';
import { TitenError, ErrorCodes } from '../errors.js';

// Sites that need login or heavy JavaScript; we can't read them reliably.
export const UNREADABLE_SITES = [
  'x.com', 'twitter.com', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.com', 'threads.net',
  'linkedin.com', 'news.google.com',
];

export function isUnreadableSite(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return UNREADABLE_SITES.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Fetch a page and return its readable text. Throws UNREADABLE for sites/pages we can't use. */
export async function readPage(input, { minWords = 80, signal } = {}) {
  const u = parsePublicUrl(input);
  if (isUnreadableSite(u.hostname)) {
    throw new TitenError(ErrorCodes.UNREADABLE, `${u.hostname} needs a login or JavaScript, so Titen can't read it. Try a regular article link.`);
  }

  const res = await fetchText(u, { signal });
  const type = res.contentType;
  let title = '';
  let text = '';
  if (/html|xml/.test(type) || /^\s*</.test(res.text)) {
    ({ title, text } = htmlToText(res.text));
  } else if (/text|json/.test(type)) {
    text = res.text;
  } else {
    throw new TitenError(ErrorCodes.UNREADABLE, `This link is a ${type || 'binary'} file, not a readable page.`);
  }

  const words = countWords(text);
  if (words < minWords) {
    throw new TitenError(ErrorCodes.UNREADABLE, 'Titen could not find enough readable text on that page (it may be behind a paywall or built with JavaScript).');
  }
  return { url: res.url, title, text, words };
}
