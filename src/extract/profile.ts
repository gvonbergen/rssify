import type { AppConfig } from '../config.ts';
import { buildBackends } from '../backends/index.ts';
import { getSite, listSections, updateSiteConfig, type Db } from '../db.ts';
import { discoverCandidates, detectMode, type DiscoveryMode } from './discover.ts';
import { fetchHtml } from './generic.ts';

/** Marker used to identify machine-generated (auto-adapting) site modules. */
export const GENERIC_TEMPLATE = 'generic';

/**
 * Build the sidecar config for a site the app realizes on its own: a generic
 * extraction profile derived from the fetched index page (no pi, no hand JS).
 */
export function profileFromSnapshot(opts: {
  html: string;
  url: string;
  title: string;
  description?: string;
  max?: number;
  /** The instance-wide default cap; when `max` equals it, it is not baked into
   *  the profile so `defaults.discover_max` keeps governing the site. */
  defaultMax?: number;
  follow?: boolean;
  followDepth?: number;
  /** Instance-wide follow defaults; equal values are not baked so
   *  `defaults.follow` / `defaults.follow_depth` keep governing the site. */
  defaultFollow?: boolean;
  defaultFollowDepth?: number;
  followUntil404?: boolean;
  defaultFollowUntil404?: boolean;
}): Record<string, unknown> {
  const max = opts.max ?? 100;
  const cands = discoverCandidates(opts.html, opts.url, { max: Math.max(max, 10) * 4 });
  const mode: DiscoveryMode = detectMode(cands) ?? 'auto';
  const extract: Record<string, unknown> = {
    mode,
    // Bake a knob only when it differs from the instance default, so a later
    // `defaults.*` change still governs unless the site overrides it.
    ...(max === opts.defaultMax ? {} : { max }),
    ...(opts.follow === undefined || opts.follow === opts.defaultFollow ? {} : { follow: opts.follow }),
    ...(opts.followDepth === undefined || opts.followDepth === opts.defaultFollowDepth ? {} : { followDepth: opts.followDepth }),
    ...(opts.followUntil404 === undefined || opts.followUntil404 === opts.defaultFollowUntil404 ? {} : { followUntil404: opts.followUntil404 }),
    hint: `auto-detected: ${mode} (${cands.length} candidates from the index page)`,
  };
  return {
    title: opts.title || '',
    description: opts.description || '',
    template: GENERIC_TEMPLATE,
    extract,
  };
}

/** The thin generated module file — imports the shared generic scraper. */
export function genericModuleSource(site: string): string {
  return `import { createGenericScraper } from '../src/extract/generic.ts';
import type { Backends, DiscoveredItem, ScraperContext, SectionRef, Article } from '../src/contract.ts';

export const site = '${site}';
const inner = createGenericScraper('${site}');

export async function discover(ctx: ScraperContext, backends: Backends, section: SectionRef): Promise<DiscoveredItem[]> {
  return inner.discover(ctx, backends, section);
}
export async function parse(ctx: ScraperContext, backends: Backends, item: DiscoveredItem): Promise<Article> {
  return inner.parse(ctx, backends, item);
}
export default { site, discover, parse };
`;
}

/**
 * Live re-probe: refetch the site's index, re-detect its extraction mode, and
 * update the saved config_json. Only meaningful for generic sites. Returns the
 * new mode, or null if there's nothing to re-probe / nothing changed.
 */
export async function reprofileSite(
  db: Db,
  config: AppConfig,
  site: string,
  log: { info(msg: string): void; warn(msg: string): void },
): Promise<DiscoveryMode | null> {
  const row = getSite(db, site);
  if (!row) return null;
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(row.config_json || '{}');
  } catch {
    cfg = {};
  }
  const sections = listSections(db, site);
  const indexUrl = sections[0]?.index_url;
  if (!indexUrl) {
    log.warn(`reprofile ${site}: no index URL registered`);
    return null;
  }
  const engine = config.defaults.engine;
  const backends = buildBackends(config);
  let html: string;
  try {
    html = await fetchHtml(backends, engine, indexUrl);
  } catch (e) {
    log.warn(`reprofile ${site}: could not fetch index: ${String(e)}`);
    return null;
  }
  const cands = discoverCandidates(html, indexUrl, { max: 400 });
  const mode = detectMode(cands) ?? 'auto';
  const prev = cfg.extract as { mode?: string; max?: number; follow?: boolean; followDepth?: number; followUntil404?: boolean } | undefined;
  const prevMode = prev?.mode;
  if (mode !== prevMode || cfg.template !== GENERIC_TEMPLATE) {
    const effectiveMax = prev?.max ?? config.defaults.discover_max;
    const extract: Record<string, unknown> = {
      mode,
      // Bake a knob only when it differs from the instance default, so a
      // later `defaults.*` change still governs unless the site explicitly
      // overrides it.
      ...(effectiveMax === config.defaults.discover_max ? {} : { max: effectiveMax }),
      ...(prev?.follow === undefined || prev.follow === config.defaults.follow ? {} : { follow: prev.follow }),
      ...(prev?.followDepth === undefined || prev.followDepth === config.defaults.follow_depth ? {} : { followDepth: prev.followDepth }),
      ...(prev?.followUntil404 === undefined || prev.followUntil404 === config.defaults.follow_until_404 ? {} : { followUntil404: prev.followUntil404 }),
      hint: `auto-detected: ${mode} (${cands.length} candidates)`,
    };
    const merged: Record<string, unknown> = { ...cfg, template: GENERIC_TEMPLATE, extract };
    updateSiteConfig(db, site, JSON.stringify(merged));
    log.info(`reprofile ${site}: mode '${prevMode ?? '(none)'}' -> '${mode}' (${cands.length} candidates)`);
    return mode;
  }
  return mode;
}
