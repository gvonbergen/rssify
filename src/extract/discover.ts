import { JSDOM } from 'jsdom';
import { normalizeUrl } from '../util.ts';

/**
 * Layout-agnostic article discovery.
 *
 * Different sites expose article links in totally different places:
 *   - plain <a href> anchors
 *   - Next.js/SPA embedded JSON (__NEXT_DATA__ etc.) with `uri`/`url` + `date`
 *   - JSON-LD ItemList / <script type="application/ld+json">
 * The generic extractor looks in ALL of them, scores each candidate by how
 * "article-like" it is (URL date pattern, headline-like anchor text, presence
 * of a date field), and returns the strongest candidates — without any per-site
 * template. The page itself tells us where the data is.
 */

export type DiscoveryMode = 'auto' | 'anchors' | 'embedded-json' | 'jsonld-list';

export interface Candidate {
  url: string; // normalized absolute URL
  title?: string;
  date?: string; // ISO-ish
  source: 'anchor' | 'json' | 'jsonld' | 'uri-regex';
  score: number;
}

export interface DiscoverHints {
  /** Preferred source when set, else auto-pick by which source dominates. */
  mode?: DiscoveryMode;
  max?: number;
}

interface Raw {
  url: string;
  title?: string;
  date?: string;
  source: Candidate['source'];
}

const NON_ARTICLE_PATH =
  /\/(?:category|categories|tag|tags|author|authors|archive|archives|page|pages|wp-json|wp-content|wp-admin|login|signup|register|subscribe|contact|about|privacy|terms|legal|cookies|feed|rss|sitemap|search|search-on|wp-includes|submit|selfservice|licensing|email-alerts)(?:\/|$)/i;
const BINARY =
  /\.(?:png|jpe?g|gif|webp|svg|css|js|json|xml|csv|pdf|zip|gz|mp4|mp3|wav|mov|ico)(?:$|\?)/i;

const URL_KEYS = ['uri', 'url', 'articleURL', 'canonical', 'link', 'permalink', 'webUrl', 'href'];
const TITLE_KEYS = ['title', 'headline', 'name', 'displayTitle', 'webTitle', 'heading'];
const DATE_KEYS = [
  'date',
  'publishDate',
  'publishedAt',
  'pubDate',
  'datePublished',
  'dateModified',
  'updated',
  'updatedAt',
  'createdAt',
  'timestamp',
];

function pick(o: Record<string, unknown>, keys: string[]): string | undefined {  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length) return v;
  }
  return undefined;
}

/** Walk any nested JSON value, publishing every object node. */
function walk(value: unknown, push: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, push);
    return;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    push(o);
    for (const v of Object.values(o)) walk(v, push);
  }
}

function collectAnchors(html: string, baseUrl: string): Raw[] {
  try {
    const dom = new JSDOM(html);
    const origin = new URL(baseUrl).origin;
    const out: Raw[] = [];
    for (const a of dom.window.document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      let abs: URL;
      try {
        abs = new URL(href, baseUrl);
      } catch {
        continue;
      }
      if (!/^https?:/i.test(abs.protocol)) continue;
      if (abs.origin !== origin) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({ url: abs.href, title: text, source: 'anchor' });
    }
    dom.window.close();
    return out;
  } catch {
    return [];
  }
}

