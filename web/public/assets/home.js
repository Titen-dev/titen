import { $, esc, api, timeAgo, sourceLinks, errorCard, revealIn, countUp, typeText, whenVisible, reduceMotion } from './app.js';

const radar = $('[data-radar]');
const TOTAL_TOPICS = 20;

const set = (sel, text) => {
  const el = $(sel);
  if (el) el.textContent = text;
};
const meter = (name, ratio) => {
  const el = $(`[data-meter="${name}"]`);
  if (!el) return;
  // set via DOM (CSP blocks inline styles); grows when the card comes into view
  whenVisible(el, () => (el.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`));
};

function topicCard(t, i) {
  const m = ['hot', 'rising', 'steady'].includes(t.momentum) ? t.momentum : 'hot';
  return `<article class="topic">
    <div class="topic-meta"><span><span class="num">${String(i + 1).padStart(2, '0')}</span> · ${esc(t.category)}</span><span class="pill pill-${m}">${esc(m)}</span></div>
    <h3>${esc(t.title)}</h3>
    <p>${esc(t.summary)}</p>
    ${t.whyItMatters ? `<p class="why"><b>Why it matters.</b> ${esc(t.whyItMatters)}</p>` : ''}
    <div class="sources">${sourceLinks(t.sources)}</div>
  </article>`;
}

function feedBars(counts) {
  const rows = [
    ['Trends', counts.trends],
    ['News', counts.news],
    ['HN', counts.hn],
    ['GitHub', counts.github],
  ];
  const max = Math.max(1, ...rows.map((r) => r[1] || 0));
  const el = $('[data-m="feeds"]');
  el.innerHTML = rows.map(([name, n]) => `<div class="m-bar"><span>${name}</span><i><span data-w="${Math.round(((n || 0) / max) * 100)}"></span></i><b>${n || 0}</b></div>`).join('');
  whenVisible(el, () => el.querySelectorAll('[data-w]').forEach((s, i) => setTimeout(() => (s.style.width = `${s.dataset.w}%`), i * 120)));
}

async function loadTrends() {
  try {
    const t = await api('/api/trends');
    radar.innerHTML = t.topics.map(topicCard).join('');
    revealIn(radar);
    set('[data-globe-caption]', `${t.signalCount} signals · 4 feeds · last scan ${timeAgo(t.generatedAt)}`);
    countUp($('[data-m="signals"]'), t.signalCount);
    countUp($('[data-m="topics"]'), t.topics.length);
    set('[data-m="topics-of"]', `of ${t.signalCount}`);
    meter('topics', t.topics.length / Math.max(1, t.signalCount)); // true share: a small sliver of everything read
    set('[data-proc="radar-last"]', timeAgo(t.generatedAt));
    typeText($('[data-proc="radar-out"]'), `${t.signalCount} signals → ${t.topics.length} stories`);
    if (t.feedCounts) feedBars(t.feedCounts);
    else $('[data-m="feeds"]').innerHTML = '';
  } catch (e) {
    radar.innerHTML = errorCard(e.message);
    set('[data-globe-caption]', 'Signals unavailable right now');
    set('[data-proc="radar-out"]', 'waiting for the next scan');
  }
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const d = s.today;
    countUp($('[data-m="briefs"]'), d.briefs);
    meter('briefs', d.briefs / TOTAL_TOPICS);
    countUp($('[data-m="flagged"]'), d.flagged);
    set('[data-m="checks-of"]', `of ${d.scamChecks}`);
    meter('flagged', d.scamChecks ? d.flagged / d.scamChecks : 0);
    set('[data-proc="brief-last"]', d.lastBrief ? timeAgo(d.lastBrief.at) : '—');
    set('[data-proc="scam-last"]', d.lastScamAt ? timeAgo(d.lastScamAt) : '—');
    // Type the console lines one after another, like a terminal printing its status.
    await new Promise((r) => setTimeout(r, 700));
    await typeText($('[data-proc="brief-out"]'), d.lastBrief ? `${d.briefs} brief${d.briefs === 1 ? '' : 's'} today · last: "${d.lastBrief.topic}"` : 'no briefs yet today · waiting for readers');
    await typeText($('[data-proc="scam-out"]'), `${d.scamChecks} check${d.scamChecks === 1 ? '' : 's'} · ${d.flagged} flagged · 0 links opened`, { keepCursor: true });
  } catch {
    /* the panel keeps its placeholders */
  }
}

// The globe leans toward the pointer (desktop only).
function globeParallax() {
  const hero = $('.hero');
  const globe = $('.globe');
  if (!hero || !globe || reduceMotion() || !window.matchMedia('(pointer: fine)').matches) return;
  let frame;
  hero.addEventListener('pointermove', (e) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      globe.style.setProperty('--ry', `${(x * 16).toFixed(2)}deg`);
      globe.style.setProperty('--rx', `${(-y * 12).toFixed(2)}deg`);
    });
  });
  hero.addEventListener('pointerleave', () => {
    globe.style.setProperty('--ry', '0deg');
    globe.style.setProperty('--rx', '0deg');
  });
}

globeParallax();
loadTrends();
loadStatus();
