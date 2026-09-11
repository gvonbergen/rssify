import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import {
  filterConfiguredEngines,
  primaryEngine,
  resolveEnginePriority,
  validateEnginePriority,
} from '../src/engines.ts';
import { persistArticle, runSiteScrape } from '../src/scraper.ts';
import type { Backends } from '../src/contract.ts';
import type { Logger } from '../src/logger.ts';
import { makeTempDir, openTempDb, removeTempDir, seedSite } from './helpers.ts';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const FIXTURES = join(import.meta.dirname, 'fixtures');
const datadomeFixture = () => readFileSync(join(FIXTURES, 'rc-datadome.html'), 'utf8');

const goodBody = (url: string, title = 'Good title'): string =>
  `<html><head><title>${title}</title></head><body><article><p>${'Real article body sentence. '.repeat(12)}</p></article></body></html>`;

const backendsMock = {
  plain: { async fetch() { throw new Error('not used'); } },
  camofox: { async fetch() { throw new Error('not used'); } },
  firecrawl: { async scrape() { throw new Error('not used'); } },
} as unknown as Backends;

// ---------------------------------------------------------------------------
// Engine priority resolution
// ---------------------------------------------------------------------------

test('validateEnginePriority keeps known engines in order, drops unknown and duplicates', () => {
  assert.deepEqual(validateEnginePriority(['camofox', 'plain', 'bogus', 'camofox', 'firecrawl']), ['camofox', 'plain', 'firecrawl']);
  assert.equal(validateEnginePriority([]), null);
  assert.equal(validateEnginePriority('plain'), null);
  assert.equal(validateEnginePriority(['bogus']), null);
  assert.equal(validateEnginePriority(undefined), null);
  assert.equal(validateEnginePriority([42]), null);
});

test('resolveEnginePriority: default config is plain-first with configured fallbacks', () => {
  assert.deepEqual(resolveEnginePriority(DEFAULT_CONFIG, {}), ['plain', 'camofox', 'firecrawl']);
  assert.equal(primaryEngine(DEFAULT_CONFIG), 'plain');
});

test('resolveEnginePriority: per-site extract.enginePriority wins over the global list', () => {
  const siteCfg = { extract: { enginePriority: ['camofox', 'plain', 'bogus', 'camofox'] } };
  assert.deepEqual(resolveEnginePriority(DEFAULT_CONFIG, siteCfg), ['camofox', 'plain']);
});

test('resolveEnginePriority: invalid/empty per-site override falls back to the global list', () => {
  assert.deepEqual(resolveEnginePriority(DEFAULT_CONFIG, { extract: { enginePriority: [] } }), ['plain', 'camofox', 'firecrawl']);
  assert.deepEqual(resolveEnginePriority(DEFAULT_CONFIG, { extract: { enginePriority: 'plain' } }), ['plain', 'camofox', 'firecrawl']);
});

test('resolveEnginePriority: no priority list configured → exact legacy single-engine behavior', () => {
  const cfg = structuredClone(DEFAULT_CONFIG) as AppConfig;
  cfg.defaults.engine_priority = [];
  cfg.defaults.engine = 'firecrawl';
  assert.deepEqual(resolveEnginePriority(cfg, {}), ['firecrawl']);
  assert.equal(primaryEngine(cfg), 'firecrawl');
});

test('filterConfiguredEngines: firecrawl is skipped without an API key, kept with one', () => {
  const cfg = structuredClone(DEFAULT_CONFIG) as AppConfig;
  assert.deepEqual(filterConfiguredEngines(['plain', 'camofox', 'firecrawl'], cfg), ['plain', 'camofox']);
  cfg.backends.firecrawl.api_key = 'test-key';
  assert.deepEqual(filterConfiguredEngines(['plain', 'camofox', 'firecrawl'], cfg), ['plain', 'camofox', 'firecrawl']);
  assert.deepEqual(filterConfiguredEngines([], cfg), []);
});

test('filterConfiguredEngines: never returns an empty list — degenerate config degrades to attempting engines', () => {
  const cfg = structuredClone(DEFAULT_CONFIG) as AppConfig;
  // A priority list naming ONLY unconfigured firecrawl still fetches (the
  // attempt fails exactly like legacy single-engine firecrawl), instead of
  // erroring out without ever fetching.
  assert.deepEqual(filterConfiguredEngines(['firecrawl'], cfg), ['firecrawl']);
});

// ---------------------------------------------------------------------------
// persistArticle: quality-triggered cascade (fetch cascade part 2)
// ---------------------------------------------------------------------------

