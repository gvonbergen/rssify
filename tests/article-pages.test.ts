import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { insertItem, type Db } from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedSite } from '../test/helpers.ts';

/** Seed a site + one cleaned article (+ optional LLM sidecar), then return
 *  every rendered surface: main index, per-feed article history, the cleaned
 *  article view and the LLM extraction view. */
async function withPages(
  opts: { site?: string; cleanedDoc?: string; sidecar?: Record<string, unknown> | null } = {},
  run: (pages: { root: string; feed: string; cleaned: string; llm: string | null }, config: AppConfig) => Promise<void>,
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
    if (opts.sidecar !== null) {
      await writeFile(
        join(dir, 'data', site, 'hash-1.llm.json'),
        JSON.stringify(opts.sidecar ?? {
          url: 'https://canonical.example/p/1',
          title: 'LLM Heading',
          html: '<p>LLM body</p>',
          model: 'test-model',
        }),
        'utf8',
      );
    }
    const app = createApp(db, config);
    const cleanedRes = await app.request(`http://internal.test/${encodeURIComponent(site)}/item/hash-1`);
    const llmRes = await app.request(`http://internal.test/${encodeURIComponent(site)}/item/hash-1/llm`);
    const pages = {
      root: await (await app.request('http://internal.test/')).text(),
      feed: await (await app.request(`http://internal.test/feed/${encodeURIComponent(site)}/articles`)).text(),
      cleaned: await cleanedRes.text(),
      llm: llmRes.status === 200 ? await llmRes.text() : null,
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
  await withPages({}, async ({ cleaned, llm }) => {
    for (const [view, html] of [['cleaned', cleaned], ['llm', llm!]] as const) {
      const surface = `${view} view`;
      // The site name opens the canonical per-feed article history…
      assert.match(html, /<a href="\/feed\/example\/articles">← example<\/a>/, surface);
      // …and NOT the site's RSS XML response (`/<site>`), which an RSS reader
      // would open as a subscription.
      assert.doesNotMatch(html, /<p class="muted"><a href="\/example"[^>]*>/, surface);
    }
    // The feed's dedicated articles page keeps its explicitly labelled RSS
    // subscription link (that one is intentional); the breadcrumb fix must
    // not touch it.
    // (covered by the article-rows tests for row markup; here the two views
    // are what changed)
  });
});

