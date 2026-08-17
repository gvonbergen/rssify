import type { AppConfig } from '../config.ts';
import type { Backends } from '../contract.ts';
import { CamofoxBackend } from './camofox.ts';
import { FirecrawlBackend, type FirecrawlLogger } from './firecrawl.ts';
import { PlainBackend } from './plain.ts';

/**
 * Build the `backends` object injected into scraper modules, wired from
 * config.yaml. All registered adapters are always available to modules;
 * `defaults.engine` just names the preferred one (passed to `pi` at `add` time).
 */
export function buildBackends(config: AppConfig, logger?: FirecrawlLogger): Backends {
  const camofox = new CamofoxBackend(config.backends.camofox);
  const firecrawl = new FirecrawlBackend({ ...config.backends.firecrawl, logger });
  const plain = new PlainBackend(config.backends.plain);
  return {
    camofox: {
      fetch: (url, opts) => camofox.fetch(url, opts),
    },
    firecrawl: {
      scrape: (url, opts) => firecrawl.scrape(url, opts),
    },
    plain: {
      fetch: (url, opts) => plain.fetch(url, opts),
    },
  };
}

export type EngineName = 'camofox' | 'firecrawl' | 'plain';

export function engineName(config: AppConfig): EngineName {
  return config.defaults.engine;
}

/** Short guidance string describing how to use each engine (for pi prompts). */
export function engineGuide(engine: EngineName): string {
  switch (engine) {
    case 'camofox':
      return 'backends.camofox.fetch(url, { waitMs, evaluateJs }) -> RAW page HTML (app cleans it). Use for JS-heavy / bot-protected sites.';
    case 'firecrawl':
      return 'backends.firecrawl.scrape(url, opts) -> { html, metadata } (html is ALREADY cleaned). Set Article.cleaned=true and Article.metadata=result.metadata.';
    case 'plain':
      return 'backends.plain.fetch(url, { headers }) -> RAW page HTML (app cleans it with readability). Use for simple, static, fetch-friendly pages.';
  }
}
