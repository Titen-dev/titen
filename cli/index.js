#!/usr/bin/env node
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import {
  getTrends, getBrief, getTldr, checkScam, ChatAgent, REGIONS, WEB_TOPICS,
  getConfig, saveConfigFile, configFile, checkKey, DEFAULT_MODEL, TitenError,
} from '../core/index.js';
import { c, wrap, spinner, costLine, renderTrends, renderBrief, renderTldr, renderScam } from './ui.js';
import { watchCommand } from './watch.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = {
  main: `
${c.coral(c.bold('titen'))} ${c.dim(`v${pkg.version}`)} — an AI agent that reads the signs of the world
${c.dim('Reads the signs of the world through careful observation.')}

${c.bold('Usage')}
  titen <command> [options]

${c.bold('Commands')}
  ${c.cyan('trends')}              What's trending in the world right now
  ${c.cyan('brief')} <topic>       Daily brief on any topic (last ~48h of news)
  ${c.cyan('tldr')} <url>          Summarize any web page
  ${c.cyan('scam')} [message]      Is this message / link / screenshot a scam?
  ${c.cyan('chat')}                Talk to Titen (it can use all of the above)
  ${c.cyan('watch')} <command>     Watch a page or a topic and get notified of changes
  ${c.cyan('setup')}               Save your OpenRouter API key and model

${c.bold('Global options')}
  --json        Print raw JSON          --model <id>   Use another OpenRouter model
  --no-color    Plain output            -h, --help     Help for a command
  -v, --version Show version

Run ${c.cyan('titen <command> --help')} for details. Get an API key at https://openrouter.ai/keys
`,
  trends: `
${c.bold('titen trends')} [--region <code>] [--refresh] [--json]

  The 8-10 most important things happening now, from Google Trends, Google News,
  Hacker News and GitHub. Cached for 6 hours.

  --region   ${Object.keys(REGIONS).join(', ')} (default: global)
  --refresh  Ignore the cache and rebuild now
`,
  brief: `
${c.bold('titen brief')} <topic> [--refresh] [--json]
${c.bold('titen brief')} --list

  A short digest of the last ~48 hours of news on any topic. Cached per topic per day.

  Examples:
    titen brief "electric cars"
    titen brief AI
`,
  tldr: `
${c.bold('titen tldr')} <url> [--refresh] [--json]

  TL;DR, key points and "what's missing" for any readable page. Cached for 24 hours.
  Pages behind logins (X, TikTok, Instagram, Facebook) or paywalls can't be read.
`,
  scam: `
${c.bold('titen scam')} "<message>" [--url <link>] [--image <screenshot>] [--json]

  Judges whether a message, link or screenshot is a scam. Links are analyzed
  (domain age, look-alike names, shorteners) but never opened.

  Examples:
    titen scam "Your parcel is on hold, pay $1.99 at dhl-redelivery.top"
    titen scam --url paypa1-secure.com
    titen scam --image ./screenshot.png
    pbpaste | titen scam          (reads the message from stdin)
`,
  chat: `
${c.bold('titen chat')}

  Free conversation. Titen can search news and the web, read pages, and use
  trends / brief / tldr / scam check by itself.
  In chat: /new (fresh conversation), /cost, /exit
`,
  watch: `
${c.bold('titen watch')} <command>

  Titen checks what you watch on a schedule. Small noise (clocks, dates, view
  counters) is ignored, and the AI is only asked when something really changed,
  so quiet days cost nothing. Meaningful changes show up as a desktop notification.

  ${c.cyan('add')} <url | "topic"> [--every 6h] [--note "what I care about"]
      Watch a web page (price, status, announcements) or a news topic.
      --every   how often: 15m minimum, e.g. 30m, 6h, 1d (default 6h)
      --note    what counts as news for you, e.g. "only when the price drops"
  ${c.cyan('list')}                       All watches and when they run next
  ${c.cyan('remove')} <id>                Stop watching
  ${c.cyan('run')} [--force]              Check what's due once, then exit (--force: check all now)
  ${c.cyan('daemon')}                     Keep running and check on schedule (Ctrl+C to stop)
  ${c.cyan('log')} [<id>]                 Recent changes Titen found
  ${c.cyan('test')}                       Show a test notification

  Examples:
    titen watch add https://store.example.com/product/123 --every 1h --note "price or stock"
    titen watch add "GTA 6 release" --every 6h
    titen watch daemon
`,
  setup: `
${c.bold('titen setup')} [--key <openrouter-key>] [--model <id>]

  Saves your settings to ${configFile()}
  Env vars OPENROUTER_API_KEY and TITEN_MODEL override the file.
`,
};

