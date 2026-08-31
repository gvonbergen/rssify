import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SectionRef,
  SiteScraper,
} from '../contract.ts';
import { normalizeUrl } from '../util.ts';
import { extractMetadata } from '../clean.ts';
import {
  discoverCandidates,
  findFollowLinks,
  type DiscoveryMode,
} from './discover.ts';

/**
 * Generic scraper served as the default site module. It needs no per-site JS:
 * discovery reads the page's own structure (anchors / embedded JSON / JSON-LD)
 * and parse returns the raw page for the app's central readability + metadata
 * extraction. A small per-site "profile" in config_json tunes it (mode, max),
 * which the app builds and can re-derive automatically on poor quality.
 * The scrape engine is global — it comes from `ctx.engine` (settings).
 */

export async function fetchHtml(
  backends: Backends,
  engine: string,
  url: string,
): Promise<string> {
  if (engine === 'firecrawl') {
    const r = await backends.firecrawl.scrape(url, {});
    return r.html;
  }
  if (engine === 'camofox') {
    return backends.camofox.fetch(url, {});
  }
  return backends.plain.fetch(url, {});
}

/** Pull an HTTP status out of an error message ("plain fetch <url> -> 404"). */
function statusFromError(msg: string): number | null {
  const m = msg.match(/->\s*(\d{3})\s*$/);
  if (m) return Number(m[1]);
  const alt = (msg.match(/\b[45]\d\d\b/g) || []).at(-1);
  return alt ? Number(alt) : null;
}

interface GenericProfile {
  extract?: {
    mode?: DiscoveryMode;
    max?: number;
    follow?: boolean;
    followDepth?: number;
    followUntil404?: boolean;
    waitMs?: number;
  };
  maxArticlesPerDiscover?: number;
}

/**
 * Prefer the article page's timestamp, unless it is implausibly later than the
 * date supplied by discovery. Listing/feed dates can be less precise, but an
 * article cannot normally be published more than a day after it was listed.
 */
export function choosePublishedDate(
  pageDate?: string,
  discoveryDate?: string,
): string | undefined {
  if (!pageDate) return discoveryDate;
  if (!discoveryDate) return pageDate;

  const pageMs = Date.parse(pageDate);
  const discoveryMs = Date.parse(discoveryDate);
  if (!Number.isFinite(pageMs)) return discoveryDate;
  if (!Number.isFinite(discoveryMs)) return pageDate;

  const oneDayMs = 24 * 60 * 60 * 1000;
  return pageMs > discoveryMs + oneDayMs ? discoveryDate : pageDate;
}

