import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { ROOT } from './logger.ts';
import type { AppConfig } from './config.ts';
import { buildBackends, engineGuide, type EngineName } from './backends/index.ts';
import { getSection, getSite, insertSection, insertSite, type Db } from './db.ts';
import { cleanHtml, extractMetadata } from './clean.ts';
import { genericModuleSource, profileFromSnapshot } from './extract/profile.ts';
import { isValidIdentifier, nowMs, slugify } from './util.ts';
import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SectionRef,
  SiteScraper,
} from './contract.ts';

export const PI_BIN = process.env.PI_BIN ?? '/opt/homebrew/bin/pi';

/** Reserved route names that can never be site or section identifiers. */
export const RESERVED = new Set(['health', 'opml', 'item', 'status']);

export function deriveSectionId(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  let id = 'index';
  if (segs.length) id = slugify(segs[segs.length - 1]);
  return id || 'index';
}

function optionalIndexUrl(url: string, sectionId: string): string {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length) return u.origin + '/' + segs.join('/');
  return u.origin;
}

export interface AddSnapshot {
  url: string;
  title: string;
  text: string; // main-content excerpt (readability), truncated
  links: { href: string; text: string }[]; // same-origin link inventory
  html: string; // full fetched raw HTML (considered a secret/snapshot of the page)
  htmlPath: string; // local file holding the full fetched raw HTML
}

/**
 * Fetch the index page ourselves via the configured scrape engine, clean it, and
 * produce a snapshot that `pi` can author an extraction template from — so pi
 * never needs (and cannot time out on) its own network request to the target site.
 */
async function buildAddSnapshot(
  backends: Backends,
  engine: EngineName,
  url: string,
  log: string[],
): Promise<AddSnapshot> {
  log.push(`add: fetching index page via '${engine}' backend...`);
  let html: string;
  if (engine === 'firecrawl') {
    const r = await backends.firecrawl.scrape(url, {});
    html = r.html;
  } else if (engine === 'camofox') {
    html = await backends.camofox.fetch(url, {});
  } else {
    html = await backends.plain.fetch(url, {});
  }
  if (!html) throw new Error(`the '${engine}' engine returned empty content for ${url}`);

  const cleaned = cleanHtml(html, url);
  const meta = extractMetadata(html, url);
  const pageTitle = meta.title || extractTitle(html) || url;
  const text = (cleaned?.text ?? '').slice(0, 6000);
  const links = buildLinkInventory(html, url);

  const dir = join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `_add_snapshot_${Date.now()}_${process.pid}.html`);
  writeFileSync(htmlPath, html, 'utf8');
  log.push(`add: saved snapshot html (${html.length} bytes) -> ${htmlPath.replace(ROOT + '/', '')}`);

  return { url, title: pageTitle, text, links, html, htmlPath };
}

/** Simple <title> fallback for pages with no useful metadata. */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : '';
}

/** Hostname fallback for a feed title ("thepaypers.com", not the full URL). */
function prettyHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Collect same-origin candidate links: both <a href> anchors and embedded JSON
 *  "uri"/"url" fields (Next.js & other JS-rendered sites embed article links in JSON). */
