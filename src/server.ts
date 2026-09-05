import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { ROOT } from './logger.ts';
import type { AppConfig } from './config.ts';
import {
  countItems,
  getItem,
  getSection,
  getSite,
  listSections,
  listSites,
  recentItems,
  type Db,
  type ItemRow,
} from './db.ts';
import { buildRss, ttlFromSchedule, type FeedItem, type FeedMeta } from './rss.ts';
import { stripImages, sanitizeArticleHtml, textToHtml, textFromHtml } from './clean.ts';

export const DEFAULT_WEBSITE_ITEM_LIMIT = 10;
/** Hard cap for one HTML index response, including progressive expansions. */
export const MAX_WEBSITE_ITEM_LIMIT = 1000;
const MAX_WEBSITE_OFFSET = 1_000_000_000;

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** Normalize user/config input without allowing an unbounded HTML response. */
export function normalizeWebsiteItemLimit(value: unknown, fallback = DEFAULT_WEBSITE_ITEM_LIMIT): number {
  const safeFallback = Math.min(positiveInteger(fallback) ?? DEFAULT_WEBSITE_ITEM_LIMIT, MAX_WEBSITE_ITEM_LIMIT);
  const parsed = positiveInteger(value);
  return Math.min(parsed ?? safeFallback, MAX_WEBSITE_ITEM_LIMIT);
}

function normalizeWebsiteOffset(value: string | null): number {
  if (value === null || !/^\d+$/.test(value.trim())) return 0;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 0;
  return Math.min(Math.max(parsed, 0), MAX_WEBSITE_OFFSET);
}