function collectJson(html: string, baseUrl: string): Raw[] {
  const origin = new URL(baseUrl).origin;
  const out: Raw[] = [];
  const scripts = html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const isLd = /type=["']application\/ld\+json["']/i.test(m[0]);
    walk(data, (o) => {
      const url = pick(o, URL_KEYS);
      let u: URL;
      try {
        u = new URL(url as string, baseUrl);
      } catch {
        return;
      }
      if (!/^https?:/i.test(u.protocol) || u.origin !== origin) return;
      out.push({
        url: u.href,
        title: pick(o, TITLE_KEYS),
        date: pick(o, DATE_KEYS),
        source: isLd ? 'jsonld' : 'json',
      });
    });
  }
  // Fallback for huge/partially-parseable scripts: naive "uri"/"url" scan.
  if (out.length === 0) {
    for (const rm of html.matchAll(/"(?:uri|url|articleURL|canonical)"\s*:\s*"(https?:\/\/[^"\\]+)"/g)) {
      const u0 = rm[1].replace(/\\\//g, '/');
      try {
        if (new URL(u0).origin === origin) out.push({ url: u0, source: 'uri-regex' });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function usable(u: URL): boolean {
  if (BINARY.test(u.pathname)) return false;
  if (NON_ARTICLE_PATH.test(u.pathname)) return false;
  // Single-segment paths are category/nav roots (e.g. /kyc-kyb-and-digital-identity),
  // not articles — they carry no date and are usually navigation.
  if (u.pathname.split('/').filter(Boolean).length < 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Category-aware "follow" crawling
//
// Some index pages only show a handful of articles plus a link to a fuller
// listing ("See All News", "More articles", pagination). We follow those
// links — but ONLY within the same category subtree (e.g. stay under
// /digital-assets/), and never into article pages themselves.
// ---------------------------------------------------------------------------

export interface FollowLink {
  url: string;
  label: string;
}

/** Exit before reaching the internals of that script. */
const ARTICLE_YEAR_PATH = /\/\d{4}\/\d{1,2}\/\d{1,2}\//; // /YYYY/M/D/slug
const ARTICLE_KEY_PATH = /\/article\//i; // evergreen explainer series

/** A URL whose path is a known article path (never follow these). */
function isArticleLike(p: string): boolean {
  return ARTICLE_YEAR_PATH.test(p) || ARTICLE_KEY_PATH.test(p) || /\/\d{4}\//.test(p);
}

/** A URL that looks like a listing / pagination page (follow these). */
function isListingLike(p: string, q: string): boolean {
  const pc = p.replace(/\/+$/, '');
  if (/\/page\/\d+$/i.test(pc)) return true;
  if (/(^|[?&])(page|paged|pg)\s*=\s*\d+/i.test(q)) return true;
  if (/\/?(news|archive|articles|stories|latest|all|more|listing|browse|headlines|index)\/?$/i.test(pc)) return true;
  return false;
}

/** Strong "more content" signal in the link text. */
const FOLLOW_TEXT =
  /see\s*all|view\s*all|show\s*more|load\s*more|all\s*news|more\s*(news|articles|stories|headlines)|latest\s*news|\barchive\b|\bnews\b|\bart'?icles?\b|stories|headlines|listing|^\d+\s*$|\bnext\b/i;

/**
 * Page number carried by a listing URL, or null when the URL has none.
 * Handles query style (?page=N / ?paged=N / ?pg=N) and path style (/page/N).
 */
function pageNumber(u: URL): number | null {
  const q =
    u.searchParams.get('page') ?? u.searchParams.get('paged') ?? u.searchParams.get('pg');
  if (q !== null && /^\d+$/.test(q)) return parseInt(q, 10);
  const m = u.pathname.match(/\/page\/(\d+)\/?$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Find "See All News" / pagination / listing pages reachable from this page
 * that stay within the same category as `sectionUrl`. Returns unique, absolute,
 * same-origin URLs that are listing-like and NOT article pages.
 *
 * Pagination is kept sequential: only the NEXT page (current + 1) is followed,
 * plus unnumbered listing links. Current/older pages and far-ahead "last page"
 * jumps (e.g. centralbanking's pager links page=0 and page=61 from page 1) are
 * dropped — they only re-fetch content the crawl already has or will reach in
 * order, and jumping to the last page pulls the oldest articles for nothing.
 */
export function findFollowLinks(html: string, sectionUrl: string, max = 6): FollowLink[] {
  try {
    const dom = new JSDOM(html);
    const base = new URL(sectionUrl);
    const origin = base.origin;
    const cur = pageNumber(base) ?? 1;
    // Category root = first path segment (e.g. /digital-assets), so we stay
    // inside the channel even when following /digital-assets/news/. A leading
    // file name (index.html) is skipped so a site-root page stays in its whole
    // origin.
    let segs = base.pathname.split('/').filter(Boolean);
    if (segs.length && /\.[a-z0-9]+$/i.test(segs[0])) segs = segs.slice(1);
    const catRoot = segs.length ? '/' + segs[0] : '';
    const out = new Map<string, FollowLink>();
    for (const a of dom.window.document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      let u: URL;
      try {
        u = new URL(href, sectionUrl);
      } catch {
        continue;
      }
      if (!/^https?:/i.test(u.protocol) || u.origin !== origin) continue;
      const path = u.pathname.replace(/\/+$/, '') || '/';
      if (isArticleLike(u.pathname)) continue;
      if (catRoot && !(path + '/').startsWith(catRoot + '/') && path !== catRoot) continue;
      // Pagination hygiene: only the next page (or unnumbered listing links).
      const pn = pageNumber(u);
      if (pn !== null && (pn <= cur || pn > cur + 1)) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      // URL signals are authoritative: real listings/pagination (/page/N,
      // ?page=N, .../news, .../archive) are followed regardless of text. A
      // text-only match is only trusted on shallow URLs (<= 2 path segments)
      // — deep slug paths are almost always article pages, and some sites
      // (e.g. The Paypers) append a "/ News" category label to every article
      // anchor, which would otherwise trigger FOLLOW_TEXT and waste a fetch.
      const urlListing = isListingLike(path, u.search);
      const textListing = FOLLOW_TEXT.test(text);
      const urlDepth = u.pathname.split('/').filter(Boolean).length;
      if (!urlListing && !(textListing && urlDepth <= 2)) continue;
      // skip the section page itself / identical pages
      const norm = normalizeUrl(u.href);
      if (norm === normalizeUrl(sectionUrl)) continue;
      if (!out.has(norm)) out.set(norm, { url: norm, label: text.slice(0, 40) });
      if (out.size >= max) break;
    }
    dom.window.close();
    return [...out.values()];
  } catch {
    return [];
  }
}

function pathScore(u: URL): number {
  const segs = u.pathname.split('/').filter(Boolean);
  let s = 0;
  if (/\b\d{4}\b/.test(u.pathname)) s += 25; // contains a year
  if (/\b\d{4}\b\/\d{1,2}\b\/\d{1,2}\b/.test(u.pathname)) s += 20; // /YYYY/M/D
  if (segs.length >= 3 && segs.length <= 9) s += 8;
  return s;
}

function textScore(t: string | undefined): number {
  if (!t) return 0;
  const n = t.trim().length;
  if (n >= 25 && n <= 220 && /\s/.test(t.trim())) return 20; // headline-like
  if (n >= 12) return 9;
  return 0;
}

function sourceBonus(source: Candidate['source']): number {
  switch (source) {
    case 'json':
    case 'jsonld':
      return 12; // structured data with fields is a strong article signal
    case 'uri-regex':
      return 8;
    default:
      return 5;
  }
}

const p2 = (n: number) => String(n).padStart(2, '0');
const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a leading date phrase out of anchor text / titles, e.g.
 * "August 5, 2026 IMF ...", "5 August 2026 - ...", "2026-08-05...".
 * Returns the ISO date plus the remainder of the text. Works even when the
 * date is glued directly to the title ("August 5, 2026IMF ...").
 */
function leadingDate(s0: string | undefined): { iso: string; rest: string } | undefined {
  if (!s0) return undefined;
  const s = s0.trim();
  let y = 0, mo = 0, d = 0, end = 0;
  let m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/); // "August 5, 2026"
  if (m) {
    mo = MONTH_NUM[m[1].toLowerCase().slice(0, 3)] ?? 0;
    d = +m[2]; y = +m[3]; end = m[0].length;
  } else {
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/); // "5 August 2026"
    if (m) {
      mo = MONTH_NUM[m[2].toLowerCase().slice(0, 3)] ?? 0;
      d = +m[1]; y = +m[3]; end = m[0].length;
    } else {
      const im = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // "2026-08-05"
      if (im) {
        y = +im[1]; mo = +im[2]; d = +im[3]; end = im[0].length;
      } else {
        return undefined;
      }
    }
  }
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const rest = s.slice(end).replace(/^[\s\-–—:·|,]+/, '').trim();
  return { iso: `${y}-${p2(mo)}-${p2(d)}`, rest };
}

/**
 * A date phrase glued into anchor text, e.g.
 *   "… Visa Direct clients10 Aug 2026 / 5 min read / News"
 *   "… EEA users12 Aug 2026 / 5 min read<description>NewsCrypto, Web3 and CBDC"
 * Finds the LAST date phrase. We strip the date (and any following
 * " / …" / "N min read" metadata) from the title ONLY when it looks like
 * appended listing metadata — glued to the previous word, or followed by
 * read-time/category markers. Otherwise we keep the full text as the title
 * but still report the date (e.g. a headline like "What Happened on 6 January 2025").
 */
function trailingDate(s0: string | undefined): { iso: string; rest: string } | undefined {
  if (!s0) return undefined;
  const s = s0.trim();
  const matches = [
    ...s.matchAll(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/g),
  ];
  if (!matches.length) return undefined;
  const m = matches[matches.length - 1];
  const raw = m[1];
  let y = 0, mo = 0, d = 0;
  let im = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (im) {
    y = +im[1]; mo = +im[2]; d = +im[3];
  } else {
    im = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (im) {
      mo = MONTH_NUM[im[2].toLowerCase().slice(0, 3)] ?? 0;
      d = +im[1]; y = +im[3];
    } else {
      im = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
      if (im) {
        mo = MONTH_NUM[im[1].toLowerCase().slice(0, 3)] ?? 0;
        d = +im[2]; y = +im[3];
      }
    }
  }
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const before = s.slice(0, m.index);
  const after = s.slice(m.index + m[0].length);
  const glued = before.length > 0 && /\S$/.test(before); // no whitespace before the date
  const metaAfter = /^\s*(\/|min read|\d+\s*min)/i.test(after);
  if (!((after === '' && glued) || metaAfter)) {
    // Date is part of the headline itself — keep the full text, still report it.
    return { iso: `${y}-${p2(mo)}-${p2(d)}`, rest: s };
  }
  const rest = before.replace(/[\s\-–—:·|,]+$/, '').trim();
  // When the remainder ends in digits: a trailing 4-digit year is the title's
  // own year ("…Life 202527 October 2025") — strip. A final token that is
  // purely 1–3 digits is likely a glued range ("…Convention 1115 October 2025"
  // -> keep "…Convention 11"? no: keep full). Digits inside an alphanumeric
  // token ("…with B2C216 July 2026") are part of a name — strip is safe there.
  const lastToken = (rest.split(/[\s\-–—:·|,]+/).at(-1) ?? '').trim();
  const endsWithYear = /(?:19|20)\d{2}$/.test(rest);
  const pureShortDigits = /^\d{1,3}$/.test(lastToken);
  const title =
    rest && (!/\d$/.test(rest) || endsWithYear || !pureShortDigits) ? rest : s;
  return { iso: `${y}-${p2(mo)}-${p2(d)}`, rest: title };
}

/** /YYYY/MM/DD/ in the URL path (e.g. imf.org/en/news/articles/2026/05/21/…). */
function dateFromPath(pathname: string): string | undefined {
  const m = pathname.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (!m) return undefined;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${p2(mo)}-${p2(d)}`;
}

/**
 * Discover + score article candidates from any index page. Returns candidates
 * sorted best-first. Never needs a template: it reads the page's own structure.
 */
export function discoverCandidates(
  html: string,
  indexUrl: string,
  hints: DiscoverHints = {},
): Candidate[] {
  const origin = new URL(indexUrl).origin;
  // The section's own listing page (and any query variant of it, e.g.
  // /topic/technology?page=2) is a *discovery* page, not an article. It is
  // followed for links but must never become a parse candidate — query
  // variants hash differently and would otherwise be re-fetched every crawl
  // and inserted as junk "articles".
  const indexPath = new URL(indexUrl).pathname.replace(/\/+$/, '');
  const isListing = (u: URL): boolean => u.pathname.replace(/\/+$/, '') === indexPath;
  const mode = hints.mode ?? 'auto';
  const raws: Raw[] = [...collectAnchors(html, indexUrl), ...collectJson(html, indexUrl)];

  const byUrl = new Map<string, Candidate>();
  for (const r of raws) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.origin !== origin || !usable(u) || isListing(u)) continue;
    if (mode === 'embedded-json' && r.source === 'anchor') continue;
    if (mode === 'anchors' && r.source !== 'anchor' && !r.date) continue;

    const norm = normalizeUrl(u.href);
    // Structured date wins; otherwise a date in the URL path, then a leading
    // date phrase in the anchor text, then a trailing date phrase (e.g. the
    // Paypers: "… Visa Direct clients10 Aug 2026 / 5 min read / News").
    // Leading/trailing dates are also stripped from the title.
    const ld = leadingDate(r.title);
    const td = ld ? undefined : trailingDate(r.title);
    const date = r.date ?? dateFromPath(u.pathname) ?? ld?.iso ?? td?.iso;
    const title = r.date ? r.title : ((ld?.rest ?? td?.rest) ?? r.title);
    let score = pathScore(u) + textScore(title) + (date ? 15 : 0) + sourceBonus(r.source);
    // In explicit embedded-json mode, anchors lose their headline bonus.
    if (mode === 'embedded-json' && r.source === 'anchor') score = Math.min(score, 8);

    // Accept when there is a strong signal: a year-in-path, headline-like link
    // text, or a structured source carrying a date. This covers both
    // "YYYY/MM/DD/slug" sites and simple sites with plain file names.
    const path = pathScore(u);
    const text = textScore(r.title);
    const accept =
      path >= 30 ||
      text >= 12 ||
      score >= 30 ||
      ((r.source === 'json' || r.source === 'jsonld') && (date || path >= 20));

    const existing = byUrl.get(norm);
    if (!existing) {
      if (accept) byUrl.set(norm, { url: norm, title, date, source: r.source, score });
    } else {
      if (!existing.title && title) existing.title = title;
      if (!existing.date && date) existing.date = date;
      existing.score = Math.max(existing.score, score);
    }
  }

  const arr = [...byUrl.values()];
  arr.sort((a, b) => b.score - a.score);
  const max = Number.isFinite(hints.max) ? Number(hints.max)! : 100;
  return arr.slice(0, max);
}

/** Which source dominates the strongest candidates — the "page personality". */
export function detectMode(cands: Candidate[]): DiscoveryMode {
  const counts: Record<string, number> = {};
  for (const c of cands.slice(0, 30)) counts[c.source] = (counts[c.source] ?? 0) + 1;
  const json = (counts['json'] ?? 0) + (counts['jsonld'] ?? 0) + (counts['uri-regex'] ?? 0);
  const anchors = counts['anchor'] ?? 0;
  if (json > 0 && json >= anchors) return 'embedded-json';
  if (anchors > 0) return 'anchors';
  return 'auto';
}
