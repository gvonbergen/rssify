import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApp, DEFAULT_WEBSITE_ITEM_LIMIT, MAX_WEBSITE_ITEM_LIMIT, normalizeWebsiteItemLimit } from '../src/server.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { insertItem, insertSite, openDb, type Db } from '../src/db.ts';

function testConfig(dir: string, websiteLimit: unknown = DEFAULT_WEBSITE_ITEM_LIMIT): AppConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.storage.db_path = join(dir, 'state.sqlite');
  config.storage.data_dir = dir;
  const defaults = config.defaults as Record<string, unknown>;
  if (websiteLimit === undefined) delete defaults.website_item_limit;
  else defaults.website_item_limit = websiteLimit;
  return config;
}

async function withFixture<T>(
  itemCount: number,
  websiteLimit: unknown,
  fn: (db: Db, config: AppConfig) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'rssify-server-test-'));
  const config = testConfig(dir, websiteLimit);
  const db = openDb(config);
  try {
    insertSite(db, {
      site: 'example',
      url: 'https://example.test',
      title: 'Example',
      description: '',
      schedule: '0 * * * *',
      config_json: '{}',
      module_path: 'example.ts',
      private: 0,
      created_at: Date.now(),
    });
    for (let i = 1; i <= itemCount; i++) {
      insertItem(db, {
        site: 'example',
        hash: `hash-${i}`,
        url: `https://example.test/article-${i}`,
        title: `Article ${i}`,
        published_at: Date.now() - i,
        first_seen: Date.now() - i,
        content_path: join(dir, `${i}.html`),
        content_hash: null,
        raw_path: null,
      });
    }
    return await fn(db, config);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function responseText(db: Db, config: AppConfig, path: string): Promise<string> {
  const response = await createApp(db, config).fetch(new Request(`http://localhost${path}`));
  assert.equal(response.status, 200);
  return response.text();
}

function articleCount(html: string): number {
  return (html.match(/<li class="item">/g) ?? []).length;
}

/** Unescape the `&amp;` entities Hono's template writes into href attributes. */
function decodeHref(href: string): string {
  return href.replace(/&amp;/g, '&');
}

test('main index stays a concise overview limited to the configured count', async () => {
  await withFixture(12, undefined, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 10);
    // Legacy expansion query params on the index must no longer expand a feed:
    // the index is always the configured overview.
    const expanded = await responseText(db, config, '/?site=example&limit=50');
    assert.equal(articleCount(expanded), 10);
    assert.match(expanded, /<h1>RSSify — 1 feeds, 12 articles<\/h1>/);
  });
});

test('show-more link targets the dedicated feed route, not the main index', async () => {
  await withFixture(12, undefined, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.match(html, /Show more articles/);
    assert.match(html, /href="\/feed\/example\/articles\?limit=20"/);
    assert.doesNotMatch(html, /href="\/\?site=/);
  });
});

test('configured website_item_limit controls the index and the dedicated-page fallback', async () => {
  await withFixture(12, 3, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 3);
    assert.match(html, /href="\/feed\/example\/articles\?limit=6"/);
    // Without a limit param the dedicated page falls back to the configured value.
    const dedicated = await responseText(db, config, '/feed/example/articles');
    assert.equal(articleCount(dedicated), 3);
  });
});

test('show-more is absent when a feed fits its configured limit', async () => {
  await withFixture(10, 10, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 10);
    assert.doesNotMatch(html, /Show more articles/);
  });
});

test('dedicated feed page identifies the feed, paginates on its own route, and links back to the index', async () => {
  await withFixture(30, 10, async (db, config) => {
    const html = await responseText(db, config, '/feed/example/articles?limit=20');
    // Clearly identifies the feed.
    assert.match(html, /<title>Example — articles<\/title>/);
    assert.match(html, /<h1>Example <span class="muted">\(example\)<\/span><\/h1>/);
    assert.match(html, /<p class="meta muted">Example article history \(showing first 20 of 30\)<\/p>/);
    // Lists the requested number of articles.
    assert.equal(articleCount(html), 20);
    // Back-to-main navigation, with the RSS feed link alongside.
    assert.match(html, /<a href="\/" title="Back to the main RSSify index">← Back to all feeds<\/a>/);
    assert.match(html, /<a href="\/example" title="Subscribe via RSS">RSS feed<\/a>/);
    // Later pagination stays on the dedicated route (progressive bounded limit).
    const link = html.match(/<p class="show-more"><a href="([^"]+)">Show more articles<\/a>/);
    assert.ok(link, 'expected a show-more link on the dedicated page');
    assert.equal(decodeHref(link[1]), '/feed/example/articles?limit=40');
  });
});

