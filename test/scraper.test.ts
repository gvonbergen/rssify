import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenericScraper, fetchHtml, choosePublishedDate } from '../src/extract/generic.ts';
import { looksBotGated, delayBandMs, withRateLimit } from '../src/scraper.ts';
import type { Backends } from '../src/contract.ts';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('delayBandMs applies partial overrides, normalizes values, and swaps inverted bounds', () => {
  const global = { lower_sec: 2, upper_sec: 5 };
  assert.deepEqual(delayBandMs(undefined, global), { lowerMs: 2000, upperMs: 5000 });
  assert.deepEqual(delayBandMs({ scrape_delay: { lower_sec: 7 } }, global), { lowerMs: 5000, upperMs: 7000 });
  assert.deepEqual(delayBandMs({ scrape_delay: { lower_sec: 9, upper_sec: 3 } }, global), { lowerMs: 3000, upperMs: 9000 });
  assert.deepEqual(delayBandMs({ scrape_delay: { lower_sec: -2, upper_sec: 'bad' } }, global), { lowerMs: 0, upperMs: 0 });
});

test('bot-gate detection requires a meaningful challenge page and known marker', () => {
  assert.equal(looksBotGated('cf-chl'.repeat(100)), true);
  assert.equal(looksBotGated('<html>' + 'just a moment '.repeat(20) + '</html>'), true);
  assert.equal(looksBotGated('cf-chl'), false);
  assert.equal(looksBotGated('<html>' + 'real article '.repeat(100) + '</html>'), false);
});

test('choosePublishedDate prefers valid page metadata unless it is implausibly late', () => {
  assert.equal(choosePublishedDate(undefined, '2026-08-01'), '2026-08-01');
  assert.equal(choosePublishedDate('2026-08-05', undefined), '2026-08-05');
  assert.equal(choosePublishedDate('not-a-date', '2026-08-01'), '2026-08-01');
  assert.equal(choosePublishedDate('2026-08-02T12:00:00Z', '2026-08-01T12:00:00Z'), '2026-08-02T12:00:00Z');
  assert.equal(choosePublishedDate('2026-08-05', '2026-08-01'), '2026-08-01');
});

test('generic scraper dispatches only through injected backend mocks', async () => {
  const calls: string[] = [];
  const backends = {
    plain: { async fetch(url: string) { calls.push(`plain:${url}`); return '<a href="/2026/08/05/article">A useful article headline for testing</a>'; } },
    camofox: { async fetch(url: string) { calls.push(`camofox:${url}`); return '<html><head><meta property="article:published_time" content="2026-08-05"></head><body><article><p>body</p></article></body></html>'; } },
    firecrawl: { async scrape(url: string) { calls.push(`firecrawl:${url}`); return { html: '<p>clean body</p>', metadata: {} }; } },
  } as unknown as Backends;
  const scraper = createGenericScraper('test');
  const context = {
    logger: noopLogger, config: { extract: { follow: false } }, kv: { async get() { return null; }, async set() {}, async del() {} },
    engine: 'plain', discoverMax: 10, follow: false, followDepth: 0, followUntil404: false, waitMs: 0,
  };
  const found = await scraper.discover(context, backends, { section: 'news', indexUrl: 'https://example.test/news' });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://example.test/2026/08/05/article');
  assert.deepEqual(calls, ['plain:https://example.test/news']);

  const parsed = await scraper.parse(context, backends, found[0]);
  assert.equal(parsed.url, found[0].url);
  assert.equal(parsed.publishedAt, '2026-08-05');
  assert.deepEqual(calls, ['plain:https://example.test/news', 'plain:https://example.test/2026/08/05/article']);

  const fire = await fetchHtml(backends, 'firecrawl', 'https://example.test/x');
  const stealth = await fetchHtml(backends, 'camofox', 'https://example.test/y');
  assert.equal(fire, '<p>clean body</p>');
  assert.match(stealth, /article/);
  assert.match(calls.join('|'), /firecrawl:https:\/\/example\.test\/x/);
  assert.match(calls.join('|'), /camofox:https:\/\/example\.test\/y/);
});

test('withRateLimit is a no-op when both delay bounds are zero', () => {
  const backends = { plain: { fetch: async () => 'x' }, camofox: { fetch: async () => 'x' }, firecrawl: { scrape: async () => ({ html: 'x', metadata: {} }) } } as unknown as Backends;
  assert.equal(
    withRateLimit(backends, { lowerMs: 0, upperMs: 0 }, 'test', noopLogger as unknown as Parameters<typeof withRateLimit>[3]),
    backends,
  );
});
