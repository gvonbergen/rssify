# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The test foundation uses Node 25's built-in runner; run `npm run typecheck && npm test` (details in `TESTING.md`).

## Article rendering

- The rendered article view `/site/item/<hash>` (cleaned) renders through ONE
  shared page shell (`articlePageHtml` + `ARTICLE_PAGE_CSS` in
  `src/server.ts`). New article-adjacent pages must reuse that shell instead
  of copying CSS. (The former `/item/<hash>/llm` view was removed with the
  unused LLM-sidecar subsystem — that route now 404s.)
- Article images must stay inside the reading column. The defenses live in
  `src/server.ts`: `ARTICLE_IMAGE_CSS` (the `<article>`-scoped rule in
  `ARTICLE_PAGE_CSS`) and `neutralizeImgInlineSizing()` (strips hostile
  inline img sizing declarations — the exact property set lives in the
  FUNCTIONS.md export table; inline `!important` sizing would otherwise
  outrank the reader CSS, and `min-width` clamps `max-width`). Stored
  cleaned docs are full-document serializations; `storedBodyHtml()`
  extracts the verbatim `<body>` content for the shell. Never let a stored
  `<img>` render at natural size (source artwork is typically 1200–2000px wide).
- The breadcrumb site-name link on article views targets the HTML article
  history `/feed/<site>/articles` — never the RSS XML endpoint `/<site>`, which
  an RSS reader would open as a subscription.
- On every article list surface (`/` and `/feed/<site>/articles`, one shared
  `articleItemHtml` row in `src/server.ts`) the title link ALWAYS opens the
  cleaned article view `/site/item/<hash>` — never the external `original`
  URL, never plain text. `original` keeps its `target=_blank` external link.
  Don't regress the title to any other target.
- Every internal article link percent-encodes its site segment through ONE
  rule (`siteItemHref` in `src/server.ts`) — the breadcrumb's feed-history
  link AND the article-row `cleaned`/title links on `/` and
  `/feed/<site>/articles`. A literal `%`+hex in a site name (e.g.
  `pct%20name`) keeps that encoding in the href, or the browser re-decodes it
  and the item route 404s. Never hand-build an internal item href.
- Every HTML page (main index, `/feed/<site>/articles`, article views)
  shares one container contract: `PAGE_SHELL_CSS` (50rem max width, 1rem
  gutters). Don't introduce a page with its own body geometry.
- Stored cleaned content is cheerio-serialized as a FULL document
  (`<html><head>…<body>…`) with no `<article>` wrapper — readability keeps
  `<div id="readability-page-1">`. The serve path extracts the verbatim
  `<body>` content (`storedBodyHtml()`) and the shell places it inside
  `<article>`, so the `<article>`-scoped image rule applies
  without touching stored data.
- og:image hero recovery: `withHeroImage` (src/clean.ts) injects the
  source-declared hero image right after `<body>` when the cleaned article
  has no in-body image (http(s) only); `rssify reprocess` mirrors it.
  Text-only feeds (`ignore_images`) strip it at serve time — don't skip
  storing the hero for text-only sites.

## Article dates

- The RSS feed and the HTML overview (main index and `/feed/<site>/articles`)
  must derive every article's date from ONE database-backed value:
  `published_at ?? first_seen` (ordering in `recentItems`, rendering in
  `articleItemHtml`/`siteFeedHtml`, all in `src/server.ts`).
  `published_at` must never be more than a day after `first_seen`: `choosePublishedDate`
  (src/extract/generic.ts) clamps at scrape time, and `rssify reprocess` (src/cli.ts)
  mirrors that clamp (never writes an implausible future page date) and heals an
  already-polluted future `published_at` back to `first_seen` (regression tests in
  tests/feed-date-source.test.ts).

## Cleaning pipeline

- All long-lived cleaning (`persistArticle` scrape path, `rssify reprocess`,
  `rssify add` snapshots) goes through `cleanHtmlAsync` (src/cleanRunner.ts), a
  worker thread recycled on a 16 MB / 200-item budget. Reason: jsdom 29 retains
  ~35–40× the document size per window even after `window.close()` + GC, and a
  whole-backlog reprocess OOM-crashed the main process at ~4 GB. Never call the
  synchronous `cleanHtml` (src/clean.ts) in a main-thread loop over many
  articles; the recycle + defer-retirement contracts are pinned by
  test/clean-runner.test.ts.
- jsdom "Could not parse CSS stylesheet" warnings are recoverable (non-fatal)
  and are attributed with the page URL + css snippet via `openAttributedDom`
  (src/clean.ts) — they diagnose a broken site stylesheet, not a failed
  extraction.
