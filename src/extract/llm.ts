import OpenAI from 'openai';
import type { AppConfig } from '../config.ts';
import { extractMetadata, sanitizeArticleHtml, textFromHtml } from '../clean.ts';

/**
 * LLM-based article extraction — the parallel alternative to tag-based
 * extraction (readability + structured metadata). Given a raw article page,
 * the model returns the four fields the RSS feed needs:
 *
 *   - title: the article headline
 *   - text:  the FULL article body as plain text — no ads, navigation,
 *            cookie banners, paywall stubs, comments or boilerplate
 *   - url:   the canonical article URL
 *   - publishedAt: ISO 8601 publication date
 *
 * The result is persisted to a per-item sidecar (`data/<site>/<hash>.llm.json`)
 * by the scraper, so the feed / `/item/<hash>/llm` route can serve it without
 * re-calling the model. This module is fully self-contained: removing the
 * feature later means dropping this file, the call site in `persistArticle`,
 * the route/link, and the `llm_extract` / `feed_source` / `extract_max_tokens`
 * config knobs — the tag-based path is untouched.
 */

export interface LlmExtraction {
  /** Extracted headline (may be null if the model couldn't determine it). */
  title: string | null;
  /** Full article body as clean HTML, reproduced verbatim (no ads/garbage),
   *  sanitized before storage. */
  html: string;
  /** Plain-text version of the body (derived when the model only returns
   *  html) — used as a fallback by older consumers. */
  text: string;
  /** Canonical article URL (model-picked; caller decides whether to trust). */
  url: string | null;
  /** ISO 8601 publication date, or null. */
  publishedAt: string | null;
  /** Model that produced this extraction (for provenance in the UI). */
  model: string;
  /** Epoch ms when the extraction ran. */
  extractedAt: number;
}

const SYSTEM_PROMPT = `You are a precise article extraction engine. You are given a page URL, the structured metadata extracted from a news article page, and the article content (HTML) extracted from that page.
Extract exactly these fields and return ONLY a single JSON object (no markdown, no commentary):
{
  "title": "the article's headline — exactly as it appears, without the site name",
  "html": "the FULL article body as clean HTML, reproduced VERBATIM — every sentence exactly as written on the page, word for word. Do NOT paraphrase, summarize, condense, add or rewrite ANY sentence. Preserve the original structure: <p> paragraphs, <h2>/<h3> headings, <ul>/<ol> lists, <blockquote>, <strong>/<em> emphasis and links. Remove ONLY the garbage: advertisements, sponsored/promo boxes, navigation menus, cookie/consent banners, newsletter signup forms, paywall stubs, related-article teasers, author bio boilerplate, comments, footers and other page chrome. If the article is paywalled or the real body is not present, return an empty string.",
  "url": "the canonical URL of the article (prefer the canonical/og:url from the metadata, else the page URL)",
  "publishedAt": "the publication date as an ISO 8601 string (prefer the metadata publishedAt, else find it in the text). If no date is present, use null."
}`;

/**
 * Build the compact prompt input: structured metadata (title/canonical/date
 * from the page head) plus the article content — NOT the raw HTML, which is
 * mostly chrome and would either blow the token budget or get truncated
 * before the body appears. `html` is the caller's already-cleaned article
 * HTML (readability / firecrawl) so the model can reproduce it verbatim WITH
 * formatting; `text` is the plain-text fallback; when neither is given a
 * cheap tag-strip of the raw HTML is used.
 */
function buildInput(
  rawHtml: string,
  url: string,
  text: string | undefined,
  html: string | undefined,
  maxChars: number,
): string {
  const meta = extractMetadata(rawHtml, url);
  const metaLines: string[] = [];
  if (meta.title) metaLines.push(`title: ${meta.title}`);
  if (meta.publishedAt) metaLines.push(`publishedAt: ${meta.publishedAt}`);
  if (meta.canonical) metaLines.push(`canonical: ${meta.canonical}`);
  if (meta.ogUrl) metaLines.push(`ogUrl: ${meta.ogUrl}`);
  if (meta.author) metaLines.push(`author: ${meta.author}`);
  const metaBlock = metaLines.length ? metaLines.join('\n') : '(no structured metadata found)';
  const content = html ?? (text ?? textFromHtml(rawHtml)).replace(/\s+/g, ' ').trim();
  const label = html ? 'ARTICLE CONTENT (HTML) EXTRACTED FROM THE PAGE' : 'ARTICLE TEXT EXTRACTED FROM THE PAGE';
  const input =
    `Page URL: ${url}\n\n` +
    `STRUCTURED METADATA EXTRACTED FROM THE PAGE:\n${metaBlock}\n\n` +
    `${label}:\n${content}`;
  return input.slice(0, maxChars);
}

