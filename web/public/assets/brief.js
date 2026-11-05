import { $, esc, api, sourceLinks, store, errorCard } from './app.js';

const MAX = 6;
const chipsEl = $('[data-topics]');
const briefsEl = $('[data-briefs]');
const hint = $('[data-topic-hint]');
let topics = [];
let selected = store.get('titen.topics', ['ai', 'tech', 'world']);

$('[data-today]').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + ' · UTC';

function renderChips() {
  chipsEl.innerHTML = topics
    .map((t) => `<button type="button" class="chip" data-topic="${esc(t.id)}" aria-pressed="${selected.includes(t.id)}">${esc(t.label)}</button>`)
    .join('');
  hint.textContent = selected.length ? `${selected.length} of ${MAX} topics selected.` : 'Pick a topic to begin.';
}

function skeleton(t) {
  return `<article class="brief card" data-brief="${esc(t.id)}" aria-busy="true">
    <div class="result-meta"><span>${esc(t.label)}</span><span>writing…</span></div>
    <div class="skeleton sk-80"></div><div class="skeleton"></div><div class="skeleton sk-65"></div><div class="skeleton sk-90"></div>
  </article>`;
}

function briefCard(t, b) {
  return `<article class="brief card" data-brief="${esc(t.id)}">
    <div class="result-meta"><span>${esc(t.label)} · ${esc(b.date)}</span><span>Last 48 hours</span></div>
    <h2>${esc(b.headline)}</h2>
    <ol>${b.bullets.map((x) => `<li><div>${esc(x.text)}<span class="src">${sourceLinks(x.sources, { limit: 3 })}</span></div></li>`).join('')}</ol>
    ${b.outlook ? `<p class="outlook"><b>Watch next:</b> ${esc(b.outlook)}</p>` : ''}
  </article>`;
}

// Briefs load one after another: cached ones are instant, new ones take a few seconds each.
let run = 0;
async function renderBriefs() {
  const myRun = ++run;
  const chosen = topics.filter((t) => selected.includes(t.id));
  briefsEl.innerHTML = chosen.map(skeleton).join('');
  for (const t of chosen) {
    let html;
    try {
      html = briefCard(t, await api(`/api/brief/${encodeURIComponent(t.id)}`));
    } catch (e) {
      html = `<article class="brief card" data-brief="${esc(t.id)}"><div class="result-meta"><span>${esc(t.label)}</span></div>${errorCard(e.message)}</article>`;
    }
    if (myRun !== run) return; // selection changed meanwhile
    const slot = briefsEl.querySelector(`[data-brief="${CSS.escape(t.id)}"]`);
    if (slot) slot.outerHTML = html;
  }
}

chipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-topic]');
  if (!btn) return;
  const id = btn.dataset.topic;
  if (selected.includes(id)) selected = selected.filter((x) => x !== id);
  else if (selected.length < MAX) selected = [...selected, id];
  else {
    hint.textContent = `You can follow up to ${MAX} topics. Remove one first.`;
    return;
  }
  store.set('titen.topics', selected);
  renderChips();
  renderBriefs();
});

(async () => {
  try {
    topics = await api('/api/topics');
    selected = selected.filter((id) => topics.some((t) => t.id === id));
    renderChips();
    renderBriefs();
  } catch (e) {
    briefsEl.innerHTML = errorCard(e.message);
  }
})();
