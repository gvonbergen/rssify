/**
 * Configurable source-URL skip rules: a global/per-site BLACKLIST of host
 * patterns (YouTube is excluded from ingestion by default — the watch pages
 * consistently stored playback-error stubs in the 2026-09 audits) and a
 * narrow PATTERN filter for non-article destinations (fund quote pages,
 * chart widgets, report landing pages) that must not ban entire hosts.
 *
 * Semantics:
 *  - Blacklist entries are host patterns: a URL matches when its host equals
 *    the entry or ends with "." + entry (so www./m./music. subdomains are
 *    covered). An entry may carry a path prefix ("youtube.com/shorts") to
 *    narrow the match to that path.
 *  - The per-site `extract.urlBlacklist` config REPLACES the global
 *    `defaults.url_blacklist` list (an empty array disables blacklisting for
 *    that site entirely).
 *  - Skip-pattern entries are wildcard patterns ("*" = any run of
 *    characters) matched case-insensitively against `<host><pathname>`, so
 *    e.g. `cnbc.com/quote/*` filters one URL shape without banning cnbc.com.
 *    The per-site `extract.skipUrlPatterns` config REPLACES the global
 *    `defaults.skip_url_patterns`.
 *
 * Enforcement lives in src/scraper.ts: candidates are skipped BEFORE any
 * fetch (no engine spend), and persistArticle re-checks the resolved
 * canonical URL so a redirect/canonical into a blacklisted host is never
 * stored. Every skip is logged with the matched entry (observable).
 */

import type { AppConfig } from './config.ts';

/**
 * Default blacklist: YouTube sources are excluded from ingestion by default
 * (explicit product request). youtube.com covers all common subdomains via
 * the host-suffix rule; youtu.be covers the short-link host (and subdomains).
 */
export const DEFAULT_URL_BLACKLIST = ['youtube.com', 'youtu.be'];

/**
 * Resolve the effective blacklist for a site: per-site
 * config_json `extract.urlBlacklist` (string array) replaces the global
 * `defaults.url_blacklist`; anything that is not an array of strings falls
 * back to the global list. Returns a validated string array.
 */
export function resolveUrlBlacklist(
  config: AppConfig,
  siteConfig: Record<string, unknown> | undefined,
): string[] {
  const ext = (siteConfig?.['extract'] ?? {}) as Record<string, unknown>;
  const perSite = ext['urlBlacklist'] ?? ext['url_blacklist'];
  if (Array.isArray(perSite)) {
    return perSite.map(String).filter((s) => s.trim() !== '');
  }
  const global = config.defaults.url_blacklist;
  return Array.isArray(global) ? global.map(String) : [];
}

/**
 * Resolve the effective non-article skip patterns for a site (same precedence
 * rules as the blacklist).
 */
export function resolveSkipUrlPatterns(
  config: AppConfig,
  siteConfig: Record<string, unknown> | undefined,
): string[] {
  const ext = (siteConfig?.['extract'] ?? {}) as Record<string, unknown>;
  const perSite = ext['skipUrlPatterns'] ?? ext['skip_url_patterns'];
  if (Array.isArray(perSite)) {
    return perSite.map(String).filter((s) => s.trim() !== '');
  }
  const global = config.defaults.skip_url_patterns;
  return Array.isArray(global) ? global.map(String) : [];
}

/**
 * Match one URL against one blacklist entry. Returns true when the URL's host
 * equals the entry's host or is a subdomain of it (and, when the entry has a
 * path prefix, the URL's pathname starts with it). Malformed URLs never match.
 */
export function matchesBlacklistEntry(url: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  const slash = e.indexOf('/');
  const entryHost = slash === -1 ? e : e.slice(0, slash);
  const entryPath = slash === -1 ? '' : e.slice(slash);
  if (!entryHost) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host !== entryHost && !host.endsWith(`.${entryHost}`)) return false;
  if (entryPath && entryPath !== '/') {
    const path = (u.pathname || '/').toLowerCase();
    if (!path.startsWith(entryPath.replace(/\/+$/, '') + '/')) return false;
  }
  return true;
}

/** First matching blacklist entry for a URL, or null when none matches. */
export function matchUrlBlacklist(url: string, entries: readonly string[]): string | null {
  for (const entry of entries) {
    if (matchesBlacklistEntry(url, entry)) return entry;
  }
  return null;
}

/**
 * Match one URL against one wildcard skip pattern (`*` = any run of
 * characters, everything else literal), case-insensitively, against
 * `<host><pathname>`. A pattern whose host part carries no `*` also matches
 * that host's subdomains ("cnbc.com/quote/*" matches "www.cnbc.com/…") —
 * the same host-suffix convention as the blacklist — while still never
 * banning the host: a pattern without a path prefix is an error-shape the
 * caller should avoid. Empty patterns and malformed URLs never match.
 */
export function matchesSkipPattern(url: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const target = `${u.host}${u.pathname || '/'}`.toLowerCase();
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wildcardToRe = (s: string): string => s.split('*').map(esc).join('.*');
  const slash = p.indexOf('/');
  const hostPart = slash === -1 ? p : p.slice(0, slash);
  const rest = slash === -1 ? '' : p.slice(slash);
  let regexSrc: string;
  if (hostPart.includes('*')) {
    // Wildcard host: plain wildcard semantics over host+path.
    regexSrc = `^${wildcardToRe(p)}$`;
  } else if (rest === '') {
    // Bare-host pattern: any path on that host (or a subdomain).
    regexSrc = `^([a-z0-9-]+\\.)?${esc(hostPart)}(/.*)?$`;
  } else {
    regexSrc = `^([a-z0-9-]+\\.)?${esc(hostPart)}${wildcardToRe(rest)}$`;
  }
  return new RegExp(regexSrc).test(target);
}

/** First matching skip pattern for a URL, or null when none matches. */
export function matchSkipPatterns(url: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (matchesSkipPattern(url, pattern)) return pattern;
  }
  return null;
}