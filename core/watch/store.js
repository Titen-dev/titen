import fs from 'node:fs';
import path from 'node:path';

/**
 * Watches live in <home>/watches.json, the last seen state of each watch in
 * <home>/watch/<id>.json, and detected changes in <home>/watch-log.jsonl.
 */
export function createStore(home) {
  const file = path.join(home, 'watches.json');
  const snapDir = path.join(home, 'watch');
  const logFile = path.join(home, 'watch-log.jsonl');

  const writeAtomic = (target, data) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  };

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { nextId: data.nextId || 1, watches: Array.isArray(data.watches) ? data.watches : [] };
    } catch {
      return { nextId: 1, watches: [] };
    }
  }

  function save(state) {
    writeAtomic(file, JSON.stringify({ version: 1, ...state }, null, 2));
  }

  function readSnapshot(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(snapDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  function writeSnapshot(id, snap) {
    writeAtomic(path.join(snapDir, `${id}.json`), JSON.stringify(snap));
  }

  function removeSnapshot(id) {
    fs.rmSync(path.join(snapDir, `${id}.json`), { force: true });
  }

  function appendLog(entry) {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    // Keep the log small: trim to the last 500 entries now and then.
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      if (lines.length > 600) writeAtomic(logFile, `${lines.slice(-500).join('\n')}\n`);
    } catch {
      /* ignore */
    }
  }

  function readLog({ id, limit = 20 } = {}) {
    try {
      return fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => !id || e.id === String(id))
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  return { load, save, readSnapshot, writeSnapshot, removeSnapshot, appendLog, readLog };
}
