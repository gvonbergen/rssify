import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  ScraperKV,
  SectionRef,
} from '../src/contract.ts';
import { normalizeUrl } from '../src/util.ts';

/**
 * a16z crypto — tag feed scraper (plain engine).
 *
 * The tag index page is Astro SSR: the feed links are Alpine `x-bind:href`
 * templates (no static <a href>), but the server pre-renders the first page
 * of Algolia results into a JSON blob:
 *
 *   <script type="application/json" id="a16z-preloaded-posts">
 *     { "context": {...}, "hits": [ { "post_title": "...",
 *         "post_date": <unix seconds>, "permalink": "/posts/article/<slug>" } ] }
 *   </script>
 *
 * Discovery reads that blob (the ONLY static source of article URLs on the
 * index page), falling back to a permalink regex scan for pages missing the
 * script id. It never crawls beyond the section index URL. For tag sections
 * the blob only carries the latest ~20 items (page 0) — the site's "load more"
 * fetches further pages client-side from its Algolia index, so discovery also
 * pages through Algolia directly (via an in-browser /api/generate-key call,
 * see fetchAlgoliaTagHits) for full tag depth. Parse passes raw article HTML
 * to the app's central readability + metadata extraction (cleaned left unset).
 */

export const site = 'a16zcrypto';

const DEFAULT_PRELOAD_ID = 'a16z-preloaded-posts';
const DEFAULT_MAX_ARTICLES = 50;
const DEFAULT_ARTICLE_PATH_RE = '^/posts/(article|podcast|videos)/';
/** Max Algolia pages to fetch past the preloaded page-0 blob (20 hits/page). */
const DEFAULT_LOAD_MORE_PAGES = 10;

interface A16zConfig {
  maxArticles?: number;
  preloadScriptId?: string;
  articlePathRe?: string;
  /** How many Algolia pages (20 hits each) to fetch for tag sections. */
  loadMorePages?: number;
}

