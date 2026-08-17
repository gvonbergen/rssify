import type { BackendFirecrawlConfig } from '../config.ts';
import type { FirecrawlResult, FirecrawlScrapeOpts } from '../contract.ts';

/**
 * firecrawl adapter — works against both cloud (api.firecrawl.dev) and
 * self-hosted base URLs. Produces cleaned main-content HTML natively
 * (`onlyMainContent`), plus passes through the scrape metadata object.
 */
/** Seconds to wait on a 429, honoring Retry-After (header or body) — capped. */
function retryAfterSeconds(res: Response, bodyText: string): number {
  const h = res.headers.get('retry-after');
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), 60);
    const d = Date.parse(h);
    if (Number.isFinite(d)) return Math.min(Math.max(Math.ceil((d - Date.now()) / 1000), 1), 60);
  }
  const m = bodyText.match(/retry after\s+(\d+)\s*s?/i);
  if (m) return Math.min(Math.max(Number(m[1]), 1), 60);
  return 25; // observed default from the API when no hint is given
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FirecrawlLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export class FirecrawlBackend {
  name = 'firecrawl';
  cfg: BackendFirecrawlConfig & { logger?: FirecrawlLogger };

  constructor(cfg: BackendFirecrawlConfig & { logger?: FirecrawlLogger }) {
    this.cfg = cfg;
  }

  base(): string {
    return this.cfg.base_url.replace(/\/+$/, '');
  }

  async scrape(url: string, opts?: FirecrawlScrapeOpts): Promise<FirecrawlResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.api_key) headers['authorization'] = `Bearer ${this.cfg.api_key}`;

    const body: Record<string, unknown> = {
      url,
      formats: ['html'],
      onlyMainContent: true,
      ...(opts ?? {}),
    };

    const post = (): Promise<Response> =>
      fetch(`${this.base()}/v2/scrape`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.request_timeout_ms),
      });

    let res = await post();
    // Free-tier burst protection: honor Retry-After / the body's "retry after Ns"
    // and retry once instead of failing the whole scrape on a transient 429.
    if (res.status === 429) {
      const bodyText = await res.text().catch(() => '');
      const waitSeconds = retryAfterSeconds(res, bodyText);
      this.cfg.logger?.info(
        { waitSeconds, url },
        'firecrawl 429 — rate limited, waiting before retry',
      );
      await sleep(waitSeconds * 1000);
      res = await post();
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`firecrawl /v2/scrape -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: { html?: string; metadata?: Record<string, unknown> } };
    const data = json.data ?? {};
    const html = typeof data.html === 'string' ? data.html : '';
    if (!html) throw new Error('firecrawl returned no HTML for ' + url);
    const metadata: Record<string, unknown> =
      data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    return { html, metadata };
  }
}
