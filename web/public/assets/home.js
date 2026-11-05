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

// ---------- spinning globe ----------
// Replaces the static SVG globe with a canvas that rotates like the Earth: dots on a tilted
// sphere, coral signals pinned to world cities, and arcs flowing between them.
const CITIES = [
  [40.7, -74.0], // New York
  [51.5, -0.1], // London
  [6.5, 3.4], // Lagos
  [19.1, 72.9], // Mumbai
  [-6.2, 106.8], // Jakarta
  [35.7, 139.7], // Tokyo
  [-23.5, -46.6], // São Paulo
];
const ROUTES = [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [0, 6], [6, 2]];

function spinningGlobe() {
  const svg = $('svg.globe');
  if (!svg || reduceMotion()) return; // keep the still SVG
  const canvas = document.createElement('canvas');
  canvas.className = 'globe globe-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'A spinning globe with signals lighting up in cities around the world');
  svg.replaceWith(canvas);
  const ctx = canvas.getContext('2d');

  const rad = Math.PI / 180;
  const TILT = 0.38; // axis tilt, radians
  const SPEED = (2 * Math.PI) / 40000; // one turn per 40 s
  const dots = [];
  for (let la = -80; la <= 80; la += 10) for (let lo = 0; lo < 360; lo += 7) dots.push([la * rad, lo * rad]);
  const cities = CITIES.map(([la, lo]) => [la * rad, lo * rad]);

  let size = 0;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = canvas.clientWidth;
    canvas.width = canvas.height = Math.round(size * dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  // Unit vector for a lat/lon after spinning by `rot` and tilting the axis toward the viewer.
  const vec = (lat, lon, rot) => {
    const x = Math.cos(lat) * Math.sin(lon + rot);
    const y = Math.sin(lat);
    const z = Math.cos(lat) * Math.cos(lon + rot);
    return [x, y * Math.cos(TILT) - z * Math.sin(TILT), y * Math.sin(TILT) + z * Math.cos(TILT)];
  };

  let running = false;
  let start = performance.now();
  let rotAtPause = 0.6;

  function draw(now) {
    if (!running) return;
    const t = now - start;
    const rot = rotAtPause + t * SPEED;
    const s = size / 480; // the design was drawn on a 480px box
    const c = 240 * s;
    const R = 200 * s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Outer dotted ring.
    ctx.strokeStyle = 'rgba(207,224,255,.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 6]);
    ctx.beginPath();
    ctx.arc(c, c, R + 14 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sphere dots: the far side faintly, the near side brighter and bigger toward the viewer.
    for (const [la, lo] of dots) {
      const [x, y, z] = vec(la, lo, rot);
      const front = z >= 0;
      ctx.fillStyle = front ? `rgba(207,224,255,${(0.15 + z * 0.7).toFixed(3)})` : 'rgba(207,224,255,.06)';
      ctx.beginPath();
      ctx.arc(c + R * x, c - R * y, (front ? 0.8 + z * 1.5 : 0.7) * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // Routes between cities: lifted arcs with a flowing dash, only when both ends face us.
    const pts = cities.map(([la, lo]) => vec(la, lo, rot));
    ctx.lineWidth = 1.4 * s;
    ctx.setLineDash([2 * s, 4 * s]);
    ctx.lineDashOffset = -t / 60;
    for (const [a, b] of ROUTES) {
      const p = pts[a];
      const q = pts[b];
      if (p[2] < 0.05 || q[2] < 0.05) continue;
      const m = [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
      const len = Math.hypot(...m) || 1;
      const lift = 1.28; // control point above the surface
      ctx.strokeStyle = `rgba(240,140,99,${Math.min(p[2], q[2]).toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(c + R * p[0], c - R * p[1]);
      ctx.quadraticCurveTo(c + (R * lift * m[0]) / len, c - (R * lift * m[1]) / len, c + R * q[0], c - R * q[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // City signals with a pulse.
    pts.forEach(([x, y, z], i) => {
      if (z < 0) return;
      const px = c + R * x;
      const py = c - R * y;
      const phase = ((t / 3500 + i * 0.2) % 1 + 1) % 1;
      ctx.fillStyle = `rgba(240,140,99,${(0.35 * (1 - phase) * z).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, (5 + phase * 16) * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(240,140,99,${(0.4 + z * 0.6).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 4.5 * s, 0, Math.PI * 2);
      ctx.fill();
    });

    requestAnimationFrame(draw);
  }

  // Only spin while the globe is on screen.
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !running) {
      running = true;
      start = performance.now();
      requestAnimationFrame(draw);
    } else if (!e.isIntersecting && running) {
      running = false;
      rotAtPause += (performance.now() - start) * SPEED;
    }
  });
  io.observe(canvas);
}

spinningGlobe();
globeParallax();
loadTrends();
loadStatus();
