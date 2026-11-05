import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Tiny file cache with TTL and single-flight:
 * concurrent callers asking for the same missing key share one generation.
 */
export function createCache(dir) {
  const inflight = new Map();
  const fileFor = (key) => path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);

  async function get(key) {
    try {
      const entry = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
      if (entry.expires > Date.now()) return entry.value;
    } catch {
      /* missing or corrupt → treat as miss */
    }
    return undefined;
  }

  /** Stored entry even when expired: { value, expires } or undefined. Used for stale-while-revalidate. */
  async function peek(key) {
    try {
      const entry = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
      return { value: entry.value, expires: entry.expires };
    } catch {
      return undefined;
    }
  }

  async function set(key, value, ttlMs) {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileFor(key)}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ key, expires: Date.now() + ttlMs, value }));
    await fs.rename(tmp, fileFor(key));
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

/** Milliseconds until the next UTC midnight (used for "once per day" items). */
export function msUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(next - now.getTime(), 60_000);
}

export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