test('breadcrumb site-name hrefs are URL-encoded for unsafe site names', async () => {
  await withPages({ site: 'glue & space' }, async ({ cleaned, llm }) => {
    const feedHref = '/feed/glue%20%26%20space/articles';
    const itemBase = '/glue%20%26%20space/item/hash-1';
    for (const html of [cleaned, llm!]) {
      // The feed-history link carries the percent-encoded site segment (a
      // literal `%` in a site name would otherwise be re-decoded by the
      // browser and 404 on the route).
      assert.match(html, new RegExp(`<a href="${feedHref}">← glue &amp; space</a>`));
      assert.doesNotMatch(html, /href="\/feed\/glue & space\/articles"/);
    }
    // The sibling item links are encoded the same way — the LLM view's
    // cleaned link and the cleaned view's LLMextraction link.
    assert.match(llm!, new RegExp(`<a href="${itemBase}">cleaned</a>`));
    assert.match(cleaned, new RegExp(`<a href="${itemBase}/llm">LLMextraction</a>`));
    assert.doesNotMatch(cleaned, /href="\/glue & space\/item/);
  });
  // A site name containing a literal `%` + hex digits must not be re-decoded
  // by the browser: every breadcrumb href round-trips through the routes.
  await withPages({ site: 'pct%20name' }, async ({ cleaned, llm }) => {
    const feedHref = '/feed/pct%2520name/articles';
    const itemBase = '/pct%2520name/item/hash-1';
    for (const html of [cleaned, llm!]) {
      assert.match(html, new RegExp(`<a href="${feedHref}">← pct%20name</a>`));
    }
    assert.match(cleaned, new RegExp(`<a href="${itemBase}/llm">LLMextraction</a>`));
    assert.match(llm!, new RegExp(`<a href="${itemBase}">cleaned</a>`));
  });
});

test('cleaned and LLM views share one page shell: byte-identical style blocks', async () => {
  await withPages({}, async ({ cleaned, llm }) => {
    assert.equal(styleBlock(cleaned), styleBlock(llm!));
    // Both views carry the mobile viewport and the article-image constraint.
    for (const html of [cleaned, llm!]) {
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
      assert.match(html, /article img \{\s*max-width: 100% !important;\s*height: auto !important;\s*\}/);
    }
  });
});

test('cleaned and LLM views keep distinct content, metadata and navigation state', async () => {
  await withPages({}, async ({ cleaned, llm }) => {
    // Content: each view renders only its own stored body.
    assert.match(cleaned, /<article><div id="readability-page-1"><p>Cleaned body<\/p><\/div><\/article>/);
    assert.match(llm!, /<article><p>LLM body<\/p><\/article>/);
    assert.doesNotMatch(cleaned, /LLM body/);
    assert.doesNotMatch(llm!, /Cleaned body/);
    // Titles: the LLM sidecar title wins on the LLM view only.
    assert.match(cleaned, /<title>Article hash-1 — cleaned<\/title>/);
    assert.match(llm!, /<title>LLM Heading — LLM extraction<\/title>/);
    // Navigation: the current view is plain text, the sibling view is a link.
    assert.match(cleaned, /· cleaned · <a href="\/example\/item\/hash-1\/llm">LLMextraction<\/a>/);
    assert.doesNotMatch(cleaned, /<a href="\/example\/item\/hash-1">cleaned<\/a>/);
    assert.match(llm!, /<a href="\/example\/item\/hash-1">cleaned<\/a> · LLMextraction/);
    assert.doesNotMatch(llm!, /<a href="\/example\/item\/hash-1\/llm">LLMextraction<\/a>/);
    // Metadata: the LLM view carries the extraction model, the cleaned view
    // does not (extraction data is not invented on the cleaned view).
    assert.match(llm!, /model: test-model/);
    assert.doesNotMatch(cleaned, /model:/);
  });
});

test('cleaned view degrades the LLM nav link when no sidecar is stored', async () => {
  await withPages({ sidecar: null }, async ({ cleaned }) => {
    // Without a stored extraction the LLM slot must not be a dead link.
    assert.match(cleaned, /· cleaned · LLMextraction</);
    assert.doesNotMatch(cleaned, /<a href="\/example\/item\/hash-1\/llm">/);
  });
});

test('hostile inline image sizing is neutralized on both article views', async () => {
  await withPages(
    {
      cleanedDoc:
        '<html><head></head><body><div id="readability-page-1">'
        + '<img src="https://cdn.test/hostile.png" style="width:1920px !important;min-width:900px;aspect-ratio:16/9" alt="hostile">'
        + '<img src="https://cdn.test/plain.png" width="1920" height="1118">'
        + '</div></body></html>',
      sidecar: {
        url: 'https://canonical.example/p/1',
        title: 'LLM Heading',
        html: '<img src="https://cdn.test/hostile.png" style="width:1920px !important;min-width:900px;aspect-ratio:16/9" alt="hostile">'
          + '<img src="https://cdn.test/plain.png" width="1920" height="1118">',
        model: 'test-model',
      },
    },
    async ({ cleaned, llm }) => {
      for (const html of [cleaned, llm!]) {
        // Sizing declarations are stripped; unrelated inline declarations and
        // width/height ATTRIBUTES (which lose to the reader constraint) stay.
        assert.match(html, /<img src="https:\/\/cdn\.test\/hostile\.png" style="aspect-ratio:16\/9" alt="hostile">/);
        assert.match(html, /<img src="https:\/\/cdn\.test\/plain\.png" width="1920" height="1118">/);
        assert.doesNotMatch(html, /width:1920px|min-width:900px/);
      }
    },
  );
});

test('main page, feed history page and both article views share one container contract', async () => {
  await withPages({}, async ({ root, feed, cleaned, llm }) => {
    const rules = [root, feed, cleaned, llm!].map(bodyRule);
    // One identical body geometry rule everywhere: same maximum width, same
    // gutters — the outer pages line up with the reading column.
    assert.ok(rules[0] && rules.every((r) => r === rules[0]), 'all pages must share the identical body rule');
    assert.match(rules[0]!, /max-width: 50rem/);
    assert.match(rules[0]!, /padding: 0 1rem/);
    // The former 60rem main-page width is gone everywhere.
    for (const html of [root, feed, cleaned, llm!]) assert.doesNotMatch(html, /60rem/);
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
    await writeFile(
      join(dir, 'data', 'example', 'hash-1.llm.json'),
      JSON.stringify({ url: 'https://canonical.example/p/1', title: 'LLM Heading', html: '<p>LLM body</p>', model: 'm' }),
      'utf8',
    );
    const app = createApp(db, config);
    const html = await (await app.request('http://internal.test/example/item/hash-1')).text();
    // Breadcrumb and sibling links are relative paths — they work unchanged
    // behind any configured public/base URL and never embed the public host.
    assert.match(html, /<a href="\/feed\/example\/articles">← example<\/a>/);
    assert.match(html, /<a href="\/example\/item\/hash-1\/llm">LLMextraction<\/a>/);
    assert.doesNotMatch(html, /feeds\.public\.test/);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});
