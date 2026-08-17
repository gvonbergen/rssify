import { createHash } from 'node:crypto';

/** sha1 hex digest */
export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Tracking / click-tracking params stripped during URL normalization. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'ref', 'referrer', 'ref_src', 'fbclid', 'gclid', 'mc_cid',
  'mc_eid', 'igshid', 'sc_campaign', 'sc_channel',
]);

/**
 * Normalize a URL for dedup: lowercase scheme+host (via URL), drop fragments
 * and known tracking params, and collapse duplicate slashes in the path.
 * Collapsing `//` guards against scraper modules that naively punt
 * `base + "/" + "/article.html"` producing double slashes.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Protocol-relative links ("//thepaypers.com/…") — resolve to https rather
    // than throwing; anything else keeps the original invalid-URL behavior.
    u = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
  }
  u.hash = '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  return u.toString();
}

/** Slugify a path segment into a URL-safe section identifier. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/** Valid site/section identifier: [a-z0-9-], <= max len. */
export function isValidIdentifier(id: string, max = 40): boolean {
  return typeof id === 'string' && /^[a-z0-9-]+$/.test(id) && id.length > 0 && id.length <= max;
}

export function nowMs(): number {
  return Date.now();
}

/** Format epoch ms as RFC-822 GMT, the date format RSS 2.0 requires. */
export function rfc822(epochMs: number): string {
  return new Date(epochMs).toUTCString();
}
