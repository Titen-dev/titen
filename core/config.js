import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A local .env (development) is loaded once. Real env vars always win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* ignore malformed .env */
  }
}

export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';

export function titenHome() {
  return process.env.TITEN_HOME || path.join(os.homedir(), '.titen');
}

export function configFile() {
  return path.join(titenHome(), 'config.json');
}

export function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfigFile(patch) {
  const next = { ...readConfigFile(), ...patch };
  fs.mkdirSync(titenHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(configFile(), 0o600);
  } catch {
    /* not supported on every OS */
  }
  return next;
}

/** Effective settings: env vars override ~/.titen/config.json, which overrides defaults. */
export function getConfig(overrides = {}) {
  const file = readConfigFile();
  const env = process.env;
  return {
    // `||` on purpose: an empty OPENROUTER_API_KEY= line in .env must not hide the saved key.
    apiKey: (overrides.apiKey ?? (env.OPENROUTER_API_KEY || file.apiKey || '')).trim(),
    model: overrides.model || env.TITEN_MODEL || file.model || DEFAULT_MODEL,
    baseUrl: (overrides.baseUrl || env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    searchEngine: overrides.searchEngine || env.TITEN_SEARCH_ENGINE || file.searchEngine || 'exa',
    cacheDir: overrides.cacheDir || env.TITEN_CACHE_DIR || path.join(titenHome(), 'cache'),
  };
}
