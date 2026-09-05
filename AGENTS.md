# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The test foundation uses Node 25's built-in runner; run `npm run typecheck && npm test` (details in `TESTING.md`).

## Article rendering

- Both rendered article views — `/site/item/<hash>` (cleaned) and
  `/site/item/<hash>/llm` — render through ONE shared page shell
  (`articlePageHtml` + `ARTICLE_PAGE_CSS` in `src/server.ts`); only the
  content, metadata and breadcrumb state differ per view. New
  article-adjacent pages must reuse that shell instead of copying CSS.
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
  history `/feed/<site>/articles` (site name URL-encoded) — never the RSS
  XML endpoint `/<site>`, which an RSS reader would open as a subscription.
- Every HTML page (main index, `/feed/<site>/articles`, article views)
  shares one container contract: `PAGE_SHELL_CSS` (50rem max width, 1rem
  gutters). Don't introduce a page with its own body geometry.
- Stored cleaned content is cheerio-serialized as a FULL document
  (`<html><head>…<body>…`) with no `<article>` wrapper — readability keeps
  `<div id="readability-page-1">`. The serve path extracts the verbatim
  `<body>` content (`storedBodyHtml()`) and the shell places it inside
  `<article>`, so the `<article>`-scoped image rule applies to both views
  without touching stored data.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
