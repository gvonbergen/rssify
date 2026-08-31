import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { addItemSection, insertItem } from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedItemFile, seedSite } from './helpers.ts';

test('HTTP routes serve root, health, status, merged/section RSS, and item content from isolated state', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const first = await seedItemFile(db, dir, 'example', 'hash-1', '<article><p>First body</p><img src="https://cdn.test/a.png"></article>');
    const second = await seedItemFile(db, dir, 'example', 'hash-2', '<article><p>Second body</p></article>');
    insertItem(db, { ...itemRow('example', 'undated', join(dir, 'undated.html')), published_at: null, first_seen: second.first_seen + 10 });
    await writeFile(join(dir, 'undated.html'), '<p>Undated body</p>', 'utf8');
    addItemSection(db, 'example', 'news', first.hash);
    addItemSection(db, 'example', 'news', second.hash);
    addItemSection(db, 'example', 'news', 'undated');

    const app = createApp(db, config);
    const root = await app.request('http://internal.test/');
    assert.equal(root.status, 200);
    const rootBody = await root.text();
    assert.match(rootBody, /RSSify — 1 feeds, 3 articles/);
    assert.match(rootBody, /href="\/example"/);
    assert.match(rootBody, /hash-1/);

    const health = await app.request('http://internal.test/health');
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { status: string; time: number };
    assert.equal(healthBody.status, 'ok');
    assert.equal(typeof healthBody.time, 'number');

    const feed = await app.request('http://internal.test/example');
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type') ?? '', /^application\/rss\+xml/);
    const feedXml = await feed.text();
    assert.match(feedXml, /<title>example feed<\/title>/);
    assert.match(feedXml, /<item>/);
    assert.match(feedXml, /<guid isPermaLink="false">hash-1<\/guid>/);
    assert.match(feedXml, /href="http:\/\/internal\.test\/example"/);

    const alias = await app.request('http://internal.test/example.xml');
    assert.equal(alias.status, 200);
    assert.match(await alias.text(), /<rss version="2.0"/);

    const section = await app.request('http://internal.test/example/news.xml');
    assert.equal(section.status, 200);
    assert.match(await section.text(), /<title>example feed - news section<\/title>/);

    const status = await app.request('http://internal.test/example/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      site: 'example', url: 'https://example.test/news', schedule: '*/5 * * * *',
      last_scrape_at: null, last_scrape_status: null, last_error: null,
      sections: 1, items: 3, per_section: { news: { indexUrl: 'https://example.test/news', count: 3 } },
    });

    const item = await app.request('http://internal.test/example/item/hash-1.html');
    assert.equal(item.status, 200);
    assert.match(await item.text(), /First body/);
    const missingContent = await app.request('http://internal.test/example/item/no-such.html');
    assert.equal(missingContent.status, 404);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('HTTP routing rejects unknown paths/methods and applies feed limits and public URL self-links', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    await seedItemFile(db, dir, 'example', 'a', '<p>A</p>');
    addItemSection(db, 'example', 'news', 'a');
    const newer = itemRow('example', 'b', join(dir, 'b.html'));
    newer.published_at = 1_800_000_000_000;
    await writeFile(newer.content_path, '<p>B</p>', 'utf8');
    insertItem(db, newer);
    addItemSection(db, 'example', 'news', 'b');
    config.server.public_url = 'https://feeds.public.test/base/';
    const app = createApp(db, config, { feedLimit: 1 });

    const feed = await app.request('http://internal.test/example?x=1');
    const xml = await feed.text();
    assert.equal((xml.match(/<item>/g) ?? []).length, 1);
    assert.match(xml, /href="https:\/\/feeds\.public\.test\/base\/example\?x=1"/);
    assert.match(xml, /<guid isPermaLink="false">b<\/guid>/);

    assert.equal((await app.request('http://internal.test/nope')).status, 404);
    assert.equal((await app.request('http://internal.test/example/nope')).status, 404);
    assert.equal((await app.request('http://internal.test/example/item')).status, 404);
    assert.equal((await app.request('http://internal.test/example/item/b/extra')).status, 404);
    const post = await app.request('http://internal.test/health', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(await post.text(), 'method not allowed');
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('HTTP item route honors per-site ignore_images setting', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const path = join(dir, 'article.html');
    await writeFile(path, '<p>Text</p><figure><img src="https://cdn.test/image.jpg"><figcaption>caption</figcaption></figure>', 'utf8');
    const row = itemRow('example', 'images', path);
    insertItem(db, row);
    addItemSection(db, 'example', 'news', row.hash);
    db.prepare('UPDATE sites SET config_json=? WHERE site=?').run(JSON.stringify({ ignore_images: true }), 'example');
    const response = await createApp(db, config).request('http://internal.test/example/item/images');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Text/);
    assert.doesNotMatch(body, /img|caption/);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});
