import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanHtml, extractMetadata } from '../src/clean.ts';
import {
  looksBotGated,
  looksLikePictureItem,
  persistArticle,
  summarizeParseResults,
} from '../src/scraper.ts';
import type { Backends } from '../src/contract.ts';
import { recentItems } from '../src/db.ts';
import type { Logger } from '../src/logger.ts';
import { makeTempDir, openTempDb, removeTempDir, seedSite } from './helpers.ts';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

// Regression fixtures captured live during the 2026-09 extraction diagnostic:
// a Reuters Connect licensable photo card, a CryptoQuant quicktake (rendered
// DOM), a TradingView news page (plain HTML), and the real DataDome
// interstitial Reuters Connect serves to bots.
const FIXTURES = join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const rcFixture = () => readFixture('rc-fixture-raw.html');
const cqFixture = () => readFixture('cq-article.html');
const tvFixture = () => readFixture('tv-article.html');
const datadomeFixture = () => readFixture('rc-datadome.html');

const cleanFixture = (name: string, url: string) => {
  const cleaned = cleanHtml(readFixture(name), url);
  assert.ok(cleaned, `fixture ${name} should clean`);
  return cleaned;
};

test('DataDome interstitial is recognized by looksBotGated and takes the fallback path', () => {
  const dd = datadomeFixture();
  assert.ok(dd.length >= 200);
  assert.equal(looksBotGated(dd), true);
  // The interstitial yields no article — readability finds nothing, which is
  // exactly why the bot-gate fallback path must trigger.
  assert.equal(cleanHtml(dd, 'https://www.reutersconnect.com/item/x/y'), null);
  // The TradingView fixture carries no bot-gate markers at all.
  assert.equal(looksBotGated(tvFixture()), false);
  // The CryptoQuant rendered DOM embeds Cloudflare's challenge-platform script
  // and the archived Reuters Connect page the site's own js.datadome.co script
  // (both sites ARE bot-protected), so the raw marker check fires for them.
  // That is unreachable for cleanable pages: looksBotGated is only consulted
  // when cleaning FAILED, and both fixtures clean fine (asserted below and via
  // the never-invoked firecrawl mocks in the persistArticle tests).
  assert.equal(looksBotGated(cqFixture()), true);
  assert.equal(looksBotGated(rcFixture()), true);
  assert.ok(cleanHtml(cqFixture(), 'https://www.cryptoquant.com/quicktake/x'));
  assert.ok(cleanHtml(rcFixture(), 'https://www.reutersconnect.com/item/x/y'));
});

test('Reuters Connect picture-item page classifies as a picture item, not a weak article', () => {
  const cleaned = cleanFixture('rc-fixture-raw.html', 'https://www.reutersconnect.com/item/x/y');
  // Caption + IPTC scaffolding sits just above the legacy 200-char bodyGood
  // threshold — the classification, not the threshold, must catch it.
  assert.ok(cleaned.text.trim().length >= 200);
  assert.equal((cleaned.content.match(/<img\b/gi) ?? []).length >= 1, true);
  assert.equal(looksLikePictureItem(cleaned.content, cleaned.text), true);
});

test('looksLikePictureItem separation edges: images, collapse, scaffolding', () => {
  // No image → never a picture item, however short the text.
  assert.equal(looksLikePictureItem('<p>too short</p>', 'too short'), false);
  // Image + one substantial paragraph below 500 chars → a readable short
  // article (the CryptoQuant quicktake shape), NOT a picture item.
  const quicktake = 'x'.repeat(400);
  assert.equal(looksLikePictureItem(`<img src="a.jpg"><p>${quicktake}</p>`, quicktake), false);
  // Image + long substantial text → real article.
  const long = 'y'.repeat(600);
  assert.equal(looksLikePictureItem(`<img src="a.jpg"><p>${long}</p>`, long), false);
  // Image + caption fragments only → picture item.
  const caption = '<img src="a.jpg"><p>short caption</p><p>Image</p><p>Credit REUTERS</p>';
  assert.equal(looksLikePictureItem(caption, 'short caption Image Credit REUTERS'), true);
  // Empty inputs are never classified.
  assert.equal(looksLikePictureItem('', ''), false);
});

test('CryptoQuant quicktake: bodyGood despite single-paragraph collapse, correct title/date', () => {
  const url = 'https://www.cryptoquant.com/quicktake/example';
  const cleaned = cleanFixture('cq-article.html', url);
  // Readability collapses the div-structured quicktake into ONE paragraph —
  // pinned here so a paragraph-count-based quality rule never creeps in.
  assert.equal((cleaned.content.match(/<p>/gi) ?? []).length, 1);
  assert.equal(cleaned.text.trim().length >= 200, true);
  assert.equal(looksLikePictureItem(cleaned.content, cleaned.text), false);
  const meta = extractMetadata(cqFixture(), url);
  assert.equal(meta.title, 'Bitcoin’s Binance Stablecoin Ratio Nears 2026 High: A Warning Behind the Rally');
  assert.equal(meta.publishedAt, '2026-09-04T20:21:51.681Z');
});

