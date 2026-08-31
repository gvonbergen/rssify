import { JSDOM } from 'jsdom';
import { load } from 'cheerio';
import { Readability } from '@mozilla/readability';
import { normalizeUrl } from './util.ts';

export interface ParsedMetadata {
  title?: string;
  author?: string;
  publishedAt?: string; // ISO 8601
  image?: string;
  canonical?: string;
  ogUrl?: string;
}

/**
 * Remove pictures from cleaned article HTML for text-only feeds — drops
 * <picture> wrappers (img + source), any stray <img>, the <figcaption>
 * that belongs to a picture (a caption without its image is noise), and
 * now-empty <figure> wrappers. Regex-based because this runs per request on
 * already-cleaned, well-formed snippets.
 */
export function stripImages(html: string): string {
  let out = html.replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '');
  out = out.replace(/<img\b[^>]*>/gi, '');
  // Captions belong to pictures — drop them too in text-only mode.
  out = out.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, '');
  // Drop figure wrappers left empty by the removals above (figures that
  // still contain other content, e.g. a table, are kept).
  out = out.replace(/<figure\b[^>]*>\s*<\/figure>/gi, '');
  // Collapse whitespace-only block wrappers left behind (e.g. <div></div>
  // around a removed figure). Bounded loop handles nesting.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/<(div|section|article|span)\b[^>]*>\s*<\/\1>/gi, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Escape text for safe inclusion as HTML body content. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert LLM-extracted plain text into a safe HTML fragment: escape
 * everything, split on blank lines into <p> paragraphs, and hard-wrap the
 * rest so long lines render as readable paragraphs. Never trusts the model's
 * output as HTML — everything is escaped first.
 */
export function textToHtml(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.replace(/\n+/g, ' ').trim())
    .filter(Boolean)
    .map((b) => `<p>${escHtml(b)}</p>`);
  if (blocks.length === 0) return '';
  return blocks.join('\n');
}

/**
 * Sanitize LLM-generated article HTML before it is stored/served: drop
 * executable elements (script/style/iframe/…), strip event-handler
 * attributes, block javascript:/data: URLs, and only keep http(s) image
 * sources. The model's output is never trusted as-is.
 */
