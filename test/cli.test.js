import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { startMockOpenRouter, tmpDir } from './helpers/mock.js';

const CLI = fileURLToPath(new URL('../cli/index.js', import.meta.url));
let mock;
before(async () => {
  mock = await startMockOpenRouter(() => ({
    content: JSON.stringify({ verdict: 'likely_scam', confidence: 90, summary: 'Classic prize scam.', redFlags: [{ flag: 'Prize you never entered', evidence: 'won $5000' }], whatToDo: ['Ignore it'] }),
  }));
});
after(() => mock.close());

function run(args, env = {}, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', TITEN_HOME: tmpDir(), OPENROUTER_BASE_URL: mock.url, OPENROUTER_API_KEY: 'test-key', ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test('help and version', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /trends\s+What's trending/);
  const v = await run(['--version']);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const sub = await run(['tldr', '--help']);
  assert.match(sub.stdout, /titen tldr <url>/);
});

test('unknown command and option fail with exit code 1', async () => {
  assert.equal((await run(['nope'])).code, 1);
  const bad = await run(['trends', '--wat']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown option/);
});

test('missing key gives a setup hint', async () => {
  const r = await run(['trends'], { OPENROUTER_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /titen setup/);
});

test('scam --json works end to end against the mock', async () => {
  const r = await run(['scam', 'Congrats! You won $5000, reply with your bank details', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'likely_scam');
  assert.equal(out.usage.calls, 1);
});

test('scam reads the message from stdin and prints a readable card', async () => {
  const r = await run(['scam'], {}, 'You won a prize, send a gift card');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /LIKELY SCAM/);
  assert.match(r.stdout, /What to do/);
  assert.match(r.stdout, /≈ \$0\.0001/);
});

test('setup --key validates and saves the key', async () => {
  const home = tmpDir();
  const r = await run(['setup', '--key', 'good-key', '--model', 'x/y'], { TITEN_HOME: home }, '');
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { apiKey: 'good-key', model: 'x/y' });
  const bad = await run(['setup', '--key', 'bad-key'], { TITEN_HOME: tmpDir() }, '');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /rejected/);
});

test('brief --list --json prints the topic list without a key', async () => {
  const r = await run(['brief', '--list', '--json'], { OPENROUTER_API_KEY: '' });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).length, 20);
});
