import type { BackendCamofoxConfig } from '../config.ts';

/**
 * camofox-browser REST API adapter (stealth Firefox). Endpoint is a REST API,
 * not raw CDP: POST /tabs creates a tab, POST /tabs/:id/evaluate runs JS to
 * grab `document.documentElement.outerHTML`, DELETE /tabs/:id cleans up.
 */
export class CamofoxBackend {
  name = 'camofox';
  cfg: BackendCamofoxConfig;

  constructor(cfg: BackendCamofoxConfig) {
    this.cfg = cfg;
  }

  base(): string {
    return this.cfg.base_url.replace(/\/+$/, '');
  }
  authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.access_key) h['authorization'] = `Bearer ${this.cfg.access_key}`;
    return h;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(this.base() + path, {
      method,
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.request_timeout_ms),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`camofox ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  /** Open a tab for url, run JS to return full-page HTML, then close the tab. */
  async fetch(url: string, opts?: { waitMs?: number; evaluateJs?: string }): Promise<string> {
    const r = await this.fetchWithStatus(url, opts);
    return r.html;
  }

  /** fetch() plus the target page's real HTTP status (null when unknowable). */
  async fetchWithStatus(
    url: string,
    opts?: { waitMs?: number; evaluateJs?: string },
  ): Promise<{ html: string; status: number | null }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await this.fetchOnce(url, opts, true)) as { html: string; status: number | null };
      } catch (e) {
        lastErr = e;
        // Retry transient 5xx once with a short pause — the browser can still
        // be booting right after the server starts (camofox marks it
        // "retryable":false but it recovers). 4xx errors are deterministic.
        const m = e instanceof Error ? e.message.match(/-> (\d{3}):/) : null;
        if (!m || !String(m[1]).startsWith('5')) throw e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchOnce(
    url: string,
    opts?: { waitMs?: number; evaluateJs?: string },
    wantStatus = false,
  ): Promise<string | { html: string; status: number | null }> {
    // camofox-browser v1.13+ requires sessionKey (a tab-group identifier; any
    // label works) alongside userId — we reuse user_id as the group label.
    const tab = (await this.request('POST', '/tabs', {
      userId: this.cfg.user_id,
      sessionKey: this.cfg.user_id,
      url,
    })) as { tabId: string };
    const { tabId } = tab;
    try {
      if (opts?.waitMs) {
        await new Promise((r) => setTimeout(r, opts.waitMs));
      }
      // camofox /evaluate runs a CDP-style *expression*, not a statement —
      // a top-level `return ...;` is a syntax error there (500). Normalize
      // the common statement style into an expression.
      // When wantStatus, the expression returns { status, html }: the real
      // HTTP status of the loaded page comes from the navigation timing entry
      // (Firefox 111+/Chrome 109+); null if the engine can't expose it.
      const js =
        opts?.evaluateJs ??
        (wantStatus
          ? `(() => { const nav = performance.getEntriesByType('navigation')[0]; return { status: nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : null, html: document.documentElement.outerHTML }; })()`
          : 'return document.documentElement.outerHTML;');
      const expression = js.trim().replace(/^return\s+/, '').replace(/;\s*$/, '');
      const evalRes = (await this.request('POST', `/tabs/${tabId}/evaluate`, {
        userId: this.cfg.user_id,
        expression,
      })) as {
        result?: unknown;
        value?: unknown;
      };
      const val = evalRes.result ?? evalRes.value;
      if (wantStatus) {
        if (val && typeof val === 'object') {
          const v = val as { html?: unknown; status?: unknown };
          return {
            html: typeof v.html === 'string' ? v.html : String(v.html ?? ''),
            status: typeof v.status === 'number' ? v.status : null,
          };
        }
        return { html: String(val ?? ''), status: null };
      }
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object' && 'html' in (val as object)) {
        const maybe = (val as { html?: unknown }).html;
        if (typeof maybe === 'string') return maybe;
      }
      return String(val ?? '');
    } finally {
      await this.request('DELETE', `/tabs/${tabId}?userId=${encodeURIComponent(this.cfg.user_id)}`).catch(() => {});
    }
  }
}