export function sanitizeArticleHtml(html: string): string {
  const $ = load(html);
  $('script, style, iframe, object, embed, form, input, button, noscript, link, meta, svg, video, audio').remove();
  // Unwrap document-level wrapper tags the model may echo back, leaving a
  // clean body fragment (html/head/body and readability's wrapper divs).
  $('html, head, body').each((_i, el) => {
    $(el).replaceWith($(el).contents());
  });
  $('*').each((_i, el: any) => {
    const attribs = (el.attribs ?? {}) as Record<string, string>;
    for (const k of Object.keys(attribs)) {
      if (k.toLowerCase().startsWith('on')) $(el).removeAttr(k);
    }
  });
  $('a[href]').each((_i, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (/^(javascript|vbscript|data):/i.test(href)) $(el).removeAttr('href');
  });
  $('img[src]').each((_i, el) => {
    const src = ($(el).attr('src') ?? '').trim();
    if (!/^https?:\/\//i.test(src)) $(el).removeAttr('src');
  });
  return $.html() ?? html;
}

export interface CleanResult {
  content: string; // cleaned article HTML (for <content:encoded> / <hash>.html)
  text: string; // plain text (for <description> / LLM input)
}

/**
 * Remove print-header boilerplate some publishers embed at the top of article
 * pages (e.g. Industry Dive: `<!-- logo for print -->` + a
 * "<span>An article from</span> <img logo>" paragraph) plus page chrome that
 * readability sometimes keeps on event/landing pages (breadcrumb nav and
 * footer are blocks of site boilerplate — tagline, contact, address — that
 * add nothing to a feed reader). It adds nothing to a feed reader. Run on
 * readability output; targeted patterns, so legitimate body text is never
 * touched.
 */
export function stripPrintBoilerplate(html: string): string {
  // Comment + the paragraph it precedes.
  let out = html.replace(/<!--\s*logo for print\s*-->[\s\S]*?<\/p>/i, '');
  // Standalone "An article from" paragraph (e.g. when the logo img was
  // already stripped elsewhere).
  out = out.replace(/<p>\s*<span>\s*An article from\s*<\/span>[\s\S]*?<\/p>/i, '');
  // Breadcrumb navigation + footer blocks (e.g. The Paypers event pages keep
  // a `nav[aria-label="Breadcrumb"]` and a `footer` with tagline + contact
  // info inside the readability-selected node).
  // Breadcrumb navigation + footer blocks (e.g. The Paypers event pages keep a
  // `div[data-function-block="Footer"]` with logo, tagline, contact and
  // address that readability folds into the selected node; remove the
  // whole block not just the <footer> element).
  const $ = load(out);
  $('[data-function-block*="footer" i], [data-function-block*="breadcrumb" i], [data-function-block*="menu" i], [data-function-block*="nav" i], [role="contentinfo"], .footer, #footer, footer, nav, [role="navigation"]').remove();
  return $.html() ?? out;
}

export interface CleanOpts {
  /** Per-site opt-in: whole-block ad markers (see `stripAdBlocks`). */
  adMarkers?: string[];
}

/**
 * Remove whole-block ad / promo inserts from cleaned article HTML (e.g. the
 * GlobalData "Access deeper industry intelligence… Find out more" box that
 * Verdict sites embed inside article bodies). Per-site opt-in: the site's
 * `config_json` `extract.ad_markers` lists case-insensitive marker phrases;
 * any element whose own contained text matches one of the marker phrases
 * marker is removed along with already-removed ancestors. Runs on readability
 * output, so legitimate body text is never touched.
 */
export function stripAdBlocks(html: string, markers: string[]): string {
  if (!markers.length) return html;
  const $ = load(html);
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const keys = markers.map(norm).filter(Boolean);
  const gone = new Set<unknown>();
  $(
    'div, section, article, aside, figure, blockquote, ul, ol, table, p, h1, h2, h3, h4, h5, h6, li, td, th, span, a',
  ).each((_: number, el: any) => {
    if ($(el).parents().toArray().some((p) => gone.has(p))) return;
    const t = norm($(el).text());
    // Length guard: only strip short ad-like blocks (the GlobalData box is
    // itself only ~100–300 chars, while a real article body runs into
    // thousands). Without this, an article that legitimately quotes a
    // marker phrase in its body (e.g. "access deeper industry
    // intelligence… find out more") gets nuked wholesale.
    if (!t || t.length > 600) return;
    if (t && keys.some((k) => t.includes(k))) {
      gone.add(el);
      $(el).remove();
    }
  });
  return $.html() ?? html;
}

/**
 * Clean a raw page HTML with @mozilla/readability. Returns cleaned article HTML +
 * extracted plain text, or null if readability found no article content.
 * Relative src/href in the result are absolutized against `baseUrl`.
 *
 * Robustness: jsdom's CSS cascade parses every `<style>` block with css-tree and
 * can THROW on malformed CSS (observed: cryptonomist.ch article pages — the whole
 * article was lost). Readability 0.6 never reads computed styles, so on failure we
 * retry once with stylesheets stripped — safe, and rescues those pages.
 */
export function cleanHtml(
  rawHtml: string,
  baseUrl: string,
  opts: CleanOpts = {},
): CleanResult | null {
  let parsed = extractArticle(rawHtml, baseUrl);
  if (!parsed) parsed = extractArticle(stripStylesheets(rawHtml), baseUrl);
  if (!parsed) return null;
  const { content: articleContent, textContent } = parsed;
  let content: string;
  let text: string;
  try {
    content = stripPrintBoilerplate(articleContent);
    if (opts.adMarkers?.length) {
      content = stripAdBlocks(content, opts.adMarkers);
    }
    text = textContent?.trim() ?? '';
  } catch {
    return null;
  }
  return { content: absolutize(content, baseUrl), text };
}

/** One JSDOM + Readability attempt; null when construction or parsing fails. */
function extractArticle(
  html: string,
  baseUrl: string,
): { content: string; textContent: string | null | undefined } | null {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) return null;
    return { content: article.content, textContent: article.textContent };
  } catch {
    return null;
  }
}

