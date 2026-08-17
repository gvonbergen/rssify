/**
 * The scraper-module contract shared between the app and `pi`-authored modules
 * (loaded from `sites/<site>.ts`). Scraper modules may `import type` these
 * interfaces, plus pure helpers from `../src/util.ts`. They must NEVER import
 * the backend adapters — all network access goes through the injected
 * `backends` object.
 *
 * Modules must be type-strippable TS (erasable syntax only) with explicit
 * `.ts` extensions on relative imports.
 */

/** Type of a structured-logger like pino. */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  child?(bindings: Record<string, unknown>): Logger;
}

/** A registered section of a site — the ONLY area of the domain scraped. */
export interface SectionRef {
  section: string;
  indexUrl: string;
}

/** A candidate article URL discovered from an index page. */
export interface DiscoveredItem {
  url: string;
  hintTitle?: string;
  hintDate?: string;
}

/**
 * The result of parsing one article. `html` is raw page HTML for the camofox
 * path (the app cleans it with @mozilla/readability); for firecrawl it already
 * arrives cleaned (`onlyMainContent`). Metadata is filled centrally by the app;
 * set a field here only to override the site's structured data when it is wrong.
 */
export interface Article {
  url: string;
  title: string;
  html: string;
  /**
   * Set `true` when `html` is ALREADY cleaned main-content (the firecrawl
   * path — `firecrawl.scrape()` returns cleaned HTML). Leave unset/false for
   * raw page HTML (camofox path) which the app cleans with @mozilla/readability.
   */
  cleaned?: boolean;
  /** firecrawl: pass through the scrape response `metadata` object here. */
  metadata?: Record<string, unknown>;
  publishedAt?: string; // ISO 8601 if discoverable
  author?: string;
  bylineImage?: string;
}

/** Per-site key/value persistence scoped to the module's own site. */
export interface ScraperKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/** Context injected into discover/parse: logger + the site's config inputs. */
export interface ScraperContext {
  logger: Logger;
  /** The per-site configurable inputs `pi` registered (opaque to the app). */
  config: Record<string, unknown>;
  kv: ScraperKV;
  /** The single scrape engine configured in settings (`defaults.engine`). */
  engine: string;
  /** Global default discovery candidate cap (`defaults.discover_max`); a
   *  per-site config may override via `extract.max`. */
  discoverMax: number;
  /** Global follow switch (`defaults.follow`); per-site override via
   *  `extract.follow`. */
  follow: boolean;
  /** Global follow depth (`defaults.follow_depth`); per-site override via
   *  `extract.followDepth`. */
  followDepth: number;
  /** Global "follow until 404" switch (`defaults.follow_until_404`); per-site
   *  override via `extract.followUntil404`. When on, pagination is followed
   *  until a page returns HTTP 404 instead of a fixed depth. */
  followUntil404: boolean;
  /** Global extra render wait MS (`defaults.wait_ms`); per-site override via
   *  `extract.waitMs`. Passed to JS-capable engines when fetching article
   *  pages so lazy-loaded bodies are present before extraction. */
  waitMs: number;
}

/** firecrawl scrape result: cleaned HTML plus the scrape response metadata object. */
export interface FirecrawlResult {
  html: string;
  metadata: Record<string, unknown>;
}

export interface CamofoxFetchOpts {
  waitMs?: number;
  evaluateJs?: string;
}

export interface PlainFetchOpts {
  headers?: Record<string, string>;
}

export interface FirecrawlScrapeOpts {
  /** Milliseconds to wait for JS rendering (the API accepts a number; some
   *  self-hosted builds also accept "6s"-style strings). */
  waitFor?: number | string;
  maxDepth?: number;
  // ... passed through to the firecrawl API as needed
}

/** Backend adapters injected into scraper modules. */
export interface Backends {
  camofox: {
    /** Returns the raw page HTML (to be cleaned by the app with readability). */
    fetch(url: string, opts?: CamofoxFetchOpts): Promise<string>;
    /** Like fetch() but also reports the target page's HTTP status (404 for
     *  not-found pages); used by the "follow until 404" discovery mode.
     *  Returns status null when the engine cannot determine it. */
    fetchWithStatus?(url: string): Promise<{ html: string; status: number | null }>;
  };
  firecrawl: {
    /** Returns cleaned main-content HTML plus the scrape metadata object. */
    scrape(url: string, opts?: FirecrawlScrapeOpts): Promise<FirecrawlResult>;
  };
  plain: {
    /** Plain fetch → raw page HTML (cleaned by the app with readability). */
    fetch(url: string, opts?: PlainFetchOpts): Promise<string>;
  };
}

/** The minimal hard contract the app relies on. */
export interface SiteScraper {
  site: string; // informational; must match the site row
  /**
   * Called once per registered section. MUST NOT crawl beyond `section.indexUrl`.
   */
  discover(
    ctx: ScraperContext,
    backends: Backends,
    section: SectionRef,
  ): Promise<DiscoveredItem[]>;
  /** Parse one discovered article → cleaned-ready Article. */
  parse(
    ctx: ScraperContext,
    backends: Backends,
    item: DiscoveredItem,
  ): Promise<Article>;
  // Modules may export extra fields; the app ignores unknown ones.
  [key: string]: unknown;
}
