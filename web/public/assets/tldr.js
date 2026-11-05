import { $, esc, api, safeUrl, hostOf, errorCard, loadingCard } from './app.js';

const form = $('[data-tldr-form]');
const input = $('#tldr-url');
const out = $('[data-tldr-result]');

function render(r) {
  const href = safeUrl(r.url);
  return `<article class="card result">
    <div class="result-meta"><span>${esc(hostOf(r.url))}</span><span>~${esc(r.readMinutesSaved)} min saved</span></div>
    ${r.title ? `<h2>${esc(r.title)}</h2>` : ''}
    <p class="tldr-line"><b>TL;DR</b>${esc(r.tldr)}</p>
    <h3>Key points</h3>
    <ol class="points">${r.keyPoints.map((p) => `<li><span>${esc(p)}</span></li>`).join('')}</ol>
    ${r.caveats?.length ? `<h3>What's missing</h3><ol class="points caveats">${r.caveats.map((p) => `<li><span>${esc(p)}</span></li>`).join('')}</ol>` : ''}
    ${href ? `<div class="result-foot">Original: <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a></div>` : ''}
  </article>`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) {
    input.focus();
    return;
  }
  const btn = form.querySelector('button');
  btn.disabled = true;
  out.innerHTML = loadingCard('Reading the page…', 'This usually takes 5 to 15 seconds.');
  try {
    out.innerHTML = render(await api('/api/tldr', { method: 'POST', body: { url } }));
    history.replaceState(null, '', `?url=${encodeURIComponent(url)}`); // drop &go=1 so a reload doesn't re-run
  } catch (err) {
    out.innerHTML = errorCard(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Shareable: /tldr?url=… fills the box. Coming from the home page (&go=1) it runs right away.
const params = new URLSearchParams(location.search);
const pre = params.get('url');
if (pre) {
  input.value = pre;
  if (params.get('go') === '1') form.requestSubmit();
}