- Second-chance recovery lives INSIDE `cleanHtml` (src/clean.ts), not in the
  callers: when the primary Readability result is missing, junk-classified,
  or near-empty (< 200 chars), it retries Readability scoped to the raw
  page's largest `<article>` element, then falls back to a sanitized JSON-LD
  `articleBody` (Moneycontrol pattern). Recovered candidates are accepted
  only when they themselves classify non-junk, and a picture-item-shaped
  primary (near-empty + `<img>`) is never replaced by either recovery pass.
  Because it is one function, the scrape path, `rssify reprocess`, and
  `rssify add` snapshots stay in sync automatically — don't fork the logic
  per call site. JSON-LD is parsed leniently (`parseJsonLdLenient`): raw
  control characters inside string literals are repaired once, other
  malformation is still discarded.

## Extraction quality

- The `bodyGood`/`dateGood` rates in the scrape quality log (`summarizeParseResults`
  in `src/scraper.ts`) count only NEWLY INSERTED TEXT ARTICLES: duplicates,
  paywalled skips and picture items are excluded. A picture item
  (`looksLikePictureItem`: ≥1 `<img>` + cleaned text < 500 chars +
  substantial-paragraph ratio < 0.7) is still inserted and stored normally —
  a caption + image is a legitimate feed item — but must never be scored as a
  weak text article. Don't raise `MIN_QUALITY_BODY` to handle photo cards; the
  classifier is the fix (a readable single-paragraph quicktake can measure
  barely above 200 chars).
- `looksBotGated`/`BOT_GATE_MARKERS` only steer the Firecrawl fallback when
  cleaning FAILED on the legacy single-engine path (an active cascade advances
  to the next configured engine instead). Real pages of bot-protected sites
  legitimately embed marker strings (Cloudflare `challenge-platform`,
  `js.datadome.co` scripts), so a marker match on raw HTML is not itself a
  false-positive signal — the fixtures in `test/fixtures/` pin this behavior.

## Ingest guards (junk gate, blacklist, boilerplate, hero)

- Junk-body classification (`looksLikeJunkBody`, src/quality.ts) extends the
  cascade's quality trigger beyond the near-empty word-count rule: JS gates,
  playback errors, consent-dominated bodies, © footer plates,
  subscription-offer walls and nav-only fragments advance to the next engine
  too. Marker/structure ONLY — never gate persistence on source-similarity
  (two sampled aggregators rewrite/translate article text; faithful captures
  can legitimately fail containment). Picture items are exempt; without a
  cascade persistArticle is byte-for-byte legacy (junk still stored, flagged).
- Source-URL skip rules (src/skip.ts): `defaults.url_blacklist`
  (YouTube — youtube.com + youtu.be — excluded from ingestion by default;
  host-suffix matching incl. subdomains, optional path prefixes) and
  `defaults.skip_url_patterns` (narrow non-article URL shapes). Checked
  BEFORE any fetch in runSiteScrape and re-checked on the resolved canonical
  URL in persistArticle; every skip logs the matched entry/pattern. Per-site
  `extract.urlBlacklist` / `extract.skipUrlPatterns` REPLACE the global
  lists (empty array disables). Do not solve YouTube with a specialized
  extractor — the requested mechanism is the blacklist.
- Boilerplate trimming (`stripBoilerplateBlocks`, src/clean.ts) removes short
  blocks (< 600 chars AND < half the document text) matching
  `defaults.boilerplate_markers` / per-site `extract.boilerplateMarkers`.
  The container-share guard is essential: without it the readability wrapper
  div of a short photo card matches a footer marker and the WHOLE article is
  removed (observed on the caption fixture).
- `rssify reprocess` mirrors the scrape-time og:image hero recovery and
  honors `boilerplate_markers` — keep both call sites in sync when changing
  clean options.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## URL resolution

- Use the shared `resolveHref` for discovery, add snapshots, and canonical/og:url resolution; keep same-origin checks after resolution. See its contract in [FUNCTIONS.md](FUNCTIONS.md) and regressions in `test/util.test.ts` and `test/clean.test.ts`.

## Fetch cascade (engine priority)

- Destination-article fetching is a configuration-driven cascade
  (`src/engines.ts`): per-site `extract.enginePriority` → global
  `defaults.engine_priority` (default `['plain','camofox','firecrawl']`) →
  legacy single `defaults.engine`. `filterConfiguredEngines` drops unconfigured
  firecrawl but never returns an empty list.
- Two halves: fetch errors advance in `runSiteScrape`'s parse loop; empty/
  near-empty cleaned bodies advance inside `persistArticle` via the
  `FetchCascade` seam (`{ engines, startIndex, refetch }` in src/contract.ts).
  Picture items are exempt (a photo card never triggers fallback-engine spend).
- Discovery is NOT cascaded and NOT priority-driven — index/listing pages stay
  on the legacy single `defaults.engine` (the pre-cascade browser default), so
  JS-rendered listing pages keep their existing engine on upgrade; Google News
  feed discovery is hardcoded plain HTTP in `sites/googlenews.ts`. `persistArticle`
  without a cascade is byte-for-byte legacy behavior; `engine_priority: []`
  restores exact single-engine behavior.
- Tests: test/fetch-cascade.test.ts (resolution rules, near-empty advance,
  picture exemption, exhaustion, end-to-end runSiteScrape via a fake module
  written into git-ignored sites/ at test time).