const OPTIONS = {
  json: { type: 'boolean' },
  refresh: { type: 'boolean' },
  region: { type: 'string' },
  url: { type: 'string' },
  image: { type: 'string' },
  model: { type: 'string' },
  key: { type: 'string' },
  list: { type: 'boolean' },
  every: { type: 'string' },
  note: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
};

function print(s) {
  process.stdout.write(`${s}\n`);
}

function fail(msg, hint) {
  process.stderr.write(`${c.red('✖')} ${msg}\n${hint ? c.dim(`  ${hint}\n`) : ''}`);
  process.exitCode = 1;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Run a feature with a spinner, then print JSON or the pretty renderer. */
async function run(label, task, render, json) {
  const sp = spinner(label);
  let result;
  try {
    result = await task();
  } finally {
    sp.stop();
  }
  if (json) print(JSON.stringify(result, null, 2));
  else print(`${render(result)}${costLine(result)}\n`);
}

// ---------- setup ----------

async function askHidden(question) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(question);
    rl.close();
    return a;
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      // Drop terminal escape sequences: bracketed-paste markers (ESC[200~ … ESC[201~) and arrow keys.
      const input = buf.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '');
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function setup(values) {
  print(`\n${c.coral(c.bold('Titen setup'))}`);
  print(c.dim(`Settings are saved to ${configFile()}\n`));

  let key = values.key?.trim();
  if (!key) {
    print(`Get a key at ${c.cyan('https://openrouter.ai/keys')} (Titen uses your own OpenRouter credit).`);
    key = (await askHidden('OpenRouter API key: ')).trim();
  }
  if (!key) return fail('No key entered. Nothing was saved.');

  const sp = spinner('Checking key with OpenRouter');
  let info;
  try {
    info = await checkKey(key);
  } finally {
    sp.stop();
  }
  const remaining = info.limit_remaining ?? (info.limit != null ? info.limit - (info.usage || 0) : null);
  print(`${c.green('✔')} Key works${info.label ? c.dim(` (${info.label})`) : ''}${remaining != null ? c.dim(` · $${Number(remaining).toFixed(2)} left on this key`) : ''}`);

  let model = values.model?.trim();
  if (!model && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    model = (await rl.question(`Model ${c.dim(`(Enter for ${getConfig().model || DEFAULT_MODEL})`)}: `)).trim();
    rl.close();
  }
  saveConfigFile({ apiKey: key, ...(model ? { model } : {}) });
  print(`${c.green('✔')} Saved. Try: ${c.cyan('titen trends')}\n`);
}

// ---------- chat ----------