function buildLinkInventory(html: string, baseUrl: string): { href: string; text: string }[] {
  const baseOrigin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const out: { href: string; text: string }[] = [];
  const add = (href: string, text: string) => {
    try {
      const abs = new URL(href, baseUrl).href;
      if (!/^https?:/i.test(abs)) return;
      if (new URL(abs).origin !== baseOrigin) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({ href: abs, text: text.replace(/\s+/g, ' ').trim().slice(0, 90) });
    } catch {
      /* ignore malformed */
    }
  };
  try {
    const dom = new JSDOM(html);
    for (const a of dom.window.document.querySelectorAll('a[href]')) {
      add(a.getAttribute('href') || '', a.textContent ?? '');
    }
    dom.window.close();
  } catch {
    /* fall through */
  }
  for (const m of html.matchAll(/"(?:uri|url|canonical)"\s*:\s*"(https?:\/\/[^"\\]+)"/g)) {
    add(m[1].replace(/\\\//g, '/'), '[embedded link]');
  }
  return out;
}

/** Build the prompt handed to `pi` for authoring a new site scraper. */
export function piPrompt(opts: {
  url: string;
  engine: EngineName;
  moduleDir: string;
  contractPath: string;
  utilPath: string;
  snapshot: AddSnapshot;
}): string {
  return `You are authoring a per-site scraper module for "RSSify", a self-hosted service that
turns websites into RSS feeds. Target URL to subscribe to: ${opts.url}

The instance scrape engine is "${opts.engine}". It is exposed to your module as:
  ${engineGuide(opts.engine)}
Write your discover/parse using that engine (you may use the others via the injected
\`backends\` object where a specific URL needs them).

TASKS
1. Read the snapshot + local HTML file below and understand the page structure.
   Decide how to extract the index URL, article URL patterns, and per-article fields.
2. Decide the scraper's inputs: the index URL, article URL patterns, CSS selectors or
   extraction schema, date parsing, pagination/"load more"/JS-rendering quirks, any
   paywall handling. These go into the sidecar config.
3. Propose a SHORT, URL-safe site identifier (lowercase [a-z0-9-], <= 40 chars, NOT one of:
   health, opml, item, status) derived from the site's name or domain (e.g. "forbes",
   "nytimes"). Write two files:
     - ${opts.moduleDir}/<identifier>.ts        (the scraper module)
     - ${opts.moduleDir}/<identifier>.config.json (the sidecar config)
4. On your final line, output exactly:  SITE_ID=<identifier>

FETCHED CONTENT (rssify already fetched the page for you)
The index page was fetched by rssify through its "${opts.engine}" engine and cleaned
(readability + metadata extraction). Base your extraction template ONLY on this data.
Do NOT use browsing/web tools to fetch the target site — you have everything you need:
  - Title: ${opts.snapshot.title}
  - Full fetched raw HTML (may be large): read the LOCAL file
      ${opts.snapshot.htmlPath}
    (relative to project root; some sites embed article links as JSON
    "uri"/"url"/"canonical" fields rather than <a href> tags — the link inventory
    below already includes those as [embedded link]).
  - Main-content excerpt (readability extraction of the index page):
  ${opts.snapshot.text.slice(0, 4000)}
  - Same-origin link inventory (href + anchor text), ${opts.snapshot.links.length} total:
${opts.snapshot.links.slice(0, 80).map((l) => `    ${l.href}${l.text ? '  | ' + l.text : ''}`).join('\n')}

CONTRACT — implement a default export (or named) object:
  site: string                      // your identifier
  discover(ctx, backends, section)  // async -> DiscoveredItem[]  (ONE call per registered
                                    // section; MUST NOT crawl beyond section.indexUrl)
  parse(ctx, backends, item)        // async -> Article
See ${opts.contractPath} for the exact TypeScript interfaces (import type from there).
Pure helpers are available at ${opts.utilPath}.

SIDECAR config (${opts.moduleDir}/<identifier>.config.json) MUST contain:
  - reserved keys "title" and "description"  (feed channel metadata; the app lifts these
    into the DB; do NOT put them under any other key)
  - any other keys are YOUR scraper configuration inputs (selectors, maxPages, wait, etc.)
  The app treats config_json as opaque JSON; keep it small and serializable.

RULES
- Modules are type-strippable TS (erasable syntax ONLY: no enum, no namespace, no
  parameter properties). Relative imports MUST use explicit ".ts" extensions.
- You may import TYPES and pure helpers from src/ (the contract + util), but NEVER the
  backend adapters / runtime app modules. All network access goes through the injected
  \`backends\` object (camofox.fetch(url, opts) -> raw HTML; firecrawl.scrape(url, opts) ->
  { html, metadata }).
- Do NOT run @mozilla/readability yourself — the app cleans and extracts metadata centrally.
  For the camofox path return the RAW page HTML in Article.html (leave Article.cleaned unset).
  For the firecrawl path set Article.html = result.html and Article.cleaned = true, and
  set Article.metadata = result.metadata.
- Only override Article.title/author/publishedAt when the site's structured data is wrong.

IMPORTANT: \`discover\` is section-driven and called once per registered section. It must
return only article URLs reachable from the given index URL — never crawl the whole site.
`;
}

/**
 * Live log: an array proxy that also echoes each line as it is pushed, so
 * `rssify add` shows progress instead of printing everything at the end.
 */
function liveLog(echo: (line: string) => void = (l) => process.stderr.write(l + '\n')): string[] {
  const arr: string[] = [];
  return new Proxy(arr, {
    get(target, prop) {
      if (prop === 'push') {
        return (line: string) => {
          target.push(line);
          echo(line);
          return target.length;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function runPi(prompt: string, logBuf: string[]): Promise<string> {
  const PI_TIMEOUT_MS = 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, ['-p', prompt], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let done = false;
    const finish = (fn: () => void) => () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      logBuf.push(`[pi] timed out after ${PI_TIMEOUT_MS / 1000}s — killing pi`);
      child.kill('SIGKILL');
      finish(() => reject(new Error(`pi timed out after ${PI_TIMEOUT_MS / 1000}s`)))();
    }, PI_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d.toString();
      logBuf.push('[pi] ' + d.toString());
    });
    child.stderr.on('data', (d) => logBuf.push('[pi-err] ' + d.toString()));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn pi: ${(e as Error).message}`));
    });
    child.on('close', (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`pi exited with code ${code}`));
    });
  });
}

function snapshotSiteFiles(): Map<string, number> {
  const dir = join(ROOT, 'sites');
  if (!existsSync(dir)) return new Map();
  const m = new Map<string, number>();
  for (const f of readdirSync(dir)) m.set(f, statSync(join(dir, f)).mtimeMs);
  return m;
}

function newlyWrittenFiles(before: Map<string, number>): string[] {
  const dir = join(ROOT, 'sites');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f)).mtimeMs;
    if (!before.has(f) || before.get(f)! < st) out.push(f);
  }
  return out;
}

function sidecarConfig(moduleDir: string, ident: string): { config: Record<string, unknown>; title: string; description: string } | null {
  const p = join(ROOT, moduleDir, `${ident}.config.json`);
  if (!existsSync(p)) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  const { title = '', description = '', ...config } = json;
  return { config: config as Record<string, unknown>, title: String(title || ident), description: String(description || '') };
}

async function loadScraperFor(site: string, modulePath: string): Promise<SiteScraper> {
  const abs = join(ROOT, modulePath);
  const mod = await import(pathToFileURL(abs).href );
  const s = mod.default ?? mod;
  if (!s || typeof s.discover !== 'function' || typeof s.parse !== 'function') {
    throw new Error('module does not implement discover()/parse()');
  }
  return s;
}

function dryRunContext(
  configInputs: Record<string, unknown>,
  section: string,
  logBuf: string[],
  engine: string,
  discoverMax: number,
  follow: boolean,
  followDepth: number,
  followUntil404: boolean,
): ScraperContext {
  return {
    logger: {
      info: (...a) => logBuf.push('[dry] ' + a.map(String).join(' ')),
      warn: (...a) => logBuf.push('[dry:warn] ' + a.map(String).join(' ')),
      error: (...a) => logBuf.push('[dry:error] ' + a.map(String).join(' ')),
      debug: () => {},
    },
    config: configInputs,
    kv: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
    },
    engine,
    discoverMax,
    follow,
    followDepth,
    followUntil404,
    waitMs: 0,
  };
}

/**
 * Side-effect-free dry run: load module, discover on the initial section, then
 * parse ONE candidate. No DB writes, no content files, no AI call.
 */
export async function dryRun(opts: {
  site: string;
  modulePath: string;
  section: SectionRef;
  configInputs: Record<string, unknown>;
  backends: Backends;
  logBuf: string[];
  engine: string;
  discoverMax?: number;
  follow?: boolean;
  followDepth?: number;
  followUntil404?: boolean;
}): Promise<{ candidates: DiscoveredItem[]; article: Article }> {
  const scraper = await loadScraperFor(opts.site, opts.modulePath);
  const ctx = dryRunContext(
    opts.configInputs,
    opts.section.section,
    opts.logBuf,
    opts.engine,
    opts.discoverMax ?? 100,
    opts.follow ?? true,
    opts.followDepth ?? 3,
    opts.followUntil404 ?? false,
  );
  const candidates = await scraper.discover(ctx, opts.backends, opts.section);
  if (!candidates || candidates.length === 0) {
    throw new Error('discover returned no candidates for the index URL');
  }
  const article = await parseFirstValid(scraper, ctx, opts.backends, candidates, opts.logBuf);
  return { candidates, article };
}

/** Try up to 3 candidates before giving up on the dry-run validation parse. */
async function parseFirstValid(
  scraper: SiteScraper,
  ctx: ScraperContext,
  backends: Backends,
  candidates: DiscoveredItem[],
  logBuf: string[],
): Promise<Article> {
  let lastErr: unknown = null;
  for (const cand of candidates.slice(0, 3)) {
    try {
      const article = await scraper.parse(ctx, backends, cand);
      if (article && article.url && article.title && typeof article.html === 'string' && article.html) {
        return article;
      }
      lastErr = new Error(`parse returned an invalid Article for ${cand.url} (url, title, and non-empty html required)`);
    } catch (e) {
      lastErr = e;
      logBuf.push(`dry-run parse of ${cand.url} failed: ${String(e).slice(0, 160)}`);
    }
  }
  throw new Error(`parse failed for the first candidates: ${String(lastErr)}`);
}

export interface AddResult {
  site: string;
  section: string;
  newDomain: boolean;
  log: string[];
}

/**
 * `rssify add <url>` — Mode A (new domain): spawn pi, validate identifier, dry-run,
 * commit site + initial section. Mode B (existing domain): derive section id, dry-run,
 * commit section only. Returns registered identifiers + pi log for reporting.
 */
export async function add(db: Db, config: AppConfig, url: string, name?: string): Promise<AddResult> {
  const log: string[] = liveLog();
  const existingSite = findSiteForUrl(db, url);
  // The site name is user-owned and never auto-discovered, so new sites
  // require --name. Adding a subcategory to an already-registered site is
  // fine without it: the site keeps its existing title (Mode B never used
  // the name argument anyway).
  if ((!name || !name.trim()) && !existingSite) {
    throw new Error('a display name is required for a new site — pass it with --name (e.g. `rssify add <url> --name "My Feed"`)');
  }
  const backends = buildBackends(config);
  const engine = config.defaults.engine;

  if (existingSite) {
    // ---- Mode B: section add, no pi invocation ----
    const section = deriveSectionId(url);
    const modulePath = existingSite.module_path;
    if (!isValidIdentifier(section) || RESERVED.has(section)) {
      throw new Error(`derived section '${section}' is invalid or reserved`);
    }
    if (getSection(db, existingSite.site, section)) {
      throw new Error(`section '${section}' already registered on site '${existingSite.site}'`);
    }
    let configInputs: Record<string, unknown> = {};
    try {
      configInputs = JSON.parse(existingSite.config_json);
    } catch {
      /* ignore */
    }
    const sidecar = sidecarConfig('sites', existingSite.site);
    if (sidecar) configInputs = sidecar.config;
    const indexUrl = optionalIndexUrl(url, section);
    const title = prettify(section);
    const sectionRef: SectionRef = { section, indexUrl };
    await dryRun({
      site: existingSite.site,
      modulePath,
      section: sectionRef,
      configInputs,
      backends,
      logBuf: log,
      engine,
      discoverMax: config.defaults.discover_max,
      follow: config.defaults.follow,
      followDepth: config.defaults.follow_depth,
      followUntil404: config.defaults.follow_until_404,
    });
    insertSection(db, {
      site: existingSite.site,
      section,
      index_url: indexUrl,
      title,
      description: '',
      created_at: nowMs(),
    });
    log.push(`Registered section '${section}' on existing site '${existingSite.site}' (index: ${indexUrl})`);
    return { site: existingSite.site, section, newDomain: false, log };
  }

  // ---- Mode A: the app realizes extraction on its own first (generic adaptive
  //      discovery needs no per-site JS); pi is optional escalation for hard sites.
  //      Reaching here means the site is new, so the name is guaranteed non-empty
  //      (the guard above threw otherwise).
  const siteName = name as string;
  const snapshot = await buildAddSnapshot(backends, engine, url, log);
  try {
    const auto = await tryGenericAdd(db, config, url, engine, snapshot, siteName, log);
    if (auto) return auto;
    log.push('auto/adaptive extraction not viable — escalating to pi with the fetched snapshot');
    return await authorViaPi(db, config, url, engine, snapshot, siteName, log);
  } finally {
    rmSync(snapshot.htmlPath, { force: true });
  }
}

/**
 * App-authored site (no pi): probe the fetched page, generate a thin generic
 * module + an adaptive profile, dry-run, and commit. Returns null if generic
 * discovery can't cover the site (then callers escalate to pi).
 */
async function tryGenericAdd(
  db: Db,
  config: AppConfig,
  url: string,
  engine: EngineName,
  snapshot: AddSnapshot,
  name: string,
  log: string[],
): Promise<AddResult | null> {
  const backends = buildBackends(config);
  const section = deriveSectionId(url);
  const indexUrl = optionalIndexUrl(url, section);
  let base = deriveBaseIdent(url);
  if (!isValidIdentifier(base)) base = 'site';
  let ident = base;
  for (let n = 2; getSite(db, ident) || RESERVED.has(ident) || existsSync(join(ROOT, 'sites', `${ident}.ts`)); n++) {
    ident = `${base}-${n}`;
  }

  const modulePath = `sites/${ident}.ts`;
  writeFileSync(join(ROOT, modulePath), genericModuleSource(ident), 'utf8');
  const sidecar = profileFromSnapshot({
    html: snapshot.html,
    url,
    title: snapshot.title,
    max: config.defaults.discover_max,
    defaultMax: config.defaults.discover_max,
    follow: config.defaults.follow,
    followDepth: config.defaults.follow_depth,
    defaultFollow: config.defaults.follow,
    defaultFollowDepth: config.defaults.follow_depth,
    followUntil404: config.defaults.follow_until_404,
    defaultFollowUntil404: config.defaults.follow_until_404,
  });
  const configFile = join(ROOT, 'sites', `${ident}.config.json`);
  writeFileSync(configFile, JSON.stringify(sidecar, null, 2), 'utf8');

  const sectionRef: SectionRef = { section, indexUrl };
  let dry: { candidates: DiscoveredItem[]; article: Article };
  try {
    dry = await dryRun({
      site: ident,
      modulePath,
      section: sectionRef,
      configInputs: sidecar,
      backends,
      logBuf: log,
      engine,
      discoverMax: config.defaults.discover_max,
      follow: config.defaults.follow,
      followDepth: config.defaults.follow_depth,
      followUntil404: config.defaults.follow_until_404,
    });
  } catch (e) {
    log.push(`auto-extraction dry-run failed: ${String(e)}`);
    rmSync(join(ROOT, modulePath), { force: true });
    rmSync(configFile, { force: true });
    return null;
  }
  if (dry.candidates.length < 3) {
    log.push(`auto-extraction found only ${dry.candidates.length} candidate(s)`);
    rmSync(join(ROOT, modulePath), { force: true });
    rmSync(configFile, { force: true });
    return null;
  }

  // Feed name is user-provided (mandatory) — never lifted from the page. The
  // sidecar/snapshot title stays available to pi as authoring context only.
  const title = name.trim() || prettify(ident);
  insertSite(db, {
    site: ident,
    url: new URL(url).origin,
    title,
    description: (sidecar.description as string) || '',
    schedule: config.defaults.schedule,
    config_json: JSON.stringify(sidecar),
    module_path: modulePath,
    private: 0,
    created_at: nowMs(),
  });
  insertSection(db, {
    site: ident,
    section,
    index_url: indexUrl,
    title: prettify(section),
    description: '',
    created_at: nowMs(),
  });
  log.push(`Registered site '${ident}' with auto-extracted template (section '${section}', index ${indexUrl})`);
  return { site: ident, section, newDomain: true, log };
}

/** Escalation path: pi authors a per-site template from the fetched snapshot. */
async function authorViaPi(
  db: Db,
  config: AppConfig,
  url: string,
  engine: EngineName,
  snapshot: AddSnapshot,
  name: string,
  log: string[],
): Promise<AddResult> {
  const backends = buildBackends(config);
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    const before = snapshotSiteFiles();
    const prompt = piPrompt({
      url,
      engine,
      moduleDir: 'sites',
      contractPath: 'src/contract.ts',
      utilPath: 'src/util.ts',
      snapshot,
    });
    let piOut: string;
    try {
      piOut = await runPi(prompt, log);
    } catch (e) {
      throw new Error(`pi failed: ${String(e)}\nlog:\n${log.join('\n')}`);
    }

    // Determine identifier: prefer SITE_ID=<id>, else newly written files.
    let ident: string | undefined;
    const m = piOut.match(/SITE_ID=([A-Za-z0-9-]+)/);
    if (m) ident = m[1];
    if (!ident) {
      const files = newlyWrittenFiles(before);
      const mod = files.find((f) => f.endsWith('.ts') && f.startsWith('sites'));
      if (mod) {
        const base = mod.replace(/^sites[\\/]/, '').replace(/\.ts$/, '');
        if (files.some((f) => f === `sites/${base}.config.json` || f === `sites${base}.config.json`)) {
          ident = base;
        }
      }
    }
    if (!ident) {
      throw new Error(`could not determine the site identifier pi chose.\npi output:\n${piOut}\n\nlog:\n${log.join('\n')}`);
    }

    const problems: string[] = [];
    if (!isValidIdentifier(ident)) problems.push(`identifier '${ident}' must be [a-z0-9-] <= 40 chars`);
    if (RESERVED.has(ident)) problems.push(`identifier '${ident}' is reserved`);
    if (getSite(db, ident)) problems.push(`site '${ident}' already registered`);

    if (problems.length) {
      log.push(`pi proposed identifier '${ident}' but ${problems.join('; ')} — re-invoking`);
      rmSync(join(ROOT, 'sites', `${ident}.ts`), { force: true });
      rmSync(join(ROOT, 'sites', `${ident}.config.json`), { force: true });
      if (attempt >= 3) throw new Error(`pi could not propose a valid identifier: ${problems.join('; ')}`);
      continue;
    }

    const modulePath = `sites/${ident}.ts`;
    if (!existsSync(join(ROOT, modulePath))) {
      throw new Error(`pi wrote identifier '${ident}' but ${modulePath} does not exist`);
    }
    const sidecar = sidecarConfig('sites', ident);
    if (!sidecar) {
      throw new Error(`missing sidecar sites/${ident}.config.json (pi was asked to write it)`);
    }

    const section = deriveSectionId(url);
    const indexUrl = optionalIndexUrl(url, section);
    const sectionRef: SectionRef = { section, indexUrl };
    await dryRun({
      site: ident,
      modulePath,
      section: sectionRef,
      configInputs: sidecar.config,
      backends,
      logBuf: log,
      engine,
      discoverMax: config.defaults.discover_max,
      follow: config.defaults.follow,
      followDepth: config.defaults.follow_depth,
      followUntil404: config.defaults.follow_until_404,
    });

    insertSite(db, {
      site: ident,
      url: new URL(url).origin,
      // User-provided name wins; the sidecar's discovered title is authoring
      // context only (per the add contract: names are never site-discovered).
      title: name.trim() || prettify(ident),
      description: sidecar.description,
      schedule: config.defaults.schedule,
      config_json: JSON.stringify(sidecar.config),
      module_path: modulePath,
      private: 0,
      created_at: nowMs(),
    });
    insertSection(db, {
      site: ident,
      section,
      index_url: indexUrl,
      title: prettify(section),
      description: '',
      created_at: nowMs(),
    });
    log.push(`Registered site '${ident}' with initial section '${section}' (index: ${indexUrl})`);
    return { site: ident, section, newDomain: true, log };
  }
  throw new Error('add failed after retries');
}

function deriveBaseIdent(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./i, '');
  // Use the registrable domain (last two labels), not the subdomain:
  // investor.visa.com -> visa, finance.yahoo.com -> yahoo, thepaypers.com -> thepaypers.
  const labels = host.split('.');
  const main = labels.length > 2 ? labels.slice(-2)[0] : labels[0];
  return slugify(main || host) || 'site';
}

function findSiteForUrl(db: Db, url: string): { site: string; module_path: string; config_json: string } | undefined {
  const origin = new URL(url).origin;
  const sites = db.prepare('SELECT * FROM sites').all() as { site: string; url: string; module_path: string; config_json: string }[];
  return sites.find((s) => s.url === origin || s.url === origin + '/') as
    | { site: string; module_path: string; config_json: string }
    | undefined;
}

function prettify(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