export function createApp(db: Db, config: AppConfig, opts: { feedLimit?: number } = {}): Hono {
  const app = new Hono();

  const resolvePath = (rel: string): string => {
    if (isAbsolute(rel)) return rel;
    return resolve(ROOT, rel);
  };
  const readContent = (rel: string): string | null => {
    try {
      return readFileSync(resolvePath(rel), 'utf8');
    } catch {
      return null;
    }
  };

  // HTML escaping + date formatting shared by the root page and the
  // LLM-extraction page.
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (m) =>
      m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : m === '"' ? '&quot;' : '&#39;',
    );
  const fmt = (ts: number | null): string =>
    ts == null ? '—' : new Date(ts).toLocaleString('en-GB', { timeZoneName: 'short' });

  // Per-site text-only mode: per-site config_json.ignore_images wins, else the
  // instance default (defaults.ignore_images). Applied at serve time so config
  // changes take effect immediately without re-scraping.
  const ignoreImagesFor = (site: string): boolean => {
    const row = getSite(db, site);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(row?.config_json ?? '{}');
    } catch {
      cfg = {};
    }
    return typeof cfg.ignore_images === 'boolean' ? cfg.ignore_images : config.defaults.ignore_images;
  };

  // Which extraction path feeds the RSS items for a site: 'tags' (readability
  // + structured metadata) or 'llm' (AI-extracted fields, falling back to tag
  // fields when no sidecar is stored). Per-site config_json extract.feedSource
  // wins, else defaults.feed_source.
  const feedSourceFor = (site: string): 'tags' | 'llm' => {
    const row = getSite(db, site);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(row?.config_json ?? '{}');
    } catch {
      cfg = {};
    }
    const ext = (cfg['extract'] ?? {}) as Record<string, unknown>;
    if (ext['feedSource'] === 'llm' || ext['feedSource'] === 'tags') return ext['feedSource'];
    return config.defaults.feed_source;
  };

  /** The persisted LLM-extraction sidecar (data/<site>/<hash>.llm.json). */
  interface LlmSidecar {
    title?: string | null;
    /** Verbatim article body as clean (sanitized) HTML. */
    html?: string;
    /** Plain-text body (older sidecars / fallback). */
    text?: string;
    url?: string | null;
    publishedAt?: string | null;
    model?: string;
    extractedAt?: number;
  }
  const readLlmSidecar = (site: string, hash: string): LlmSidecar | null => {
    const p = resolvePath(join(config.storage.data_dir, site, `${hash}.llm.json`));
    try {
      if (!existsSync(p)) return null;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as LlmSidecar) : null;
    } catch {
      return null;
    }
  };

  /** Shared article-list row: `Title · cleaned · original`.
   *  - Title opens RSSify's LLM extraction view; without a stored LLM sidecar
   *    it falls back to the canonical external URL (the pre-change title
   *    target, mirroring the feed's llm→tags fallback), and if even that is
   *    missing, to the cleaned view — the title link is never dead.
   *  - `cleaned` keeps opening the stored cleaned article view.
   *  - `original` (replacing the former `LLMextraction` slot) opens the
   *    canonical external scraped-source URL (the LLM sidecar's canonical
   *    pick wins, else the stored source URL — the same resolution the LLM
   *    page and the feed use); omitted when no such URL exists. */
  const articleItemHtml = (site: string, it: ItemRow, llm: LlmSidecar | null): string => {
    const cleanHref = `/${site}/item/${it.hash}`;
    const llmHref = `${cleanHref}/llm`;
    const canonicalUrl = llm?.url || it.url || '';
    const titleHref = llm ? llmHref : canonicalUrl || cleanHref;
    const titleAttrs = !llm && canonicalUrl ? ' target="_blank" rel="noopener"' : '';
    const original = canonicalUrl
      ? `<span class="muted">· <a class="original" href="${esc(canonicalUrl)}" target="_blank" rel="noopener">original</a></span>`
      : '';
    return `<li class="item">
      <span class="date">${esc(fmt(it.published_at ?? it.first_seen))}</span>
      <a class="title" href="${esc(titleHref)}"${titleAttrs}>${esc(it.title || '(untitled)')}</a>
      <span class="muted">· <a class="cleaned" href="${esc(cleanHref)}">cleaned</a></span>${original}
    </li>`;
  };

  function siteFeedHtml(site: string, section: string | null, feedUrl: string): string {
    // opts.feedLimit overrides defaults.feed_item_limit; 0 = every stored
    // article (recentItems runs a LIMIT ?, so map to a huge cap).
    const limit = opts.feedLimit === 0 ? 1_000_000_000 : opts.feedLimit ?? config.defaults.feed_item_limit;
    const items = recentItems(db, site, section, limit);
    const strip = ignoreImagesFor(site);
    const feedSource = feedSourceFor(site);
    const rows = items
      .map((it) => {
        const content = readContent(it.content_path);
        // Tag-based fields are the default; when the site's feedSource is
        // 'llm' the stored LLM sidecar overrides title/link/date/content
        // (falling back to tag fields where the sidecar has nothing).
        let title: string = it.title;
        let link: string = it.url;
        let pubDate: number = it.published_at ?? it.first_seen;
        let contentHtml: string | null = content ? (strip ? stripImages(content) : content) : null;
        let description: string | null = content ? textFromHtml(content) : null;
        if (feedSource === 'llm') {
          const llm = readLlmSidecar(site, it.hash);
          if (llm) {
            if (llm.title) title = llm.title;
            if (llm.url) link = llm.url;
            if (llm.publishedAt) {
              const t = Date.parse(llm.publishedAt);
              if (Number.isFinite(t)) pubDate = t;
            }
            // Verbatim HTML body (sanitized again at serve time); older
            // sidecars carry plain text → convert defensively. Respect the
            // site's ignore_images setting like the tag path does.
            const llmHtml = llm.html
              ? sanitizeArticleHtml(llm.html)
              : textToHtml(llm.text ?? '');
            if (llmHtml) contentHtml = strip ? stripImages(llmHtml) : llmHtml;
            // <description> = full body text (verbatim when the sidecar has it).
            description = llm.text || (llmHtml ? textFromHtml(llmHtml) : null);
          }
        }
        return {
          title,
          link,
          guid: it.hash,
          pubDate,
          description,
          contentHtml,
        } as FeedItem;
      })
      .filter((i) => i);

    const meta: FeedMeta = {
      title: '',
      description: '',
      link: '',
      feedUrl,
      ttlMinutes: 15,
      lastBuildDate: items.reduce((m, it) => Math.max(m, it.first_seen), 0),
      items: rows,
    };

    if (section) {
      const sec = getSection(db, site, section);
      const s = getSite(db, site);
      // Subcategory feeds read as "<Site> - <Section>" (e.g. "Payments Dive -
      // Technology") so they're distinguishable in a reader. When the site
      // title already ends with the section name, don't repeat it.
      const siteTitle = s?.title ?? site;
      const secTitle = sec?.title ?? section;
      meta.title = siteTitle.toLowerCase().endsWith(secTitle.toLowerCase())
        ? siteTitle
        : `${siteTitle} - ${secTitle}`;
      meta.description = sec?.description ?? '';
      meta.link = sec?.index_url ?? '';
    } else {
      const s = getSite(db, site);
      meta.title = s?.title ?? site;
      meta.description = s?.description ?? '';
      meta.link = s?.url ?? '';
      const sched = getSite(db, site);
      meta.ttlMinutes = ttlFromSchedule(sched?.schedule ?? config.defaults.schedule);
    }
    return buildRss(meta);
  }

  function siteStatus(site: string): Record<string, unknown> {
    const s = getSite(db, site);
    const sections = listSections(db, site);
    const items = recentItems(db, site, null, 100000);
    const perSection: Record<string, { indexUrl: string; count: number }> = {};
    for (const sec of sections) {
      perSection[sec.section] = {
        indexUrl: sec.index_url,
        count: recentItems(db, site, sec.section, 100000).length,
      };
    }
    return {
      site,
      url: s?.url,
      schedule: s?.schedule,
      last_scrape_at: s?.last_scrape_at,
      last_scrape_status: s?.last_scrape_status,
      last_error: s?.last_error,
      sections: Object.keys(perSection).length,
      items: items.length,
      per_section: perSection,
    };
  }

  function stripExt(seg: string): { name: string; ext?: string } {
    const dot = seg.lastIndexOf('.');
    if (dot > 0) return { name: seg.slice(0, dot), ext: seg.slice(dot) };
    return { name: seg };
  }

  function serveRss(xml: string): Response {
    return new Response(xml, {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });
  }

  function rootPageHtml(): string {
    const sites = listSites(db).sort((a, b) => a.site.localeCompare(b.site));
    // The main index is a fixed, concise overview: every feed shows exactly the
    // configured per-feed limit. Deeper history lives on the dedicated
    // /feed/<site>/articles page, so the index never expands in place.
    const configuredLimit = normalizeWebsiteItemLimit(config.defaults.website_item_limit);
    const totalItems = sites.reduce((n, s) => n + countItems(db, s.site), 0);

    const blocks = sites.map((s) => {
      const sections = listSections(db, s.site);
      const totalCount = countItems(db, s.site);
      const pageLimit = configuredLimit;
      const pageOffset = 0;
      // Fetch one extra row so the link is based on whether more articles
      // actually exist, without loading all stored records into the response.
      const page = recentItems(db, s.site, null, pageLimit + 1, pageOffset);
      const items = page.slice(0, pageLimit);
      const hasMore = page.length > pageLimit;
      const sectionLinks = sections
        .map((sec) => {
          const count = recentItems(db, s.site, sec.section, 100000).length;
          const siteTitle = s.title || s.site;
          const secTitle = sec.title || sec.section;
          const name = siteTitle.toLowerCase().endsWith(secTitle.toLowerCase())
            ? siteTitle
            : `${siteTitle} - ${secTitle}`;
          return `<li><a href="/${esc(s.site)}/${esc(sec.section)}">${esc(name)}</a>`
            + ` <span class="muted">/${esc(s.site)}/${esc(sec.section)} (${count})</span></li>`;
        })
        .join('');
      const itemRows = items
        .map((it) => articleItemHtml(s.site, it, readLlmSidecar(s.site, it.hash)))
        .join('');
      let moreLink = '';
      if (hasMore) {
        const nextLimit = Math.min(MAX_WEBSITE_ITEM_LIMIT, Math.max(pageLimit + 1, pageLimit * 2));
        const href = `/feed/${encodeURIComponent(s.site)}/articles?limit=${nextLimit}`;
        moreLink = `<p class="show-more"><a href="${esc(href)}">Show more articles</a></p>`;
      }
      return `<section class="site">
        <h2><a href="${esc(s.url || '')}" target="_blank" rel="noopener">${esc(s.title || s.site)}</a>
          <span class="muted">(${esc(s.site)})</span></h2>
        <p class="meta muted">
          feed: <a href="/${esc(s.site)}">/${esc(s.site)}</a> · schedule <code>${esc(s.schedule || '')}</code>
          · last scrape ${esc(fmt(s.last_scrape_at))} (${esc(s.last_scrape_status || 'never')})${s.last_error ? ' · error: ' + esc(s.last_error) : ''}
          · ${totalCount} items${items.length < totalCount ? ` (showing first ${items.length})` : ''}
        </p>
        ${sectionLinks ? `<ul class="sections">${sectionLinks}</ul>` : ''}
        <ol class="items">${itemRows}</ol>
        ${moreLink}
      </section>`;
    }).join('\n');

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>RSSify — feeds</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .5rem; }
  h2 { margin: 1.6rem 0 .3rem; }
  .muted { color: #777; font-size: .85rem; }
  code { background: #f4f4f4; padding: 0 .3em; border-radius: 3px; }
  ul.sections, ol.items { padding-left: 1.4rem; }
  li.item { margin: .35rem 0; }
  .show-more { margin: .8rem 0 0; }
  li.item .date { font-variant-numeric: tabular-nums; color: #555; font-size: .85rem; margin-right: .5rem; }
  .site + .site { border-top: 1px solid #eee; margin-top: 1.6rem; padding-top: .4rem; }
</style>
</head><body>
<h1>RSSify — ${sites.length} feeds, ${totalItems} articles</h1>
${blocks}
<footer class="muted"><p>health: <a href="/health">/health</a></p></footer>
</body></html>`;
  }

  /** Dedicated per-feed article page at /feed/<site>/articles.
   *  The main index stays a fixed overview; this page carries the bounded,
   *  progressive article history for a single site (same limit/offset rules
   *  as the shipped website_item_limit feature). Returns null for unknown
   *  sites (caller replies 404). */
  function feedArticlesPageHtml(site: string, url: URL): string | null {
    const s = getSite(db, site);
    if (!s) return null;
    const configuredLimit = normalizeWebsiteItemLimit(config.defaults.website_item_limit);
    const pageLimit = normalizeWebsiteItemLimit(url.searchParams.get('limit'), configuredLimit);
    const pageOffset = normalizeWebsiteOffset(url.searchParams.get('offset'));
    const totalCount = countItems(db, site);
    // Fetch one extra row so the link is based on whether more articles
    // actually exist, without loading all stored records into the response.
    const page = recentItems(db, site, null, pageLimit + 1, pageOffset);
    const items = page.slice(0, pageLimit);
    const hasMore = page.length > pageLimit;
    const siteTitle = s.title || site;

    const itemRows = items
      .map((it) => articleItemHtml(site, it, readLlmSidecar(site, it.hash)))
      .join('');

    let rangeNote = '';
    if (items.length > 0) {
      rangeNote =
        pageOffset > 0
          ? ` (showing ${pageOffset + 1}–${pageOffset + items.length} of ${totalCount})`
          : items.length < totalCount
            ? ` (showing first ${items.length} of ${totalCount})`
            : ` (${totalCount} items)`;
    } else if (totalCount > 0) {
      rangeNote = ` (no articles on this page — ${totalCount} stored)`;
    } else {
      rangeNote = ' (no articles yet)';
    }

    let moreLink = '';
    if (hasMore) {
      const nextLimit = Math.min(MAX_WEBSITE_ITEM_LIMIT, Math.max(pageLimit + 1, pageLimit * 2));
      const nextOffset = pageLimit >= MAX_WEBSITE_ITEM_LIMIT ? pageOffset + pageLimit : 0;
      const params = new URLSearchParams({ limit: String(nextLimit) });
      if (nextOffset > 0) params.set('offset', String(nextOffset));
      const href = `/feed/${encodeURIComponent(site)}/articles?${params.toString()}`;
      moreLink = `<p class="show-more"><a href="${esc(href)}">Show more articles</a></p>`;
    }

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(siteTitle)} — articles</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .5rem; }
  .muted { color: #777; font-size: .85rem; }
  ol.items { padding-left: 1.4rem; }
  li.item { margin: .35rem 0; }
  .show-more { margin: .8rem 0 0; }
  .nav { margin-bottom: 1rem; }
  .nav a { margin-right: 1.25rem; color: #555; }
  li.item .date { font-variant-numeric: tabular-nums; color: #555; font-size: .85rem; margin-right: .5rem; }
</style>
</head><body>
<p class="nav"><a href="/" title="Back to the main RSSify index">← Back to all feeds</a><a href="/${esc(site)}" title="Subscribe via RSS">RSS feed</a></p>
<h1>${esc(siteTitle)} <span class="muted">(${esc(site)})</span></h1>
<p class="meta muted">${esc(siteTitle)} article history${rangeNote}</p>
<ol class="items">${itemRows}</ol>
${moreLink}
</body></html>`;
  }

  /** Render the stored LLM extraction for one item as an HTML article page
   *  (the counterpart of the `cleaned` route — for RSS readers / comparison). */
  function llmPageHtml(site: string, it: ItemRow, llm: LlmSidecar): string {
    const title = llm.title || it.title || '(untitled)';
    const link = llm.url || it.url;
    const dateTs = llm.publishedAt ? Date.parse(llm.publishedAt) : NaN;
    const dateStr = Number.isFinite(dateTs) ? fmt(dateTs) : fmt(it.published_at ?? it.first_seen);
    const body = llm.html
      ? sanitizeArticleHtml(llm.html)
      : textToHtml(llm.text ?? '');
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(title)} — LLM extraction</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 50rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.6rem; line-height: 1.25; }
  .meta { color: #777; font-size: .85rem; margin-bottom: 1.5rem; word-break: break-all; }
  article p { line-height: 1.6; margin: 0 0 1rem; }
  .muted { color: #777; font-size: .85rem; }
  .muted a { color: #555; }
</style>
</head><body>
<p class="muted"><a href="/${esc(site)}">← ${esc(site)}</a> · <a href="/${esc(site)}/item/${esc(it.hash)}">cleaned</a> · LLMextraction</p>
<h1>${esc(title)}</h1>
<p class="meta"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a> · ${esc(dateStr)}${llm.model ? ` · model: ${esc(llm.model)}` : ''}</p>
<article>${body || '<p class="muted">(no article text extracted — paywalled or unparseable)</p>'}</article>
</body></html>`;
  }

  // Single catch-all handler (custom path grammar).
  app.all('*', (c) => {
    const url = new URL(c.req.url);
    const path = decodeURIComponent(url.pathname);
    // External/public base URL override: feed self-links then point at the
    // public host even when the request arrives via an internal IP/host
    // (e.g. behind Traefik with TLS termination).
    const base = (config.server.public_url ?? '').replace(/\/+$/, '');
    const feedUrl = (base || url.origin) + path + (url.search || '');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('method not allowed', 405);

    if (path === '/' || path === '') {
      return c.html(rootPageHtml());
    }

    if (path === '/health') return c.json({ status: 'ok', time: Date.now() });

    let segments = path.split('/').filter(Boolean);
    // Normalize alias "site.xml" at any final position.
    const plainSite = (seg: string) => stripExt(seg).name;

    // /feed/<site>/articles — dedicated per-feed articles page.
    // Match before the generic 3-segment handler; guard so the item route
    // still wins when a site is literally named "feed".
    if (segments.length === 3 && segments[0] === 'feed' && segments[2] === 'articles' && segments[1] !== 'item') {
      const page = feedArticlesPageHtml(plainSite(segments[1]), url);
      return page === null ? c.text('not found', 404) : c.html(page);
    }

    // /<site>[/.xml]  → merged feed
    // /<site>/<section>[/.xml] → section feed
    // /<site>/status
    // /<site>/item/<hash>[.html]

    if (segments.length === 1) {
      const s = plainSite(segments[0]);
      if (getSite(db, s)) {
        return serveRss(siteFeedHtml(s, null, feedUrl));
      }
      return c.text('not found', 404);
    }

    if (segments.length === 2) {
      const site = segments[0];
      if (!getSite(db, site)) return c.text('not found', 404);
      const second = segments[1];
      if (second === 'status') return c.json(siteStatus(site));
      if (second === 'item' || second === 'opml') return c.text('not found', 404);
      const section = plainSite(second);
      if (getSection(db, site, section)) {
        return serveRss(siteFeedHtml(site, section, feedUrl));
      }
      return c.text('not found', 404);
    }

    if (segments.length === 3) {
      const site = segments[0];
      if (!getSite(db, site)) return c.text('not found', 404);
      const [second, third] = [segments[1], segments[2]];
      if (second === 'item') {
        const hash = plainSite(third);
        const it = getItem(db, site, hash);
        if (!it) return c.text('not found', 404);
        const html = readContent(it.content_path);
        if (html === null) return c.text('content missing', 404);
        return c.html(ignoreImagesFor(site) ? stripImages(html) : html);
      }
      return c.text('not found', 404);
    }

    if (segments.length === 4) {
      const site = segments[0];
      if (!getSite(db, site)) return c.text('not found', 404);
      const [second, third, fourth] = [segments[1], segments[2], segments[3]];
      if (second === 'item' && fourth === 'llm') {
        const hash = plainSite(third);
        const it = getItem(db, site, hash);
        if (!it) return c.text('not found', 404);
        const llm = readLlmSidecar(site, hash);
        if (!llm) {
          return c.text(
            `no LLM extraction stored for this item — re-scrape the site or run \`rssify reprocess ${site}\` to generate it`,
            404,
          );
        }
        return c.html(llmPageHtml(site, it, llm));
      }
      return c.text('not found', 404);
    }

    return c.text('not found', 404);
  });

  return app;
}
