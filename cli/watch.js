import { createWatcher, formatInterval } from '../core/watch/index.js';
import { TitenError, ErrorCodes } from '../core/errors.js';
import { c, wrap, spinner, timeAgo, linkText } from './ui.js';

const print = (s = '') => process.stdout.write(`${s}\n`);

function label(w) {
  if (w.type === 'topic') return `"${w.target}"`;
  try {
    const u = new URL(w.target);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 60);
  } catch {
    return w.target;
  }
}

function until(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return 'due now';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function describe(r) {
  const w = r.watch;
  const head = `${c.dim(`#${w.id}`)} ${label(w)}`;
  if (r.error) return `${head} ${c.red('✖')} ${c.dim(r.error.message)}`;
  const res = r.result;
  if (res.baseline) return `${head} ${c.dim('· baseline saved, watching from now on')}`;
  if (!res.changed) return `${head} ${c.dim('· no change')}`;
  if (!res.meaningful) return `${head} ${c.dim('· changed, but nothing worth telling you')}`;
  const link = w.type === 'page' ? res.url || w.target : res.items?.[0]?.url;
  const linkLine = link ? `\n    ${linkText(w.type === 'page' ? 'open the page' : res.items[0].title, link)}` : '';
  return `${head} ${c.coral('● news')}\n${wrap(res.summary, 4)}${linkLine}${r.notified ? '' : c.dim('\n    (desktop notification unavailable, shown here instead)')}`;
}

const costOf = (results) => results.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);

export async function watchCommand(args, values, config) {
  const [sub = 'list', ...rest] = args;
  const watcher = createWatcher({ config });
  const json = Boolean(values.json);
  const needKey = () => {
    if (!config.apiKey) throw new TitenError(ErrorCodes.NO_KEY, 'No OpenRouter API key yet (needed to judge changes). Run: titen setup');
  };

  switch (sub) {
    case 'add': {
      const target = rest.join(' ').trim();
      const w = watcher.add({ target, every: values.every, note: values.note });
      const sp = spinner('Taking a first look');
      let first;
      try {
        [first] = await watcher.runDue({ ids: [w.id] });
      } finally {
        sp.stop();
      }
      if (json) return print(JSON.stringify(first?.watch || w, null, 2));
      print(`${c.green('✔')} Watching ${c.bold(`#${w.id}`)} ${label(w)} ${c.dim(`· ${w.type} · every ${formatInterval(w.everyMs)}`)}`);
      if (w.note) print(c.dim(`  only telling you about: ${w.note}`));
      if (first?.error) print(`${c.yellow('!')} First check failed: ${first.error.message}\n${c.dim('  Titen will keep trying, waiting a bit longer each time.')}`);
      else print(c.dim('  First snapshot saved. You will be notified when something meaningful changes.'));
      print(c.dim(`  Keep it running with ${c.cyan('titen watch daemon')} (or run ${c.cyan('titen watch run')} from a scheduler).`));
      return;
    }

    case 'list':
    case 'ls': {
      const list = watcher.list();
      if (json) return print(JSON.stringify(list, null, 2));
      if (!list.length) return print(`\nNothing watched yet. Try: ${c.cyan('titen watch add "AI regulation"')}\n`);
      print(`\n${c.coral(c.bold('TITEN'))} ${c.dim('·')} ${c.bold('WATCHES')}\n${c.dim('─'.repeat(72))}`);
      for (const w of list) {
        const status = w.lastError ? c.red(`failing ×${w.failures}`) : w.lastCheckAt ? c.green('ok') : c.dim('new');
        print(`${c.coral(`#${w.id}`.padEnd(4))} ${label(w)} ${c.dim(`[${w.type}]`)}`);
        print(c.dim(`     every ${formatInterval(w.everyMs)} · next ${until(w.nextCheckAt)} · last change ${w.lastChangeAt ? timeAgo(w.lastChangeAt) : 'none yet'} · `) + status);
        if (w.note) print(c.dim(`     note: ${w.note}`));
        if (w.lastError) print(c.dim(`     last error: ${w.lastError}`));
      }
      return print();
    }

    case 'remove':
    case 'rm': {
      const id = rest[0];
      if (!id) throw new TitenError(ErrorCodes.BAD_INPUT, 'Which one? Example: titen watch remove 2');
      watcher.remove(id);
      return print(`${c.green('✔')} Stopped watching #${id}.`);
    }

    case 'run': {
      needKey();
      const sp = spinner('Checking your watches');
      let results;
      try {
        results = await watcher.runDue({ force: Boolean(values.force) });
      } finally {
        sp.stop();
      }
      if (json) return print(JSON.stringify(results.map((r) => ({ watch: r.watch, result: r.result, error: r.error?.message, notified: r.notified, usage: r.usage })), null, 2));
      if (!results.length) return print(c.dim(`Nothing is due yet. Use --force to check everything now.`));
      for (const r of results) print(describe(r));
      const cost = costOf(results);
      return print(c.dim(`\n◦ ${results.length} checked · ${cost ? `≈ $${cost.toFixed(4)}` : 'no AI needed · $0'}`));
    }

    case 'daemon': {
      needKey();
      const count = watcher.list().length;
      if (!count) throw new TitenError(ErrorCodes.BAD_INPUT, 'Nothing to watch yet. Add something first: titen watch add <url | "topic">');
      const controller = new AbortController();
      const stop = () => {
        if (!controller.signal.aborted) print(c.dim('\nStopping. Your watches are saved.'));
        controller.abort();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      print(`${c.coral(c.bold('Titen'))} is watching ${count} thing${count === 1 ? '' : 's'}. ${c.dim('Leave this window open · Ctrl+C to stop')}`);
      let total = 0;
      await watcher.daemon({
        signal: controller.signal,
        onResult: (r) => {
          total += r.usage?.cost || 0;
          const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          print(`${c.dim(time)} ${describe(r)}`);
        },
      });
      return print(c.dim(`Spent ≈ $${total.toFixed(4)} this session.`));
    }

    case 'log': {
      const entries = watcher.log({ id: rest[0], limit: 20 });
      if (json) return print(JSON.stringify(entries, null, 2));
      if (!entries.length) return print(c.dim('No changes recorded yet.'));
      print(`\n${c.coral(c.bold('TITEN'))} ${c.dim('·')} ${c.bold('WHAT CHANGED')}\n${c.dim('─'.repeat(72))}`);
      for (const e of entries) {
        print(`${c.coral(`#${e.id}`)} ${c.bold(e.type === 'topic' ? `"${e.target}"` : e.target)} ${c.dim(`· ${timeAgo(e.at)}`)}`);
        print(wrap(e.summary, 3));
        for (const it of e.items || []) print(`   ↳ ${linkText(it.title, it.url)}`);
        if (e.type === 'page' && e.link) print(`   ${linkText('open the page', e.link)}`);
        print();
      }
      return;
    }

    case 'test': {
      const ok = await watcher.notify({ title: 'Titen · test', message: 'Notifications work. Titen will tell you here when something you watch changes.' });
      return print(ok ? `${c.green('✔')} Notification sent. Did you see it?` : `${c.yellow('!')} This system did not accept a desktop notification. Titen will print changes in the terminal instead.`);
    }

    default:
      throw new TitenError(ErrorCodes.BAD_INPUT, `Unknown watch command "${sub}". Run: titen watch --help`);
  }
}
