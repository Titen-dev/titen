import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Cache with TTL and single-flight on top of any key/value storage:
 * concurrent callers asking for the same missing key share one generation.
 *
 * storage = { read(key) → { value, expires } | undefined, write(key, entry, ttlMs) }
 * Built-in storages: files (CLI / Node server), memory, and Workers KV (see worker/).
 */
export function createCacheWith(storage) {
  const inflight = new Map();

  /** Stored entry even when expired: { value, expires } or undefined. Used for stale-while-revalidate. */
  async function peek(key) {
    try {
      const entry = await storage.read(key);
      return entry ? { value: entry.value, expires: entry.expires } : undefined;
    } catch {
      return undefined; // missing or corrupt → treat as miss
    }
  }

  async function get(key) {
    const entry = await peek(key);
    return entry && entry.expires > Date.now() ? entry.value : undefined;
  }

  async function set(key, value, ttlMs) {
    await storage.write(key, { key, expires: Date.now() + ttlMs, value }, ttlMs);
  }

  /** Returns { value, cached }. `refresh: true` skips the stored value (still single-flight). */
  async function getOrCreate(key, ttlMs, create, { refresh = false } = {}) {
    if (!refresh) {
      const hit = await get(key);
      if (hit !== undefined) return { value: hit, cached: true };
    }
    if (inflight.has(key)) return { value: await inflight.get(key), cached: false };

    const p = (async () => {
      const value = await create();
      await set(key, value, ttlMs).catch(() => {});
      return value;
    })();
    inflight.set(key, p);
    try {
      return { value: await p, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  const isInflight = (key) => inflight.has(key);

  return { get, peek, set, getOrCreate, isInflight };
}

/** File-backed cache (one JSON file per key) for the CLI and the Node web server. */
export function createCache(dir) {
  const fileFor = (key) => path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
  return createCacheWith({
    async read(key) {
      return JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
    },
    async write(key, entry) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${fileFor(key)}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry));
      await fs.rename(tmp, fileFor(key));
    },
  });
}

/** In-memory cache (lost on restart). */
export function createMemoryCache(maxEntries = 500) {
  const map = new Map();
  return createCacheWith({
    async read(key) {
      return map.get(key);
    },
    async write(key, entry) {
      map.delete(key);
      map.set(key, entry);
      if (map.size > maxEntries) map.delete(map.keys().next().value); // drop the oldest
    },
  });
}

/** Milliseconds until the next UTC midnight (used for "once per day" items). */
export function msUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(next - now.getTime(), 60_000);
}

export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
