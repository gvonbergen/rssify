import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from './logger.ts';

export const CONFIG_PATH = join(ROOT, 'config.yaml');
export const ENV_PATH = join(ROOT, '.env');

export interface BackendCamofoxConfig {
  base_url: string;
  access_key: string;
  user_id: string;
  request_timeout_ms: number;
}
export interface BackendFirecrawlConfig {
  mode: 'cloud' | 'selfhosted';
  base_url: string;
  api_key: string;
  request_timeout_ms: number;
}
export interface BackendPlainConfig {
  request_timeout_ms: number;
  user_agent: string;
}
export interface AppConfig {
  server: { host: string; port: number; domain?: string; public_url?: string };
  backends: {
    camofox: BackendCamofoxConfig;
    firecrawl: BackendFirecrawlConfig;
    plain: BackendPlainConfig;
  };
  ai: {
    base_url: string;
    api_key: string;
    model: string;
    max_input_chars: number;
    /** Max output tokens for the LLM article-extraction call (full body text
     *  needs a large output budget; reasoning models also consume a large
     *  share of the budget on hidden reasoning tokens, so keep this
     *  generous). */
    extract_max_tokens: number;
  };
  defaults: {
    schedule: string;
    engine: 'camofox' | 'firecrawl' | 'plain';
    feed_item_limit: number;
    scrape_concurrency: number;
    /** Random delay band (seconds) between requests to a site; 0 = no delay.
     *  Per-site override lives in the site's config_json `scrape_delay`. */
    scrape_delay: { lower_sec: number; upper_sec: number };
    /** Max candidate articles collected per discovery run; per-site override
     *  lives in the site's config_json `extract.max`. */
    discover_max: number;
    /** Follow category-scoped pagination/listing pages during discovery
     *  (global switch; per-site override: config_json `extract.follow`). */
    follow: boolean;
    /** How many follow pages to fetch beyond the index page (global default;
     *  per-site override: config_json `extract.followDepth`). Total page
     *  fetches per discovery = 1 (index) + follow_depth. */
    follow_depth: number;
    /** Follow pagination until a page returns HTTP 404 (the real end of the
     *  chain) instead of a fixed follow_depth. Global switch; per-site
     *  override: config_json `extract.followUntil404`. */
    follow_until_404: boolean;
    /** Extra render wait (ms) after the page loads before the engine grabs
     *  the HTML, for JS sites whose article bodies lazy-load (A default of 0
     *  keeps current behavior for everyone else). Per-site override:
     *  config_json `extract.waitMs`. */
    wait_ms: number;
    /** Strip pictures from served article content (text-only feeds). Global
     *  switch; per-site override lives in the site's config_json
     *  `ignore_images`. */
    ignore_images: boolean;
    /** Per-site random jitter (seconds) added to each scheduled run so sites
     *  don't all fire at the same cron minute; 0 disables. */
    schedule_jitter_seconds: number;
    /** Keep the raw fetched HTML beside the cleaned article
     *  (data/<site>/<hash>.raw.html) so later reprocessing (new cleaning
     *  rules, date fixes) can re-run locally without re-scraping the site.
     *  Global switch; per-site override: config_json `extract.storeRaw`. */
    store_raw: boolean;
    /** Run LLM-based article extraction (title / full clean text / link /
     *  publication date) in parallel with the tag-based extractor. Only
     *  effective when an AI api key is configured. Per-site override:
     *  config_json `extract.llm`. */
    llm_extract: boolean;
    /** Which extraction's fields feed the RSS items: 'tags' (readability +
     *  structured metadata) or 'llm' (AI-extracted title/text/link/date,
     *  falling back to tag fields when no LLM result is stored). Per-site
     *  override: config_json `extract.feedSource`. */
    feed_source: 'tags' | 'llm';
  };
  storage: {
    data_dir: string;
    db_path: string;
    keep_content_forever: boolean;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  server: { host: '127.0.0.1', port: 3000 },
  backends: {
    camofox: {
      base_url: 'http://192.168.2.95:9377',
      access_key: '',
      user_id: 'rssify',
      request_timeout_ms: 60000,
    },
    firecrawl: {
      mode: 'cloud',
      base_url: 'https://api.firecrawl.dev',
      api_key: '',
      request_timeout_ms: 60000,
    },
    plain: {
      request_timeout_ms: 60000,
      user_agent: '',
    },
  },
  ai: {
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o-mini',
    max_input_chars: 40000,
    extract_max_tokens: 32000,
  },
  defaults: {
    schedule: '0 */6 * * *',
    engine: 'firecrawl',
    feed_item_limit: 10,
    scrape_concurrency: 2,
    scrape_delay: { lower_sec: 2, upper_sec: 5 },
    discover_max: 100,
    follow: true,
    follow_depth: 3,
    follow_until_404: false,
    wait_ms: 0,
    ignore_images: false,
    store_raw: true,
    schedule_jitter_seconds: 1800,
    llm_extract: true,
    feed_source: 'tags',
  },
  storage: {
    data_dir: './data',
    db_path: './data/state.sqlite',
    keep_content_forever: true,
  },
};

/** Minimal .env parser → map. */
export function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Expand `${VAR}` references in a string against the env map + process.env. */
function expand(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name] ?? process.env[name] ?? '';
    return v;
  });
}

