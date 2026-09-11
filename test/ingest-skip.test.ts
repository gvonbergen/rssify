import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { persistArticle, runSiteScrape } from '../src/scraper.ts';
import { looksLikeJunkBody } from '../src/quality.ts';
import type { Backends } from '../src/contract.ts';
import { recentItems } from '../src/db.ts';
import type { Logger } from '../src/logger.ts';
import { makeTempDir, openTempDb, removeTempDir, seedSite } from './helpers.ts';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const FIXTURES = join(import.meta.dirname, 'fixtures');
const preferredSourcesFixture = () => readFileSync(join(FIXTURES, 'boilerplate-preferred-sources.html'), 'utf8');

const goodBody = (url: string, title = 'Good title'): string =>
  `<html><head><title>${title}</title></head><body><article><p>${'Real article body sentence. '.repeat(12)}</p></article></body></html>`;

// ---------------------------------------------------------------------------
// persistArticle: junk gate advances the cascade beyond the word-count rule
// ---------------------------------------------------------------------------

test('a junk body (subscription-offer wall) advances the cascade even though it is long', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/offer' };
    // FT-syndication shape: hundreds of words, zero article text — no word
    // count alone could catch this; the marker/structure gate must.
    const offerWall =
      'Subscribe to unlock this article. Choose a subscription plan that suits you. Already a subscriber? Sign in. '.repeat(10);
    const cascade = {
      engines: ['plain', 'camofox'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        return { url: cand.url, title: 'Recovered', html: goodBody(cand.url) };
      },
    };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: `<article><p>${offerWall}</p></article>` },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger, cascade, 0,
    );
    assert.deepEqual(refetched, ['camofox']);
    assert.equal(res.inserted, 1);
    const stored = recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, 'Recovered');
  } finally {
    await removeTempDir(dir);
  }
});

test('junk verdicts are exempt for picture items (caption + image cards stay)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const refetched: string[] = [];
    const cand = { url: 'https://www.example.test/news/photo' };
    const cascade = {
      engines: ['plain', 'camofox'],
      startIndex: 0,
      refetch: async (engine: string) => {
        refetched.push(engine);
        return { url: cand.url, title: 'x', html: goodBody(cand.url) };
      },
    };
    // A photo card whose caption contains a marker phrase stays a picture
    // item — never a reason to burn fallback-engine credits.
    const caption = '<img src="a.jpg"><p>short caption</p><p>Image</p><p>© REUTERS. All rights reserved.</p>';
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: caption },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger, cascade, 0,
    );
    assert.deepEqual(refetched, []);
    assert.equal(res.inserted, 1);
    assert.equal(res.pictureItem, true);
  } finally {
    await removeTempDir(dir);
  }
});

test('looksLikeJunkBody is exported and agrees with the persisted gate decisions', () => {
  assert.equal(looksLikeJunkBody('Javascript is required to see this page.').junk, true);
});

// ---------------------------------------------------------------------------
// persistArticle: blacklist re-check on the canonical URL
// ---------------------------------------------------------------------------

test('persistArticle refuses to store an article whose canonical URL is blacklisted', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const res = await persistArticle(
      db, config, 'example', 'news', { url: 'https://www.example.test/news/x' },
      { url: 'https://www.youtube.com/watch?v=abc', title: 'Junk', html: goodBody('https://www.youtube.com/watch?v=abc') },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger,
    );
    assert.equal(res.inserted, 0);
    assert.equal(res.blacklisted, true);
    assert.equal(recentItems(db, 'example', null, 10).length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// persistArticle: og:image hero recovery + boilerplate trimming integration
// ---------------------------------------------------------------------------

test('persistArticle injects the og:image hero when the cleaned article has no image', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const cand = { url: 'https://www.example.test/news/hero' };
    const html = `<html><head><meta property="og:image" content="https://cdn.example.test/hero.jpg"><title>t</title></head>
      <body><article><p>${'Real article body sentence. '.repeat(12)}</p></article></body></html>`;
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger,
    );
    assert.equal(res.inserted, 1);
    const stored = recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    const content = readFileSync(join(dir, 'data', 'example', `${stored[0].hash}.html`), 'utf8');
    assert.match(content, /<figure><img src="https:\/\/cdn\.example\.test\/hero\.jpg"><\/figure>/);
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle leaves articles that already carry an in-body image untouched', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const cand = { url: 'https://www.example.test/news/inbody' };
    const html = `<html><head><meta property="og:image" content="https://cdn.example.test/hero.jpg"><title>t</title></head>
      <body><article><img src="https://cdn.example.test/inline.jpg"><p>${'Real article body sentence. '.repeat(12)}</p></article></body></html>`;
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger,
    );
    assert.equal(res.inserted, 1);
    const stored = recentItems(db, 'example', null, 10);
    const content = readFileSync(join(dir, 'data', 'example', `${stored[0].hash}.html`), 'utf8');
    assert.doesNotMatch(content, /<figure>/);
    assert.match(content, /cdn\.example\.test\/inline\.jpg/);
  } finally {
    await removeTempDir(dir);
  }
});

