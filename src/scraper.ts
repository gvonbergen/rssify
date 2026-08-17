import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  addItemSection,
  finishRun,
  getSection,
  getSite,
  insertItem,
  insertRun,
  itemBelongsToSite,
  kvDel,
  kvGet,
  kvSet,
  listSections,
  parseSiteConfig,
  updateSiteLastScrape,
  type Db,
  type ScrapeQuality,
} from './db.ts';
import type { AppConfig } from './config.ts';
import { buildBackends } from './backends/index.ts';
export { buildBackends };
import { buildLlmExtractor } from './extract/llm.ts';
import { absolutize, cleanHtml, extractMetadata, stripAdBlocks, textFromHtml } from './clean.ts';
import { normalizeUrl, sha1, nowMs } from './util.ts';
import { ROOT, siteLogger, type Logger } from './logger.ts';
import { reprofileSite, GENERIC_TEMPLATE } from './extract/profile.ts';
import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SiteScraper,
} from './contract.ts';

/** Cache of loaded scraper module instances, keyed by site (with mtime bust). */
async function loadScraper(site: string, modulePath: string): Promise<SiteScraper> {
  const abs = resolve(ROOT, modulePath);
  const url = pathToFileURL(abs).href ;
  const mod = await import(url);
  const scraper: SiteScraper = mod.default ?? mod;
  if (!scraper || typeof scraper.discover !== 'function' || typeof scraper.parse !== 'function') {
    throw new Error(`Module ${modulePath} does not implement discover() and parse()`);
  }
  return scraper;
}

function makeContext(db: Db, site: string, config: AppConfig, section: string): ScraperContext {
  const row = getSite(db, site);
  let configInputs: Record<string, unknown> = {};
  try {
    configInputs = JSON.parse(row?.config_json ?? '{}');
  } catch {
    configInputs = {};
  }
  const log: Logger = siteLogger(site).child({ section });
  return {
    logger: log,
    config: configInputs,
    kv: {
      get: async (key) => kvGet(db, site, key),
      set: async (key, value) => kvSet(db, site, key, value),
      del: async (key) => kvDel(db, site, key),
    },
    engine: config.defaults.engine,
    discoverMax: config.defaults.discover_max,
    follow: config.defaults.follow,
    followDepth: config.defaults.follow_depth,
    followUntil404: config.defaults.follow_until_404,
    waitMs: config.defaults.wait_ms,
  };
}

function parseIso(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// --- Per-site random scrape delay + rate-limit logging ---
export interface DelayBand {
  lowerMs: number;
  upperMs: number;
}

/**
 * Effective delay band for a site (ms): the site's config_json `scrape_delay`
 * overrides the instance-wide `defaults.scrape_delay`. 0 = no delay.
 */
export function delayBandMs(
  siteConfig: Record<string, unknown> | undefined,
  globalDefault: AppConfig['defaults']['scrape_delay'],
): DelayBand {
  const toMs = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
  };
  let lower = toMs(globalDefault?.lower_sec);
  let upper = toMs(globalDefault?.upper_sec);
  const sc = siteConfig?.['scrape_delay'];
  if (sc && typeof sc === 'object') {
    const s = sc as Record<string, unknown>;
    if (s.lower_sec !== undefined) lower = toMs(s.lower_sec);
    if (s.upper_sec !== undefined) upper = toMs(s.upper_sec);
  }
  if (upper < lower) [upper, lower] = [lower, upper];
  return { lowerMs: lower, upperMs: upper };
}