async function chatLoop(config) {
  const agent = new ChatAgent({ config });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  print(`\n${c.coral(c.bold('Titen chat'))} ${c.dim(`· ${config.model} · /new /cost /exit`)}\n`);
  while (true) {
    let input;
    try {
      input = (await rl.question(c.bold('you › '))).trim();
    } catch {
      break;
    }
    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;
    if (input === '/new') {
      agent.reset();
      print(c.dim('Started a fresh conversation.\n'));
      continue;
    }
    if (input === '/cost') {
      const u = agent.usage.toJSON();
      print(c.dim(`≈ $${u.cost.toFixed(4)} · ${u.calls} AI calls · ${u.promptTokens + u.completionTokens} tokens\n`));
      continue;
    }
    const sp = spinner('Thinking');
    try {
      const answer = await agent.send(input, {
        onEvent: (ev) => {
          if (ev.type === 'tool_start') {
            const arg = Object.values(ev.args || {})[0];
            sp.update(`${ev.name.replace(/_/g, ' ')}${arg ? c.dim(` ${String(arg).slice(0, 60)}`) : ''}`);
          }
        },
      });
      sp.stop();
      print(`\n${c.coral('titen ›')} ${answer}\n`);
    } catch (e) {
      sp.stop();
      fail(e.message);
      process.exitCode = 0;
    }
  }
  rl.close();
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return fail(e.message.replace(/^TypeError \[[A-Z_]+\]: /, ''), 'Run titen --help');
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) return print(pkg.version);
  if (!command || command === 'help') return print(HELP[rest[0]] || HELP.main);
  if (!HELP[command]) return fail(`Unknown command "${command}".`, 'Run titen --help to see all commands.');
  if (values.help) return print(HELP[command]);

  const config = getConfig(values.model ? { model: values.model } : {});
  const json = Boolean(values.json);
  const needsKey = ['trends', 'brief', 'tldr', 'scam', 'chat'].includes(command) && !(command === 'brief' && values.list);
  if (needsKey && !config.apiKey) {
    return fail('No OpenRouter API key yet.', 'Run: titen setup   (or set OPENROUTER_API_KEY). Keys: https://openrouter.ai/keys');
  }

  switch (command) {
    case 'setup':
      return setup(values);

    case 'trends':
      return run(
        'Reading the signs: trends, news, Hacker News, GitHub',
        () => getTrends({ region: values.region || 'global', refresh: values.refresh, config }),
        renderTrends,
        json
      );

    case 'brief': {
      if (values.list) {
        if (json) return print(JSON.stringify(WEB_TOPICS, null, 2));
        return print(`\n${c.bold('Suggested topics')} ${c.dim('(any topic works)')}\n${wrap(WEB_TOPICS.map((t) => t.label.replace(/ /g, ' ')).join(' · '), 2)}\n`);
      }
      const topic = rest.join(' ').trim();
      if (!topic) return fail('Please give a topic.', 'Example: titen brief "electric cars"');
      return run(`Writing your brief on ${topic}`, () => getBrief({ topic, refresh: values.refresh, config }), renderBrief, json);
    }

    case 'tldr': {
      const url = rest[0] || values.url;
      if (!url) return fail('Please give a link.', 'Example: titen tldr https://example.com/article');
      return run('Reading the page', () => getTldr({ url, refresh: values.refresh, config }), renderTldr, json);
    }

    case 'scam': {
      let text = rest.join(' ').trim();
      if (!text && !values.url && !values.image) text = await readStdin();
      if (!text && !values.url && !values.image) return fail('Give Titen something to check.', 'Example: titen scam "your message" | --url <link> | --image <file>');
      return run(
        values.image ? 'Looking at the screenshot' : 'Checking for scam signs',
        () => checkScam({ text, url: values.url, imagePath: values.image, config }),
        renderScam,
        json
      );
    }

    case 'watch':
      return watchCommand(rest, values, config);

    case 'chat':
      if (!process.stdin.isTTY) return fail('titen chat needs an interactive terminal.');
      return chatLoop(config);
  }
}

main().catch((e) => {
  if (e instanceof TitenError) {
    const hint = e.code === 'NO_KEY' || e.code === 'BAD_KEY' ? 'Run: titen setup' : undefined;
    fail(e.message, hint);
  } else {
    fail(`Unexpected error: ${e.message}`, 'If this keeps happening, run with --json and share the output.');
  }
});
