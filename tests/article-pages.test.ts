import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { insertItem, type Db } from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedSite } from '../test/helpers.ts';

/** Seed a site + one cleaned article, then return every rendered surface:
 *  main index, per-feed article history and the cleaned article view. */
async function withPages(
  opts: { site?: string; cleanedDoc?: string } = {},
  run: (pages: { root: string; feed: string; cleaned: string }, config: AppConfig) => Promise<void>,
): Promise<void> {
  const site = opts.site ?? 'example';
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db, site);
    const contentPath = join(dir, 'data', site, 'hash-1.html');
    await mkdir(join(dir, 'data', site), { recursive: true });
    await writeFile(
      contentPath,
      opts.cleanedDoc ?? '<html><head></head><body><div id="readability-page-1"><p>Cleaned body</p></div></body></html>',
      'utf8',
    );
    insertItem(db, itemRow(site, 'hash-1', contentPath));
    const app = createApp(db, config);
    const pages = {
      root: await (await app.request('http://internal.test/')).text(),
      feed: await (await app.request(`http://internal.test/feed/${encodeURIComponent(site)}/articles`)).text(),
      cleaned: await (await app.request(`http://internal.test/${encodeURIComponent(site)}/item/hash-1`)).text(),
    };
    await run(pages, config);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
}

const styleBlock = (html: string): string => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(m, 'page must carry a <style> block');
  return m[1];
};

const bodyRule = (html: string): string | undefined => /body \{[^}]*\}/.exec(html)?.[0];

test('breadcrumb site-name link targets the HTML article history, never the RSS XML endpoint', async () => {
  await withPages({}, async ({ cleaned }) => {
    // The site name opens the canonical per-feed article history…
    assert.match(cleaned, /<a href="\/feed\/example\/articles">← example<\/a>/);
    // …and NOT the site's RSS XML response (`/<site>`), which an RSS reader
    // would open as a subscription.
    assert.doesNotMatch(cleaned, /<p class="muted"><a href="\/example"[^>]*>/);
    // The current view is labelled as plain text at the end of the
    // breadcrumb; no sibling links remain (the LLM view was removed).
    assert.match(cleaned, /· cleaned</);
    assert.doesNotMatch(cleaned, /LLMextraction/);
  });
});