test('persistArticle advances through engines on a near-empty extraction and stores the first good body', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/a1' };
    const cascade = {
      engines: ['plain', 'camofox', 'firecrawl'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        if (engine === 'camofox') throw new Error('camofox down');
        return { url: cand.url, title: 'Better title', html: goodBody(cand.url) };
      },
    };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: '<p>stub</p>' },
      backendsMock, noopLogger, cascade, 0,
    );
    // Failed refetch advances to the next engine; firecrawl's cleaned body wins.
    assert.deepEqual(refetched, ['camofox', 'firecrawl']);
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, true);
    const stored = (await import('../src/db.ts')).recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, 'Better title');
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle never cascades for a picture item (caption + image is legitimate content)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/a2' };
    const cascade = {
      engines: ['plain', 'camofox'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        return { url: cand.url, title: 'x', html: goodBody(cand.url) };
      },
    };
    const caption = '<img src="a.jpg"><p>short caption</p><p>Image</p><p>Credit REUTERS</p>';
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: caption },
      backendsMock, noopLogger, cascade, 0,
    );
    assert.deepEqual(refetched, []); // no fallback-engine spend on a photo card
    assert.equal(res.inserted, 1);
    assert.equal(res.pictureItem, true);
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle stores the last attempt when every engine yields a near-empty body', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/a3' };
    const cascade = {
      engines: ['plain', 'camofox'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        return { url: cand.url, title: 'still stub', html: '<p>stub too</p>' };
      },
    };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: '<p>stub</p>' },
      backendsMock, noopLogger, cascade, 0,
    );
    assert.deepEqual(refetched, ['camofox']);
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, false); // stored, flagged weak — not lost
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle advances to the next engine when cleaning fails (bot-gated page under cascade)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/a4' };
    const cascade = {
      engines: ['plain', 'firecrawl'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        return {
          url: cand.url,
          title: 'Cleaned',
          html: goodBody(cand.url),
          cleaned: true,
          metadata: {},
        };
      },
    };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: 'Reuters item', html: datadomeFixture() },
      backendsMock, noopLogger, cascade, 0,
    );
    assert.deepEqual(refetched, ['firecrawl']);
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, true);
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle without a cascade keeps exact legacy behavior (no refetch, weak body stored)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const cand = { url: 'https://www.example.test/news/a5' };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: '<p>stub</p>' },
      backendsMock, noopLogger,
    );
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, false);
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: runSiteScrape drives the cascade through a real scraper module
// ---------------------------------------------------------------------------

const FAKE_MODULE = 'sites/fm-cascade-fake.ts';
const FAKE_SOURCE = `import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SectionRef,
} from '../src/contract.ts';

export const site = 'cascadetest';
export const attempts: string[] = [];

export async function discover(
  ctx: ScraperContext,
  backends: Backends,
  section: SectionRef,
): Promise<DiscoveredItem[]> {
  attempts.push('discover:' + ctx.engine);
  return [{ url: 'https://cascadetest.test/news/a1', hintTitle: 'A1' }];
}

export async function parse(
  ctx: ScraperContext,
  backends: Backends,
  item: DiscoveredItem,
): Promise<Article> {
  attempts.push('parse:' + ctx.engine);
  if (ctx.engine === 'plain') {
    // First parse returns a near-empty body → cascade must advance;
    // a second plain parse would only happen if the cascade looped back.
    if (attempts.filter((a) => a === 'parse:plain').length >= 2) {
      throw new Error('plain fetch https://cascadetest.test/news/a1 -> 403');
    }
    return { url: item.url, title: item.hintTitle || 'Untitled', html: '<p>stub</p>' };
  }
  return {
    url: item.url,
    title: 'Good title',
    html: '<html><head><title>Good title</title></head><body><article><p>' +
      'Real article body sentence. '.repeat(12) +
      '</p></article></body></html>',
  };
}

export default { site, discover, parse };
`;

test('runSiteScrape: plain-first cascade refetches a near-empty article through camofox', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  // No firecrawl API key → cascade is [plain, camofox] end to end.
  await writeFile(FAKE_MODULE, FAKE_SOURCE, 'utf8');
  try {
    seedSite(db);
    // Point the site at the fake module (helpers' module_path is googlenews).
    db.prepare("UPDATE sites SET module_path='sites/fm-cascade-fake.ts' WHERE site='example'").run();

    const res = await runSiteScrape(db, config, 'example');
    assert.equal(res?.status, 'ok');
    assert.equal(res?.newItems, 1);
    // Discovery stays on the legacy defaults.engine ('firecrawl' in the
    // default config — the article-page priority list does not steer it);
    // parse advanced plain → camofox (firecrawl filtered out, no API key).
    const fake = (await import(`../${FAKE_MODULE}`)) as { attempts: string[] };
    assert.deepEqual((fake as { attempts: string[] }).attempts, [
      'discover:firecrawl',
      'parse:plain', // near-empty body
      'parse:camofox', // cascade advance → good body
    ]);
    const stored = (await import('../src/db.ts')).recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, 'Good title');
  } finally {
    await rm(FAKE_MODULE, { force: true });
    await removeTempDir(dir);
  }
});

test('runSiteScrape: discovery follows legacy defaults.engine, not the plain priority head', async () => {
  const LEGACY_MODULE = 'sites/fm-cascade-fake-legacy.ts';
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir, { engine: 'camofox' });
  await writeFile(LEGACY_MODULE, FAKE_SOURCE, 'utf8');
  try {
    seedSite(db);
    db.prepare("UPDATE sites SET module_path='sites/fm-cascade-fake-legacy.ts' WHERE site='example'").run();

    const res = await runSiteScrape(db, config, 'example');
    assert.equal(res?.status, 'ok');
    assert.equal(res?.newItems, 1);
    const fake = (await import(`../${LEGACY_MODULE}`)) as { attempts: string[] };
    // Legacy engine 'camofox' steers discovery even though the priority head
    // for article pages is still 'plain'; the article cascade is unchanged.
    assert.deepEqual((fake as { attempts: string[] }).attempts, [
      'discover:camofox',
      'parse:plain', // near-empty body
      'parse:camofox', // cascade advance → good body
    ]);
  } finally {
    await rm(LEGACY_MODULE, { force: true });
    await removeTempDir(dir);
  }
});
