import { TitenError, ErrorCodes } from './errors.js';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export function isPrivateHost(hostname = '') {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === '' || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h === '0.0.0.0' || h === '::' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    /^0\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || /^::ffff:/.test(h)
  );
}

/** Parse and check a user-supplied URL. Adds https:// when the scheme is missing. */
export function parsePublicUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new TitenError(ErrorCodes.BAD_INPUT, 'Please provide a URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new TitenError(ErrorCodes.BAD_INPUT, `That does not look like a valid URL: ${input}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new TitenError(ErrorCodes.BAD_INPUT, 'Only http and https links are supported.');
  if (isPrivateHost(u.hostname)) throw new TitenError(ErrorCodes.BLOCKED_HOST, 'Local or private network addresses are not allowed.');
  return u;
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src|ref|si|spm|_hsenc|_hsmi|yclid|msclkid)$/i;

/** Canonical form of a URL for cache keys: lowercase host, no hash, no tracking params, no trailing slash. */
export function normalizeUrl(input) {
  const u = parsePublicUrl(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  const s = u.toString();
  // "https://a.com/" → "https://a.com", "https://a.com/x/" → "https://a.com/x"
  return !u.search && s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Fetch a URL as text with a timeout and a size cap.
 * Redirects are followed manually so every hop is checked against private hosts.
 */
export async function fetchText(url, { timeoutMs = 20_000, maxBytes = 3_000_000, headers = {}, accept, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let current = typeof url === 'string' ? url : url.toString();

  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (isPrivateHost(u.hostname)) throw new TitenError(ErrorCodes.BLOCKED_HOST, 'Redirected to a private address; refusing.');

    let res;
    try {
      res = await fetch(u, {
        headers: { 'User-Agent': BROWSER_UA, Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...headers },
        redirect: 'manual',
        signal: sig,
      });
    } catch (e) {
      if (deadline.aborted) throw new TitenError(ErrorCodes.TIMEOUT, `Timed out loading ${u.hostname}.`);
      if (signal?.aborted) throw e;
      throw new TitenError(ErrorCodes.FETCH_FAILED, `Could not reach ${u.hostname}.`, { cause: e });
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    if (!res.ok) throw new TitenError(ErrorCodes.FETCH_FAILED, `${u.hostname} answered HTTP ${res.status}.`, { status: res.status });

    const type = res.headers.get('content-type') || '';
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { url: current, status: res.status, contentType: type, text };
  }
  throw new TitenError(ErrorCodes.FETCH_FAILED, 'Too many redirects.');
}

export async function fetchJSON(url, opts = {}) {
  const r = await fetchText(url, { accept: 'application/json', ...opts });
  try {
    return JSON.parse(r.text);
  } catch {
    throw new TitenError(ErrorCodes.FETCH_FAILED, `Unexpected response from ${new URL(r.url).hostname}.`);
  }
}