test('breadcrumb site-name hrefs are URL-encoded for unsafe site names', async () => {
  await withPages({ site: 'glue & space' }, async ({ cleaned }) => {
    const feedHref = '/feed/glue%20%26%20space/articles';
    assert.match(cleaned, new RegExp(`<a href="${feedHref}">← glue &amp; space</a>`));
    assert.doesNotMatch(cleaned, /href="\/feed\/glue & space\/articles"/);
    assert.doesNotMatch(cleaned, /href="\/glue & space\/item/);
  });
  // A site name containing a literal `%` + hex digits must not be re-decoded
  // by the browser: every breadcrumb href round-trips through the routes.
  await withPages({ site: 'pct%20name' }, async ({ cleaned }) => {
    const feedHref = '/feed/pct%2520name/articles';
    assert.match(cleaned, new RegExp(`<a href="${feedHref}">← pct%20name</a>`));
  });
});

test('article-row links percent-encode the site segment and round-trip on every route', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    const site = 'pct%20name';
    seedSite(db, site);
    const contentPath = join(dir, 'data', site, 'hash-1.html');
    await mkdir(join(dir, 'data', site), { recursive: true });
    await writeFile(contentPath, '<html><head></head><body><p>Cleaned body</p></body></html>', 'utf8');
    insertItem(db, itemRow(site, 'hash-1', contentPath));
    const app = createApp(db, config);
    // Every surface rendering articleItemHtml — the root overview and the
    // feed's article history — must carry the percent-encoded row links
    // (cleaned + title), exactly like the breadcrumb links. The title always
    // opens the cleaned view.
    const encodedClean = '/pct%2520name/item/hash-1';
    for (const pagePath of ['/', `/feed/${encodeURIComponent(site)}/articles`]) {
      const res = await app.request(`http://internal.test${pagePath}`);
      assert.equal(res.status, 200, pagePath);
      const html = await res.text();
      assert.match(html, new RegExp(`href="${encodedClean}">cleaned</a>`));
      assert.match(html, new RegExp(`class="title" href="${encodedClean}"`));
      // The raw (un-encoded) site segment must not appear in row hrefs — the
      // browser would re-decode the literal %20 and 404 on the route.
      assert.doesNotMatch(html, /href="\/pct%20name\/item\//);
    }
    // The exact href rendered above must round-trip: requesting it serves
    // the item route (200), never a 404.
    assert.equal((await app.request(`http://internal.test${encodedClean}`)).status, 200, encodedClean);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('the cleaned article view carries the mobile viewport and the article-image constraint', async () => {
  await withPages({}, async ({ cleaned }) => {
    assert.match(cleaned, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(cleaned, /article img \{\s*max-width: 100% !important;\s*height: auto !important;\s*\}/);
    // The stored cleaned markup renders verbatim inside <article>.
    assert.match(cleaned, /<article><div id="readability-page-1"><p>Cleaned body<\/p><\/div><\/article>/);
    assert.match(cleaned, /<title>Article hash-1 — cleaned<\/title>/);
  });
});

test('hostile inline image sizing is neutralized on the cleaned article view', async () => {
  await withPages(
    {
      cleanedDoc:
        '<html><head></head><body><div id="readability-page-1">'
        + '<img src="https://cdn.test/hostile.png" style="width:1920px !important;min-width:900px;aspect-ratio:16/9" alt="hostile">'
        + '<img src="https://cdn.test/plain.png" width="1920" height="1118">'
        + '</div></body></html>',
    },
    async ({ cleaned }) => {
      // Sizing declarations are stripped; unrelated inline declarations and
      // width/height ATTRIBUTES (which lose to the reader constraint) stay.
      assert.match(cleaned, /<img src="https:\/\/cdn\.test\/hostile\.png" style="aspect-ratio:16\/9" alt="hostile">/);
      assert.match(cleaned, /<img src="https:\/\/cdn\.test\/plain\.png" width="1920" height="1118">/);
      assert.doesNotMatch(cleaned, /width:1920px|min-width:900px/);
    },
  );
});

test('main page, feed history page and the article view share one container contract', async () => {
  await withPages({}, async ({ root, feed, cleaned }) => {
    const rules = [root, feed, cleaned].map(bodyRule);
    // One identical body geometry rule everywhere: same maximum width, same
    // gutters — the outer pages line up with the reading column.
    assert.ok(rules[0] && rules.every((r) => r === rules[0]), 'all pages must share the identical body rule');
    assert.match(rules[0]!, /max-width: 50rem/);
    assert.match(rules[0]!, /padding: 0 1rem/);
    // The former 60rem main-page width is gone everywhere.
    for (const html of [root, feed, cleaned]) assert.doesNotMatch(html, /60rem/);
  });
});

test('article view links stay root-relative behind a configured public base URL', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    config.server.public_url = 'https://feeds.public.test/base/';
    const contentPath = join(dir, 'data', 'example', 'hash-1.html');
    await mkdir(join(dir, 'data', 'example'), { recursive: true });
    await writeFile(contentPath, '<html><head></head><body><p>Cleaned body</p></body></html>', 'utf8');
    insertItem(db, itemRow('example', 'hash-1', contentPath));
    const app = createApp(db, config);
    const html = await (await app.request('http://internal.test/example/item/hash-1')).text();
    // Breadcrumb links are relative paths — they work unchanged behind any
    // configured public/base URL and never embed the public host.
    assert.match(html, /<a href="\/feed\/example\/articles">← example<\/a>/);
    assert.doesNotMatch(html, /feeds\.public\.test/);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});