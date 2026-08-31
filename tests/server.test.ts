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

test('HTML index defaults to ten articles and offers a bounded expansion', async () => {
  await withFixture(12, undefined, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 10);
    assert.match(html, /Show more articles/);
    assert.match(html, /href="\/\?site=example&amp;limit=20"/);
  });
});

test('configured website_item_limit controls HTML only', async () => {
  await withFixture(12, 3, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 3);
    assert.match(html, /href="\/\?site=example&amp;limit=6"/);
  });
});

test('show-more is absent when a feed fits its configured limit', async () => {
  await withFixture(10, 10, async (db, config) => {
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 10);
    assert.doesNotMatch(html, /Show more articles/);
  });
});

test('expanded feed view preserves site context and displays more articles', async () => {
  await withFixture(30, 10, async (db, config) => {
    const html = await responseText(db, config, '/?site=example&limit=20');
    assert.equal(articleCount(html), 20);
    assert.match(html, /Show more articles/);
    assert.match(html, /href="\/\?site=example&amp;limit=40"/);
  });
});

test('invalid configured and requested limits safely fall back', async () => {
  for (const configured of [undefined, null, 0, -1, 'invalid', Number.NaN]) {
    await withFixture(12, configured, async (db, config) => {
      assert.equal(articleCount(await responseText(db, config, '/')), 10);
    });
  }
  for (const requested of ['0', '-1', 'invalid', '']) {
    await withFixture(12, 3, async (db, config) => {
      assert.equal(articleCount(await responseText(db, config, `/?site=example&limit=${encodeURIComponent(requested)}`)), 3);
    });
  }
});

test('excessively large limits are capped and remain paginable', async () => {
  assert.equal(normalizeWebsiteItemLimit(999999), MAX_WEBSITE_ITEM_LIMIT);
  await withFixture(MAX_WEBSITE_ITEM_LIMIT + 5, 999999, async (db, config) => {
    const html = await responseText(db, config, '/?site=example&limit=999999');
    assert.equal(articleCount(html), MAX_WEBSITE_ITEM_LIMIT);
    assert.match(html, /site=example&amp;limit=1000&amp;offset=1000/);
  });
});

test('website limit does not change RSS item limits or output', async () => {
  await withFixture(12, 3, async (db, config) => {
    config.defaults.feed_item_limit = 2;
    const html = await responseText(db, config, '/');
    assert.equal(articleCount(html), 3);
    const rss = await responseText(db, config, '/example');
    assert.equal((rss.match(/<item>/g) ?? []).length, 2);
    assert.match(rss, /<title>Example<\/title>/);
  });
});