export function createGenericScraper(site: string): SiteScraper {
  return {
    site,
    async discover(
      ctx: ScraperContext,
      backends: Backends,
      section: SectionRef,
    ): Promise<DiscoveredItem[]> {
      const cfg = (ctx.config ?? {}) as GenericProfile;
      const ext = cfg.extract ?? {};
      const engine = ctx.engine ?? 'plain';
      const mode = (ext.mode ?? 'auto') as DiscoveryMode;
      const max = Number(ext.max ?? cfg.maxArticlesPerDiscover ?? ctx.discoverMax ?? 100) || 100;

      // Follow "See All News" / pagination pages within the same category to
      // collect more articles than a single page shows. Follow on/off and depth
      // are globally configurable (defaults.follow / defaults.follow_depth) and
      // overridable per site via extract.follow / extract.followDepth.
      const followEnabled = (ext.follow ?? ctx.follow ?? true) !== false;
      const followDepth = Math.min(Math.max(Number(ext.followDepth ?? ctx.followDepth ?? 3) || 0, 0), 8);
      // "Follow until 404": keep crawling pagination until a page returns
      // HTTP 404 (the real end of the chain) instead of a fixed depth.
      const followUntil404 = (ext.followUntil404 ?? ctx.followUntil404 ?? false) === true;

      const visited = new Set<string>();
      const queue: string[] = [section.indexUrl];
      const merged = new Map<string, DiscoveredItem>();
      let followFetched = 0; // follow pages fetched beyond the initial one
      let safety = 0;

      while (queue.length && merged.size < max && safety < 40) {
        const url = queue.shift()!;
        const normUrl = normalizeUrl(url);
        if (visited.has(normUrl)) continue;
        visited.add(normUrl);

        // The index page is mandatory; follow pages are optional enrichment —
        // a transient failure there must not abort discovery.
        const isIndex = normUrl === normalizeUrl(section.indexUrl);
        let html = '';
        let pageStatus: number | null = null;
        try {
          if (followUntil404 && !isIndex && engine === 'camofox' && backends.camofox.fetchWithStatus) {
            const r = await backends.camofox.fetchWithStatus(url);
            html = r.html;
            pageStatus = r.status;
          } else {
            html = await fetchHtml(backends, engine, url);
            pageStatus = 200;
          }
        } catch (e) {
          if (isIndex) throw e;
          // The plain engine reports the status in the error message
          // ("plain fetch <url> -> 404").
          const st = statusFromError(String((e as Error)?.message ?? e));
          if (followUntil404 && st === 404) {
            ctx.logger.info({ url }, 'follow: 404 — reached the end of pagination, stopping');
            break;
          }
          ctx.logger.warn({ url, err: String((e as Error)?.message ?? e) }, 'follow page fetch failed — skipping');
          continue;
        }
        if (followUntil404 && !isIndex && pageStatus === 404) {
          ctx.logger.info({ url }, 'follow: 404 — reached the end of pagination, stopping');
          break;
        }
        safety++;

        // Pass a large per-page cap so a single busy page doesn't mask the
        // follow pages; we trim to `max` at the end.
        const perPageMax = followEnabled ? 100000 : max;
        const cands = discoverCandidates(html, url, { mode, max: perPageMax });
        for (const c of cands) {
          const norm = normalizeUrl(c.url);
          if (!merged.has(norm)) {
            merged.set(norm, { url: norm, hintTitle: c.title, hintDate: c.date });
          }
        }

        // Enqueue category-scoped listing/pagination links (BFS, deduped).
        if (followEnabled && (followUntil404 || followDepth > 0)) {
          if (isIndex || followUntil404 || followFetched < followDepth) {
            for (const f of findFollowLinks(html, url)) {
              const fN = normalizeUrl(f.url);
              if (!visited.has(fN) && !queue.includes(fN)) queue.push(fN);
            }
          }
          if (!isIndex && !followUntil404) followFetched++;
        }
      }

      return [...merged.values()].slice(0, max);
    },

    async parse(
      ctx: ScraperContext,
      backends: Backends,
      item: DiscoveredItem,
    ): Promise<Article> {
      const engine = ctx.engine ?? 'plain';
      if (engine === 'firecrawl') {
        const r = await backends.firecrawl.scrape(item.url, {});
        const meta = extractMetadata(r.html, item.url);
        return {
          url: item.url,
          title: item.hintTitle || 'Untitled',
          html: r.html,
          cleaned: true,
          metadata: r.metadata,
          // The article page's own structured date (JSON-LD /
          // og:article:published_time / <time datetime>) is authoritative;
          // the discovery-page hint (date-only, e.g. "10 Aug 2026") is a
          // fallback for pages that expose no date at all.
          publishedAt: choosePublishedDate(meta.publishedAt, item.hintDate),
        };
      }
      // camofox: raw page via stealth browser → readability (same semantics as
      // plain, but the fetch goes through the JS-capable engine). Some sites
      // lazy-load the article body, so honor the render wait knob.
      const cfg = (ctx.config ?? {}) as GenericProfile;
      const ext = cfg.extract ?? {};
      const waitMs = Number(ext.waitMs ?? ctx.waitMs ?? 0) || 0;
      const html =
        engine === 'camofox'
          ? await backends.camofox.fetch(item.url, { waitMs })
          : await backends.plain.fetch(item.url, {});
      const article: Article = {
        url: item.url,
        title: item.hintTitle || 'Untitled',
        html,
      };
      // Page's own structured date wins over the discovery hint (which is
      // usually date-only; the article page carries the full timestamp).
      const meta = extractMetadata(html, item.url);
      article.publishedAt = choosePublishedDate(meta.publishedAt, item.hintDate);
      return article;
    },
  };
}
