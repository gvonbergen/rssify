# RSSify

Self-hosted service that scrapes websites into cleaned, distraction-free HTML,
indexes new articles on a schedule, and serves them as **RSS 2.0 feeds** at
`<RSSify-domain>/<site>`. Optional LLM article extraction reproduces the full
body verbatim (title, text, date) in parallel with the tag-based extractor.

This repository is the **Phase 1 MVP** implementation of [`PLAN.md`](PLAN.md).

> **New here?** [`FUNCTIONS.md`](FUNCTIONS.md) is the complete function/module
> reference — every CLI command, exported function, config knob, DB table and
> HTTP route, with a fast-navigation table.

## Requirements

- **Node.js ≥ 25** (uses native TypeScript type-stripping — no build step).
- `pi` (the coding agent) at `/opt/homebrew/bin/pi` for `rssify add` of new
  domains (set `PI_BIN` env if elsewhere).

## Install & run

```sh
npm install
# First run creates config.yaml + .env with defaults.
node src/cli.ts list
```

CLI entry: `node src/cli.ts <command>` (or `npm run`). A `bin/rssify` launcher
is wired via `npm link` if you want it on `PATH`.

## Testing

See [TESTING.md](TESTING.md) for the deterministic unit, HTTP-route, and SQLite persistence suite.

```sh
npm run typecheck
npm test
```

## Docker

```sh
cp docker-compose.example.yml docker-compose.yml   # your local file stays out of git
cp config.example.yaml config.yaml   # Docker: keep server.host 0.0.0.0
cp .env.example .env                  # fill in AI_API_KEY / FIRECRAWL_API_KEY
docker compose up -d --build          # serves on http://<host>:3000
```

### External access

By default feeds are served on whatever host you reach the server on
(`http://<host>:3000`). To give feeds a stable public URL (useful behind a
reverse proxy with TLS), set `server.public_url` in `config.yaml` — feed
self-links (`atom:link self`) then point at that base even when the request
arrives via an internal IP/hostname:

```yaml
server:
  host: 0.0.0.0
  port: 3000
  public_url: https://rssify.example.com
```

With Traefik on the same host, label-based discovery works without a custom
compose file — see the commented `traefik` block in `docker-compose.example.yml`.

Secrets are **not** baked into the image — `config.yaml` and `.env` are
bind-mounted read-only, edit them on the host and `docker compose restart`.
`./data` (sqlite DB, raw HTML, LLM sidecars) and `./logs` persist on the host
as volumes. Feed URLs are unchanged: `/health`, `/<site>`, `/<site>/<section>`.

When moving the container to another machine, also check the two `docker-compose.yml`
comments: `server.host` must be `0.0.0.0`, and the `defaults.engine` camofox
`base_url` (`192.168.1.110:9377` example) must be reachable from that box —
use `firecrawl` there unless a tunnel/VPN to the camofox host exists.

## Quick start (works offline against a local/simple site)

Scraping backends are pluggable (see `config.yaml` → `backends`). The default
`engine` is `firecrawl`; a plain-fetch `engine` (named `plain`) is also built in
for static, fetch-friendly sites and needs no API key.

```sh
# Configure the AI endpoint used for LLM article extraction (optional — the
# tag-based extractor works without it):
rssify config set ai.base_url https://openrouter.ai/api/v1
rssify config set ai.api_key <your-key>     # writes AI_API_KEY to .env
rssify config set ai.model meta-llama/llama-3.1-8b-instruct

# Add a site (new domain) — spawns `pi` to author the scraper module:
rssify add https://example.com/section
# Add another section of an already-registered domain (no pi invocation):
rssify add https://example.com/other

rssify list                 # registered sites
rssify scrape <site>        # manual scrape now
rssify serve                # HTTP server + scheduler
# Feeds:
#   GET /                        concise HTML index (up to N articles per feed)
#   GET /feed/<site>/articles    dedicated HTML page for one feed's article history
#   GET /<site>                  merged RSS feed
#   GET /<site>/<section>        per-section feed
#   GET /<site>/item/<hash>      cleaned article HTML
#   GET /<site>/item/<hash>/llm  LLM-extracted article (title/text/link/date)
#   GET /<site>/status           scrape status
#   GET /health                  liveness
```

The HTML index (`GET /`) is a concise overview: it shows up to
`defaults.website_item_limit` articles per feed by default, configured
independently from RSS output:

```yaml
defaults:
  website_item_limit: 20
```

When more articles are stored, each feed gets a **Show more articles** link.
That link performs a normal navigation to a dedicated page for that feed at
`/feed/<site>/articles` (e.g. `/feed/example/articles?limit=20`) — the main
index itself never expands, appends to, or otherwise mutates in place. The
dedicated page identifies the feed, links back to the main index (and to the
RSS feed), and pages through the full article history with a bounded,
progressive `limit` parameter (plus `offset` once the 1000-item cap is
reached); invalid, zero, negative, and missing values fall back safely, and
excessively large values are capped. RSS item limits and RSS output are
controlled separately by `defaults.feed_item_limit`.


## Commands

