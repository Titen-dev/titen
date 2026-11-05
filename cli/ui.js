// Terminal output helpers: colors, wrapping, spinner, and renderers for each feature.

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color');
const paint = (code) => (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  italic: paint('3'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  coral: paint('38;5;209'),
  inverse: paint('7'),
};

export function width() {
  return Math.min(process.stdout.columns || 100, 100);
}

/** Word-wrap text to the terminal width with a hanging indent. */
export function wrap(text, indent = 0, firstIndent = indent) {
  const max = Math.max(width() - indent, 30);
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  for (const w of words) {
    if (line && visible(`${line} ${w}`) > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => ' '.repeat(i === 0 ? firstIndent : indent) + l).join('\n');
}

export function header(title, sub = '') {
  return `\n${c.coral(c.bold('TITEN'))} ${c.dim('·')} ${c.bold(title.toUpperCase())}${sub ? c.dim(`  ${sub}`) : ''}\n${c.dim('─'.repeat(Math.min(width(), 72)))}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function costLine(result) {
  const u = result?.usage;
  if (result?.cached) return c.dim('\n◦ served from cache · $0');
  if (!u || !u.calls) return '';
  const cost = u.cost ? `≈ $${u.cost.toFixed(4)}` : 'cost n/a';
  return c.dim(`\n◦ ${cost} · ${u.calls} AI call${u.calls === 1 ? '' : 's'}${u.webSearches ? ` · ${u.webSearches} web search` : ''}`);
}

// Clickable terminal links (OSC 8) keep long URLs out of sight. TITEN_PLAIN_LINKS=1 prints full URLs instead.
const useHyperlinks = () => useColor() && !process.env.TITEN_PLAIN_LINKS;
const hyperlink = (text, url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/** "text ↗" as a clickable link in capable terminals, or "text — url" otherwise. */
export function linkText(text, url) {
  return useHyperlinks() ? c.cyan(hyperlink(`${text} ↗`, url)) : `${text} — ${url}`;
}

function sourceLine(sources, indent = 5) {
  const pad = ' '.repeat(indent);
  return sources
    .map((s) => {
      const name = s.source || hostOf(s.url);
      return useHyperlinks()
        ? `${pad}${c.dim('↳')} ${c.cyan(hyperlink(`${name} ↗`, s.url))}`
        : `${pad}↳ ${name} — ${s.url}`;
    })
    .join('\n');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ---------- renderers ----------

export function renderTrends(r) {
  const out = [header('Trend Radar', `${r.region} · updated ${timeAgo(r.generatedAt)} · ${r.signalCount} signals`)];
  r.topics.forEach((t, i) => {
    const tag = c.dim(`[${t.category} · ${t.momentum}${t.regions?.length ? ` · ${t.regions.join(' ')}` : ''}]`);
    out.push(`\n${c.coral(String(i + 1).padStart(2))}. ${c.bold(t.title)} ${tag}`);
    out.push(wrap(t.summary, 4));
    if (t.whyItMatters) out.push(wrap(`${c.italic('Why it matters:')} ${t.whyItMatters}`, 4));
    out.push(sourceLine(t.sources, 4));
  });
  if (r.unavailableSources?.length) out.push(c.dim(`\n(some feeds were unavailable: ${r.unavailableSources.join(', ')})`));
  return out.join('\n');
}

export function renderBrief(r) {
  const out = [header('Daily Brief', `${r.topic} · ${r.date}`)];
  out.push(`\n${wrap(c.bold(r.headline), 1)}`);
  for (const b of r.bullets) {
    out.push(`\n${wrap(`${c.coral('•')} ${b.text}`, 3, 1)}`);
    out.push(sourceLine(b.sources, 3));
  }
  if (r.outlook) out.push(`\n${wrap(`${c.italic('Watch next:')} ${r.outlook}`, 1)}`);
  return out.join('\n');
}

export function renderTldr(r) {
  const out = [header('TL;DR', `${hostOf(r.url)} · ~${r.readMinutesSaved} min saved`)];
  if (r.title) out.push(`\n${wrap(c.bold(r.title), 1)}`);
  out.push(`\n${wrap(`${c.coral('TL;DR')}  ${r.tldr}`, 1)}`);
  out.push(`\n ${c.bold('Key points')}`);
  for (const p of r.keyPoints) out.push(wrap(`${c.coral('•')} ${p}`, 3, 1));
  if (r.caveats?.length) {
    out.push(`\n ${c.bold("What's missing")}`);
    for (const p of r.caveats) out.push(wrap(`${c.yellow('!')} ${p}`, 3, 1));
  }
  out.push(c.dim(`\n ${r.url}`));
  return out.join('\n');
}

const VERDICT = {
  likely_scam: { label: ' LIKELY SCAM ', color: (s) => c.inverse(c.red(s)), icon: '🔴' },
  suspicious: { label: ' SUSPICIOUS ', color: (s) => c.inverse(c.yellow(s)), icon: '🟡' },
  looks_safe: { label: ' LOOKS SAFE ', color: (s) => c.inverse(c.green(s)), icon: '🟢' },
};

export function renderScam(r) {
  const v = VERDICT[r.verdict];
  const out = [header('Scam Check')];
  out.push(`\n ${v.icon} ${c.bold(v.color(v.label))}  ${c.dim(`confidence ${r.confidence}%`)}`);
  out.push(`\n${wrap(r.summary, 1)}`);
  if (r.redFlags.length) {
    out.push(`\n ${c.bold('Red flags')}`);
    for (const f of r.redFlags) out.push(wrap(`${c.red('✖')} ${c.bold(f.flag)}${f.evidence ? c.dim(` — ${f.evidence}`) : ''}`, 3, 1));
  }
  const links = r.checks?.links || [];
  if (links.length) {
    out.push(`\n ${c.bold('Links checked')} ${c.dim('(never opened)')}`);
    for (const l of links) {
      const age = l.ageDays === null ? 'age unknown' : `${l.ageDays} days old`;
      out.push(wrap(`${c.cyan(l.domain || l.url)} ${c.dim(`· ${age}`)}`, 3, 1));
      for (const f of l.flags) out.push(wrap(c.dim(`- ${f}`), 5, 3));
    }
  }
  if (r.whatToDo.length) {
    out.push(`\n ${c.bold('What to do')}`);
    r.whatToDo.forEach((s, i) => out.push(wrap(`${c.coral(`${i + 1}.`)} ${s}`, 4, 1)));
  }
  out.push(`\n${wrap(c.dim(r.disclaimer), 1)}`);
  return out.join('\n');
}

// ---------- spinner (stderr, TTY only) ----------

export function spinner(text) {
  if (!process.stderr.isTTY || process.argv.includes('--json')) return { update() {}, stop() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let label = text;
  const started = Date.now();
  const draw = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    process.stderr.write(`\r\x1b[2K${c.coral(frames[i++ % frames.length])} ${label}${secs >= 3 ? c.dim(` ${secs}s`) : ''}`);
  };
  const timer = setInterval(draw, 90);
  draw();
  return {
    update(t) {
      label = t;
    },
    stop() {
      clearInterval(timer);
      process.stderr.write('\r\x1b[2K');
    },
  };
}