interface A16zHit {
  post_title?: unknown;
  post_date?: unknown;
  permalink?: unknown;
  post_type?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function asEpochSeconds(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function toIso(sec?: number): string | undefined {
  if (sec === undefined) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

async function fetchHtml(backends: Backends, engine: string, url: string): Promise<string> {
  if (engine === 'firecrawl') {
    const r = await backends.firecrawl.scrape(url, {});
    return r.html;
  }
  if (engine === 'camofox') return backends.camofox.fetch(url, {});
  return backends.plain.fetch(url, {});
}

/**
 * Fetch the full tag feed straight from the site's Algolia index.
 *
 * The tag index page only pre-renders page 0 (20 hits) into the
 * `a16z-preloaded-posts` blob; the "load more" button fetches further pages
 * client-side. The Algolia credentials come from POST /api/generate-key,
 * which is AWS-WAF-protected against non-browser callers AND rate-limited
 * (HTTP 429) — so we run the key fetch and the Algolia queries inside the
 * camofox browser (same origin, browser fingerprint, no page scripts needed),
 * and cache the 5-minute key in the per-site KV to avoid hammering the
 * endpoint on every discovery run. Returns hits for the tag beyond the static
 * page-0 blob.
 *
 * Returns [] when the engine can't do in-page fetches (non-camofox) or the
 * key endpoint is rate-limited (the static blob still gives page 0).
 */
async function fetchAlgoliaTagHits(
  backends: Backends,
  engine: string,
  indexUrl: string,
  slug: string,
  maxPages: number,
  kv?: ScraperKV,
  log?: (msg: string) => void,
): Promise<A16zHit[]> {
  if (engine !== 'camofox') return [];

  // Reuse the last 5-minute key when it's still valid (>= 60s headroom).
  const KV_KEY = 'algolia_key';
  let cached: { securedApiKey?: string; appId?: string; indexName?: string; expiresAt?: number } | null = null;
  try {
    const raw = await kv?.get(KV_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { securedApiKey?: string; appId?: string; indexName?: string; expiresAt?: number };
      if (c?.securedApiKey && c?.appId && c?.indexName && c.expiresAt && Date.now() < c.expiresAt - 60000) {
        cached = c;
      }
    }
  } catch {
    /* ignore kv errors */
  }
  const cachedJson = JSON.stringify(
    cached ? { securedApiKey: cached.securedApiKey, appId: cached.appId, indexName: cached.indexName } : null,
  );
  const slugJson = JSON.stringify(slug);

  const expression = `(async () => {
    const cached = ${cachedJson};
    const gk = async () => {
      try {
        const r = await fetch('/api/generate-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (r.status !== 200) return null;
        return await r.json();
      } catch { return null; }
    };
    const query = async (key, page) => {
      const r = await fetch('https://' + key.appId + '-dsn.algolia.net/1/indexes/' + key.indexName + '/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': key.appId,
          'X-Algolia-API-Key': key.securedApiKey,
        },
        body: JSON.stringify({
          query: '',
          hitsPerPage: 20,
          page,
          facetFilters: ['taxonomies.post_tag:' + ${slugJson}],
        }),
      });
      const j = await r.json();
      return { ok: r.ok && !j.message, j };
    };
    let key = cached || null;
    let hits = [];
    let usedKey = null;
    let attempts = 0;
    while (attempts < 2) {
      if (!key) key = await gk();
      if (!key || !key.securedApiKey) break;
      usedKey = key;
      hits = [];
      let failed = false;
      for (let page = 0; page < ${maxPages}; page++) {
        const res = await query(key, page);
        if (!res.ok) { failed = true; break; }
        const pageHits = Array.isArray(res.j.hits) ? res.j.hits : [];
        hits.push(...pageHits);
        if (pageHits.length < 20) break;
      }
      if (!failed) break;
      // Cached key invalid (IP change / expiry) — re-fetch once and retry.
      key = null;
      attempts++;
    }
    return { html: JSON.stringify({
      hits,
      key: usedKey ? { securedApiKey: usedKey.securedApiKey, appId: usedKey.appId, indexName: usedKey.indexName, expiresAt: usedKey.expiresAt } : null,
      error: !usedKey ? 'generate-key failed (rate-limited?)' : undefined,
    }) };
  })()`;

  // One polite pause before the extra in-browser request (2–5s mandate).
  await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)));
  try {
    const out = await backends.camofox.fetch(indexUrl, { waitMs: 1500, evaluateJs: expression });
    const data = JSON.parse(out) as { hits?: unknown[]; key?: { securedApiKey?: string; appId?: string; indexName?: string; expiresAt?: string } | null; error?: string };
    if (data.error) log?.(`algolia depth: ${data.error}`);
    // Cache the fresh key for the next run (valid ~5 min).
    if (data.key?.securedApiKey && data.key.appId && data.key.indexName) {
      const expiresAt = data.key.expiresAt ? Date.parse(data.key.expiresAt) : NaN;
      await kv
        ?.set(
          KV_KEY,
          JSON.stringify({
            securedApiKey: data.key.securedApiKey,
            appId: data.key.appId,
            indexName: data.key.indexName,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300000,
          }),
        )
        .catch(() => {});
    }
    if (!Array.isArray(data.hits)) return [];
    // Algolia stores some permalinks on the CMS origin (cms.a16zcrypto.com)
    // — rewrite to the public origin so the module's same-origin check passes.
    let origin: string;
    try {
      origin = new URL(indexUrl).origin;
    } catch {
      origin = 'https://a16zcrypto.com';
    }
    const cmsPrefix = 'https://cms.' + new URL(origin).host;
    return data.hits
      .filter((h): h is A16zHit => !!h && typeof h === 'object')
      .map((h) =>
        typeof h.permalink === 'string' && h.permalink.startsWith(cmsPrefix)
          ? { ...h, permalink: origin + h.permalink.slice(cmsPrefix.length) }
          : h,
      );
  } catch (e) {
    log?.(`algolia depth: fetch failed: ${String(e).slice(0, 200)}`);
    return []; // depth is best-effort; the static blob still works
  }
}

