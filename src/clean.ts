import { JSDOM, VirtualConsole } from 'jsdom';
import { load } from 'cheerio';
import { Readability } from '@mozilla/readability';
import { normalizeUrl } from './util.ts';
import { logger } from './logger.ts';
import { looksLikeJunkBody } from './quality.ts';

/**
 * Minimal logger shape the jsdom warning router needs. pino loggers satisfy
 * it structurally; kept narrow so tests can pass a capturing fake.
 */
export interface JsdomWarningSink {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** Cap the offending-CSS snippet attached to a warning (sheetText can be huge). */
const MAX_CSS_SNIPPET = 200;

/**
 * Construct a JSDOM whose virtual console routes jsdomErrors (recoverable
 * `<style>`/stylesheet parse failures such as "Could not parse CSS
 * stylesheet") through the RSSify logger WITH the page URL attached, instead
 * of jsdom's default virtual console, which forwards the bare message to
 * `console.error` with no site/item context. Warnings stay non-fatal: jsdom
 * keeps the valid parts of a broken stylesheet and parsing continues.
 */
export function openAttributedDom(
  html: string,
  url: string,
  sink: JsdomWarningSink = logger,
): JSDOM {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error & { type?: string; sheetText?: string }) => {
    const sheet = typeof e.sheetText === 'string' ? e.sheetText : undefined;
    sink.warn(
      {
        url,
        jsdomErrorType: e.type,
        css: sheet ? sheet.slice(0, MAX_CSS_SNIPPET) : undefined,
      },
      `jsdom: ${e.message}`,
    );
  });
  return new JSDOM(html, { url, virtualConsole: vc });
}

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

/**
 * Restore the source-declared hero image (og:image / JSON-LD image) when the
 * cleaned article has no in-body image — the audits found ~49% of cleaned
 * views render text-only while the source declares an og:image. The URL is
 * absolutized against the article URL and restricted to http(s) (the same
 * image-safety rule the sanitizer applies to stored images); anything else is
 * ignored. Insertion is byte-exact string splicing — right after the
 * `<body>` tag for full-document serializations (the stored clean pipeline's
 * format), prepended for fragments — so the rest of the stored markup is
 * untouched. Text-only feeds strip the figure again at serve time
 * (stripImages).
 */
export function withHeroImage(
  content: string,
  imageUrl: string | undefined | null,
  baseUrl: string,
): string {
  const src = (imageUrl ?? '').trim();
  if (!src) return content;
  if (/<img\b/i.test(content)) return content;
  let abs: string;
  try {
    const u = new URL(src, baseUrl);
    if (!/^https?:$/.test(u.protocol)) return content;
    abs = u.href;
  } catch {
    return content;
  }
  const figure = `<figure><img src="${abs.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></figure>`;
  const bodyOpen = /<body[^>]*>/i.exec(content);
  if (bodyOpen) {
    const idx = bodyOpen.index + bodyOpen[0].length;
    return content.slice(0, idx) + figure + content.slice(idx);
  }
  return figure + content;
}

