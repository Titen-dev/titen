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

// ---------- motion helpers ----------

export const reduceMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const REVEAL_SELECTOR = '.eyebrow, .display-2, .section-lede, .m-card, .topic, .tool, .console, .card, .brief, .prose > *, .about-art, .footer-grid > *';
let revealObserver;

/**
 * Fade/slide things in as they scroll into view. Only elements that start below the
 * fold are hidden, so nothing visible ever blinks. Call again after inserting content.
 */
export function revealIn(root = document) {
  if (reduceMotion() || !('IntersectionObserver' in window)) return;
  revealObserver ||= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        revealObserver.unobserve(el);
        el.classList.add('is-visible');
        // Hand back to the normal hover transitions once the entrance is over.
        setTimeout(() => el.classList.remove('reveal', 'is-visible'), 900 + (parseInt(el.style.getPropertyValue('--d'), 10) || 0));
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 }
  );
  const fold = window.innerHeight * 0.92;
  const perParent = new Map();
  for (const el of root.querySelectorAll(REVEAL_SELECTOR)) {
    if (el.dataset.revealed || el.closest('.hero')) continue;
    el.dataset.revealed = '1';
    if (el.getBoundingClientRect().top < fold) continue; // already on screen
    const i = perParent.get(el.parentElement) || 0;
    perParent.set(el.parentElement, i + 1);
    el.style.setProperty('--d', `${Math.min(i, 6) * 90}ms`); // siblings arrive one after another
    el.classList.add('reveal');
    revealObserver.observe(el);
  }
}

/** Run `fn` once, the first time `el` is on screen. */
export function whenVisible(el, fn) {
  if (!el) return;
  if (!('IntersectionObserver' in window)) return fn();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  });
  io.observe(el);
}

/** Count a number up from 0 when it becomes visible. Non-numbers are set as-is. */
export function countUp(el, value, { duration = 1100 } = {}) {
  if (!el) return;
  const target = Number(value);
  if (!Number.isFinite(target) || reduceMotion()) {
    el.textContent = value;
    return;
  }
  el.textContent = '0';
  whenVisible(el, () => {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = Math.round(target * (1 - (1 - t) ** 3)).toLocaleString('en-US');
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Type text into an element like a terminal, with a blinking cursor while typing. */
export function typeText(el, text, { speed = 16, keepCursor = false } = {}) {
  if (!el) return Promise.resolve();
  if (reduceMotion()) {
    el.textContent = text;
    return Promise.resolve();
  }
  clearInterval(el._typing);
  el.textContent = '';
  el.classList.add('typing');
  let i = 0;
  return new Promise((resolve) => {
    el._typing = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) {
        clearInterval(el._typing);
        if (!keepCursor) el.classList.remove('typing');
        resolve();
      }
    }, speed);
  });
}

initHeader();
initCopy();
revealIn();