/** Pull the first balanced JSON object out of a model reply (handles code
 *  fences, leading prose, trailing text). Returns null when there is none.
 *  Small models sometimes emit literal newlines/tabs inside string values
 *  (invalid JSON) — a light repair pass escapes them before parsing.
 */
function extractJson(raw: string): unknown | null {
  let s = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          try {
            return JSON.parse(repairJsonStrings(candidate));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Escape literal newlines/tabs inside JSON string values (model artifact). */
function repairJsonStrings(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Light cleanup of markdown/formatting artifacts some small models leave in
 * the extracted text despite the prompt ("**bold**", "*italic*", headings,
 * blockquotes, inline code). Conservative — only paired/line-anchored
 * markers are touched, so legitimate asterisks/quotes in the body survive.
 */
function stripMarkdownArtifacts(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^[#]{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Build an OpenAI-compatible LLM extractor from central `ai:` config — the
 * same endpoint/model family used for AI calls, but a separate call with its
 * own prompt and a larger output budget. Best-effort: never throws; any
 * failure (network, bad JSON, missing fields) resolves to null so the item
 * still saves through the tag-based path.
 */
export function buildLlmExtractor(
  config: AppConfig,
): (rawHtml: string, url: string, text?: string, html?: string) => Promise<LlmExtraction | null> {
  const client = new OpenAI({
    apiKey: config.ai.api_key || 'not-set',
    baseURL: config.ai.base_url,
    // Extraction must never stall a scrape worker: fail fast and let the
    // tag-based fields stand.
    timeout: 60_000,
  });

  return async function extract(
    rawHtml: string,
    url: string,
    text?: string,
    html?: string,
  ): Promise<LlmExtraction | null> {
    const input = buildInput(rawHtml, url, text, html, config.ai.max_input_chars);
    const call = (jsonMode: boolean) =>
      client.chat.completions.create({
        model: config.ai.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        max_tokens: config.ai.extract_max_tokens,
        // JSON mode helps small local models stay parseable, but some
        // reasoning models burn the whole budget on hidden reasoning tokens
        // in JSON mode (and may rename keys) — so plain mode is tried first
        // (the repair pass handles literal newlines) and JSON mode is the
        // retry when the plain response is unusable.
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      });
    const parse = (resp: Awaited<ReturnType<typeof call>>): LlmExtraction | null => {
      const content = resp.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = extractJson(content);
      if (!parsed || typeof parsed !== 'object') return null;
      const o = parsed as Record<string, unknown>;
      const firstStr = (...keys: string[]): string | null => {
        for (const k of keys) {
          const v = o[k];
          if (typeof v === 'string' && v.trim()) return v;
        }
        return null;
      };
      const title = firstStr('title', 'headline', 'heading');
      // Verbatim HTML body; tolerate models that still return plain text.
      const htmlOut = firstStr('html', 'content', 'body') ?? '';
      const textOut =
        firstStr('text', 'article_text') ??
        (htmlOut ? textFromHtml(htmlOut) : '');
      const llmUrl = firstStr('url', 'link', 'canonical', 'canonicalUrl');
      const publishedAt = firstStr('publishedAt', 'datePublished', 'published', 'pubDate', 'date');
      // Quality floor: the model occasionally answers with a real title but a
      // stub body ("..." / "<p>...</p>"), which the one-field-present check
      // would otherwise accept. When the tag path has a substantial body,
      // treat a tiny model body as a failed extraction — the caller falls
      // back to the tag text instead of serving the placeholder. Genuinely
      // short posts (tag text < 1000 chars) are exempt: there is nothing
      // longer to copy.
      const MIN_LLM_BODY = 150;
      const MIN_TAG_BODY = 1000;
      const tagBodyLen = text ? text.replace(/\s+/g, ' ').trim().length : 0;
      const llmBodyLen = Math.max(textOut.length, textFromHtml(htmlOut).length);
      if (llmBodyLen < MIN_LLM_BODY && tagBodyLen >= MIN_TAG_BODY) return null;
      // At least one usable field is required — an empty object is a failure.
      if (!title && !htmlOut && !textOut && !llmUrl && !publishedAt) return null;
      return {
        title: title ? stripMarkdownArtifacts(title) : null,
        html: htmlOut ? sanitizeArticleHtml(stripMarkdownArtifacts(htmlOut)) : '',
        text: stripMarkdownArtifacts(textOut.trim()),
        url: llmUrl,
        publishedAt,
        model: config.ai.model,
        extractedAt: Date.now(),
      };
    };
    // 1) plain mode (fast, honors the requested schema on most models).
    let resp;
    try {
      resp = await call(false);
    } catch {
      resp = null;
    }
    let result = resp ? parse(resp) : null;
    // 2) unusable (API error, empty content, unparseable JSON, wrong schema)
    //    → retry once in JSON mode.
    if (!result) {
      try {
        resp = await call(true);
      } catch {
        return null;
      }
      result = parse(resp);
    }
    return result;
  };
}
