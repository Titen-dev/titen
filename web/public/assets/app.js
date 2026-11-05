// Shared helpers for every page. Page scripts import from here.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Only http(s) links, always opened safely in a new tab. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function sourceLinks(sources = [], { limit = 4 } = {}) {
  return sources
    .slice(0, limit)
    .map((s) => {
      const href = safeUrl(s.url);
      const name = esc(s.source || hostOf(s.url) || 'source');
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${name} ↗</a>` : '';
    })
    .join('');
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or blocked storage: fine */
    }
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON API call. Retries once after a 429 (waits Retry-After, max 8s). Throws Error with a friendly message. */
export async function api(path, { method = 'GET', body, signal, retry = true } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Could not reach Titen. Check your connection and try again.');
  }
  if (res.status === 429 && retry) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 5, 8);
    await sleep(wait * 1000);
    return api(path, { method, body, signal, retry: false });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

export function errorCard(message) {
  return `<div class="error-card" role="alert"><div><b>That didn't work.</b><br><span>${esc(message)}</span></div></div>`;
}

export function loadingCard(title, note) {
  return `<div class="loading-card" role="status"><span class="spinner" aria-hidden="true"></span><div><b>${esc(title)}</b><br><span>${esc(note)}</span></div></div>`;
}

// ---------- page chrome ----------

function initHeader() {
  const header = $('[data-header]');
  if (!header) return;
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const toggle = $('[data-nav-toggle]');
  const nav = $('#site-nav');
  toggle?.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    header.classList.toggle('is-scrolled', open || window.scrollY > 24);
  });
}

function initCopy() {
  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.parentElement.querySelector('[data-copy-source]')?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'copied';
      } catch {
        btn.textContent = 'select & copy';
      }
      setTimeout(() => (btn.textContent = 'copy'), 1800);
    });
  });
}

initHeader();
initCopy();
