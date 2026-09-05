# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The test foundation uses Node 25's built-in runner; run `npm run typecheck && npm test` (details in `TESTING.md`).

## Article rendering

- Both rendered article views — `/site/item/<hash>` (cleaned) and
  `/site/item/<hash>/llm` — must keep article images inside the reading
  column. The shared defenses live in `src/server.ts`: `ARTICLE_IMAGE_CSS`
  (the `<article>`-scoped rule used by the LLM page template),
  `injectArticleCss()` (serve-time injection into stored cleaned docs), and
  `neutralizeImgInlineSizing()` (strips hostile inline img
  width/height/min/max declarations — inline `!important` sizing would
  otherwise outrank the reader CSS, and `min-width` clamps `max-width`). Any
  new article-adjacent HTML page should reuse them; never let a stored
  `<img>` render at natural size (source artwork is typically 1200–2000px wide).
- Stored cleaned content is cheerio-serialized as a FULL document
  (`<html><head>…<body>…`) with no `<article>` wrapper — readability keeps
  `<div id="readability-page-1">` — so a page-scoped image rule targeting
  only `<article>` silently misses the cleaned view; the cleaned-doc
  injection uses an unqualified `img` rule (the whole page is the article).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
