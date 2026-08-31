import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates, detectMode, findFollowLinks } from '../src/extract/discover.ts';
import { parseGoogleAlertsFeed, discover as discoverGoogle } from '../sites/googlenews.ts';
import type { Backends, ScraperContext } from '../src/contract.ts';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = (config: Record<string, unknown> = {}): ScraperContext => ({
  logger, config, kv: { async get() { return null; }, async set() {}, async del() {} },
  engine: 'plain', discoverMax: 100, follow: true, followDepth: 3, followUntil404: false, waitMs: 0,
});

test('discoverCandidates filters unsafe/non-article links, deduplicates normalized URLs, and scores structured data', () => {
  const html = `
    <a href="/2026/08/05/story?utm_source=news">A substantial headline about payment technology and markets</a>
    <a href="https://other.test/2026/08/05/nope">A substantial external headline that must be ignored</a>
    <a href="/category/payments">Payments category</a>
    <a href="/2026/08/05/story?ref=listing">duplicate tracking spelling</a>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"url":"/article/evergreen","headline":"An embedded article","datePublished":"2026-08-05"}]}</script>
    <script type="application/json">{"items":[{"url":"https://example.test/news/plain","title":"JSON article","publishedAt":"2026-08-04"}]}</script>`;
  const candidates = discoverCandidates(html, 'https://example.test/news', { max: 20 });
  assert.equal(new Set(candidates.map((c) => c.url)).size, candidates.length);
  assert.equal(candidates.filter((c) => c.url === 'https://example.test/2026/08/05/story').length, 1);
  assert.ok(candidates.some((c) => c.url === 'https://example.test/article/evergreen' && c.source === 'jsonld'));
  assert.ok(candidates.some((c) => c.url === 'https://example.test/news/plain' && c.source === 'json'));
  assert.ok(candidates.every((c) => !c.url.includes('other.test')));
  assert.equal(candidates.some((c) => c.url.includes('/category/')), false);
  assert.equal(detectMode(candidates), 'embedded-json');
});

test('discoverCandidates extracts listing dates and respects explicit mode/max', () => {
  const html = '<a href="/reports/alpha">10 August 2026 — Latest payments report</a><a href="/reports/beta">Older report</a>';
  const candidates = discoverCandidates(html, 'https://example.test/reports', { mode: 'anchors', max: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].date, '2026-08-10');
  assert.equal(candidates[0].title, 'Latest payments report');
});

test('findFollowLinks follows only the next category-scoped listing page', () => {
  const html = `<a href="?page=0">Previous</a><a href="?page=2">Next</a><a href="?page=3">Last</a>
    <a href="/digital-assets/2026/08/05/story">Next article</a>
    <a href="/other/news?page=2">Other category news</a>
    <a href="/digital-assets/archive">Archive</a>`;
  const links = findFollowLinks(html, 'https://example.test/digital-assets?page=1');
  assert.deepEqual(links.map((l) => l.url), [
    'https://example.test/digital-assets?page=2',
    'https://example.test/digital-assets/archive',
  ]);
});

test('Google Alerts parser unwraps redirect URLs, decodes title markup/entities, sorts and caps feeds', async () => {
  const xml = `<?xml version="1.0"?><feed>
    <entry><title>OCC &lt;b&gt;Stablecoin&lt;/b&gt; &#39;Update&#39; — 市場</title><link href="https://www.google.com/url?rct=j&amp;url=https%3A%2F%2Fnews.example%2Fnew%3Fa%3D1"/><published>2026-08-06T10:00:00Z</published></entry>
    <entry><title>Older</title><link href="https://news.example/old"/><published>2026-08-05T10:00:00Z</published></entry>
    <entry><title>Bad URL</title><link href="javascript:alert(1)"/><published>2026-08-07T10:00:00Z</published></entry>
  </feed>`;
  const parsed = parseGoogleAlertsFeed(xml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://news.example/new?a=1');
  assert.equal(parsed[0].hintTitle, "OCC Stablecoin 'Update' — 市場");

  let requested = '';
  const backends = { plain: { async fetch(url: string) { requested = url; return xml; } } } as unknown as Backends;
  const discovered = await discoverGoogle({ ...ctx({ extract: { max: 1 } }), discoverMax: 1 }, backends, { section: 'alerts', indexUrl: 'https://alerts.test/feed' });
  assert.equal(requested, 'https://alerts.test/feed');
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].url, 'https://news.example/new?a=1');
});
