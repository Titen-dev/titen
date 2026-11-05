import { $, esc, api, errorCard, loadingCard } from './app.js';

const form = $('[data-scam-form]');
const out = $('[data-scam-result]');
const drop = $('[data-drop]');
const fileInput = $('[data-file]');
const emptyEl = $('[data-drop-empty]');
const previewEl = $('[data-drop-preview]');
const previewImg = $('[data-preview-img]');
let imageDataUrl = null;

const MAX_SIDE = 1600;
const MAX_BYTES = 4_500_000;
const VERDICT = {
  likely_scam: { title: 'Likely a scam.', label: 'Verdict' },
  suspicious: { title: 'Suspicious.', label: 'Verdict' },
  looks_safe: { title: 'Looks safe.', label: 'Verdict' },
};

// Shrink screenshots in the browser before upload (faster, cheaper, nothing huge leaves the device).
async function toDataUrl(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Please use a PNG, JPG or WebP image.');
  if (file.size > 20_000_000) throw new Error('That image is too large.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image.'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.86, 0.72, 0.6]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length * 0.75 < MAX_BYTES) return data;
    }
    throw new Error('That image is too large even after shrinking.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function setImage(file) {
  try {
    imageDataUrl = await toDataUrl(file);
    previewImg.src = imageDataUrl;
    emptyEl.hidden = true;
    previewEl.hidden = false;
  } catch (e) {
    out.innerHTML = errorCard(e.message);
  }
}

function clearImage() {
  imageDataUrl = null;
  previewImg.removeAttribute('src');
  fileInput.value = '';
  emptyEl.hidden = false;
  previewEl.hidden = true;
}

drop.addEventListener('click', (e) => {
  if (!e.target.closest('[data-remove-image]')) fileInput.click();
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
$('[data-remove-image]').addEventListener('click', (e) => {
  e.stopPropagation();
  clearImage();
});
fileInput.addEventListener('change', () => fileInput.files[0] && setImage(fileInput.files[0]));
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && setImage(e.dataTransfer.files[0]));
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    setImage(item.getAsFile());
  }
});

function render(r) {
  const v = VERDICT[r.verdict];
  const links = r.checks?.links || [];
  return `<article class="card result">
    <div class="verdict verdict-${esc(r.verdict)}">
      <span class="verdict-label">${v.label}</span>
      <p class="verdict-title">${v.title}</p>
      <div class="verdict-conf">Confidence<b>${esc(r.confidence)}%</b></div>
      <div class="verdict-meter" aria-hidden="true"><span data-meter="${Math.max(0, Math.min(100, Number(r.confidence) || 0))}"></span></div>
    </div>
    <p>${esc(r.summary)}</p>
    ${r.redFlags?.length ? `<h3>Red flags</h3><ul class="flags">${r.redFlags.map((f) => `<li><span><b>${esc(f.flag)}</b>${f.evidence ? ` — ${esc(f.evidence)}` : ''}</span></li>`).join('')}</ul>` : ''}
    ${links.length ? `<h3>Links checked <span class="optional">(never opened)</span></h3>
      <div class="table-wrap"><table class="links-table"><thead><tr><th>Domain</th><th>Age</th><th>Notes</th></tr></thead><tbody>
      ${links.map((l) => `<tr><td>${esc(l.domain || l.url)}</td><td>${l.ageDays === null || l.ageDays === undefined ? 'unknown' : `${esc(l.ageDays)} days`}</td><td>${l.flags?.length ? `<ul>${l.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : 'nothing unusual'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${r.whatToDo?.length ? `<h3>What to do</h3><ol class="points">${r.whatToDo.map((s) => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
    <p class="disclaimer">${esc(r.disclaimer)}</p>
  </article>`;
}

// Message handed over from the home page command box: fill in and check right away.
function takeHandoff() {
  let data = null;
  try {
    data = JSON.parse(sessionStorage.getItem('titen.handoff') || 'null');
    sessionStorage.removeItem('titen.handoff');
  } catch {
    return;
  }
  if (!data) return;
  if (data.text) $('#scam-text').value = String(data.text).slice(0, 8000);
  if (data.url) $('#scam-url').value = String(data.url).slice(0, 2000);
  if (data.text || data.url) form.requestSubmit();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#scam-text').value.trim();
  const url = $('#scam-url').value.trim();
  if (!text && !url && !imageDataUrl) {
    out.innerHTML = errorCard('Paste a message, add a link or a screenshot first.');
    $('#scam-text').focus();
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  out.innerHTML = loadingCard(imageDataUrl ? 'Looking at the screenshot…' : 'Looking closely…', 'Checking links and reading the message. Usually 5 to 15 seconds.');
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    out.innerHTML = render(await api('/api/scam', { method: 'POST', body: { text, url, imageDataUrl } }));
    // CSP blocks inline style attributes, so the meter width is set through the DOM.
    const meter = out.querySelector('[data-meter]');
    if (meter) meter.style.width = `${meter.dataset.meter}%`;
  } catch (err) {
    out.innerHTML = errorCard(err.message);
  } finally {
    btn.disabled = false;
  }
});

takeHandoff();
