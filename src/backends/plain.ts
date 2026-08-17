import type { BackendPlainConfig } from '../config.ts';

/**
 * Plain `fetch` + central-Readability adapter for trivial, static,
 * SEO-friendly pages that need no JS or bot protection. Returns RAW html —
 * the app cleans it with @mozilla/readability (same path as camofox). This is
 * an example of how the pluggable adapter layer accommodates new engines
 * without touching scheduler/modules/feeds.
 */
export class PlainBackend {
  name = 'plain';
  cfg: BackendPlainConfig;

  constructor(cfg: BackendPlainConfig) {
    this.cfg = cfg;
  }

  async fetch(url: string, opts?: { headers?: Record<string, string> }): Promise<string> {
    const headers: Record<string, string> = {
      // Browser-like defaults: sites like Forbes' WAF 403 on minimal/"bot"
      // accept headers, but allow a realistic Chrome header set.
      'user-agent':
        this.cfg.user_agent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'upgrade-insecure-requests': '1',
      ...(opts?.headers ?? {}),
    };
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.cfg.request_timeout_ms),
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      throw new Error(`plain fetch ${url} -> ${res.status}`);
    }
    if (!ct.includes('html') && !ct.includes('text')) {
      // Not HTML; still return whatever text we can.
    }
    return res.text();
  }
}