| Command | Purpose |
|---|---|
| `rssify add <url>` | Register a site — the app auto-discovers the layout; pi is optional escalation |
| `rssify list` | Registered sites, sections, schedule, last scrape, item count |
| `rssify scrape <site> [section] [--force]` | Manual scrape now |
| `rssify serve [--port] [--host]` | HTTP server + in-process scheduler |
| `rssify remove <site> [section] [--purge]` | Unregister (keeps `data/` unless `--purge`) |
| `rssify delay <site> [lower upper]` | View or set a site's random scrape-delay band in seconds |
| `rssify reprofile <site>` | Re-probe a site and update its auto-adaptive extraction profile |
| `rssify reprocess <site>` | Re-clean stored items from saved raw HTML (no re-scrape) — refreshes content/date after extraction fixes |
| `rssify logs <site> [--tail N]` | Recent scrape runs + log lines |
| `rssify config show / config set <key> <value>` | Edit config; `*.api_key` values write to `.env` |

## Self-adaptive extraction (no per-site code)

Every site has a totally different layout, so RSSify **realizes on its own where the
data is** instead of requiring a hand-written template. A generic extractor
(`src/extract/`) looks in all the places a site might hide its articles and scores
what it finds by how “article-like” it is:

* **`<a href>` anchors** — headline-looking link text, URL date pattern (`/2026/08/12/`)
* **Embedded JSON** (`__NEXT_DATA__` etc.) — objects carrying a `uri`/`url` + `title` + `date`
* **JSON-LD** (`ItemList`, `NewsArticle`, …) — structured lists of articles

When you `rssify add <url>`, RSSify fetches the page, auto-detects which of these the
site uses, and writes a thin generic module + a small per-site **profile** in
`config_json` (e.g. `extract.mode = "embedded-json"`). No `pi` needed for normal sites —
`pi` is only escalated when generic discovery can't cover a hard site.

Extraction **quality is measured on every scrape** (fraction of parsed articles with a
real body and a real date). If it drops below threshold on a generic site, RSSify
**re-probes and updates the profile automatically** (`rssify reprofile <site>` does it
manually). The per-site profile lives in the DB `config_json`:

```jsonc
{
  "template": "generic",
  "engine": "plain",            // backend used to fetch this site
  "extract": { "mode": "embedded-json", "max": 12 }
}
```

## LLM extraction (parallel path)

Alongside the tag-based extractor, RSSify can run an **AI extraction** on every new
article that returns the four feed fields directly: **title, the full article body
reproduced VERBATIM as clean HTML (word-for-word, formatting preserved, no
ads/nav/paywall stubs/comments), canonical link, publication date**. Both
paths run in parallel so you can compare which performs better, then keep one.

* Enabled by default when an AI key is configured (`ai.api_key`); toggle with
  `defaults.llm_extract: false` or per-site `extract.llm: false`.
* The result is cached per item at `data/<site>/<hash>.llm.json` and shown via the
  **`LLMextraction`** link next to `cleaned` on the index page (`/<site>/item/<hash>/llm`).
* Feeds serve the LLM fields by default (`defaults.feed_source: llm` — set in
  `config.yaml`; per-site `extract.feedSource: "tags"` reverts a site) —
  `<title>/<link>/<pubDate>/<content:encoded>` come from the LLM sidecar, falling
  back to tag fields when no sidecar is stored.
* `rssify reprocess <site>` re-runs LLM extraction from saved raw HTML without
  re-scraping.
* Output budget: `ai.extract_max_tokens` (default 32000); article body sent to the model is capped by `ai.max_input_chars` (default 40000).

## Politely pacing requests (`scrape_delay`)

Sites rate-limit scrapers, so RSSify can insert a **random delay** between requests
per site, within a lower/upper band (seconds). This lets you find and stay under a
site's limit.

* **Per site** (recommended):
  ```sh
  rssify delay forbes-digital-assets 15 30      # sleep a random 15–30s before each request
  rssify delay forbes-digital-assets            # show current band + where it's set
  ```
  This is stored in the site's `config_json` (`scrape_delay`), overriding the instance default.
* **Instance default** (`config.yaml`):
  ```yaml
  defaults:
    scrape_delay: { lower_sec: 0, upper_sec: 0 }   # 0 = no delay
  ```

Each request logs the applied delay, latency, and byte size (`rate-limit: ...`). If a
request looks **throttled** (403/429/503/529 or a `rate-limit`/`Retry-After` message) it
logs a **warning** advising you to raise the band — that's the signal that tells you
where the site's scraping limit is.

## Layout

```
config.yaml             # backends, AI, defaults (secrets live in .env)
.env                    # secrets (never committed)
sites/<site>.ts         # pi-authored scraper modules (+ .config.json)
data/state.sqlite       # registry & items (SQLite)
data/<site>/<hash>.html # cleaned main-content HTML (the content artifact)
data/<site>/<hash>.raw.html # raw page HTML saved alongside (defaults.store_raw) so
                       # `rssify reprocess <site>` can re-clean without re-scraping
data/<site>/<hash>.meta.json # optional sidecar metadata
logs/rssify.log         # structured (pino) logs
src/                    # the app (config, db, backends, scraper, scheduler, server, cli)
```

## Backends (pluggable adapter layer)

- `camofox` — stealth Firefox REST API (raw page HTML; app cleans it).
- `firecrawl` — cloud or self-hosted (returns already-cleaned HTML).
- `plain` — plain `fetch` + Readability for simple/static pages.

New engines are added by writing an adapter in `src/backends/` and exposing it
via `buildBackends`; scheduler/modules/feeds stay untouched.

## Workspace / generated files

`data/`, `logs/`, `.env`, `node_modules/`, and `sites/` are git-ignored —
scraper modules and content are environment-specific per-installation.