test('dedicated feed page serves later pages via offset once the cap is reached', async () => {
  await withFixture(MAX_WEBSITE_ITEM_LIMIT + 5, 10, async (db, config) => {
    const first = await responseText(db, config, `/feed/example/articles?limit=${MAX_WEBSITE_ITEM_LIMIT}`);
    assert.equal(articleCount(first), MAX_WEBSITE_ITEM_LIMIT);
    const link = first.match(/<p class="show-more"><a href="([^"]+)">Show more articles<\/a>/);
    assert.equal(decodeHref(link![1]), `/feed/example/articles?limit=${MAX_WEBSITE_ITEM_LIMIT}&offset=${MAX_WEBSITE_ITEM_LIMIT}`);

    const second = await responseText(db, config, `/feed/example/articles?limit=${MAX_WEBSITE_ITEM_LIMIT}&offset=${MAX_WEBSITE_ITEM_LIMIT}`);
    assert.equal(articleCount(second), 5);
    assert.doesNotMatch(second, /Show more articles/);
    assert.match(second, /showing 1001–1005 of 1005/);
  });
});

test('invalid feed, limit, and offset inputs are handled safely on the dedicated page', async () => {
  await withFixture(12, 10, async (db, config) => {
    const app = createApp(db, config);
    // Unknown feed → 404, not a crash.
    const unknown = await app.request('http://localhost/feed/nope/articles');
    assert.equal(unknown.status, 404);
    const post = await app.request('http://localhost/feed/example/articles', { method: 'POST' });
    assert.equal(post.status, 405);
    // Invalid limits fall back to the configured limit.
    for (const requested of ['0', '-1', 'invalid', '']) {
      const html = await responseText(db, config, `/feed/example/articles?limit=${encodeURIComponent(requested)}`);
      assert.equal(articleCount(html), 10, `limit=${JSON.stringify(requested)} should fall back to the configured limit`);
    }
    // Invalid offsets fall back to 0.
    for (const requested of ['0', '-3', 'abc']) {
      const html = await responseText(db, config, `/feed/example/articles?limit=4&offset=${encodeURIComponent(requested)}`);
      assert.match(html, /showing first 4 of 12/);
    }
  });
  // Invalid configured limits fall back to the default on both routes.
  for (const configured of [undefined, null, 0, -1, 'invalid', Number.NaN]) {
    await withFixture(12, configured, async (db, config) => {
      assert.equal(articleCount(await responseText(db, config, '/')), 10);
      assert.equal(articleCount(await responseText(db, config, '/feed/example/articles')), 10);
    });
  }
});

test('excessively large limits are capped and remain paginable on the dedicated page', async () => {
  assert.equal(normalizeWebsiteItemLimit(999999), MAX_WEBSITE_ITEM_LIMIT);
  await withFixture(MAX_WEBSITE_ITEM_LIMIT + 5, 999999, async (db, config) => {
    const html = await responseText(db, config, '/feed/example/articles?limit=999999');
    assert.equal(articleCount(html), MAX_WEBSITE_ITEM_LIMIT);
    assert.match(html, /href="\/feed\/example\/articles\?limit=1000&amp;offset=1000"/);
  });
});

test('website limit does not change RSS item limits or output', async () => {
  await withFixture(12, 3, async (db, config) => {
    config.defaults.feed_item_limit = 2;
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 3);
    const rss = await responseText(db, config, '/example');
    assert.match(rss, /^<\?xml/);
    assert.equal((rss.match(/<item>/g) ?? []).length, 2);
    assert.match(rss, /<title>Example<\/title>/);
    // The dedicated route must not swallow the RSS feed route.
    assert.equal((await createApp(db, config).request('http://localhost/feed')).status, 404);
  });
});
