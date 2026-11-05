import { getConfig, titenHome } from '../config.js';
import { parsePublicUrl } from '../http.js';
import { isUnreadableSite } from '../sources/fetchPage.js';
import { Usage } from '../usage.js';
import { TitenError, ErrorCodes } from '../errors.js';
import * as realSources from '../sources/index.js';
import { createStore } from './store.js';
import { checkPage, checkTopic } from './check.js';
import { notify as realNotify } from './notify.js';
import { parseInterval, nextDelay, looksLikeUrl } from './text.js';

export { parseInterval, formatInterval, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS } from './text.js';

const MAX_WATCHES = 50;

/**
 * Everything Titen watches for one user. Storage defaults to ~/.titen.
 * `notify` and `sources` can be swapped in tests.
 */
export function createWatcher({ home = titenHome(), config = getConfig(), sources = realSources, notify = realNotify, now = () => Date.now() } = {}) {
  const store = createStore(home);

  function add({ target, every, note } = {}) {
    const raw = String(target || '').trim();
    if (!raw) throw new TitenError(ErrorCodes.BAD_INPUT, 'Tell Titen what to watch: a link, or a topic in quotes.');
    const everyMs = parseInterval(every);
    const state = store.load();
    if (state.watches.length >= MAX_WATCHES) throw new TitenError(ErrorCodes.BAD_INPUT, `You already have ${MAX_WATCHES} watches. Remove one first.`);

    let type = 'topic';
    let value = raw.slice(0, 120);
    if (looksLikeUrl(raw)) {
      const u = parsePublicUrl(raw); // validates and blocks local/private addresses
      if (isUnreadableSite(u.hostname)) throw new TitenError(ErrorCodes.UNREADABLE, `${u.hostname} needs a login or JavaScript, so Titen can't watch it.`);
      type = 'page';
      value = u.toString();
    }
    if (state.watches.some((w) => w.type === type && w.target.toLowerCase() === value.toLowerCase())) {
      throw new TitenError(ErrorCodes.BAD_INPUT, 'You are already watching that.');
    }

    const watch = {
      id: String(state.nextId),
      type,
      target: value,
      note: String(note || '').trim().slice(0, 300),
      everyMs,
      createdAt: new Date(now()).toISOString(),
      nextCheckAt: new Date(now()).toISOString(), // check (and take a baseline) on the next run
      lastCheckAt: null,
      lastChangeAt: null,
      failures: 0,
      lastError: null,
      title: null,
    };
    store.save({ nextId: state.nextId + 1, watches: [...state.watches, watch] });
    return watch;
  }

  function list() {
    return store.load().watches;
  }

  function remove(id) {
    const state = store.load();
    const next = state.watches.filter((w) => w.id !== String(id));
    if (next.length === state.watches.length) throw new TitenError(ErrorCodes.BAD_INPUT, `No watch with id ${id}. Run "titen watch list" to see ids.`);
    store.save({ ...state, watches: next });
    store.removeSnapshot(String(id));
    return true;
  }

  function log({ id, limit } = {}) {
    return store.readLog({ id, limit });
  }

  /** Check one watch now. Never throws: failures are recorded on the watch. */
  async function checkOne(watch, { signal } = {}) {
    const usage = new Usage();
    const prev = store.readSnapshot(watch.id);
    const at = new Date(now()).toISOString();
    try {
      const r = watch.type === 'page'
        ? await checkPage(watch, prev, { sources, config, usage, signal })
        : await checkTopic(watch, prev, { sources, config, usage, signal });
      store.writeSnapshot(watch.id, r.snapshot);
      const updated = {
        ...watch,
        title: r.title || watch.title,
        lastCheckAt: at,
        failures: 0,
        lastError: null,
        nextCheckAt: new Date(now() + watch.everyMs).toISOString(),
        ...(r.meaningful ? { lastChangeAt: at } : {}),
      };
      let notified = false;
      if (r.meaningful) {
        const link = watch.type === 'page' ? r.url || watch.target : r.items?.[0]?.url;
        store.appendLog({ id: watch.id, at, type: watch.type, target: watch.target, summary: r.summary, link, items: (r.items || []).slice(0, 5).map((i) => ({ title: i.title, url: i.url, source: i.source })) });
        const name = watch.type === 'page' ? watch.title || r.title || new URL(watch.target).hostname : watch.target;
        notified = await notify({ title: `Titen · ${name}`, message: r.summary, url: link });
      }
      return { watch: updated, result: { ...r, snapshot: undefined }, notified, usage: usage.toJSON() };
    } catch (e) {
      const failures = (watch.failures || 0) + 1;
      return {
        watch: { ...watch, lastCheckAt: at, failures, lastError: String(e.message).slice(0, 200), nextCheckAt: new Date(now() + nextDelay(watch.everyMs, failures)).toISOString() },
        error: e,
        usage: usage.toJSON(),
      };
    }
  }

  /** Check every watch that is due (or all with force). Returns one entry per checked watch. */
  async function runDue({ force = false, ids, signal, onResult } = {}) {
    const state = store.load();
    const due = state.watches.filter((w) => (ids ? ids.includes(w.id) : force || new Date(w.nextCheckAt).getTime() <= now()));
    const results = [];
    for (const w of due) {
      if (signal?.aborted) break;
      const r = await checkOne(w, { signal });
      results.push(r);
      // Save after each check so a crash or Ctrl+C never loses progress.
      const latest = store.load();
      store.save({ ...latest, watches: latest.watches.map((x) => (x.id === w.id ? r.watch : x)) });
      onResult?.(r);
    }
    return results;
  }

  /** Keep running until the signal aborts. Wakes up every `tickMs` to check what is due. */
  async function daemon({ signal, tickMs = 60_000, onResult, onTick } = {}) {
    while (!signal?.aborted) {
      await runDue({ signal, onResult });
      onTick?.();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, tickMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }

  return { add, list, remove, log, checkOne, runDue, daemon, notify };
}
