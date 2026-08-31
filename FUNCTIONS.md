# RSSify — Function & Module Reference

**Purpose:** complete catalog of every function, class, command, route, config knob
and data structure in this repo, so a new session/developer can find anything
without re-reading the whole codebase. Written from the source (verified against
`src/`, `sites/`, `bin/`).

- Language: TypeScript, run **directly by Node ≥ 25** via native type stripping —
  **no build step**. Entry point: `bin/rssify.js` → `src/cli.ts`.
- DB: SQLite (`better-sqlite3`), WAL mode, file `data/state.sqlite` (see `config.yaml`).
- CLI: commander (`node src/cli.ts <command>` or `rssify <command>`).

---

## 1. Fast navigation

| I need to… | Go to |
|---|---|
| Add/remove a site, scrape, serve | [CLI commands](#2-cli-commands) |
| Understand the scrape pipeline | [Scrape lifecycle](#11-scrape-lifecycle-srcscraperts) |
| Write/extend a site module (`sites/<site>.ts`) | [Scraper-module contract](#6-scraper-module-contract) + [§5 `src/contract.ts`](#5-srccontractts--scraper-module-contract) |
| Tune per-site extraction (mode, max, follow, ad/paywall, images…) | [Site config_json knobs](#4-site-config_json-knobs) |
| Fix extraction quality / paywall / ad-box issues | [§11 `persistArticle`](#11-scrape-lifecycle-srcscraperts), [§10 `src/clean.ts`](#10-srccleants--cleaning-metadata-filters), [reprocess command](#2-cli-commands) |
| Understand/compare LLM extraction (title/text/link/date) | [§10b `src/extract/llm.ts`](#10b-srcextractllmts--llm-extraction-parallel-path), [§4 `extract.llm`/`feedSource`](#4-site-config_json-knobs) |
| Understand discovery (anchors / embedded JSON / JSON-LD) | [§8 `src/extract/discover.ts`](#8-srcextractdiscoverts--discovery-engine) |
| See feed/HTML routes | [HTTP routes](#3-http-routes) |
| Query the DB | [§12 `src/db.ts`](#12-database-schema-srcdbts) + [schema](#12-database-schema-srcdbts) |
| Change global config | [§13 `src/config.ts`](#13-global-config-configyaml-env) + [`config.yaml`](#13-global-config-configyaml-env) |
| How the scheduler fires scrapes | [§16 `src/scheduler.ts`](#16-srcschedulerts--srccronts--scheduling), [`src/cron.ts`](#16-srcschedulerts--srccronts--scheduling) |
| What the backends do (camofox/firecrawl/plain) | [§17 `src/backends/`](#17-srcbackends--fetch-adapters) |

### File map

| File | Purpose |
|---|---|
| `bin/rssify.js` | Launcher; imports `src/cli.ts` |
| `src/cli.ts` | All CLI commands (commander) |
| `src/add.ts` | `rssify add` — site registration, pi escalation, dry-run |
| `src/scraper.ts` | Scrape engine: discovery loop, parse phase, persist, paywall/ad filters, quality tracking, rate limiting |
| `src/clean.ts` | Readability cleaning, ad-block stripping, metadata extraction, image stripping |
| `src/extract/generic.ts` | Generic scraper used by all `sites/<site>.ts` modules |
| `src/extract/discover.ts` | Layout-agnostic candidate discovery + follow-link crawling |
| `src/extract/profile.ts` | Auto-adaptive site profile generation + re-probe |
| `src/extract/llm.ts` | LLM article extraction (title / full clean text / link / date) — parallel path to tag extraction |
| `src/contract.ts` | TypeScript contract for scraper modules (`SiteScraper`, `Backends`, …) |
| `src/db.ts` | SQLite schema + all queries |
| `src/config.ts` | config.yaml + .env loading, deep-merge, `config set` |
| `src/server.ts` | Hono HTTP server (feeds, item pages, status, root) |
| `src/rss.ts` | RSS 2.0 document builder |
| `src/scheduler.ts` | In-process per-site staggered cron timers |
| `src/cron.ts` | Cron validation + next-run computation |
| `src/logger.ts` | pino logger + `ROOT` |
| `src/loader.ts`, `src/loader-hook.ts` | `.js`→`.ts` relative-import resolution for site modules |
| `src/backends/` | `camofox`, `firecrawl`, `plain` fetch adapters |
| `sites/<site>.ts` + `.config.json` | Per-site scraper module + sidecar config (all currently generic) |

---

## 2. CLI commands

All commands open the DB via `withDb()` (creates config if missing). Invoke:
`node src/cli.ts <command>` or `rssify <command>`.

| Command | Description | Options |
|---|---|---|
| `add <url>` | Register a site (new domain: auto-extract, pi escalation if needed; existing domain: add a section). **New sites require `-n/--name`.** | `-n, --name <name>` |
| `rename <site> <name>` | Set site display name (feed `<title>`). | |
| `list` | Table of sites: sections, schedule, last scrape, status, item count. | |
| `delay <site> [lower] [upper]` | View/set per-site random scrape-delay band (seconds). | |
| `limit <site> [n\|none]` | View/set per-site discovery candidate cap (`extract.max`). | |
| `follow <site> [action]` | View/set pagination-follow: `on \| off \| until404 \| <depth 0-8> \| none`. | |
| `images <site> [action]` | View/set picture stripping: `on \| off \| none`. Applied at serve time. | |
| `reprofile <site>` | Re-fetch index, re-detect extraction mode, update saved profile. | |
| `reprocess <site>` | Re-clean **stored items from saved raw HTML** (no re-scrape). Updates content hash, publish date, title if improved. | `--refetch` (re-fetch pages instead of using raw) |
| `scrape <site> [section]` | Manual scrape; `<site>` may be `<site>/<section>`. | `--force` |
| `serve` | Start HTTP server + scheduler. | `--port`, `--host`, `--all`, `--limit <n>` |
| `remove <site> [section]` | Unregister site (deletes `sites/<site>.ts` + `.config.json`; keeps `data/` unless `--purge`) or one section. | `--purge` |
| `logs <site>` | Recent scrape runs + tail of `logs/rssify.log` for the site. | `--tail <n>` (default 50) |
| `config show` | Print merged config (secrets masked). | |
| `config set <key> <value>` | Set dotted config path; `*api_key*`/`*KEY*` values go to `.env`. | |

---

## 3. HTTP routes

Server built by `createApp(db, config, opts)` (`src/server.ts`), bound by `rssify serve`.

| Route | Output |
|---|---|
| `GET /` | HTML index of all sites + recent items + feed links (up to `defaults.website_item_limit` per feed) |
| `GET /?site=<site>&limit=<n>` | Progressively expanded HTML view for one feed; bounded/capped `limit`, with optional `offset` for further pages |
| `GET /health` | `{ status: 'ok', time }` |
| `GET /<site>` or `/<site>.xml` | Merged RSS 2.0 feed for the site |
| `GET /<site>/<section>` or `/<site>/<section>.xml` | Section-scoped RSS feed |
| `GET /<site>/status` | JSON: site + per-section item counts, last scrape |
| `GET /<site>/item/<hash>` or `/<hash>.html` | Cleaned article HTML (read from `content_path`); stripped of images when `ignore_images` |
| `GET /<site>/item/<hash>/llm` | LLM-extracted article rendered as HTML (from `data/<site>/<hash>.llm.json`); 404 with hint when no sidecar stored |
| any other | 404 |

Feed item model: `<description>` = full article body text, `<content:encoded>` = full cleaned
HTML, `<guid isPermaLink="false">` = content hash, `<dc:creator>` = author when present.
When the site's feed source is `llm` (see [§4 `extract.feedSource`](#4-site-config_json-knobs)),
`<title>`/`<link>`/`<pubDate>`/`<content:encoded>` come from the stored LLM sidecar
(falling back to tag fields when absent).

---

## 4. Site config_json knobs

Each site row stores a JSON `config_json` in the DB. **The DB is the runtime
source of truth** — `sites/<site>.config.json` is the authoring sidecar written at
`add` time and is **not** hot-read by the scraper/server. Keep both in sync when
editing by hand (the CLI commands below update the DB; `remove` deletes the file).

### Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `title` | string | Feed title (lifted to DB `sites.title` at add; display name owned by user) |
| `description` | string | Feed description |
| `template` | string | `"generic"` for all auto-adaptive sites (`GENERIC_TEMPLATE`) |
| `ignore_images` | boolean | Per-site picture stripping (CLI: `rssify images`) |
| `scrape_delay` | `{ lower_sec, upper_sec }` | Per-site random delay band (CLI: `rssify delay`) |
| `extract` | object | See below |

### `extract` keys (consumed by `createGenericScraper` / `persistArticle`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `'auto' \| 'anchors' \| 'embedded-json' \| 'jsonld-list'` | auto-detected | Discovery source preference |
| `max` | number | `defaults.discover_max` | Discovery candidate cap (CLI: `rssify limit`) |
| `follow` | boolean | `defaults.follow` | Follow pagination/listing pages (CLI: `rssify follow`) |
| `followDepth` | number | `defaults.follow_depth` | Follow pages beyond index (CLI: `rssify follow`) |
| `followUntil404` | boolean | `defaults.follow_until_404` | Crawl pagination until HTTP 404 (CLI: `rssify follow`) |
| `waitMs` | number | `defaults.wait_ms` | Extra render wait for JS-capable engines |
| `ad_markers` | **string[]** | `[]` | Case-insensitive phrases; any cleaned element (≤600 chars) containing one is removed (GlobalData promo boxes etc.). ⚠️ **Must be an ARRAY** — a JSON-string value silently disables stripping (`Array.isArray` guard). |
| `paywall_markers` | **string[]** | `[]` | Case-insensitive phrases in the **cleaned text**; if any matches, the article is **not stored** (counted as paywall skip). |
| `storeRaw` | boolean | `defaults.store_raw` | Save `data/<site>/<hash>.raw.html` next to cleaned content |
| `llm` | boolean | `defaults.llm_extract` | Enable/disable the LLM extraction path for this site (`false` opts out; only effective when an AI key is configured) |
| `feedSource` | `'tags' \| 'llm'` | `defaults.feed_source` | Which extraction feeds the RSS items for this site — `'llm'` uses the stored sidecar's title/html/link/date (fallback to tag fields when no sidecar). **This instance defaults to `'llm'`** |

Example (see `sites/electronicpaymentsinternational.config.json`):

```jsonc
{
  "title": "News - Electronic Payments International",
  "template": "generic",
  "ignore_images": true,
  "extract": {
    "mode": "anchors",
    "ad_markers": ["access deeper industry intelligence", "experience unmatched clarity"],
    "paywall_markers": ["unlock free access"]
  }
}
```

---

## 5. `src/contract.ts` — scraper-module contract

Interfaces shared between the app and site modules. Site modules may `import type`
these plus pure helpers from `src/util.ts`; they must **never** import backend
adapters — network access only via the injected `backends`.

| Export | Kind | Notes |
|---|---|---|
| `Logger` | interface | pino-shaped logger (`info/warn/error/debug`, optional `child`) |
| `SectionRef` | interface | `{ section: string; indexUrl: string }` |
| `DiscoveredItem` | interface | `{ url; hintTitle?; hintDate? }` |
| `Article` | interface | `{ url; title; html; cleaned?; metadata?; publishedAt?; author?; bylineImage? }` — `cleaned: true` = firecrawl path (html already main-content), unset = raw page for readability |
| `ScraperKV` | interface | per-site kv: `get/set/del` (backed by `scratch_kv` table) |
| `ScraperContext` | interface | `{ logger, config, kv, engine, discoverMax, follow, followDepth, followUntil404, waitMs }` |
| `FirecrawlResult` | interface | `{ html; metadata }` |
| `CamofoxFetchOpts` | interface | `{ waitMs?; evaluateJs? }` |
| `PlainFetchOpts` | interface | `{ headers? }` |
| `FirecrawlScrapeOpts` | interface | `{ waitFor?; maxDepth?; … }` |
| `Backends` | interface | `{ camofox: { fetch, fetchWithStatus? }, firecrawl: { scrape }, plain: { fetch } }` |
| `SiteScraper` | interface | required: `site`, `discover(ctx, backends, section) → DiscoveredItem[]`, `parse(ctx, backends, item) → Article`; extra fields allowed |

---

## 6. Scraper-module contract

Every site has a module `sites/<site>.ts` exporting `default { site, discover, parse }`.
All currently-registered sites are thin wrappers around the generic scraper:

```ts
import { createGenericScraper } from '../src/extract/generic.ts';
export const site = 'thepaypers';
const inner = createGenericScraper('thepaypers');
export async function discover(ctx, backends, section) { return inner.discover(ctx, backends, section); }
export async function parse(ctx, backends, item) { return inner.parse(ctx, backends, item); }
export default { site, discover, parse };
```

Rules (from `piPrompt` in `src/add.ts`):
- Type-strippable TS only (no enums/namespaces/parameter properties); relative imports use explicit `.ts`.
- `discover` is called once per registered section and must only return article URLs reachable from `section.indexUrl` — never crawl the whole site.
- For camofox/plain: return **raw** page HTML in `Article.html` (app cleans it). For firecrawl: return already-cleaned html + `cleaned: true` + `metadata`.
- Only override `title/author/publishedAt` when the site's structured data is wrong.

---

## 7. `src/extract/generic.ts` — generic scraper

| Export | Signature | Notes |
|---|---|---|
| `fetchHtml` | `(backends, engine: string, url) → Promise<string>` | Engine dispatch: firecrawl → `scrape().html`; camofox → `fetch()`; else plain |
| `createGenericScraper` | `(site: string) → SiteScraper` | The default scraper used by every site module |
| `statusFromError` | `(msg: string) → number \| null` | Pulls HTTP status out of error text (`-> 404`) |

`createGenericScraper().discover`: BFS over index + follow pages (bounded by
`extract.max`, `followDepth` ≤ 8, safety ≤ 40 pages), merges candidates from
`discoverCandidates`, follows category-scoped listing links via `findFollowLinks`.
Honors `followUntil404` (stops at HTTP 404; uses `camofox.fetchWithStatus`).

`createGenericScraper().parse`: returns `{ url, title, html }` (+ `publishedAt`
from `extractMetadata` of the article page, falling back to the discovery hint).
firecrawl path passes through `metadata` and marks `cleaned: true`.

---

## 8. `src/extract/discover.ts` — discovery engine

| Export | Signature | Notes |
|---|---|---|
| `DiscoveryMode` | type | `'auto' \| 'anchors' \| 'embedded-json' \| 'jsonld-list'` |
| `Candidate` | interface | `{ url; title?; date?; source: 'anchor'\|'json'\|'jsonld'\|'uri-regex'; score }` |
| `DiscoverHints` | interface | `{ mode?; max? }` |
| `FollowLink` | interface | `{ url; label }` |
| `findFollowLinks` | `(html, sectionUrl, max = 6) → FollowLink[]` | Finds "See All News"/pagination links **within the same category subtree**, sequential-next-page only, never article pages |
| `discoverCandidates` | `(html, indexUrl, hints?) → Candidate[]` | Collects anchors + embedded JSON + JSON-LD, scores by article-likeness (year-in-path, headline text, date presence, source bonus), dedupes, sorts best-first, caps at `max` |
| `detectMode` | `(cands) → DiscoveryMode` | Picks the dominant source ("page personality") for the site profile |

Internal helpers (not exported): `collectAnchors`, `collectJson`, `usable`,
`isArticleLike`, `isListingLike`, `FOLLOW_TEXT`, `pageNumber`, `pathScore`,
`textScore`, `sourceBonus`, `leadingDate`, `trailingDate`, `dateFromPath`,
`pick`, `walk`, `URL_KEYS`, `TITLE_KEYS`, `DATE_KEYS`, `NON_ARTICLE_PATH`, `BINARY`.

---

## 9. `src/extract/profile.ts` — auto-adaptive profiles

| Export | Signature | Notes |
|---|---|---|
| `GENERIC_TEMPLATE` | const `'generic'` | Marker for auto-generated site modules |
| `profileFromSnapshot` | `(opts) → Record<string, unknown>` | Builds a sidecar config from a fetched index page: detects mode, bakes only knobs differing from defaults (so later `defaults.*` changes still govern) |
| `genericModuleSource` | `(site: string) → string` | Source of the thin generic site module |
| `reprofileSite` | `(db, config, site, log) → Promise<DiscoveryMode \| null>` | Refetches index, re-detects mode, updates saved `config_json`; null when nothing changed / no index |

---

## 10. `src/clean.ts` — cleaning, metadata, filters

| Export | Signature | Notes |
|---|---|---|
| `ParsedMetadata` | interface | `{ title?; author?; publishedAt?; image?; canonical?; ogUrl? }` |
| `CleanResult` | interface | `{ content: string; text: string }` |
| `CleanOpts` | interface | `{ adMarkers?: string[] }` |
| `stripImages` | `(html) → string` | Text-only mode: removes `<picture>` wrappers, `<img>`, `<figcaption>` (caption without picture = noise) and now-empty `<figure>`/`<div>` wrappers (regex; used at serve time for `ignore_images`) |
| `stripPrintBoilerplate` | `(html) → string` | Removes print-header/"An article from" paragraphs, breadcrumbs, footers, nav |
| `stripAdBlocks` | `(html, markers: string[]) → string` | Removes whole blocks (any of div/section/article/…/p/span/a) whose own text (≤600 chars) contains a marker phrase; length guard protects real bodies |
| `cleanHtml` | `(rawHtml, baseUrl, opts?) → CleanResult \| null` | JSDOM + `@mozilla/readability` → content, then `stripPrintBoilerplate` + optional `stripAdBlocks`; null when readability finds nothing |
| `absolutize` | `(html, baseUrl) → string` | Resolves relative `src/href/srcset` to absolute |
| `textFromHtml` | `(html) → string` | Plain-text extraction (firecrawl-cleaned path) |
| `extractMetadata` | `(rawHtml, url) → ParsedMetadata` | JSON-LD (prefers Article/NewsArticle/BlogPosting over BreadcrumbList) → OG/Twitter → `<time>` → visible-text date fallback; canonical + og:url |

Internal: `first`, `unwrapJsonLd`, `authorFromJsonLd`, `imageFromJsonLd`.

---

## 10b. `src/extract/llm.ts` — LLM extraction (parallel path)

Runs **in parallel** with the tag-based extractor on every new article: the model
reads the page URL, the head metadata, and the already-cleaned article content
(readability / firecrawl) and returns the four RSS fields — headline, **the full
article body reproduced VERBATIM as clean HTML** (word-for-word, formatting
preserved, no ads/nav/cookie banners/paywall stubs/comments/boilerplate),
canonical URL, and ISO publication date — as JSON. The result is persisted to
`data/<site>/<hash>.llm.json` (fields `title`, `html`, `text`, `url`,
`publishedAt`, `model`, `extractedAt`) so the feed and the `/item/<hash>/llm`
route serve it without re-calling the model. Model output is sanitized
(`sanitizeArticleHtml`) before storage; older sidecars that only carry plain
`text` are rendered via `textToHtml` as a fallback. Removing the feature later =
drop this module, the call in `persistArticle`, the route/link, and the
`llm_extract` / `feed_source` / `extract_max_tokens` knobs; the tag path is
untouched.

| Export | Signature | Notes |
|---|---|---|
| `LlmExtraction` | interface | `{ title: string\|null; html: string; text: string; url: string\|null; publishedAt: string\|null; model: string; extractedAt: number }` |
| `buildLlmExtractor` | `(config) → (rawHtml, url, text?, html?) → Promise<LlmExtraction \| null>` | OpenAI-compatible client (same `ai.*` config); 60 s timeout; input truncated to `ai.max_input_chars`; output capped at `ai.extract_max_tokens`; **best-effort — never throws**, null on any failure (tag fields stand). Plain mode first (JSON `response_format` retried only when the plain response is unusable — reasoning models burn their whole budget in JSON mode); tolerant key mapping + markdown-artifact stripping |

Internal: `SYSTEM_PROMPT` (extraction instructions), `extractJson` (robust
balanced-brace JSON parsing incl. code fences), `asString`.

Enabled when `defaults.llm_extract` is true **and** an AI key is configured **and**
the site's `extract.llm` isn't `false`.

---

## 11. Scrape lifecycle (`src/scraper.ts`)

`runSiteScrape(db, config, site, section?)` is the engine. Flow per section:

1. **discover** via the site module → candidates (deduped by normalized URL).
2. **pre-parse skip** (no fetch): listing URLs (paths matching any registered
   section index) and already-known items (sha1 of both slash spellings).
3. **parse phase** with bounded concurrency (`defaults.scrape_concurrency`):
   `scraper.parse` → `persistArticle`.
4. **quality tracking**: `bodyGood` = cleaned text ≥ `MIN_QUALITY_BODY` (200);
   `dateGood` = parsed `published_at`. If body/date rate < 0.6 on a generic site,
   auto-`reprofileSite` (cooldown `REPROFILE_COOLDOWN_MS` = 6 h).
5. Summary: status `ok` / `partial` / `error`, run row + site last-scrape update.

### Exported functions

| Export | Signature | Notes |
|---|---|---|
| `buildBackends` | re-export from `src/backends/index.ts` | |
| `DelayBand` | interface | `{ lowerMs; upperMs }` |
| `delayBandMs` | `(siteConfig, globalDefault) → DelayBand` | Per-site `scrape_delay` wins over `defaults.scrape_delay`; ms conversion |
| `withRateLimit` | `(backends, band, site, log) → Backends` | Wraps every fetch with a random sleep + latency/status logging; warns on throttling (403/429/503/529, rate-limit text) |
| `runSiteScrape` | `(db, config, site, section?) → Promise<ScrapeResult \| null>` | One full scrape run; serialized per site via `inflight` set |

### `persistArticle` (internal, key logic)

`(db, config, site, section, cand, article, llmExtractor) → { inserted; bodyGood; dateGood; paywalled? }`

1. Normalizes URL/title; reads site config for `ad_markers`.
2. Cleans: firecrawl path (`article.cleaned`) → `absolutizeBody` + `stripAdBlocks`
   + `textFromHtml`; camofox/plain path → `cleanHtml(raw, url, { adMarkers })`.
3. **Paywall filter** (before any insert): if `extract.paywall_markers` non-empty
   and the cleaned plain text contains any marker → returns
   `{ inserted: 0, paywalled: true }` (never stored, not counted as failure).
4. Field precedence: module explicit > `extractMetadata` > hint.
5. Canonical URL (same-origin only, fallback `og:url` → fetched URL) → sha1 hash;
   re-checks dedup (slash-insensitive) → `addItemSection` if known.
6. Writes `data/<site>/<hash>.html` (+ `.raw.html` when `storeRaw`,
   + `.meta.json` when author/image/metadata present).
7. **LLM extraction** (when `llmExtractor` non-null, i.e. enabled + key configured):
   runs on the raw page HTML, best-effort, and writes `data/<site>/<hash>.llm.json`
   (title/text/url/publishedAt/model/extractedAt). Only runs for NEW items —
   dedup and paywall skips never burn model credits. Failure logs a warning;
   the item still saves with tag fields.
8. `insertItem` (UNIQUE race → duplicate, not failure) + `addItemSection`.

### Other internals

`loadScraper`, `makeContext`, `parseIso`, `randomMs`, `sleep`, `isThrottle`,
`extractStatus`, `absolutizeBody`, `firecrawlMetadata`, `otherMeta`,
`sha1SlashInsensitive`, `sha1BothSlashSpellings`, `mapLimit`, `inflight`,
`MIN_QUALITY_BODY`, `REPROFILE_COOLDOWN_MS`, `ScrapeResult`.

---

## 12. Database schema (`src/db.ts`)

Tables (all created idempotently by `openDb`):

| Table | Columns | Notes |
|---|---|---|
| `sites` | `site PK, url, title, description, schedule, config_json, module_path, private, created_at, last_scrape_at, last_scrape_status, last_error` | `config_json` = all per-site knobs |
| `sections` | `site FK→sites, section, index_url, title, description, created_at` | PK `(site, section)`; cascade delete |
| `items` | `site FK→sites, hash, url, title, published_at, first_seen, content_path, content_hash, raw_path` | PK `(site, hash)`; index on `(site, first_seen DESC)` |
| `item_sections` | `site, section, hash` | PK `(site, section, hash)`; FKs → items + sections, cascade |
| `scrape_runs` | `id PK AUTOINCREMENT, site, started_at, finished_at, status, discovered, new_items, error, log_excerpt, quality_json` | quality_json added by migration |
| `scratch_kv` | `site, key, value` | PK `(site, key)`; per-site module persistence |

### Exported functions

| Function | Signature | Notes |
|---|---|---|
| `Db` | type | `better-sqlite3` Database |
| `openDb` | `(config) → Db` | Creates file, WAL, foreign keys, schema, idempotent migrations |
| `parseSiteConfig` | `(row) → Record<string, unknown>` | Safe JSON parse of `config_json` |
| `sanitizeSiteConfig` | `(json) → string` | Strips a legacy top-level `engine` key; called by every write |
| `insertSite` | `(db, s)` | Sanitizes config_json |
| `getSite` / `listSites` | `(db, site)` / `(db)` | |
| `deleteSite` | `(db, site)` | Cascades sections/items/runs |
| `updateSiteLastScrape` | `(db, site, at, status, error)` | |
| `updateSiteConfig` | `(db, site, configJson)` | Sanitizes; used by CLI knobs |
| `updateSiteTitle` | `(db, site, title)` | |
| `countItems` | `(db, site) → number` | |
| `getSectionTitle` | `(db, site, section) → string?` | |
| `insertSection` / `getSection` / `listSections` / `deleteSection` | | Section CRUD |
| `deleteOrphanItems` | `(db, site)` | Deletes items no longer in any section |
| `getItem` | `(db, site, hash) → ItemRow?` | |
| `itemSectionHashes` | `(db, site, section) → Set<string>` | |
| `itemBelongsToSite` | `(db, site, hash) → boolean` | |
| `insertItem` / `addItemSection` | | Item + membership (INSERT OR IGNORE) |
| `recentItems` | `(db, site, section \| null, limit) → ItemRow[]` | Sorted: undated sink, then `COALESCE(published_at, first_seen) DESC` |
| `insertRun` | `(db, site, startedAt) → id` | |
| `finishRun` | `(db, id, finishedAt, status, opts)` | opts: discovered/newItems/error/excerpt/quality |
| `runsForSite` | `(db, site, limit=50) → RunRow[]` | |
| `kvGet` / `kvSet` / `kvDel` | | scratch_kv upsert/read/delete |

Row interfaces: `SiteRow`, `SectionRow`, `ItemRow`, `RunRow`, `ScrapeQuality`.

---

## 13. Global config (`config.yaml` + `.env`)

Loaded by `src/config.ts`; `DEFAULT_CONFIG` deep-merged with on-disk YAML,
then `${VAR}` env expansion. Secrets (`*api_key*`) live in `.env`
(`AI_API_KEY`, `FIRECRAWL_API_KEY`, `CAMOFOX_ACCESS_KEY`).

### `src/config.ts` exports

| Export | Signature | Notes |
|---|---|---|
| `CONFIG_PATH`, `ENV_PATH` | consts | `config.yaml`, `.env` at project root |
| `AppConfig` + sub-interfaces | interfaces | `server`, `backends.{camofox,firecrawl,plain}`, `ai`, `defaults`, `storage` |
| `DEFAULT_CONFIG` | const | See below |
| `loadEnvFile` | `() → Record<string, string>` | Minimal `.env` parser |
| `loadConfig` | `() → AppConfig` | deep-merge defaults + disk + env expansion |
| `ensureConfig` | `()` | Writes default `config.yaml` + `.env` if missing |
| `configGet` | `(dotted path) → unknown` | |
| `configSet` | `(path, value) → string \| null` | Secrets → `.env`; otherwise YAML write; returns env key name when secret |

### `defaults` keys (with per-site override)

| Key | Default | Per-site override |
|---|---|---|
| `schedule` | `0 */6 * * *` | per-site `sites.schedule` |
| `engine` | `firecrawl` (code default) | none (global) — **this instance overrides to `camofox`** in `config.yaml` |
| `website_item_limit` | 10 | HTML index default per-feed article count; `GET /?site=<site>&limit=<n>` expands one feed (hard cap 1000) |
| `feed_item_limit` | 10 | RSS output; `serve --limit` / `--all` |
| `scrape_concurrency` | 2 | none |
| `scrape_delay` | `{ lower_sec: 2, upper_sec: 5 }` | `config_json.scrape_delay` |
| `discover_max` | 100 | `config_json.extract.max` |
| `follow` | true | `config_json.extract.follow` |
| `follow_depth` | 3 | `config_json.extract.followDepth` |
| `follow_until_404` | false | `config_json.extract.followUntil404` |
| `wait_ms` | 0 | `config_json.extract.waitMs` |
| `ignore_images` | false | `config_json.ignore_images` |
| `schedule_jitter_seconds` | 1800 | none |
| `store_raw` | true | `config_json.extract.storeRaw` |
| `llm_extract` | true | `config_json.extract.llm` (set `false` to opt a site out) |
| `feed_source` | `'llm'` (this instance) | `config_json.extract.feedSource` (`'tags'` switches a site back to tag fields) |

`storage`: `data_dir: ./data`, `db_path: ./data/state.sqlite`, `keep_content_forever: true`.

---

## 14. `src/server.ts` — HTTP app

| Export | Signature | Notes |
|---|---|---|
| `createApp` | `(db, config, opts?: { feedLimit?: number }) → Hono` | Single catch-all route; see [HTTP routes](#3-http-routes). `feedLimit 0` = every stored RSS article; HTML index uses `defaults.website_item_limit` independently |

Internal: `resolvePath`, `readContent`, `esc`/`fmt` (shared HTML escape + date
format), `ignoreImagesFor` (per-site `ignore_images` → else global; applied at
serve time), `feedSourceFor` (per-site `extract.feedSource` → else
`defaults.feed_source`), `readLlmSidecar` (loads `data/<site>/<hash>.llm.json`),
`siteFeedHtml`, `siteStatus`, `stripExt`, `serveRss`, `rootPageHtml`,
`llmPageHtml` (renders the stored LLM extraction as an HTML article page).
Exported limit helpers: `normalizeWebsiteItemLimit` safely falls back and caps
HTML index limits at 1000; `DEFAULT_WEBSITE_ITEM_LIMIT` and
`MAX_WEBSITE_ITEM_LIMIT` expose those bounds.

---

## 15. `src/rss.ts` — RSS builder

| Export | Signature | Notes |
|---|---|---|
| `FeedItem` | interface | `{ title; link; guid; pubDate; description; contentHtml; author? }` |
| `FeedMeta` | interface | `{ title; description; link; feedUrl; ttlMinutes; lastBuildDate; items }` |
| `buildRss` | `(meta) → string` | RSS 2.0 with `<content:encoded>` full content + `<dc:creator>` |
| `ttlFromSchedule` | `(schedule) → number` | `*/N * * * *` → N minutes, else 15 |

Internal: `esc`, `cdata` (safe `]]>` splitting).

---

## 16. `src/scheduler.ts` + `src/cron.ts` — scheduling

`Scheduler` class (started by `rssify serve`):

| Member | Signature | Notes |
|---|---|---|
| `constructor` | `(db, config)` | |
| `start` | `()` | Schedules one staggered timer per registered site |
| `scheduleSite` | `(site: SiteRow)` | Validates cron (fallback to default), computes next run + random jitter, re-arms after each tick |
| `unschedule` | `(site)` | Clear one timer |
| `stop` | `()` | Clear all timers |

`src/cron.ts`:

| Export | Signature | Notes |
|---|---|---|
| `validateCron` | `(expr) → boolean` | node-cron 5-field validation |
| `nextCronRun` | `(expr, afterMs) → number` | Next epoch ms; supports wildcard/step/range/list; Vixie dom+dow OR semantics; 5-year horizon then hourly fallback |

---

## 17. `src/backends/` — fetch adapters

`src/backends/index.ts`:

| Export | Signature | Notes |
|---|---|---|
| `buildBackends` | `(config, logger?) → Backends` | Wires camofox/firecrawl/plain from config |
| `EngineName` | type `'camofox' \| 'firecrawl' \| 'plain'` | |
| `engineName` | `(config) → EngineName` | |
| `engineGuide` | `(engine) → string` | Usage guidance string used in pi prompts |

| Class | Key methods | Notes |
|---|---|---|
| `CamofoxBackend` (`camofox.ts`) | `fetch(url, {waitMs?, evaluateJs?}) → html`; `fetchWithStatus(url, opts?) → { html, status \| null }`; internals `base`, `authHeaders`, `request`, `fetchOnce` | Stealth Firefox REST API: POST `/tabs` → POST `/tabs/:id/evaluate` (`document.documentElement.outerHTML`; status via `performance.getEntriesByType('navigation')[0].responseStatus`) → DELETE tab. One retry on 5xx. |
| `FirecrawlBackend` (`firecrawl.ts`) | `scrape(url, opts?) → { html, metadata }` | POST `/v2/scrape`, `onlyMainContent: true`, cloud or self-hosted; honors Retry-After on 429 (one retry) |
| `PlainBackend` (`plain.ts`) | `fetch(url, {headers?}) → html` | Plain `fetch` with browser-like headers, redirect follow, timeout |

---

## 18. `src/util.ts` — pure helpers (importable by site modules)

| Export | Signature | Notes |
|---|---|---|
| `sha1` | `(s) → string` | Hex sha1 |
| `normalizeUrl` | `(raw) → string` | Lowercases scheme+host, drops fragments + tracking params (utm_*, fbclid, gclid, ref…), collapses duplicate slashes |
| `slugify` | `(s) → string` | URL-safe identifier |
| `isValidIdentifier` | `(id, max=40) → boolean` | `[a-z0-9-]`, non-empty, ≤ max |
| `nowMs` | `() → number` | `Date.now()` |
| `rfc822` | `(epochMs) → string` | RSS-required RFC-822 GMT |

---

## 19. `src/logger.ts`, `src/loader*.ts`

| Export | Signature | Notes |
|---|---|---|
| `ROOT` | const | Project root (parent of `src/`) |
| `logger` | pino Logger | JSON to stdout + `logs/rssify.log` (sync file destination) |
| `siteLogger` | `(site, extra?) → Logger` | Child logger bound to a site |
| `loader.ts` `register` | — | Registers the `.js`→`.ts` import hook at CLI entry |
| `loader-hook.ts` `resolve` | `(specifier, context, nextResolve)` | Rewrites relative `.js`/extensionless imports to `.ts` when a `.ts` sibling exists (for pi-authored modules) |

---

## 20. `src/add.ts` — site registration

`rssify add <url>` flow:

1. **Mode A (new domain)**: fetch index via engine → snapshot → try **auto/generic
   add** (`tryGenericAdd`: write generic module + profile, dry-run, commit); if
   generic discovery can't cover the site (< 3 candidates / dry-run fail) →
   **escalate to `pi`** (`authorViaPi`, up to 3 attempts) with a pre-built prompt
   (`piPrompt`) + local snapshot file.
2. **Mode B (existing domain)**: derive section id, dry-run the module, commit
   section only — no pi invocation.

| Export | Signature | Notes |
|---|---|---|
| `PI_BIN` | const | `process.env.PI_BIN ?? '/opt/homebrew/bin/pi'` |
| `RESERVED` | Set | `health, opml, item, status` (never valid site/section ids) |
| `deriveSectionId` | `(url) → string` | Last path segment slugified, fallback `index` |
| `AddSnapshot` | interface | `{ url; title; text; links; html; htmlPath }` |
| `piPrompt` | `(opts) → string` | Prompt handed to `pi` (contract + snapshot + rules) |
| `dryRun` | `(opts) → Promise<{ candidates; article }>` | Side-effect-free: discover + parse first valid candidate (up to 3 tries), no DB/file/AI writes |
| `AddResult` | interface | `{ site; section; newDomain; log }` |
| `add` | `(db, config, url, name?) → Promise<AddResult>` | Main registration entry |

Internal: `buildAddSnapshot`, `extractTitle`, `prettyHost`, `buildLinkInventory`,
`liveLog`, `runPi`, `snapshotSiteFiles`, `newlyWrittenFiles`, `sidecarConfig`,
`loadScraperFor`, `dryRunContext`, `parseFirstValid`, `tryGenericAdd`,
`authorViaPi`, `deriveBaseIdent`, `findSiteForUrl`, `prettify`.

---

## 21. Site modules (`sites/`)

All registered sites are generic wrappers (see [§6](#6-scraper-module-contract)):

| Site | Module | Config highlights |
|---|---|---|
| `a16zcrypto` | `sites/a16zcrypto.ts` | generic |
| `ccn` | `sites/ccn.ts` | generic |
| `electronicpaymentsinternational` | `sites/electronicpaymentsinternational.ts` | generic + `ad_markers` (GlobalData promo box), `paywall_markers` (`unlock free access`), `ignore_images: true` |
| `fintech` | `sites/fintech.ts` | generic + `ad_markers` (newsletter CTA, copyright footer, investor tag block, sponsor links), `ignore_images: true` |
| `forbes` | `sites/forbes.ts` | generic + `ad_markers` (CryptoCodex / CryptoAsset Advisor newsletter plugs, `MORE FOR YOU` / `MORE FROM FORBES` related inserts) |
| `imf` | `sites/imf.ts` | generic |
| `mastercard` | `sites/mastercard.ts` | generic |
| `paymentsdive` | `sites/paymentsdive.ts` | generic |
| `thepaypers` | `sites/thepaypers.ts` | generic |
| `visa` | `sites/visa.ts` | generic |

---

## 22. Data layout

```
data/state.sqlite                  # SQLite registry + items
data/<site>/<hash>.html            # cleaned main-content HTML (served as article content)
data/<site>/<hash>.raw.html        # raw page HTML (defaults.store_raw) — reprocess source
data/<site>/<hash>.meta.json       # optional { author?, bylineImage?, metadata? }
data/<site>/<hash>.llm.json        # LLM extraction sidecar (defaults.llm_extract): { title?, html, text, url?, publishedAt?, model, extractedAt } — verbatim body as sanitized HTML; serves /item/<hash>/llm + feedSource=llm
data/_add_snapshot_*.html          # temporary snapshots during `rssify add` (deleted after)
logs/rssify.log                    # pino JSON logs
sites/<site>.ts, .config.json      # scraper module + sidecar config
config.yaml, .env                  # global config + secrets
```

---

## 23. Gotchas & design notes

- **`ad_markers` / `paywall_markers` must be real JSON arrays** in `config_json`.
  A string value (e.g. `"[\"...\"]"`) silently disables ad stripping because the
  code guards with `Array.isArray(...)`. This happened for
  `electronicpaymentsinternational` and was fixed (see git history).
- **DB `config_json` is the runtime truth.** `sites/*.config.json` is only the
  authoring sidecar. Editing just the file does nothing until the DB is updated
  (CLI knobs do this automatically).
- **Paywall filter runs on cleaned plain text** (after readability), before any
  insert; matched items are skipped (never stored) and counted as `paywalled`,
  not as failures.
- **Dedup hashing**: item identity = sha1 of the normalized canonical URL
  (same-origin canonical → og:url → fetched URL), slash-insensitive. Pre-parse
  dedupe checks both slash spellings so listings that link "/slug" vs "/slug/"
  count as known without fetching.
- **Ignore-images is applied at serve time** — `rssify images <site> on` takes
  effect immediately without re-scraping (strips `<picture>` + `<img>` from
  feeds and item pages).
- **Reprocess re-cleans from saved raw HTML** — run it after changing cleaning
  rules/ad markers so stored items pick up the fix without re-scraping. It does
  NOT apply the paywall filter and does not re-run LLM extraction for items that
  already have a sidecar.
- **Engine is global** (`defaults.engine`); per-site engine keys are stripped by
  `sanitizeSiteConfig`.
- **Quality self-correction**: generic sites whose body/date extraction rate
  drops below 60% are auto-reprofiled (6 h cooldown).
- **Site modules must never import backend adapters**; all network access goes
  through the injected `backends` object.