test('persistArticle trims the recurring "Preferred Sources" boilerplate from the stored body', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const cand = { url: 'https://biggo.test/news/f129' };
    const res = await persistArticle(
      db, config, 'example', 'news', cand,
      { url: cand.url, title: '', html: preferredSourcesFixture() },
      { plain: { fetch: async () => { throw new Error("unused"); } } } as unknown as Backends,
      noopLogger,
    );
    assert.equal(res.inserted, 1);
    assert.equal(res.bodyGood, true);
    const stored = recentItems(db, 'example', null, 10);
    const content = readFileSync(join(dir, 'data', 'example', `${stored[0].hash}.html`), 'utf8');
    assert.doesNotMatch(content, /Preferred Sources/);
    assert.match(content, /private token sale/);
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: runSiteScrape skips blacklisted YouTube candidates BEFORE any
// fetch, while non-blacklisted candidates still follow the plain-first cascade.
// ---------------------------------------------------------------------------

const FAKE_MODULE = 'sites/fm-ingest-skip-fake.ts';
const FAKE_SOURCE = `import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SectionRef,
} from '../src/contract.ts';

export const site = 'skiptest';
export const attempts: string[] = [];

export async function discover(
  ctx: ScraperContext,
  backends: Backends,
  section: SectionRef,
): Promise<DiscoveredItem[]> {
  attempts.push('discover:' + ctx.engine);
  return [
    { url: 'https://www.youtube.com/watch?v=Ic9Pq7FuoPw', hintTitle: 'Playback error video' },
    { url: 'https://youtu.be/abc123', hintTitle: 'Short link video' },
    { url: 'https://skiptest.test/news/a1', hintTitle: 'A1' },
  ];
}

export async function parse(
  ctx: ScraperContext,
  backends: Backends,
  item: DiscoveredItem,
): Promise<Article> {
  attempts.push('parse:' + ctx.engine + ':' + item.url);
  if (ctx.engine === 'plain') {
    // Non-blacklisted candidate: plain returns a near-empty stub so the
    // cascade must advance to camofox (proving the cascade still runs).
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

test('runSiteScrape: blacklisted YouTube sources are skipped before fetching; the rest follow the cascade', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  await writeFile(FAKE_MODULE, FAKE_SOURCE, 'utf8');
  try {
    seedSite(db);
    db.prepare("UPDATE sites SET module_path='sites/fm-ingest-skip-fake.ts' WHERE site='example'").run();

    const res = await runSiteScrape(db, config, 'example');
    assert.equal(res?.status, 'ok');
    // Only the non-YouTube candidate was fetched (twice: plain stub → camofox
    // cascade advance) and stored.
    assert.equal(res?.newItems, 1);
    const fake = (await import(`../${FAKE_MODULE}`)) as { attempts: string[] };
    assert.deepEqual(fake.attempts, [
      'discover:firecrawl',
      'parse:plain:https://skiptest.test/news/a1',
      'parse:camofox:https://skiptest.test/news/a1',
    ]);
    const stored = recentItems(db, 'example', null, 10);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].url, 'https://skiptest.test/news/a1');
  } finally {
    await rm(FAKE_MODULE, { force: true });
    await removeTempDir(dir);
  }
});

test('runSiteScrape: an empty per-site urlBlacklist disables skipping (override semantics)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  const MODULE = 'sites/fm-ingest-skip-fake2.ts';
  await writeFile(MODULE, FAKE_SOURCE, 'utf8');
  try {
    seedSite(db);
    db.prepare("UPDATE sites SET module_path='sites/fm-ingest-skip-fake2.ts' WHERE site='example'").run();
    // Per-site override replaces the global list — empty array disables it,
    // so the YouTube candidate is fetched like any other.
    const row = JSON.parse((db.prepare('SELECT config_json FROM sites WHERE site=?').get('example') as { config_json: string }).config_json);
    row.extract = { ...(row.extract ?? {}), urlBlacklist: [] };
    db.prepare('UPDATE sites SET config_json=? WHERE site=?').run(JSON.stringify(row), 'example');

    const res = await runSiteScrape(db, config, 'example');
    assert.equal(res?.newItems, 3);
    const fake = (await import(`../${MODULE}`)) as { attempts: string[] };
    assert.ok(fake.attempts.some((a) => a.includes('youtube.com/watch')));
  } finally {
    await rm(MODULE, { force: true });
    await removeTempDir(dir);
  }
});

test('runSiteScrape: skip_url_patterns filter non-article destinations before fetching', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  const MODULE = 'sites/fm-ingest-skip-fake3.ts';
  await writeFile(MODULE, FAKE_SOURCE, 'utf8');
  try {
    seedSite(db);
    db.prepare("UPDATE sites SET module_path='sites/fm-ingest-skip-fake3.ts' WHERE site='example'").run();
    const row = JSON.parse((db.prepare('SELECT config_json FROM sites WHERE site=?').get('example') as { config_json: string }).config_json);
    row.extract = { ...(row.extract ?? {}), urlBlacklist: [], skipUrlPatterns: ['skiptest.test/news/*'] };
    db.prepare('UPDATE sites SET config_json=? WHERE site=?').run(JSON.stringify(row), 'example');

    const res = await runSiteScrape(db, config, 'example');
    // The YouTube entries stay (no blacklist), the pattern-filtered article
    // is never fetched; nothing new is stored.
    assert.equal(res?.newItems, 2);
    const fake = (await import(`../${MODULE}`)) as { attempts: string[] };
    assert.ok(fake.attempts.some((a) => a.includes('youtube.com/watch')));
    assert.ok(!fake.attempts.some((a) => a.includes('skiptest.test/news')));
  } finally {
    await rm(MODULE, { force: true });
    await removeTempDir(dir);
  }
});