/** Tag slug for /posts/tags/<slug> section URLs, else null. */
function tagSlug(indexUrl: string): string | null {
  try {
    const m = new URL(indexUrl).pathname.match(/^\/posts\/tags\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the `a16z-preloaded-posts` JSON script tag into raw hit records.
 * Returns [] when the script is missing or unparseable.
 */
function parsePreloaded(html: string, scriptId: string): A16zHit[] {
  const idQuoted = [`id="${scriptId}"`, `id='${scriptId}'`];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!idQuoted.some((q) => m[0].includes(q))) continue;
    try {
      const data = JSON.parse(m[1]) as { hits?: unknown[] };
      if (!Array.isArray(data?.hits)) return [];
      return data.hits.filter((h): h is A16zHit => !!h && typeof h === 'object');
    } catch {
      return [];
    }
  }
  return [];
}

export async function discover(
  ctx: ScraperContext,
  backends: Backends,
  section: SectionRef,
): Promise<DiscoveredItem[]> {
  const cfg = (ctx.config ?? {}) as A16zConfig;
  const engine = ctx.engine ?? 'plain';
  const max = Math.min(Math.max(Number(cfg.maxArticles ?? DEFAULT_MAX_ARTICLES) || DEFAULT_MAX_ARTICLES, 1), 500);
  const scriptId = cfg.preloadScriptId ?? DEFAULT_PRELOAD_ID;
  let pathRe: RegExp;
  try {
    pathRe = new RegExp(cfg.articlePathRe ?? DEFAULT_ARTICLE_PATH_RE);
  } catch {
    pathRe = new RegExp(DEFAULT_ARTICLE_PATH_RE);
  }

  const html = await fetchHtml(backends, engine, section.indexUrl);
  const origin = new URL(section.indexUrl).origin;
  const seen = new Map<string, DiscoveredItem>();
  const push = (permalink: unknown, title: unknown, date: unknown): void => {
    const p = asString(permalink);
    if (!p) return;
    try {
      const abs = new URL(p, section.indexUrl);
      if (abs.origin !== origin || !pathRe.test(abs.pathname)) return;
      const norm = normalizeUrl(abs.href);
      if (seen.has(norm)) return;
      const item: DiscoveredItem = { url: norm };
      const t = asString(title);
      if (t) item.hintTitle = t;
      const iso = toIso(asEpochSeconds(date));
      if (iso) item.hintDate = iso;
      seen.set(norm, item);
    } catch {
      /* ignore malformed permalink */
    }
  };

  // Primary: server-preloaded Algolia hits.
  for (const h of parsePreloaded(html, scriptId)) {
    push(h.permalink, h.post_title, h.post_date);
  }

  // Fallback: regex over HTML-entity-escaped JSON (e.g. `x-data` featured
  // posts) when the script blob is missing/renamed.
  if (seen.size === 0) {
    const unescaped = html
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    for (const m of unescaped.matchAll(/"post_title"\s*:\s*"([^"]*)","post_date"\s*:\s*(\d+),"permalink"\s*:\s*"([^"]+)"/g)) {
      push(m[3], m[1], m[2]);
    }
    if (seen.size === 0) {
      for (const m of unescaped.matchAll(/"permalink"\s*:\s*"((?:\/|https?:)?[^"]+)"/g)) {
        push(m[1].replace(/\\\//g, '/'), undefined, undefined);
      }
    }
  }

  // Depth: for tag sections, fetch further pages straight from Algolia (the
  // page only pre-renders 20 hits; the site's own "load more" is client-side).
  // Best-effort — if it fails, discovery still has the static page-0 hits.
  const slug = tagSlug(section.indexUrl);
  if (slug) {
    const loadMore = Math.min(
      Math.max(Number(cfg.loadMorePages ?? DEFAULT_LOAD_MORE_PAGES) || DEFAULT_LOAD_MORE_PAGES, 0),
      50,
    );
    if (loadMore > 0) {
      const extra = await fetchAlgoliaTagHits(
        backends,
        engine,
        section.indexUrl,
        slug,
        loadMore,
        ctx.kv,
        (m) => ctx.logger?.warn?.({ site: 'a16zcrypto', section: section.section }, m),
      );
      for (const h of extra) {
        push(h.permalink, h.post_title, h.post_date);
      }
    }
  }

  return [...seen.values()].slice(0, max);
}

export async function parse(
  ctx: ScraperContext,
  backends: Backends,
  item: DiscoveredItem,
): Promise<Article> {
  const cfg = (ctx.config ?? {}) as A16zConfig;
  const engine = ctx.engine ?? 'plain';

  if (engine === 'firecrawl') {
    const r = await backends.firecrawl.scrape(item.url, {});
    const article: Article = {
      url: item.url,
      title: item.hintTitle ?? 'Untitled',
      html: r.html,
      cleaned: true,
      metadata: r.metadata,
    };
    if (item.hintDate) article.publishedAt = item.hintDate;
    return article;
  }

  const html = await fetchHtml(backends, engine, item.url);
  const article: Article = {
    url: item.url,
    title: item.hintTitle ?? 'Untitled',
    html,
  };
  if (item.hintDate) article.publishedAt = item.hintDate;
  return article;
}

export default { site, discover, parse };