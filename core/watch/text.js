import crypto from 'node:crypto';
import { TitenError, ErrorCodes } from '../errors.js';

// ---------- intervals ----------

export const MIN_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30m" / "6h" / "1d" / "1.5h" → milliseconds (minimum 15 minutes). */
export function parseInterval(input) {
  if (input === undefined || input === null || input === '') return DEFAULT_INTERVAL_MS;
  const m = String(input).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (!m) throw new TitenError(ErrorCodes.BAD_INPUT, `Can't read "${input}" as an interval. Use something like 30m, 6h or 1d.`);
  const ms = Number(m[1]) * UNITS[m[2][0]];
  if (ms < MIN_INTERVAL_MS) throw new TitenError(ErrorCodes.BAD_INPUT, 'The shortest interval is 15m, to be kind to the websites you watch.');
  return Math.round(ms);
}

export function formatInterval(ms) {
  if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`;
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`;
  return `${Math.round(ms / UNITS.m)}m`;
}

/** After failures, wait longer (×2 each time) but never more than a day. */
export function nextDelay(everyMs, failures = 0) {
  if (!failures) return everyMs;
  return Math.min(Math.max(everyMs * 2 ** Math.min(failures, 6), everyMs), UNITS.d);
}

// ---------- page text ----------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
// Things that change on every visit but carry no news: clocks, dates, "3 minutes ago", view counters.
const NOISE = [
  /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?(?:\s*[a-z]{2,4}t)?\b/gi,
  /\b(?:just now|yesterday|today)\b/gi,
  /\b\d+\s*(?:sec|second|min|minute|hour|hr|day|week|month|year)s?\s+ago\b/gi,
  /\b(?:updated|last updated|published|posted)\s*:?\s*/gi,
  /\b[\d,.]+\s*(?:views?|reads?|comments?|likes?|shares?|followers?|points?)\b/gi,
];

/** Remove noise so "the page changed" means the content changed. */
export function normalizeText(text = '') {
  let s = String(text);
  for (const re of NOISE) s = s.replace(re, ' ');
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');
}

export function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** Line-level diff: which lines appeared and which disappeared (order kept, duplicates ignored). */
export function lineDiff(oldText = '', newText = '', maxChars = 4000) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = [...new Set(newLines.filter((l) => !oldSet.has(l)))];
  const removed = [...new Set(oldLines.filter((l) => !newSet.has(l)))];
  const cap = (arr) => {
    const out = [];
    let used = 0;
    for (const l of arr) {
      if (used + l.length > maxChars / 2) {
        out.push(`… and ${arr.length - out.length} more line(s)`);
        break;
      }
      out.push(l);
      used += l.length;
    }
    return out;
  };
  return { added: cap(added), removed: cap(removed), addedCount: added.length, removedCount: removed.length };
}

// ---------- topic items ----------

export function itemKey(item) {
  return String(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 140);
}

/** New items not seen before, plus the updated seen list (capped). */
export function newItems(items, seen = [], cap = 500) {
  const seenSet = new Set(seen);
  const fresh = [];
  for (const it of items) {
    const k = itemKey(it);
    if (!k || seenSet.has(k)) continue;
    seenSet.add(k);
    fresh.push(it);
  }
  const updated = [...seen, ...fresh.map(itemKey)].slice(-cap);
  return { fresh, seen: updated };
}

export function looksLikeUrl(s) {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(String(s).trim()) && !/\s/.test(String(s).trim());
}