test('persistArticle scores the CryptoQuant quicktake as a good text article — no bot-gate fallback', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  config.backends.firecrawl.api_key = 'test-key';
  try {
    seedSite(db);
    const scrapeCalls: string[] = [];
    const backends = {
      firecrawl: { async scrape(url: string) { scrapeCalls.push(url); return { html: '', metadata: {} }; } },
    } as unknown as Backends;
    const url = 'https://www.cryptoquant.com/quicktake/example';
    const res = await persistArticle(
      db, config, 'example', 'news', { url },
      { url, title: '', html: cqFixture() },
      backends, noopLogger,
    );
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, true);
    assert.equal(res.pictureItem, false);
    assert.equal(res.dateGood, true);
    // The embedded Cloudflare script must not reroute a cleanable page.
    assert.deepEqual(scrapeCalls, []);
    const stored = recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, 'Bitcoin’s Binance Stablecoin Ratio Nears 2026 High: A Warning Behind the Rally');
  } finally {
    await removeTempDir(dir);
  }
});

test('TradingView article extracts well through the plain pathway, correct title/date', () => {
  const url = 'https://www.tradingview.com/news/cryptobriefing:d0228aa05094b:0-example/';
  const cleaned = cleanFixture('tv-article.html', url);
  assert.equal(cleaned.text.trim().length >= 200, true);
  assert.equal(looksLikePictureItem(cleaned.content, cleaned.text), false);
  const meta = extractMetadata(tvFixture(), url);
  assert.equal(meta.title, 'Base ecosystem launches 25 new projects and integrations in August');
  assert.equal(meta.publishedAt, '2026-09-04T20:51:49+00:00');
});

test('persistArticle stores a picture item normally and flags it for the quality summary', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const scrapeCalls: string[] = [];
    const backends = {
      firecrawl: { async scrape(url: string) { scrapeCalls.push(url); return { html: '', metadata: {} }; } },
    } as unknown as Backends;
    const cand = { url: 'https://www.reutersconnect.com/item/x/y' };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: rcFixture() },
      backends, noopLogger,
    );
    // Inserted and stored like any feed item — but flagged, not scored.
    assert.equal(res.inserted, 1);
    assert.equal(res.pictureItem, true);
    // Cleaning succeeded, so the firecrawl fallback must never be invoked.
    assert.deepEqual(scrapeCalls, []);
    const stored = recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    // Canonical URL + metadata come from the page itself.
    assert.ok(stored[0].url.startsWith('https://www.reutersconnect.com/item/'));
    assert.equal(stored[0].title, '10th World Water Forum in Bali');
    assert.equal(res.dateGood, true);
    assert.equal(stored[0].published_at, Date.parse('2024-05-20T06:37:00.000Z'));
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle routes a DataDome interstitial to the firecrawl bot-gate fallback', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  config.backends.firecrawl.api_key = 'test-key';
  try {
    seedSite(db);
    const scrapeCalls: string[] = [];
    const longBody = `<p>${'Real article body sentence. '.repeat(12)}</p>`;
    const backends = {
      firecrawl: {
        async scrape(url: string) {
          scrapeCalls.push(url);
          return { html: longBody, metadata: {} };
        },
      },
    } as unknown as Backends;
    const cand = { url: 'https://www.reutersconnect.com/item/z/w' };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: 'Reuters item', html: datadomeFixture() },
      backends, noopLogger,
    );
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, true);
    assert.deepEqual(scrapeCalls, [cand.url]);
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle bot-gate fallback surfaces a distinct error when firecrawl yields nothing', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  config.backends.firecrawl.api_key = 'test-key';
  try {
    seedSite(db);
    const backends = {
      firecrawl: { async scrape() { return { html: '', metadata: {} }; } },
    } as unknown as Backends;
    const cand = { url: 'https://www.reutersconnect.com/item/z/w' };
    await assert.rejects(
      persistArticle(
        db, config, 'example', 'news', cand,
        { url: cand.url, title: 'Reuters item', html: datadomeFixture() },
        backends, noopLogger,
      ),
      /firecrawl fallback returned no html/,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('summarizeParseResults excludes picture items, duplicates, and paywalls from quality rates', () => {
  const quality = { parsed: 0, bodyGood: 0, dateGood: 0 };
  const summary = summarizeParseResults(
    [
      // A good text article.
      { ok: true, inserted: 1, bodyGood: true, dateGood: true, paywalled: false, picture: false },
      // A second good article with no parsed date.
      { ok: true, inserted: 1, bodyGood: true, dateGood: false, paywalled: false, picture: false },
      // A picture item: stored, but excluded from every quality tally.
      { ok: true, inserted: 1, bodyGood: true, dateGood: true, paywalled: false, picture: true },
      // Duplicate re-parse and paywall skip: never scored.
      { ok: true, inserted: 0, bodyGood: false, dateGood: false, paywalled: false, picture: false },
      { ok: true, inserted: 0, bodyGood: false, dateGood: false, paywalled: true, picture: false },
      // A hard failure: not scored either.
      { ok: false, inserted: 0, bodyGood: false, dateGood: false, paywalled: false, picture: false },
    ],
    quality,
  );
  assert.deepEqual(quality, { parsed: 2, bodyGood: 2, dateGood: 1 });
  assert.deepEqual(summary, { newItems: 3, paywalled: 1, pictures: 1 });
});
