import type { AppConfig } from './config.ts';

/**
 * Config-driven fetch-engine priority ("fetch cascade").
 *
 * Engines are tried in priority order when scraping a destination article
 * page: the primary (first) engine fetches, and when it fails (network error,
 * bot gate, timeout) or yields an empty/near-empty cleaned extraction, the
 * next configured engine advances. Plain fetch is always tried first in the
 * default configuration; camofox and firecrawl remain optional, configured
 * fallbacks.
 *
 * Backward compatibility: `defaults.engine` (single engine) stays authoritative
 * whenever no priority list is configured — set `defaults.engine_priority: []`
 * (or omit per-site/global overrides) to restore exact single-engine behavior.
 */

export const ENGINE_NAMES = ['plain', 'camofox', 'firecrawl'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

/**
 * Validate a configured priority list: must be a non-empty array of known
 * engine names (unknown entries are dropped, duplicates removed preserving
 * order). Returns null when nothing usable remains — the caller then falls
 * back to the next level (per-site → global → single `defaults.engine`).
 */
export function validateEnginePriority(value: unknown): EngineName[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.filter(
    (v): v is EngineName =>
      typeof v === 'string' && (ENGINE_NAMES as readonly string[]).includes(v),
  );
  const deduped = [...new Set(names)];
  return deduped.length > 0 ? deduped : null;
}

/**
 * Resolve the ordered engine priority for one site. Precedence:
 * 1. per-site override — the site's config_json `extract.enginePriority`;
 * 2. the global `defaults.engine_priority` list;
 * 3. the legacy single-engine setting `defaults.engine` (exact old behavior).
 */
export function resolveEnginePriority(
  config: AppConfig,
  siteConfig: Record<string, unknown> | undefined,
): EngineName[] {
  const ext = (siteConfig?.['extract'] ?? {}) as Record<string, unknown>;
  const perSite = validateEnginePriority(ext['enginePriority']);
  if (perSite) return perSite;
  const global = validateEnginePriority(config.defaults.engine_priority);
  if (global) return global;
  return [config.defaults.engine];
}

/**
 * Drop engines whose backend is not usable right now. Firecrawl is skipped
 * unless an API key is configured (consistent with the existing bot-gate
 * fallback's availability check); plain and camofox have no such gate.
 * Degenerate guard: if filtering would empty the whole list (e.g. a priority
 * list naming ONLY unconfigured firecrawl), the input list is returned — a
 * misconfigured cascade degrades to attempting the engines (errors surface
 * exactly like the legacy single-engine behavior) rather than never fetching.
 */
export function filterConfiguredEngines(
  engines: EngineName[],
  config: AppConfig,
): EngineName[] {
  const usable = engines.filter(
    (e) => e !== 'firecrawl' || Boolean(config.backends.firecrawl.api_key),
  );
  return usable.length > 0 ? usable : engines;
}

/** The primary engine for a site — the head of its resolved priority list. */
export function primaryEngine(
  config: AppConfig,
  siteConfig?: Record<string, unknown>,
): EngineName {
  return resolveEnginePriority(config, siteConfig)[0];
}
