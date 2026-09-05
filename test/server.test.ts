import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, neutralizeImgInlineSizing, storedBodyHtml } from '../src/server.ts';
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
          + '<p><img src="https://cdn.test/commented.png" style="width/*x*/:1200px !important;border:2px dotted red" alt="commented"></p>'
          + '<p><img src="https://cdn.test/commented-min.png" style="min-/*x*/width:700px;aspect-ratio:16/9" alt="commented-min"></p>'
          + '<p><img src="https://cdn.test/escaped.png" style="w\\69 dth:1920px !important;aspect-ratio:2/1" alt="escaped"></p>'
          + '<p><img src="https://cdn.test/logical.png" style="inline-size:1200px !important;min-block-size:500px" alt="logical"></p>'
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
        + '<img src="https://cdn.test/commented.png" style="width/*x*/:1200px !important;border:2px dotted red" alt="commented">'
        + '<img src="https://cdn.test/commented-min.png" style="min-/*x*/width:700px;aspect-ratio:16/9" alt="commented-min">'
        + '<img src="https://cdn.test/escaped-min.png" style="\\6d in-width:900px !important" alt="escaped-min">'
        + '<img src="https://cdn.test/logical.png" style="inline-size:1200px !important;min-block-size:500px" alt="logical">'
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
    // CSS comments spliced into sizing properties must not let the sizing
    // declaration slip past (browsers tokenize the comment away): both the
    // plain and min-width variants are removed, unrelated borders kept.
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/commented\.png" style="border:2px dotted red" alt="commented">/);
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/commented-min\.png" style="aspect-ratio:16\/9" alt="commented-min">/);
    // CSS escape sequences inside property names are decoded by the browser's
    // tokenizer (`\69 ` is `i`), so escape-camouflaged sizing must be
    // detected and removed just like comment-camouflaged sizing.
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/escaped\.png" style="aspect-ratio:2\/1" alt="escaped">/);
    // Logical sizing properties (inline-size/block-size, which map to
    // width/height in horizontal writing modes) are stripped too.
    assert.match(llmHtml, /<img src="https:\/\/cdn\.test\/logical\.png" alt="logical">/);
    assert.doesNotMatch(llmHtml, /1200px|700px|500px/);
    assert.match(llmHtml, /article img\s*\{\s*max-width:\s*100%\s*!important;\s*height:\s*auto\s*!important;\s*\}/);

    const cleaned = await app.request('http://internal.test/example/item/hash-1');
    assert.equal(cleaned.status, 200);
    const cleanedHtml = await cleaned.text();
    // The cleaned view renders through the shared article page shell: same
    // shell/typography/media constraints as the LLM view (asserted in
    // tests/article-pages.test.ts), with the stored cleaned markup kept
    // verbatim inside <article> and hostile inline sizing neutralized.
    assert.match(cleanedHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(cleanedHtml, /<article><p>Cleaned body<\/p>/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/hostile\.png" style="aspect-ratio:16\/9" alt="hostile">/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/query\.png\?a>b" style="border:0">/);
    assert.match(cleanedHtml, /<img data-x=" style= " src="https:\/\/cdn\.test\/shielded\.png" style="aspect-ratio:1">/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/decoy\.png" style="background:url\('a;width:10px'\);border:1px">/);
    // Same unbalanced-quote robustness on the cleaned route, including the
    // single-quoted attribute form where the unbalanced quote is a raw `"`.
    assert.match(cleanedHtml, /<img src='https:\/\/cdn\.test\/dq\.png' style='font-family:O"Reilly'>/);
    assert.match(cleanedHtml, /<img src='https:\/\/cdn\.test\/squrl\.png' style='background:url\(don"t\.png\)'>/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/commented\.png" style="border:2px dotted red" alt="commented">/);
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/commented-min\.png" style="aspect-ratio:16\/9" alt="commented-min">/);
    // Escape-camouflaged min-width (which clamps the reader constraint's
    // max-width) is removed on the cleaned route too.
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/escaped-min\.png" alt="escaped-min">/);
    // Logical sizing is removed on the cleaned route too.
    assert.match(cleanedHtml, /<img src="https:\/\/cdn\.test\/logical\.png" alt="logical">/);
    assert.doesNotMatch(cleanedHtml, /width:1920px|min-width|100vw|width:900px|width:5px|1200px|700px|500px/);

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

test('storedBodyHtml extracts the article body from any stored-content shape', () => {
  // Full-document serialization (the clean pipeline's stored shape) → the
  // verbatim <body> inner HTML; the empty <head> is dropped.
  const full = storedBodyHtml('<html><head></head><body><p>Body</p><img src="a.png"></body></html>');
  assert.equal(full, '<p>Body</p><img src="a.png">');
  // A body tag with attributes still matches.
  assert.equal(storedBodyHtml('<html><body class="doc"><p>Body</p></body></html>'), '<p>Body</p>');
  // Fragment with a body tag → the body inner HTML.
  assert.equal(storedBodyHtml('<body><p>Body</p></body>'), '<p>Body</p>');
  // Bare fragment → returned verbatim (the whole fragment IS the article).
  assert.equal(storedBodyHtml('<p>Body</p>'), '<p>Body</p>');
  // Unterminated body tag: everything after the open tag is the article.
  assert.equal(storedBodyHtml('<html><body><p>Body</p>'), '<p>Body</p>');
  // <header> is never mistaken for <body>.
  assert.equal(storedBodyHtml('<header class="site"><p>Body</p></header>'), '<header class="site"><p>Body</p></header>');
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
    // No image markup of any kind survives text-only mode (the shell's own
    // `article img` reader-constraint CSS is not an image element).
    assert.doesNotMatch(body, /<img|<picture|<figcaption|caption/);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('neutralizeImgInlineSizing strips comment-camouflaged sizing declarations only', () => {
  // A CSS comment spliced into a sizing property masks it from a naive
  // property-name match, but the browser tokenizes `width/*x*/:1920px` as
  // `width:1920px` — so the declaration must be detected on comment-stripped
  // text and removed, keeping unrelated declarations verbatim.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" alt="x" style="width/*x*/:1920px !important;border:1px solid">'),
    '<img src="a.png" alt="x" style="border:1px solid">',
  );
  // Comments spliced into composite properties are handled the same way.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="min-/*x*/width:700px;aspect-ratio:16/9">'),
    '<img src="a.png" style="aspect-ratio:16/9">',
  );
  // An unterminated comment swallows the rest of the declaration, mirroring
  // the browser's tokenizer.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="width:800px/*x">'),
    '<img src="a.png">',
  );
  // Comments are only stripped for matching: unrelated declarations keep
  // their exact text, comments included.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="color:red/*keep me*/;width:10px">'),
    '<img src="a.png" style="color:red/*keep me*/">',
  );
  // A comment inside a quoted string is string content, not a comment.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style=\'font-family:"A/*x*/B";width:9px\'>'),
    '<img src="a.png" style=\'font-family:"A/*x*/B"\'>',
  );
  // A comment inside a parenthesized group is preserved too.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="background:url(/*x*/img.png);width:8px">'),
    '<img src="a.png" style="background:url(/*x*/img.png)">',
  );
});

