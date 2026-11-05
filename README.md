# Titen

**An AI agent that reads the signs of the world.**

Titen is named after *ilmu titen*, the old Javanese art of reading signs and patterns through careful, patient observation. It watches what's happening and tells you what matters, in plain English.

| Command | What it does |
|---|---|
| `titen trends` | The 8–10 most important things happening right now (Google Trends, Google News, Hacker News, GitHub) |
| `titen brief <topic>` | A short digest of the last ~48 hours of news on any topic |
| `titen tldr <url>` | TL;DR, key points and "what's missing" for any readable web page |
| `titen scam` | Is this message, link or screenshot a scam? |
| `titen chat` | Talk to Titen; it can use all of the above by itself |

Every claim links to its source. Titen only cites sources it actually collected, so it can't invent links.

## Install

Requires Node.js 20.12 or newer.

```bash
npm install -g titen      # once published; for now: npm link (from this folder)
titen setup               # paste your OpenRouter API key
```

Titen runs on **your own [OpenRouter](https://openrouter.ai/keys) key**. The default model is `anthropic/claude-haiku-5.5`, which is cheap: most commands cost a fraction of a cent.

## Usage

```bash
titen trends                       # global
titen trends --region gb           # us, gb, in, ca, au, de, fr, jp, br, id, ng, sg
titen brief "electric cars"
titen brief --list                 # suggested topics
titen tldr https://example.com/some-article
titen scam "Your parcel is on hold, pay $1.99 at dhl-redelivery.top"
titen scam --url paypa1-secure.com
titen scam --image ./screenshot.png
pbpaste | titen scam               # message from stdin
titen chat
```

Options for every command: `--json` (raw output), `--model <id>` (any OpenRouter model with tool support), `--refresh` (skip the cache), `--no-color`, `--help`.

Sources are shown as clickable links in terminals that support them. If yours doesn't, set `TITEN_PLAIN_LINKS=1` to print full URLs.

### Costs and caching

- Trend Radar is cached for 6 hours, briefs once per topic per day, TL;DRs for 24 hours (in `~/.titen/cache`).
- Web search (OpenRouter web plugin, about $0.007 per search) is only used when free sources are not enough.
- Each command prints its cost at the end.

### Scam Check, in short

Links are analyzed but **never opened**: domain age (RDAP), look-alike brand names (`paypa1`, `amaz0n`), link shorteners, risky endings, raw IPs, punycode. The AI then reads the message or screenshot and gives a verdict (`likely scam`, `suspicious`, `looks safe`) with red flags and clear next steps. Titen is an AI and can be wrong; always verify through official channels.

## Watch (CLI)

Let Titen keep an eye on a page or a topic and tell you when something meaningful changes.

```bash
titen watch add https://store.example.com/product/123 --every 1h --note "price or stock"
titen watch add "GTA 6 release" --every 6h
titen watch list
titen watch daemon            # keep running; Ctrl+C to stop
titen watch run               # check what's due once (for schedulers)
titen watch log               # what changed recently
titen watch remove 2
titen watch test              # show a test desktop notification
```

How it works:

- **Pages**: Titen reads the page, strips noise (clocks, dates, "5 minutes ago", view counters) and compares it with the last snapshot. Only when the text really changed does it ask the AI whether the change matters (using your `--note` if you gave one).
- **Topics**: Titen looks for headlines it hasn't seen before; the AI keeps only the relevant ones and sums them up.
- No change means no AI call, so quiet days cost nothing. A typical change costs a fraction of a cent.
- Minimum interval is 15 minutes. If a site fails, Titen waits longer before trying again (up to a day).
- Notifications use the system itself: Windows toast, macOS Notification Center, `notify-send` on Linux. If none works, changes are printed in the terminal. Set `TITEN_NOTIFY=0` to turn them off.
- Data lives in `~/.titen/watches.json`, snapshots in `~/.titen/watch/`, the change log in `~/.titen/watch-log.jsonl`.

### Run it automatically

`titen watch daemon` only runs while its terminal is open. To check in the background, schedule `titen watch run` instead (it exits after checking what is due):

- **Windows** (Task Scheduler, every 15 minutes):
  ```powershell
  schtasks /Create /SC MINUTE /MO 15 /TN "Titen Watch" /TR "cmd /c titen watch run"
  ```
  Remove it with `schtasks /Delete /TN "Titen Watch" /F`.
- **macOS** (launchd): create `~/Library/LaunchAgents/dev.titen.watch.plist` with `ProgramArguments` = the full path of `titen` plus `watch`, `run`, and `StartInterval` = `900`, then `launchctl load ~/Library/LaunchAgents/dev.titen.watch.plist`.
- **Linux** (cron): `*/15 * * * * titen watch run >/dev/null 2>&1` in `crontab -e`, or a systemd user timer.

## Website

The same four features run as a public website: English only, no login, a dark "Night Console" design (deep nila, coral signals, serif headlines, monospace data). Trends on the web are global only.

```bash
npm start            # http://localhost:3000
npm run web          # same, and opens Chrome (Windows)
```

On Windows you can also double-click **Start Titen.bat**.

| Route | What it does |
|---|---|
| `/` | Globe hero, live process panel (real counters), measured cards, global Trend Radar, tools |
| `/brief` | Daily Brief for up to 6 of 20 fixed topics (choice saved in the browser) |
| `/tldr` | TL;DR for a link |
| `/scam` | Scam Check with text, link or screenshot (resized in the browser, never stored) |
| `/about` | The story of ilmu titen, limits, privacy |

The website runs on the owner's OpenRouter key (`OPENROUTER_API_KEY`). Protection is deliberately light: about one request per 5 seconds per visitor (small bursts allowed), same-origin JSON only, a 5 MB image cap, strict security headers, and no logging of what people paste. Trend Radar is shared by everyone and refreshed at most every 6 hours (stale results are shown instantly while a fresh scan runs in the background); each brief is written once per topic per day. Set a spending limit on the key in the OpenRouter dashboard as an emergency brake.

Environment variables for the server: `PORT` (default 3000), `HOST` (default 127.0.0.1, or 0.0.0.0 when `NODE_ENV=production`), `TRUST_PROXY=1` behind a reverse proxy, `WARM_TRENDS=0` to skip the first scan on start.

## Configuration

`titen setup` saves to `~/.titen/config.json`. Environment variables override it:

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Your OpenRouter key |
| `TITEN_MODEL` | Model id (default `anthropic/claude-haiku-5.5`) |
| `TITEN_SEARCH_ENGINE` | Web search engine: `exa` (default), `parallel`, `perplexity`, `native` |
| `TITEN_HOME` | Where config and cache live (default `~/.titen`) |

## Development

```bash
npm test                 # unit + integration tests (no API key needed, uses a mock OpenRouter)
node cli/index.js trends # run the CLI from source
```

Project layout:

```
core/        the brain: LLM calls, data sources, features (trends, brief, tldr, scam), chat agent
cli/         terminal interface
web/         website: server.js (API + pages), views/ (templates), public/ (CSS, JS, icons)
test/        node:test suites + fixtures + mock OpenRouter
```

## Privacy

Titen sends your input to OpenRouter and the model provider to answer it. It keeps nothing except the local cache in `~/.titen`. Never paste passwords or one-time codes.