function walk(obj: unknown, env: Record<string, string>): unknown {
  if (typeof obj === 'string') return expand(obj, env);
  if (Array.isArray(obj)) return obj.map((x) => walk(x, env));
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = walk(o[k], env);
    return out;
  }
  return obj;
}

/** Deep-merge defaults with the on-disk config.yaml, expanding ${VAR}. */
export function loadConfig(): AppConfig {
  const env = { ...loadEnvFile() };
  let disk: unknown = {};
  if (existsSync(CONFIG_PATH)) {
    disk = YAML.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {};
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG) as unknown, disk);
  return walk(merged, env) as AppConfig;
}

/** Ensure config.yaml + .env exist with defaults on first run. */
export function ensureConfig(): void {
  mkdirSync(ROOT, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, YAML.stringify(DEFAULT_CONFIG), 'utf8');
  }
  if (!existsSync(ENV_PATH)) {
    writeFileSync(
      ENV_PATH,
      '# RSSify secrets — never commit this file.\nCAMOFOX_ACCESS_KEY=\nFIRECRAWL_API_KEY=\n',
      'utf8',
    );
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) && Array.isArray(override)) return override;
  if (
    base &&
    typeof base === 'object' &&
    override &&
    typeof override === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const b = base as Record<string, unknown>;
    const o = override as Record<string, unknown>;
    const out: Record<string, unknown> = { ...b };
    for (const k of Object.keys(o)) out[k] = deepMerge(b[k], o[k]);
    return out;
  }
  return override;
}

/** Get a dotted path value from the on-disk (merged, expanded) config. */
export function configGet(path: string): unknown {
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  const parts = path.split('.');
  let cur: unknown = cfg;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else return undefined;
  }
  return cur;
}

/**
 * Set a dotted-path config key on-disk. Keys ending in `.api_key` (or
 * containing `KEY`) are treated as secrets and written to `.env` instead of
 * config.yaml. Returns the key name written to .env if it was a secret.
 */
export function configSet(path: string, value: string): string | null {
  // Secrets → .env
  if (/\.(api_key|access_key)$/.test(path) || /KEY/.test(path)) {
    const secretKeys: Record<string, string> = {
      'ai.api_key': 'AI_API_KEY',
      'backends.firecrawl.api_key': 'FIRECRAWL_API_KEY',
      'backends.camofox.access_key': 'CAMOFOX_ACCESS_KEY',
    };
    const envName = secretKeys[path];
    if (!envName) throw new Error(`No known secret env var for path '${path}'`);
    const env = loadEnvFile();
    env[envName] = value;
    writeEnvFile(env);
    return envName;
  }
  // Non-secret → config.yaml
  mkdirSync(ROOT, { recursive: true });
  let disk: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) disk = YAML.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {};
  const parts = path.split('.');
  const coerced = coerce(value);
  let cur = disk;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = coerced;
  writeFileSync(CONFIG_PATH, YAML.stringify(disk), 'utf8');
  return null;
}

function writeEnvFile(env: Record<string, string>): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

function coerce(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return s;
}