/** Remove <style> blocks + stylesheet <link>s (jsdom CSS crash workaround). */
function stripStylesheets(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, '');
}

/** Resolve relative src/href against a base URL (absolute URLs pass through). */
export function absolutize(html: string, baseUrl: string): string {
  const $ = load(html);
  const base = new URL(baseUrl);
  const abs = (value: string): string | null => {
    if (/^(data:|#|mailto:|javascript:|tel:)/i.test(value)) return null;
    try {
      return new URL(value, base).href;
    } catch {
      return null;
    }
  };
  $('[src]').each((_i, el) => {
    const v = $(el).attr('src');
    if (v) {
      const a = abs(v);
      if (a) $(el).attr('src', a);
    }
  });
  $('[href]').each((_i, el) => {
    const v = $(el).attr('href');
    if (v) {
      const a = abs(v);
      if (a) $(el).attr('href', a);
    }
  });
  // Also handle srcset (simplify to first candidate + src fallback).
  $('[srcset]').each((_i, el) => {
    const v = $(el).attr('srcset');
    if (!v) return;
    const parts = v.split(',');
    if (parts.length) {
      const first = parts[0].trim().split(/\s+/)[0];
      const a = abs(first);
      if (a) {
        $(el).removeAttr('srcset');
        $(el).attr('src', a);
      }
    }
  });
  return $.html();
}

/** Extract plain text from HTML (for <description> / LLM input). */
export function textFromHtml(html: string): string {
  const $ = load(html);
  // Some sites (ASP.NET-era pages, e.g. Finextra) wrap the ENTIRE document
  // in a single <form>; stripping forms/buttons/nav then destroys the whole
  // body. Measure first, and only keep the stripped result if it didn't nuke
  // most of the page — otherwise fall back to the raw body text.
  const before = $('body').text().replace(/\s+/g, ' ').trim();
  $('script,style,noscript,svg,form,button,nav,footer,aside,header').remove();
  const after = $('body').text().replace(/\s+/g, ' ').trim();
  if (after.length >= Math.max(1, Math.floor(before.length / 4))) return after;
  return before || $('*').first().text().replace(/\s+/g, ' ').trim();
}

/**
 * Extract structured metadata from raw HTML (camofox path): JSON-LD →
 * Open Graph/Twitter meta → <time>/microdata, plus canonical URL.
 * Fields the module set explicitly win over this (handled by the caller).
 */
export function extractMetadata(rawHtml: string, url: string): ParsedMetadata {
  const out: ParsedMetadata = {};
  let $: ReturnType<typeof load>;
  try {
    $ = load(rawHtml);
  } catch {
    return out;
  }

  // Canonical metadata is commonly relative. Resolve it against the fetched
  // page before normalization, and ignore malformed values without losing the
  // rest of the metadata extraction.
  const resolveMetaUrl = (value: string): string | undefined => {
    try {
      return normalizeUrl(new URL(value, url).href);
    } catch {
      return undefined;
    }
  };
  const canonical = $('link[rel="canonical"]').first().attr('href');
  if (canonical) out.canonical = resolveMetaUrl(canonical);

  // og:url — the page's own canonical identity; used as fallback when the
  // <link rel=canonical> points at a different domain (cross-published content).
  const ogUrl = $('meta[property="og:url"]').first().attr('content');
  if (ogUrl) out.ogUrl = resolveMetaUrl(ogUrl);

  // JSON-LD (Article / NewsArticle / BlogPosting). Collect every block, then
  // prefer an article-typed node over the first block: sites (e.g. The
  // Paypers) emit a BreadcrumbList block before the NewsArticle, and the
  // breadcrumb's shape would otherwise shadow the real date.
  const ARTICLE_TYPES = new Set(['NewsArticle', 'Article', 'BlogPosting']);
  const candidates: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      // Some sites (e.g. CCN) wrap the article node in a @graph container
      // instead of a top-level array; others use an array of graphs. Unwrap
      // until we land on the actual typed node.
      let node = unwrapJsonLd(parsed);
      while (Array.isArray(node) && node.length) node = unwrapJsonLd(node);
      if (node && typeof node === 'object') candidates.push(node as Record<string, unknown>);
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const isArticle = (n: Record<string, unknown>): boolean => {
    const t = n['@type'];
    const types = Array.isArray(t) ? (t as unknown[]) : [t];
    return types.some((x) => ARTICLE_TYPES.has(String(x)));
  };
  const jsld = candidates.find(isArticle) ?? candidates[0] ?? null;
  if (jsld) {
    const title = first(jsld['headline'], jsld['name'], jsld['title']);
    if (title) out.title = String(title);
    const date = first(jsld['datePublished'], jsld['dateModified']);
    if (date) out.publishedAt = String(date);
    const author = authorFromJsonLd(jsld['author']);
    if (author) out.author = author;
    const image = imageFromJsonLd(jsld['image']);
    if (image) out.image = image;
  }

  const og = (prop: string) => $(`meta[property="${prop}"], meta[name="${prop}"]`).first().attr('content');
  const twitter = (name: string) => $(`meta[name="${name}"]`).first().attr('content');

  if (!out.title) out.title = og('og:title') ?? twitter('twitter:title') ?? undefined;
  if (!out.publishedAt) out.publishedAt = og('article:published_time') ?? undefined;
  if (!out.author) out.author = og('article:author') ?? twitter('twitter:creator') ?? undefined;
  if (!out.image) {
    out.image =
      og('og:image:secure_url') ??
      og('og:image') ??
      twitter('twitter:image') ??
      undefined;
  }

  // <time datetime> fallback for publishedAt
  if (!out.publishedAt) {
    const t = $('time[datetime]').first().attr('datetime');
    if (t) out.publishedAt = t;
  }

  // Visible-text fallback: some sites (IR portals, press rooms) expose the
  // publish date only as plain text near the byline, e.g. "July 28, 2026".
  // Last resort — first full-date match in document order (bylines come
  // before footers/sidebars), US or EU ordering.
  if (!out.publishedAt) {
    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const m =
      bodyText.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/,
      ) ??
      bodyText.match(
        /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/,
      );
    if (m) out.publishedAt = m[0];
  }
  return out;
}

function first(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Drill into a JSON-LD document to find the typed article node:
 *  - top-level array of nodes, or
 *  - a `@graph` container (single or array) of nodes.
 * Prefers NewsArticle/Article/BlogPosting over the first node.
 */
function unwrapJsonLd(n: unknown): unknown {
  if (Array.isArray(n)) {
    const types = ['NewsArticle', 'Article', 'BlogPosting'];
    for (const t of types) {
      const found = n.find(
        (x) => x && typeof x === 'object' && (x as { '@type'?: unknown })['@type'] === t,
      );
      if (found) return found;
    }
    return n[0];
  }
  if (n && typeof n === 'object') {
    const graph = (n as { '@graph'?: unknown })['@graph'];
    if (Array.isArray(graph)) return unwrapJsonLd(graph);
  }
  return n;
}

function authorFromJsonLd(a: unknown): string | undefined {
  if (!a) return undefined;
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return authorFromJsonLd(a[0]);
  if (typeof a === 'object') {
    const o = a as Record<string, unknown>;
    const name = o['name'];
    if (typeof name === 'string') return name;
    const nested = o['author'];
    if (nested) return authorFromJsonLd(nested);
  }
  return undefined;
}

function imageFromJsonLd(img: unknown): string | undefined {
  if (!img) return undefined;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return imageFromJsonLd(img[0]);
  if (typeof img === 'object') {
    const o = img as Record<string, unknown>;
    const u = o['url'];
    if (typeof u === 'string') return u;
  }
  return undefined;
}
