import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, injectArticleCss } from '../src/server.ts';
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

test('cleaned and LLM article pages constrain oversized article images to the reading column', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    // Faithful to the real reproduction: article artwork is a 1920px-wide PNG
    // with no width/height attributes, which previously rendered at natural
    // size and overflowed the 50rem reading column (and the viewport).
    const llmDir = join(dir, 'data', 'example');
    await mkdir(llmDir, { recursive: true });
    await writeFile(
      join(llmDir, 'hash-1.llm.json'),
      JSON.stringify({
        title: 'Wide image article',
        html: '<p><img src="https://images.cryptorank.io/articles/wide.png" fetchpriority="high" alt="artwork"></p>'
          + '<p><img src="https://cdn.test/inline.png" width="1920" height="1118" style="width:1920px;height:1118px;max-width:none"></p>'
          + '<p><img src="https://cdn.test/hostile.png" style=\'width:1920px !important;min-width:900px;aspect-ratio:16/9;border:2px solid #333\' alt="hostile"></p>'
          + '<p><img alt="a>b" class="art" src="https://cdn.test/gt.png" style="min-width:800px;height:500px !important;aspect-ratio:4/3"></p>'
          + '<p><img data-x=" style= " src="https://cdn.test/shielded.png" style="width:900px !important;aspect-ratio:1"></p>'
          + '<p><img src="https://cdn.test/decoy.png" style="background:url(\'a;width:10px\');border:1px;width:5px"></p>'
          // An unbalanced quote character inside the style value (ordinary
          // markup: an apostrophe in a font name or in an unquoted url())
          // must not shield the following hostile declarations.
          + '<p><img src="https://cdn.test/apos.png" style="font-family:O\'Reilly;width:1920px !important;aspect-ratio:3/2"></p>'
          + '<p><img src="https://cdn.test/urlapos.png" style="background:url(don\'t.png);width:1920px !important"></p>'
          + '<p>Article body text.</p>',
        url: 'https://example.test/news/a',
        publishedAt: null,
        model: 'test-model',
        extractedAt: 1_700_000_000_500,
      }),
      'utf8',
    );
    const contentPath = join(dir, 'hash-1.html');
    // Store article content shaped like the clean pipeline's full-document
    // serialization (the real stored files begin with <html><head><body>).
    // Includes a hostile inline !important width and an unrelated
    // aspect-ratio declaration to exercise the serve-time neutralizer.
    await writeFile(
      contentPath,
      '<html><head></head><body><article><p>Cleaned body</p>'
        + '<img src="https://cdn.test/hostile.png" style="width:1920px !important;min-width:900px;aspect-ratio:16/9" alt="hostile">'
        + '<img src="https://cdn.test/query.png?a>b" style="width:100vw !important;border:0">'
        + '<img data-x=" style= " src="https://cdn.test/shielded.png" style="width:900px !important;aspect-ratio:1">'
        + '<img src="https://cdn.test/decoy.png" style="background:url(\'a;width:10px\');border:1px;width:5px">'
        // Single-quoted style attributes carrying an unbalanced double quote
        // (raw `"` is legal inside single-quoted attribute values) followed
        // by hostile sizing declarations.
        + '<img src=\'https://cdn.test/dq.png\' style=\'font-family:O"Reilly;width:900px !important;height:5px\'>'
        + '<img src=\'https://cdn.test/squrl.png\' style=\'background:url(don"t.png);min-width:600px !important\'>'
        + '</article></body></html>',
      'utf8',
    );
    insertItem(db, itemRow('example', 'hash-1', contentPath));

    const app = createApp(db, config);
    const llm = await app.request('http://internal.test/example/item/hash-1/llm');
    assert.equal(llm.status, 200);
    const llmHtml = await llm.text();
    // Both imgs render inside the article; width/height attributes and
    // unrelated inline declarations stay verbatim but hostile inline sizing
    // declarations (which could outrank the reader constraint via !important
    // or clamp max-width via min-width) are stripped at the serve boundary,
    // so only the reader constraint controls image sizing.
    assert.match(llmHtml, /<article>/);
    assert.match(llmHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/inline\.png" width="1920" height="1118">/);
    assert.doesNotMatch(llmHtml, /width:1920px|min-width|max-width:none/);
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/hostile\.png" style="aspect-ratio:16\/9;border:2px solid #333" alt="hostile">/);
    // A raw '>' inside a quoted attribute value must not shield the style
    // attribute from the neutralizer.
    assert.match(llmHtml, /<img alt="a>b" class="art" src="https:\/\/cdn\.test\/gt\.png" style="aspect-ratio:4\/3">/);
    // A `style=` token inside an EARLIER attribute's quoted value must not be
    // mistaken for the style attribute (hostile !important width survives).
    assert.match(llmHtml, /<img data-x=" style= " src="https:\/\/cdn\.test\/shielded\.png" style="aspect-ratio:1">/);
    // Semicolons inside quoted url() values are not declaration separators:
    // width-like fragments there must never corrupt unrelated declarations.
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/decoy\.png" style="background:url\('a;width:10px'\);border:1px">/);
    // An unbalanced apostrophe in the style value must not poison the
    // declaration splitting: the hostile width that follows is still stripped
    // and the unrelated declarations stay byte-for-byte.
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/apos\.png" style="font-family:O'Reilly;aspect-ratio:3\/2">/);
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/urlapos\.png" style="background:url\(don't\.png\)">/);
    assert.doesNotMatch(llmHtml, /width:900px|width:5px/);
    assert.match(llmHtml, /article img\s*\{\s*max-width:\s*100%\s*!important;\s*height:\s*auto\s*!important;\s*\}/);

    const cleaned = await app.request('http://internal.test/example/item/hash-1');
    assert.equal(cleaned.status, 200);
    const cleanedHtml = await cleaned.text();
    // Stored cleaned documents also get the constraint injected into <head>
    // (selector covers the doc's readability wrapper divs) plus a viewport
    // meta for mobile, with the article markup kept verbatim.
    assert.match(cleanedHtml, /<head><meta name="viewport" content="width=device-width, initial-scale=1">\n<style>img \{\s*max-width:\s*100%\s*!important;\s*height:\s*auto\s*!important;\s*\}\s*<\/style>/);
    assert.match(cleanedHtml, /<article><p>Cleaned body<\/p>/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/hostile\.png" style="aspect-ratio:16\/9" alt="hostile">/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/query\.png\?a>b" style="border:0">/);
    assert.match(cleanedHtml, /<img data-x=" style= " src="https:\/\/cdn\.test\/shielded\.png" style="aspect-ratio:1">/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/decoy\.png" style="background:url\('a;width:10px'\);border:1px">/);
    // Same unbalanced-quote robustness on the cleaned route, including the
    // single-quoted attribute form where the unbalanced quote is a raw `"`.
    assert.match(cleanedHtml, /<img src='https:\/\/cdn\.test\/dq\.png' style='font-family:O"Reilly'>/);
    assert.match(cleanedHtml, /<img src='https:\/\/cdn\.test\/squrl\.png' style='background:url\(don"t\.png\)'>/);
    assert.doesNotMatch(cleanedHtml, /width:1920px|min-width|100vw|width:900px|width:5px/);

    // The constraint is scoped to rendered article pages: neither the RSS XML
    // nor the app chrome index pages carry the image style.
    const feed = await app.request('http://internal.test/example');
    const feedXml = await feed.text();
    assert.doesNotMatch(feedXml, /max-width:\s*100%\s*!important/);
    const root = await app.request('http://internal.test/');
    const rootHtml = await root.text();
    assert.doesNotMatch(rootHtml, /article img/);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('injectArticleCss places the reader constraint into any stored-content shape', () => {
  const style = /<style>img \{\s*max-width:\s*100%\s*!important;\s*height:\s*auto\s*!important;\s*\}\s*<\/style>/;
  // Full-document serialization (the clean pipeline's stored shape) → <head>,
  // with the viewport meta added once.
  const full = injectArticleCss('<html><head></head><body><p>Body</p></body></html>');
  assert.match(full, /<head><meta name="viewport" content="width=device-width, initial-scale=1">\s*<style>img \{/);
  // A document that already declares a viewport keeps its own meta.
  const viewed = injectArticleCss('<html><head><meta name="viewport" content="width=device-width"><style>s</style></head><body><p>Body</p></body></html>');
  assert.equal((viewed.match(/name=["']viewport["']/g) ?? []).length, 1);
  assert.match(viewed, /<style>img \{/);
  // Fragment with a body tag → right after <body>.
  const bodyFrag = injectArticleCss('<body><p>Body</p></body>');
  assert.ok(bodyFrag.startsWith('<body><style>img {'));
  // Bare fragment → prepended; browsers still apply it.
  const bare = injectArticleCss('<p>Body</p>');
  assert.match(bare, style);
  assert.ok(bare.endsWith('<p>Body</p>'));
  // <header> is never mistaken for <head>: a fragment-shaped doc starting
  // with a header element gets the style prepended, not nested inside it.
  const headerFrag = injectArticleCss('<header class="site"><p>Body</p></header>');
  assert.ok(headerFrag.startsWith('<style>img {'));
  assert.ok(headerFrag.endsWith('<header class="site"><p>Body</p></header>'));
  // A head tag with attributes still matches.
  const headAttrs = injectArticleCss('<html><head lang="en"></head><body></body></html>');
  assert.match(headAttrs, /<head lang="en"><meta name="viewport"/);
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