test('neutralizeImgInlineSizing strips escape-camouflaged sizing declarations only', () => {
  // A CSS escape inside a property name is decoded by the browser's
  // tokenizer (`\69 ` is `i`), so escape-encoded sizing properties must be
  // detected and removed, keeping unrelated declarations verbatim.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" alt="x" style="w\\69 dth:1920px !important;border:1px solid">'),
    '<img src="a.png" alt="x" style="border:1px solid">',
  );
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="\\77idth:800px;aspect-ratio:16/9">'),
    '<img src="a.png" style="aspect-ratio:16/9">',
  );
  // Escaped min-width clamps the reader constraint's max-width, so it must
  // be removed too; the style attribute drops entirely when empty.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="\\6d in-width:900px !important">'),
    '<img src="a.png">',
  );
  // Escapes combine with comment camouflage.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="\\77/*x*/idth:700px">'),
    '<img src="a.png">',
  );
  // Escapes are decoded for matching only: an unrelated declaration keeps
  // its verbatim text, escapes included.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="color:red;\\66 ont-family:x;width:10px">'),
    '<img src="a.png" style="color:red;\\66 ont-family:x">',
  );
  // An escaped colon makes the property unknown (the browser drops the
  // declaration) — never a sizing one, so it stays verbatim.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="w\\3A idth:1920px;color:red">'),
    '<img src="a.png" style="w\\3A idth:1920px;color:red">',
  );
});

test('neutralizeImgInlineSizing strips logical inline-size/block-size sizing declarations', () => {
  // inline-size maps to width (and block-size to height) in horizontal
  // writing modes, so hostile logical sizing must not survive either —
  // including their min-/max- variants, which clamp the reader constraint.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="inline-size:1920px !important;aspect-ratio:16/9">'),
    '<img src="a.png" style="aspect-ratio:16/9">',
  );
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="block-size:900px !important;border:0">'),
    '<img src="a.png" style="border:0">',
  );
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="min-inline-size:700px;max-inline-size:900px">'),
    '<img src="a.png">',
  );
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="min-block-size:600px;max-block-size:800px">'),
    '<img src="a.png">',
  );
  // Logical sizing combines with the other camouflage classes: comment and
  // escape forms are caught, unrelated declarations stay verbatim.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="i\\6e/*x*/line-size:900px !important;color:red">'),
    '<img src="a.png" style="color:red">',
  );
  // Unrelated logical-ish declarations are untouched.
  assert.equal(
    neutralizeImgInlineSizing('<img src="a.png" style="margin-inline-size:5px;width:10px">'),
    '<img src="a.png" style="margin-inline-size:5px">',
  );
});