function randomMs(lowerMs: number, upperMs: number): number {
  if (upperMs <= lowerMs) return lowerMs;
  return lowerMs + Math.floor(Math.random() * (upperMs - lowerMs + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Likely rate-limiter responses (429/403/etc.) or mention of throttling. */
function isThrottle(msg: string): boolean {
  if (/\b(403|420|429|503|529)\b/.test(msg)) return true;
  return /rate.?limit|throttl|too many requests|retry[- ]after/i.test(msg);
}

/** Pull the HTTP status out of an error message without tripping over
 *  IPs/ports (e.g. "plain fetch http://127.0.0.1:65292/a -> 429"). */
function extractStatus(msg: string): string | undefined {
  const m = msg.match(/->\s*(\d{3})\s*$/);
  if (m) return m[1];
  return (msg.match(/\b[45]\d\d\b/g) || []).at(-1);
}

/**
 * Wrap the backends handed to a module so every request is preceded by a random
 * sleep in the site's band and each outcome is logged (delay, latency, bytes,
 * status). Throttling responses surface as warnings so you can tune the band.
 */
export function withRateLimit(backends: Backends, band: DelayBand, site: string, log: Logger): Backends {
  if (band.lowerMs <= 0 && band.upperMs <= 0) return backends;

  const before = async (url: string) => {
    const ms = randomMs(band.lowerMs, band.upperMs);
    if (ms > 0) {
      log.info(
        { url, delayMs: ms, lowerMs: band.lowerMs, upperMs: band.upperMs },
        'rate-limit: sleeping before request',
      );
      await sleep(ms);
    }
    return ms;
  };
  const after = (url: string, ms: number, ok: boolean, extra: Record<string, unknown>) => {
    const msg = String(extra.err ?? '');
    const status = extractStatus(msg);
    if (!ok && isThrottle(msg)) {
      log.warn(
        { url, status, delayMs: ms, ...extra },
        'rate-limit: likely throttled — consider raising the scrape_delay band',
      );
    } else {
      log.info({ url, status, delayMs: ms, ...extra }, ok ? 'rate-limit: request ok' : 'rate-limit: request failed');
    }
  };

  const wrapFetch =
    (inner: (url: string, opts?: unknown) => Promise<string>) =>
    async (url: string, opts?: unknown): Promise<string> => {
      const ms = await before(url);
      const t0 = Date.now();
      try {
        const res = await inner(url, opts);
        after(url, ms, true, { latencyMs: Date.now() - t0, bytes: res.length });
        return res;
      } catch (e) {
        after(url, ms, false, { latencyMs: Date.now() - t0, err: String((e as Error)?.message ?? e) });
        throw e;
      }
    };

  const wrapScrape =
    (inner: (url: string, opts?: unknown) => Promise<{ html: string; metadata?: Record<string, unknown> }>) =>
    async (url: string, opts?: unknown): Promise<{ html: string; metadata?: Record<string, unknown> }> => {
      const ms = await before(url);
      const t0 = Date.now();
      try {
        const res = await inner(url, opts);
        after(url, ms, true, { latencyMs: Date.now() - t0, bytes: res.html?.length ?? 0 });
        return res;
      } catch (e) {
        after(url, ms, false, { latencyMs: Date.now() - t0, err: String((e as Error)?.message ?? e) });
        throw e;
      }
    };

  return {
    camofox: { fetch: wrapFetch((u, o) => backends.camofox.fetch(u, o as never)) },
    firecrawl: { scrape: wrapScrape((u, o) => backends.firecrawl.scrape(u, o as never)) },
    plain: { fetch: wrapFetch((u, o) => backends.plain.fetch(u, o as never)) },
  } as Backends;
}

interface ScrapeResult {
  status: 'ok' | 'error' | 'partial';
  discovered: number;
  newItems: number;
  error: string | null;
}

/** Minimum cleaned-body length (chars) for an extraction to count as "good". */
const MIN_QUALITY_BODY = 200;
/** Re-probe the site profile at most this often (self-correction guard). */
const REPROFILE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Run a scrape for one site (optionally restricted to one section).
 * Serializes per-site with an in-flight guard. Returns summary stats.
 */
export async function runSiteScrape(
  db: Db,
  config: AppConfig,
  site: string,
  section?: string,
): Promise<ScrapeResult | null> {
  if (inflight.has(site)) {
    siteLogger(site).warn('scrape skipped: another run already in flight');
    return null;
  }
  const row = getSite(db, site);
  if (!row) return null;

  inflight.add(site);
  const startedAt = nowMs();
  const runId = insertRun(db, site, startedAt);
  const log = siteLogger(site);

  let discovered = 0;
  let newItems = 0;
  let status: ScrapeResult['status'] = 'ok';
  const errors: string[] = [];
  const quality: ScrapeQuality = { parsed: 0, bodyGood: 0, dateGood: 0 };

  try {
    const scraper = await loadScraper(site, row.module_path);
    let siteCfg: Record<string, unknown> = {};
    try {
      siteCfg = JSON.parse(row.config_json ?? '{}');
    } catch {
      siteCfg = {};
    }
    const band = delayBandMs(siteCfg, config.defaults.scrape_delay);
    if (band.upperMs > 0) {
      log.info(
        { site, lowerMs: band.lowerMs, upperMs: band.upperMs },
        'rate-limit: random scrape delay enabled',
      );
    }
    const backends: Backends = withRateLimit(buildBackends(config, log), band, site, log);

    // LLM article extraction runs IN PARALLEL with the tag-based path (both
    // produce fields for every new article; the feed picks one via
    // feed_source). Enabled unless the global switch is off, the site opts
    // out via `extract.llm: false`, or no API key is configured.
    const siteExtractCfg = (siteCfg['extract'] ?? {}) as Record<string, unknown>;
    const llmExtractEnabled =
      config.defaults.llm_extract && Boolean(config.ai.api_key) && siteExtractCfg['llm'] !== false;
    const llmExtractor = llmExtractEnabled ? buildLlmExtractor(config) : null;
    if (llmExtractEnabled) {
      log.info('llm extract: enabled (parallel with tag extraction)');
    } else {
      log.info(config.ai.api_key
        ? 'llm extract: disabled (defaults.llm_extract=false or site extract.llm=false)'
        : 'llm extract: disabled — no AI api key configured');
    }

    const sections = section
      ? [getSection(db, site, section)].filter((x): x is NonNullable<typeof x> => !!x)
      : listSections(db, site);

    if (section && sections.length === 0) {
      log.warn(`unknown section '${section}' on site '${site}' — register it first with \`rssify add <section-index-url>\``);
      status = 'error';
      errors.push(`unknown section '${section}'`);
      return { status, discovered, newItems, error: errors[0] ?? null };
    }

    if (sections.length === 0) {
      log.warn('no sections to scrape');
      status = 'error';
      errors.push('no sections registered');
      return { status, discovered, newItems, error: errors[0] ?? null };
    }

    for (const sec of sections) {
      const secLog = siteLogger(site).child({ section: sec.section });
      let candidates: DiscoveredItem[];
      try {
        const ctx = makeContext(db, site, config, sec.section);
        candidates = await scraper.discover(ctx, backends, {
          section: sec.section,
          indexUrl: sec.index_url,
        });
      } catch (e) {
        secLog.error({ err: String(e) }, 'discover failed');
        errors.push(`discover[${sec.section}]: ${String(e)}`);
        status = 'partial';
        continue;
      }
      discovered += candidates.length;
      secLog.info({ candidates: candidates.length }, 'discovered candidates');

      if (candidates.length === 0) continue;
      secLog.info(
        { candidates: candidates.length, concurrency: config.defaults.scrape_concurrency },
        'parse phase: starting',
      );

      // Bounded concurrency of the fetch/parse step. Candidates we
      // already have are skipped BEFORE fetching — re-scrapes don't burn engine
      // credits on duplicates. persistArticle re-checks after parse (canonical
      // may differ); this is just the cheap fast path.
      const fresh: { cand: DiscoveredItem; i: number }[] = [];
      let skippedKnown = 0;
      let skippedListing = 0;
      // Safety net on top of discovery's per-section isListing(): a URL whose
      // pathname matches ANY registered section index of this site (same or
      // another section, incl. ?page= variants) is a listing page — it must
      // never be parsed as an article.
      const sectionIndexPaths = new Set(
        listSections(db, site).map((s) => {
          try {
            return new URL(s.index_url).pathname.replace(/\/+$/, '');
          } catch {
            return '';
          }
        }),
      );
      candidates.forEach((cand, i) => {
        try {
          if (sectionIndexPaths.has(new URL(cand.url).pathname.replace(/\/+$/, ''))) {
            skippedListing++;
            return;
          }
          // Slash-insensitive: sites sometimes link the same article with and
          // without a trailing slash — either form counts as known. Both
          // spellings are checked: a listing may link "/slug" while the
          // article's canonical (and thus its stored hash) is "/slug/".
          const hs = sha1BothSlashSpellings(normalizeUrl(cand.url));
          if (hs.some((h) => itemBelongsToSite(db, site, h))) {
            skippedKnown++;
            return;
          }
        } catch {
          /* keep the candidate if its URL can't be normalized */
        }
        fresh.push({ cand, i });
      });
      if (skippedKnown > 0 || skippedListing > 0) {
        secLog.info({ skippedKnown, skippedListing, total: candidates.length }, 'parse: skipping already-known or listing candidates');
      }
      const indexed = fresh.map(({ cand, i }) => ({ cand, i }));
      const results = await mapLimit(indexed, config.defaults.scrape_concurrency, async ({ cand, i }) => {
        const total = fresh.length;
        const t0 = Date.now();
        secLog.info({ idx: i + 1, total, url: cand.url }, 'parse: fetching article');
        try {
          const ctx = makeContext(db, site, config, sec.section);
          const article = await scraper.parse(ctx, backends, cand);
          const res = await persistArticle(
            db,
            config,
            site,
            sec.section,
            cand,
            article,
            llmExtractor,
            backends,
            secLog,
          );
          secLog.info(
            { idx: i + 1, total, url: cand.url, inserted: res.inserted, paywalled: !!res.paywalled, ms: Date.now() - t0 },
            res.paywalled ? 'parse: paywall — skipped' : res.inserted ? 'parse: ok — new item' : 'parse: duplicate — skipped',
          );
          return { cand: cand.url, ok: true, inserted: res.inserted, bodyGood: res.bodyGood, dateGood: res.dateGood, paywalled: !!res.paywalled } as const;
        } catch (e) {
          // Bot-gate HTTP error (e.g. Cloudflare challenge returns 403): the
          // plain backend throws before any HTML reaches cleaning. If Firecrawl
          // is configured, retry the page once through its headless browser and
          // persist the cleaned HTML as a regular (cleaned) article.
          const msg = String(e);
          if (config.backends.firecrawl.api_key && /(->|status|HTTP)\s*403/.test(msg)) {
            try {
              const r = await backends.firecrawl.scrape(cand.url, {});
              if (r?.html) {
                const fbArticle: Article = {
                  url: cand.url,
                  title: cand.hintTitle || 'Untitled',
                  html: r.html,
                  cleaned: true,
                  metadata: r.metadata,
                };
                const res = await persistArticle(
                  db,
                  config,
                  site,
                  sec.section,
                  cand,
                  fbArticle,
                  llmExtractor,
                  backends,
                  secLog,
                );
                secLog.info(
                  { idx: i + 1, total, url: cand.url, inserted: res.inserted, ms: Date.now() - t0 },
                  res.inserted ? 'parse: firecrawl fallback ok — new item' : 'parse: firecrawl fallback ok — duplicate',
                );
                return { cand: cand.url, ok: true, inserted: res.inserted, bodyGood: res.bodyGood, dateGood: res.dateGood, paywalled: !!res.paywalled } as const;
              }
            } catch (e2) {
              secLog.warn({ url: cand.url, err: String(e2) }, 'firecrawl fallback failed');
            }
          }
          secLog.error(
            { idx: i + 1, total, url: cand.url, err: String(e), ms: Date.now() - t0 },
            'parse failed',
          );
          errors.push(`parse ${cand.url}: ${String(e)}`);
          return { cand: cand.url, ok: false, inserted: 0, bodyGood: false, dateGood: false } as const;
        }
      });
      // Sum inserted counts + extraction-quality stats after all workers finish.
      let paywalled = 0;
      for (const r of results) {
        newItems += r.inserted;
        if (r.paywalled) paywalled += 1;
        // Quality is measured only on NEWLY INSERTED articles — a deduplicated
        // re-parse of something we already have says nothing about extraction
        // quality and must not drag the rate down.
        if (r.ok && r.inserted > 0) {
          quality.parsed += 1;
          if (r.bodyGood) quality.bodyGood += 1;
          if (r.dateGood) quality.dateGood += 1;
        }
      }

      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0 && failed < results.length) status = 'partial';
      // Only when there WERE parse attempts: all of them failed (results is
      // empty when every candidate was skipped as already-known).
      if (results.length > 0 && failed === results.length) status = 'partial';
      secLog.info({ candidates: candidates.length, failed, paywalled }, 'section scrape complete');
    }

    if (errors.length > 0 && status === 'ok') status = 'partial';

    // --- Extraction-quality summary + self-correction (generic sites only) ---
    if (quality.parsed > 0) {
      const bodyRate = quality.bodyGood / quality.parsed;
      const dateRate = quality.dateGood / quality.parsed;
      log.info(
        { parsed: quality.parsed, bodyGood: quality.bodyGood, dateGood: quality.dateGood, bodyRate: +bodyRate.toFixed(2), dateRate: +dateRate.toFixed(2) },
        'extraction quality',
      );
      const weak = bodyRate < 0.6 || dateRate < 0.6;
      if (weak && siteCfg.template === GENERIC_TEMPLATE) {
        const lastReprofile = Number(kvGet(db, site, 'reprofiled_at') ?? 0);
        if (nowMs() - lastReprofile > REPROFILE_COOLDOWN_MS) {
          log.warn(
            { bodyRate: +bodyRate.toFixed(2), dateRate: +dateRate.toFixed(2) },
            'extraction quality low — re-probing site profile',
          );
          try {
            await reprofileSite(db, config, site, {
              info: (m) => log.info(m),
              warn: (m) => log.warn(m),
            });
            kvSet(db, site, 'reprofiled_at', String(nowMs()));
          } catch (re) {
            log.error({ err: String(re) }, 'reprofile failed');
          }
        }
      }
    }
  } catch (e) {
    log.error({ err: String(e) }, 'scrape run failed');
    status = 'error';
    errors.push(String(e));
  } finally {
    const finishedAt = nowMs();
    finishRun(db, runId, finishedAt, status, {
      discovered,
      newItems,
      error: errors[0] ?? null,
      excerpt: errors.slice(0, 5).join('\n').slice(0, 2000),
      quality,
    });
    updateSiteLastScrape(db, site, finishedAt, status, errors[0] ?? null);
    inflight.delete(site);
  }
  return { status, discovered, newItems, error: errors[0] ?? null };
}

/**
 * Persist a parsed article: normalize/dedup, clean + extract metadata, write
 * data/<site>/<hash>.html, insert item + section membership.
 * Returns 1 if a new item row was written, else 0.
 */
const BOT_GATE_MARKERS = [
  'cf-chl', // Cloudflare challenge script
  'challenge-platform', // Cloudflare Turnstile
  'cf-browser-verification',
  'cf-challenge',
  '__cf_chl_',
  'just a moment', // Cloudflare interstitial <title>
];

/**
 * Heuristic: is this HTML a bot-protection interstitial (e.g. a Cloudflare
 * "Just a moment…" challenge page) instead of real content? Such pages come
 * back with HTTP 200/403 and no article body, so readability finds nothing.
 */
export function looksBotGated(html: string): boolean {
  if (!html || html.length < 200) return false;
  const lower = html.toLowerCase();
  return BOT_GATE_MARKERS.some((m) => lower.includes(m));
}

async function persistArticle(
  db: Db,
  config: AppConfig,
  site: string,
  section: string,
  cand: DiscoveredItem,
  article: Article,
  llmExtractor: ReturnType<typeof buildLlmExtractor> | null,
  backends: Backends,
  log: Logger,
): Promise<{ inserted: number; bodyGood: boolean; dateGood: boolean; paywalled?: boolean }> {
  if (!article || typeof article.html !== 'string' || !article.html) {
    throw new Error('parse returned empty article (no html)');
  }
  if (!article.url) article.url = cand.url;
  article.url = normalizeUrl(article.url);
  article.title = article.title || cand.hintTitle || '';

  // --- site config (per-site ad/paywall filters) ---
  const adRow = getSite(db, site);
  let adSiteCfg: Record<string, unknown> = {};
  try {
    adSiteCfg = JSON.parse(adRow?.config_json ?? '{}');
  } catch {
    adSiteCfg = {};
  }
  const adExtract = (adSiteCfg['extract'] ?? {}) as Record<string, unknown>;
  const adMarkers = Array.isArray(adExtract['ad_markers'])
    ? (adExtract['ad_markers'] as unknown[]).map(String)
    : [];

  // --- cleaning + metadata (centralized) ---
  let content: string;
  let text: string;
  let meta: ReturnType<typeof extractMetadata> = {};
  if (article.cleaned === true) {
    // firecrawl path: html already cleaned; metadata comes via Article.metadata
    content = absolutizeBody(article.html, article.url);
    if (adMarkers.length) {
      content = stripAdBlocks(content, adMarkers);
      text = textFromHtml(content);
    } else {
      text = textFromHtml(article.html);
    }
    meta = firecrawlMetadata(article.metadata);
  } else {
    // camofox path: raw page → readability + metadata extraction
    const cleaned = cleanHtml(article.html, article.url, { adMarkers });
    if (!cleaned) {
      // Bot-protection interstitial (e.g. Cloudflare challenge)? The fetch
      // returns the challenge page with no article. Retry once through
      // Firecrawl (headless browser) when it is configured, then store its
      // cleaned HTML exactly like the native firecrawl path.
      if (looksBotGated(article.html) && config.backends.firecrawl.api_key) {
        let r: Awaited<ReturnType<Backends['firecrawl']['scrape']>>;
        try {
          r = await backends.firecrawl.scrape(article.url, {});
        } catch (e) {
          throw new Error(`readability could not extract article content (firecrawl fallback failed: ${String((e as Error)?.message ?? e)})`);
        }
        if (!r?.html) {
          throw new Error('readability could not extract article content (firecrawl fallback returned no html)');
        }
        log.info({ url: article.url }, 'bot-gated page — firecrawl fallback used');
        content = absolutizeBody(r.html, article.url);
        if (adMarkers.length) {
          content = stripAdBlocks(content, adMarkers);
          text = textFromHtml(content);
        } else {
          text = textFromHtml(r.html);
        }
        meta = firecrawlMetadata(r.metadata);
      } else {
        throw new Error('readability could not extract article content');
      }
    } else {
      content = cleaned.content;
      text = cleaned.text;
      meta = extractMetadata(article.html, article.url);
    }
  }

  // --- paywall filter (per-site opt-in) ---
  // Some sites (e.g. Electronic Payments International) gate a subset of
  // articles behind a paywall. The page still fetches fine, but readability
  // extracts only the "Unlock FREE Access…" stub instead of the body.
  // When the site's config lists `extract.paywall_markers`, a cleaned article
  // whose text contains any of those markers is treated as premium content
  // and NOT stored (counted as a paywall skip, never as a failure).
  const paywallRow = getSite(db, site);
  let paywallSiteCfg: Record<string, unknown> = {};
  try {
    paywallSiteCfg = JSON.parse(paywallRow?.config_json ?? '{}');
  } catch {
    paywallSiteCfg = {};
  }
  const paywallExtract = (paywallSiteCfg['extract'] ?? {}) as Record<string, unknown>;
  const paywallMarkers = Array.isArray(paywallExtract['paywall_markers'])
    ? (paywallExtract['paywall_markers'] as unknown[]).map(String)
    : [];
  if (paywallMarkers.length > 0 && text) {
    const t = text.toLowerCase();
    if (paywallMarkers.some((m) => m && t.includes(m.toLowerCase()))) {
      return { inserted: 0, bodyGood: false, dateGood: false, paywalled: true };
    }
  }

  // --- field precedence: module explicit > structured metadata > hint ---
  const title = article.title || meta.title || cand.hintTitle || 'Untitled';
  const author = article.author ?? meta.author ?? undefined;
  const bylineImage = article.bylineImage ?? meta.image ?? undefined;
  const publishedMs = parseIso(article.publishedAt ?? meta.publishedAt);

  // --- canonical URL → hash; re-check dedup (canonical may differ) ---
  // Only SAME-ORIGIN canonicals are trusted: a cross-domain canonical (e.g.
  // Industry Dive sister sites publishing the same story) would move items off
  // the followed domain and defeat pre-parse dedupe. Fall back to og:url, then
  // to the fetched URL itself.
  const ownOrigin = new URL(article.url).origin;
  const sameOrigin = (u: string | undefined): boolean => {
    if (!u) return false;
    try {
      return new URL(u).origin === ownOrigin;
    } catch {
      return false;
    }
  };
  const canonical = normalizeUrl(
    sameOrigin(meta.canonical)
      ? (meta.canonical as string)
      : sameOrigin(meta.ogUrl)
        ? (meta.ogUrl as string)
        : article.url,
  );
  const hs = sha1SlashInsensitive(canonical);
  const hash = hs[0];

  if (itemBelongsToSite(db, site, hash)) {
    // Already known (possibly under another section) → just add membership.
    addItemSection(db, site, section, hash);
    return { inserted: 0, bodyGood: false, dateGood: false };
  }
  if (hs.length > 1 && itemBelongsToSite(db, site, hs[1])) {
    // Same article stored under the trailing-slash twin URL.
    addItemSection(db, site, section, hs[1]);
    return { inserted: 0, bodyGood: false, dateGood: false };
  }

  // --- persist content file ---
  const dataDir = resolve(ROOT, config.storage.data_dir, site);
  mkdirSync(dataDir, { recursive: true });
  const fileName = `${hash}.html`;
  const contentPath = join(config.storage.data_dir, site, fileName);
  writeFileSync(join(dataDir, fileName), content, 'utf8');

  // --- keep the raw scrape beside the cleaned article so later reprocessing
  // (new cleaning rules, date fixes) can re-run locally without re-scraping.
  // Only the camofox/plain path carries raw HTML; the firecrawl path's
  // `article.html` is already cleaned, so there is nothing raw to save. ---
  let rawPath: string | null = null;
  if (article.cleaned !== true && config.defaults.store_raw) {
    const siteRow = getSite(db, site);
    let siteCfg: Record<string, unknown> = {};
    try {
      siteCfg = JSON.parse(siteRow?.config_json ?? '{}');
    } catch {
      siteCfg = {};
    }
    const ext = (siteCfg['extract'] ?? {}) as Record<string, unknown>;
    const storeRaw =
      ext['storeRaw'] !== undefined
        ? Boolean(ext['storeRaw'])
        : config.defaults.store_raw;
    if (storeRaw) {
      const rawFileName = `${hash}.raw.html`;
      writeFileSync(join(dataDir, rawFileName), article.html, 'utf8');
      rawPath = join(config.storage.data_dir, site, rawFileName);
    }
  }

  if (meta || author || bylineImage) {
    const sidecar: Record<string, unknown> = {};
    if (author) sidecar['author'] = author;
    if (bylineImage) sidecar['bylineImage'] = bylineImage;
    if (otherMeta(meta)) sidecar['metadata'] = otherMeta(meta);
    writeFileSync(join(dataDir, `${hash}.meta.json`), JSON.stringify(sidecar, null, 2), 'utf8');
  }

  // --- LLM extraction (parallel path, best-effort) ---
  // Runs only for NEW items (after the dedup + paywall filters above, so
  // duplicates never burn model credits). The result is persisted to a
  // sidecar (`data/<site>/<hash>.llm.json`) which the feed and the
  // `/item/<hash>/llm` route serve without re-calling the model. A failure
  // is logged and the item still saves with the tag-based fields.
  if (llmExtractor) {
    try {
      // `content` (cleaned HTML) + `text` are the tag-path output — the LLM
      // gets structured article content + head metadata instead of truncated
      // raw HTML, so it can reproduce the body VERBATIM with formatting and
      // the body is never cut off by max_input_chars.
      const llm = await llmExtractor(article.html, article.url, text, content);
      if (llm) {
        writeFileSync(
          join(dataDir, `${hash}.llm.json`),
          JSON.stringify(
            {
              title: llm.title,
              html: llm.html,
              text: llm.text,
              url: llm.url,
              publishedAt: llm.publishedAt,
              model: llm.model,
              extractedAt: llm.extractedAt,
            },
            null,
            2,
          ),
          'utf8',
        );
        siteLogger(site).info(
          { url: article.url, hasText: llm.text.length > 0, hasDate: !!llm.publishedAt, model: llm.model },
          'llm extract: ok — sidecar saved',
        );
      } else {
        siteLogger(site).warn({ url: article.url }, 'llm extract: returned nothing usable — tag fields stand');
      }
    } catch (e) {
      siteLogger(site).error({ url: article.url, err: String(e) }, 'llm extract failed');
    }
  }

  // --- insert row + membership ---
  try {
    insertItem(db, {
      site,
      hash,
      url: canonical,
      title,
      published_at: publishedMs,
      first_seen: nowMs(),
      content_path: contentPath,
      content_hash: sha1(content),
      raw_path: rawPath,
    });
  } catch (e) {
    // Race: another worker inserted the same URL between our dedupe scan and
    // this INSERT (concurrent scrape). Treat as a duplicate, not a failure.
    if (e instanceof Error && /UNIQUE constraint failed: items\.site, items\.hash/i.test(e.message)) {
      addItemSection(db, site, section, hash);
      return { inserted: 0, bodyGood: false, dateGood: false };
    }
    throw e;
  }
  addItemSection(db, site, section, hash);
  const bodyGood = text.trim().length >= MIN_QUALITY_BODY;
  return { inserted: 1, bodyGood, dateGood: publishedMs != null };
}

/** Absolutize relative src/href in already-cleaned HTML (firecrawl path). */
function absolutizeBody(html: string, baseUrl: string): string {
  return absolutize(html, baseUrl);
}

function firecrawlMetadata(metadata?: Record<string, unknown>): Partial<{
  title: string;
  author: string;
  publishedAt: string;
  image: string;
  canonical: string;
  ogUrl: string;
}> {
  if (!metadata) return {};
  const m = metadata as Record<string, unknown>;
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  return {
    title: first('title', 'og:title', 'twitterTitle'),
    author: first('author', 'og:author'),
    publishedAt: first('datePublished', 'publishedAt', 'article:published_time'),
    image: first('og:image', 'image'),
    canonical: first('canonicalUrl', 'canonical'),
    ogUrl: first('og:url', 'ogUrl'),
  };
}

function otherMeta(
  meta: ReturnType<typeof extractMetadata>,
): Record<string, unknown> | undefined {
  const m: Record<string, unknown> = {};
  if (meta.title) m['title'] = meta.title;
  if (meta.author) m['author'] = meta.author;
  if (meta.publishedAt) m['publishedAt'] = meta.publishedAt;
  if (meta.image) m['image'] = meta.image;
  if (meta.canonical) m['canonical'] = meta.canonical;
  return Object.keys(m).length ? m : undefined;
}

const inflight = new Set<string>();

/**
 * Trailing-slash-insensitive hash set: the same URL with and without a trailing
 * slash yields the same identity (sites sometimes link both spellings).
 */
function sha1SlashInsensitive(u: string): string[] {
  const h = sha1(u);
  const stripped = u.replace(/\/+$/, '');
  return stripped === u ? [h] : [h, sha1(stripped)];
}

/**
 * Both-spelling hash set for the pre-parse dedupe fast path. Unlike
 * sha1SlashInsensitive (which only ever *strips* a trailing slash), this
 * synthesizes the slash-ADDED twin too, so a candidate whose listing spelling
 * differs from the stored canonical (e.g. a16zcrypto links "/slug" but its
 * canonical is "/slug/") still counts as known BEFORE fetching.
 */
function sha1BothSlashSpellings(u: string): string[] {
  const stripped = u.replace(/\/+$/, '');
  return [...new Set([sha1(stripped), sha1(stripped + '/')])];
}

/** Run an async mapper with bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