export interface CleanResult {
  content: string; // cleaned article HTML (for <content:encoded> / <hash>.html)
  text: string; // plain text (for <description>)
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

/**
 * Marker matcher shared by the block strippers: a marker containing spaces is
 * a phrase (plain substring match); a single-token marker (e.g. the literal
 * "Advt" ad label on ETBFSI pages) matches on word boundaries only, so a
 * marker like "advt" can never bite into "adventure". Text is normalized
 * (whitespace-collapsed, lowercased) before matching.
 */
export function blockMarkerHit(text: string, marker: string): boolean {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const m = marker.trim().toLowerCase();
  if (!m) return false;
  if (/\s/.test(m)) return norm.includes(m);
  return new RegExp(`(^|[^a-z0-9])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(norm);
}

/**
 * Remove recurring consent / preferred-source / advertising / app-promotion /
 * footer / related-content boilerplate blocks from cleaned article HTML.
 * Driven by the `defaults.boilerplate_markers` list (per-site override:
 * config_json `extract.boilerplate_markers`) — the audit-identified recurring
 * artifacts (BigGo/PYMNTS "Preferred Sources" widget, Finextra cookie banner,
 * ETBFSI "Advt" labels, app promos, © footer plates, "You may also like"
 * tails) are shipped as the default marker list.
 *
 * Same guardrails as `stripAdBlocks`: only elements whose OWN contained text
 * matches a marker AND is short (< 600 chars — a real article body runs into
 * thousands) are removed, so an article legitimately quoting a marker phrase
 * in a long paragraph is never nuked. Runs on readability output, so
 * legitimate body text is never touched.
 */
export function stripBoilerplateBlocks(html: string, markers: string[]): string {
  if (!markers.length) return html;
  const $ = load(html);
  const gone = new Set<unknown>();
  // Container guard: a block that carries HALF or more of the whole document
  // text is the article container (readability's wrapper div), not a
  // boilerplate block — removing it would nuke the article (observed on
  // short photo-card captions where the wrapper's text matched a footer
  // marker).
  const totalChars = $('body').text().replace(/\s+/g, ' ').trim().length;
  $(
    'div, section, article, aside, figure, blockquote, ul, ol, table, p, h1, h2, h3, h4, h5, h6, li, td, th, span, a, form, footer, nav, small',
  ).each((_: number, el: any) => {
    if ($(el).parents().toArray().some((p) => gone.has(p))) return;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    // Length guard: only strip short boilerplate-like blocks; a real article
    // body runs into thousands of chars (see stripAdBlocks).
    if (!t || t.length > 600) return;
    if (totalChars > 0 && t.length * 2 > totalChars) return;
    if (markers.some((k) => blockMarkerHit(t, k))) {
      gone.add(el);
      $(el).remove();
    }
  });
  return $.html() ?? html;
}

/**
 * Below this cleaned-text length a body counts as near-empty for the
 * second-chance recovery triggers (mirrors scraper.ts MIN_QUALITY_BODY —
 * kept local to avoid a scraper→clean import cycle).
 */
const NEAR_EMPTY_BODY_CHARS = 200;
/** A raw <article> element must hold at least this much text to seed a
 *  second-chance Readability run (shorter elements are chrome fragments). */
const MIN_ARTICLE_ELEMENT_CHARS = 200;
/** A JSON-LD `articleBody` must hold at least this many characters to
 *  qualify as a substantial body fallback. */
const MIN_ARTICLE_BODY_CHARS = 200;
/** Upper bound for the JSON-LD control-character repair pass (a pathological
 *  multi-MB block is skipped rather than re-scanned). */
const MAX_JSON_LD_REPAIR_CHARS = 2 * 1024 * 1024;

export interface CleanOpts {
  /** Per-site opt-in: whole-block ad markers (see `stripAdBlocks`). */
  adMarkers?: string[];
  /** Recurring boilerplate block markers (see `stripBoilerplateBlocks`);
   *  callers default to `defaults.boilerplate_markers`. */
  boilerplateMarkers?: string[];
  /** Warning sink for jsdom CSS parse warnings (defaults to the root logger). */
  log?: JsdomWarningSink;
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
 * Shared tail of every extraction path: boilerplate strippers (print header,
 * configured boilerplate/ad markers) + absolutization. Returns null when a
 * stripper throws — the same failure contract the original cleanHtml had.
 */
function finalizeClean(
  articleContent: string,
  textContent: string | null | undefined,
  baseUrl: string,
  opts: CleanOpts,
): CleanResult | null {
  let content: string;
  let text: string;
  try {
    content = stripPrintBoilerplate(articleContent);
    if (opts.boilerplateMarkers?.length) {
      content = stripBoilerplateBlocks(content, opts.boilerplateMarkers);
    }
    if (opts.adMarkers?.length) {
      content = stripAdBlocks(content, opts.adMarkers);
    }
    text = textContent?.trim() ?? '';
  } catch {
    return null;
  }
  return { content: absolutize(content, baseUrl), text };
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
 *
 * Second-chance recovery (2026-09 audits): when the primary Readability result
 * is junk (src/quality.ts), near-empty, or missing entirely, two GENERIC recovery
 * passes run before giving up —
 *  1. `<article>`-element retry: re-run Readability scoped to the raw page's
 *     largest `<article>` element (e.g. PANews SSR pages, where the footer
 *     disclaimer out-scores the short brief Readability should have picked).
 *  2. JSON-LD `articleBody` fallback: when a parsed article-typed JSON-LD node
 *     carries a substantial `articleBody` (e.g. Moneycontrol, whose article
 *     region is a JS-injected stub and whose body text exists only in JSON-LD),
 *     sanitize it into plain paragraphs and use it as the body.
 * A recovered body is accepted only when it does NOT itself classify as junk,
 * so boilerplate is never promoted into article content; picture-item-shaped
 * primaries (near-empty body carrying images) are never replaced by either
 * pass. Living inside cleanHtml keeps the scrape path, `rssify reprocess`, and
 * `rssify add` snapshots in sync automatically.
 */
export function cleanHtml(
  rawHtml: string,
  baseUrl: string,
  opts: CleanOpts = {},
): CleanResult | null {
  const html = revealInlineHiddenContent(rawHtml);
  let parsed = extractArticle(html, baseUrl, opts.log);
  if (!parsed) parsed = extractArticle(stripStylesheets(html), baseUrl, opts.log);
  const primary = parsed ? finalizeClean(parsed.content, parsed.textContent, baseUrl, opts) : null;
  const primaryText = primary?.text.trim() ?? '';
  const primaryJunk = primary ? looksLikeJunkBody(primaryText, primary.content).junk : true;
  const primaryNearEmpty = primaryText.length < NEAR_EMPTY_BODY_CHARS;
  if (primary && !primaryJunk && !primaryNearEmpty) return primary;

  const fromArticle = extractFromArticleElement(html, baseUrl, opts, primary, primaryJunk);
  if (fromArticle) return fromArticle;
  const fromJsonLd = extractFromJsonLdArticleBody(rawHtml, baseUrl, opts, primary, primaryJunk);
  if (fromJsonLd) return fromJsonLd;
  return primary;
}

/**
 * Second chance 1: re-run Readability scoped to the raw page's largest
 * `<article>` element. Accepted only when the recovered body classifies as
 * real article text; when the primary was merely near-empty (not junk — e.g. a
 * legitimate short flash brief), the recovery must also be meaningfully fuller
 * than the primary so a good short extraction is never downgraded.
 */
function extractFromArticleElement(
  html: string,
  baseUrl: string,
  opts: CleanOpts,
  primary: CleanResult | null,
  primaryJunk: boolean,
): CleanResult | null {
  if (primary && !primaryJunk && /<img\b/i.test(primary.content)) return null;
  let bestHtml: string | null = null;
  let bestLen = 0;
  try {
    const $ = load(html);
    $('article').each((_i, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > bestLen) {
        bestLen = t.length;
        bestHtml = $.html(el);
      }
    });
  } catch {
    return null;
  }
  if (!bestHtml || bestLen < MIN_ARTICLE_ELEMENT_CHARS) return null;
  const scoped = `<!doctype html><html><head></head><body>${bestHtml}</body></html>`;
  let parsed = extractArticle(scoped, baseUrl, opts.log);
  let cand = parsed ? finalizeClean(parsed.content, parsed.textContent, baseUrl, opts) : null;
  if (!cand) {
    // Readability can refuse very short scoped documents; the element itself
    // is already the article content, so clean it without re-scoring.
    const frag = load(bestHtml);
    frag('script,style').remove();
    cand = finalizeClean(frag.html() ?? bestHtml, '', baseUrl, opts);
  }
  if (!cand) return null;
  cand = { ...cand, text: textFromHtml(cand.content).trim() };
  if (looksLikeJunkBody(cand.text, cand.content).junk) return null;
  if (primary && !primaryJunk && cand.text.trim().length <= primary.text.trim().length) return null;
  return cand;
}

/**
 * Second chance 2: a substantial `articleBody` on an article-typed JSON-LD
 * node (Moneycontrol pattern: DOM article region is a JS-injected stub, the
 * full body lives only in JSON-LD). The raw string is sanitized into plain
 * paragraphs (see `articleBodyToHtml`); the result must not classify junk.
 * Never fires when the primary is merely near-empty AND carries images — that
 * shape is a legitimate picture item, and replacing it would drop the image.
 */
function extractFromJsonLdArticleBody(
  rawHtml: string,
  baseUrl: string,
  opts: CleanOpts,
  primary: CleanResult | null,
  primaryJunk: boolean,
): CleanResult | null {
  if (primary && !primaryJunk && /<img\b/i.test(primary.content)) return null;
  const body = articleBodyFromJsonLd(rawHtml);
  if (!body) return null;
  const built = articleBodyToHtml(body);
  const staged = finalizeClean(built.content, '', baseUrl, opts);
  if (!staged) return null;
  // Text must be derived from the FINAL content (after the boilerplate/ad
  // strippers may have removed blocks), so text and content never diverge.
  const cand: CleanResult = { ...staged, text: textFromHtml(staged.content).trim() };
  if (!cand) return null;
  if (looksLikeJunkBody(cand.text, cand.content).junk) return null;
  return cand;
}

/**
 * Parse a JSON-LD block, tolerating RAW CONTROL CHARACTERS inside string
 * literals (Moneycontrol embeds literal newlines inside `articleBody`, which
 * makes strict JSON.parse throw "Bad control character … in a string"). On
 * strict-parse failure, retry ONCE after escaping control characters inside
 * string literals (string-boundary aware, single bounded pass). Any other
 * malformation keeps the legacy outcome: the block is discarded.
 */
export function parseJsonLdLenient(txt: string): unknown | undefined {
  try {
    return JSON.parse(txt);
  } catch {
    /* fall through to the bounded repair pass */
  }
  if (!txt || txt.length > MAX_JSON_LD_REPAIR_CHARS) return undefined;
  try {
    return JSON.parse(repairJsonLdControlChars(txt));
  } catch {
    return undefined;
  }
}

/**
 * Escape raw control characters inside JSON string literals (string-boundary
 * aware: `"` / `\\` toggling and escapes are honored, so escaped quotes and
 * already-escaped sequences are never corrupted). `\n`/`\r`/`\t`/`\b`/`\f`
 * use their short escapes; other C0 controls get `\uXXXX`.
 */
function repairJsonLdControlChars(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        out += c;
        escaped = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += c;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : code === 0x08 ? '\\b' : code === 0x0c ? '\\f' : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

const ARTICLE_TYPES = new Set(['NewsArticle', 'Article', 'BlogPosting']);

function isArticleNode(n: Record<string, unknown>): boolean {
  const t = n['@type'];
  const types = Array.isArray(t) ? (t as unknown[]) : [t];
  return types.some((x) => ARTICLE_TYPES.has(String(x)));
}

/**
 * Parse every `<script type="application/ld+json">` block (leniently — see
 * `parseJsonLdLenient`) and return the unwrapped typed nodes in document
 * order. Shared by metadata extraction and the `articleBody` body fallback.
 */
function collectJsonLdNodes($: ReturnType<typeof load>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    const parsed = parseJsonLdLenient(txt);
    if (!parsed || typeof parsed !== 'object') return;
    let node = unwrapJsonLd(parsed);
    while (Array.isArray(node) && node.length) node = unwrapJsonLd(node);
    if (node && typeof node === 'object') out.push(node as Record<string, unknown>);
  });
  return out;
}

/**
 * First substantial `articleBody` on an article-typed JSON-LD node, or null.
 * "Substantial" = at least MIN_ARTICLE_BODY_CHARS — a flash-brief-length stub
 * never replaces a cleaned body.
 */
function articleBodyFromJsonLd(rawHtml: string): string | null {
  let $: ReturnType<typeof load>;
  try {
    $ = load(rawHtml);
  } catch {
    return null;
  }
  const articleNode = collectJsonLdNodes($).find(isArticleNode);
  const body = articleNode?.['articleBody'];
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return trimmed.length >= MIN_ARTICLE_BODY_CHARS ? trimmed : null;
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sanitize a JSON-LD `articleBody` string into plain paragraph HTML. The body
 * is treated as UNTRUSTED text: script/style subtrees are dropped, remaining
 * markup is stripped via text extraction, entities are decoded once, and the
 * result is re-escaped into `<p>` elements — no tags, attributes, or URLs from
 * the source survive, so nothing hostile can ride into the stored article.
 * Paragraph breaks come from blank lines (single newlines only when the body
 * has no blank-line structure at all).
 */
function articleBodyToHtml(body: string): CleanResult {
  const $ = load(`<div id="__rssify_ab">${body}</div>`);
  $('script,style').remove();
  const text = $('#__rssify_ab').text() ?? '';
  let paras = text
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paras.length <= 1) {
    paras = text
      .split(/\n/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  const content = paras.map((p) => `<p>${escapeHtmlText(p)}</p>`).join('');
  return { content, text: paras.join(' ') };
}

/**
 * One JSDOM + Readability attempt; null when construction or parsing fails.
 * CSS parse warnings are attributed to `baseUrl` via `openAttributedDom`, and
 * the window is closed eagerly — jsdom 29 retains per-window memory even
 * after the reference drops, and `close()` is the documented release hook.
 */
function extractArticle(
  html: string,
  baseUrl: string,
  sink?: JsdomWarningSink,
): { content: string; textContent: string | null | undefined } | null {
  let dom: JSDOM | null = null;
  try {
    dom = openAttributedDom(html, baseUrl, sink);
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) return null;
    return { content: article.content, textContent: article.textContent };
  } catch {
    return null;
  } finally {
    dom?.window.close();
  }
}

/**
 * Neutralize inline `visibility:hidden` declarations before readability runs.
 * Some publishers (e.g. The Paypers, a Nuxt SSR site) render the article body
 * inside a container carrying inline `style="visibility:hidden;…"` and reveal
 * it client-side. Readability's `_isProbablyVisible` drops such nodes BEFORE
 * scoring, so the highest-scoring surviving candidate becomes site
 * boilerplate (e.g. the footer tagline) — which then passes every quality
 * gate because the boilerplate alone exceeds MIN_QUALITY_BODY. The hidden
 * content is genuinely present in the served HTML; hiding it is a UI reveal
 * device, not a signal that the text is boilerplate (a bot-gated page would
 * have no body at all). Only inline styles are touched: Readability checks
 * `node.style` (inline), never stylesheets, and stylesheet-hidden content is
 * more often genuinely hidden template junk. Removal is declaration-boundary
 * exact, so sibling `*-visibility` properties
 * (`content-visibility`, `backface-visibility`) are never corrupted. Runs as
 * a first-class pre-pass (not a retry) because the boilerplate
 * mis-extraction still SUCCEEDS, so a retry-on-null would never fire.
 */
export function revealInlineHiddenContent(html: string): string {
  const isDocument = /<!doctype\s+html|<\s*html[\s>]/i.test(html);
  const $ = isDocument ? load(html) : load(`<div id="__rssify_reveal">${html}</div>`);
  const visibilityHidden = /^visibility\s*:\s*hidden(?:\s*!important)?$/i;
  $('[style]').each((_i, el: any) => {
    const style = String($(el).attr('style') ?? '');
    const decls = style.split(';').map((d) => d.trim());
    const kept = decls.filter((d) => !visibilityHidden.test(d));
    if (kept.length !== decls.length) $(el).attr('style', kept.join(';'));
  });
  if (isDocument) return $.html() ?? html;
  const out = $('#__rssify_reveal').html();
  return typeof out === 'string' ? out : html;
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

/** Extract plain text from HTML (for <description>). */
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
  // breadcrumb's shape would otherwise shadow the real date. Parsing is
  // lenient (see parseJsonLdLenient): raw control characters inside string
  // literals — e.g. Moneycontrol's multi-line `articleBody` — no longer
  // discard the whole block (which also cost the page its date and author).
  const candidates = collectJsonLdNodes($);
  const jsld = candidates.find(isArticleNode) ?? candidates[0] ?? null;
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
  if (!out.publishedAt)
    out.publishedAt =
      og('article:published_time') ??
      // Moneycontrol (and other sites) emit the OG article namespace WITH the
      // `og:` prefix — `property="og:article:published_time"`.
      og('og:article:published_time') ??
      undefined;
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
