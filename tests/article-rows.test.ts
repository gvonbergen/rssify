import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { insertItem, type Db } from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedSite } from '../test/helpers.ts';

/** Run a row-markup scenario with a seeded site on a temp store,
 *  then fetch BOTH list surfaces (main index and dedicated feed page). */
async function withRows(
  setup: (db: Db, dir: string) => Promise<void>,
  run: (db: Db, config: AppConfig, pages: { root: string; feed: string }) => Promise<void>,
): Promise<void> {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    await setup(db, dir);
    const app = createApp(db, config);
    const pages = {
      root: await (await app.request('http://internal.test/')).text(),
      feed: await (await app.request('http://internal.test/feed/example/articles')).text(),
    };
    await run(db, config, pages);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
}

async function writeSidecar(dir: string, hash: string, sidecar: Record<string, unknown>): Promise<void> {
  const siteDir = join(dir, 'data', 'example');
  await mkdir(siteDir, { recursive: true });
  await writeFile(join(siteDir, `${hash}.llm.json`), JSON.stringify(sidecar), 'utf8');
}

test('article rows are Title → cleaned · LLMextraction(only with sidecar) · original on both list surfaces', async () => {
  await withRows(
    async (db, dir) => {
      insertItem(db, itemRow('example', 'hash-1', join(dir, '1.html')));
      await writeSidecar(dir, 'hash-1', {
        url: 'https://canonical.example/p/1',
        title: 'LLM Heading',
        html: '<p>LLM body</p>',
        model: 'm',
      });
      // No sidecar → row renders Title → cleaned · cleaned · original (title
      // still opens the cleaned view, no LLM slot).
      insertItem(db, itemRow('example', 'hash-2', join(dir, '2.html')));
    },
    async (_db, _config, { root, feed }) => {
      for (const html of [root, feed]) {
        const surface = html === root ? 'index' : 'feed page';
        // The title ALWAYS opens the stored cleaned view — with a sidecar …
        assert.match(html, /<a class="title" href="\/example\/item\/hash-1">Article hash-1<\/a>/, surface);
        // …and without one. Never /llm, never the external site, and never
        // plain text (the anchor is always present).
        assert.match(html, /<a class="title" href="\/example\/item\/hash-2">Article hash-2<\/a>/, surface);
        assert.doesNotMatch(html, /<a class="title" href="[^"]*\/llm">/, surface);
        assert.doesNotMatch(html, /<a class="title" href="https?:/, surface);
        // Title links are internal: no target/_blank, no rel=noopener.
        assert.doesNotMatch(html, /class="title" href="[^"]*"[^>]*target=/, surface);
        // cleaned keeps opening the stored cleaned view.
        assert.match(html, /<a class="cleaned" href="\/example\/item\/hash-1">cleaned<\/a>/, surface);
        assert.match(html, /<a class="cleaned" href="\/example\/item\/hash-2">cleaned<\/a>/, surface);
        // The LLM extraction view stays reachable through its own secondary
        // slot — present only when a sidecar is stored, internal no-target.
        assert.match(html, /<a class="llm" href="\/example\/item\/hash-1\/llm">LLMextraction<\/a>/, surface);
        // …and only then: no LLM slot for the sidecar-less article.
        assert.doesNotMatch(html, /<a class="llm" href="\/example\/item\/hash-2\/llm">/, surface);
        // original opens the canonical external scraped-source URL: the
        // sidecar's canonical pick when present, the stored source URL
        // otherwise (mirroring the LLM page / feed resolution) — unchanged.
        assert.match(
          html,
          /<a class="original" href="https:\/\/canonical\.example\/p\/1" target="_blank" rel="noopener">original<\/a>/,
          surface,
        );
        assert.match(
          html,
          /<a class="original" href="https:\/\/example\.test\/news\/hash-2" target="_blank" rel="noopener">original<\/a>/,
          surface,
        );
        // Visible order: Title · cleaned · [LLMextraction] · original.
        assert.match(
          html,
          /<a class="title" href="\/example\/item\/hash-1">Article hash-1<\/a>\s*<span class="muted">· <a class="cleaned" href="\/example\/item\/hash-1">cleaned<\/a><\/span><span class="muted">· <a class="llm" href="\/example\/item\/hash-1\/llm">LLMextraction<\/a><\/span><span class="muted">· <a class="original"[^>]*>original<\/a><\/span>/,
          surface,
        );
        assert.match(
          html,
          /<a class="title" href="\/example\/item\/hash-2">Article hash-2<\/a>\s*<span class="muted">· <a class="cleaned" href="\/example\/item\/hash-2">cleaned<\/a><\/span><span class="muted">· <a class="original"[^>]*>original<\/a><\/span>/,
          surface,
        );
      }
    },
  );
});

test('rows fall back deterministically when the LLM sidecar or source URL is unavailable', async () => {
  // Corrupt sidecar file → treated as no sidecar (readLlmSidecar failure
  // resolves to null); empty stored source URL → the original link is
  // omitted (never a dead link). The title still always opens the cleaned
  // view either way.
  await withRows(
    async (db, dir) => {
      insertItem(db, itemRow('example', 'corrupt', join(dir, 'corrupt.html')));
      const siteDir = join(dir, 'data', 'example');
      await mkdir(siteDir, { recursive: true });
      await writeFile(join(siteDir, 'corrupt.llm.json'), '{not-json', 'utf8');
      const sourceless = itemRow('example', 'sourceless', join(dir, 'sourceless.html'));
      sourceless.url = '';
      insertItem(db, sourceless);
    },
    async (_db, _config, { root, feed }) => {
      for (const html of [root, feed]) {
        const surface = html === root ? 'index' : 'feed page';
        // Corrupt sidecar behaves like a missing one: no LLM slot, and the
        // title still opens the cleaned view (never the external URL).
        assert.match(
          html,
          /<a class="title" href="\/example\/item\/corrupt">Article corrupt<\/a>\s*<span class="muted">· <a class="cleaned" href="\/example\/item\/corrupt">cleaned<\/a><\/span><span class="muted">· <a class="original"[^>]*>original<\/a><\/span>/,
          surface,
        );
        assert.doesNotMatch(html, /href="\/example\/item\/corrupt\/llm"/, surface);
        assert.doesNotMatch(html, /<a class="title" href="https?:/, surface);
        // No source URL and no sidecar → title opens the cleaned view, no
        // dead original link, and no dead LLM slot follow that row (the row
        // ends after the cleaned link). The corrupt row keeps its legitimate
        // original link, so this must be scoped to the sourceless row only.
        assert.match(
          html,
          /<a class="title" href="\/example\/item\/sourceless">Article sourceless<\/a>\s*<span class="muted">· <a class="cleaned" href="\/example\/item\/sourceless">cleaned<\/a><\/span>\s*<\/li>/,
          surface,
        );
        assert.match(html, /<a class="cleaned" href="\/example\/item\/sourceless">cleaned<\/a>/, surface);
      }
    },
  );
});

test('row links and labels HTML-escape titles, hashes, and URLs on both list surfaces', async () => {
  await withRows(
    async (db, dir) => {
      const tricky = itemRow('example', 'tricky', join(dir, 'tricky.html'));
      tricky.title = `He said "a & <b>bold</b>"`;
      tricky.url = 'https://example.test/news/a?x=1&y=2&z=<t>';
      insertItem(db, tricky);
      // Sidecar canonical URL with query separators that need escaping.
      await writeSidecar(dir, 'tricky', { url: 'https://canonical.example/p?q=1&r=2&s=<t>' });
    },
    async (_db, _config, { root, feed }) => {
      for (const html of [root, feed]) {
        const surface = html === root ? 'index' : 'feed page';
        // Text node: escaped once (the response body carries the entities);
        // the title anchor is still there (escaped text, not a dead/plain
        // rendering) and still points at the cleaned view.
        assert.match(html, /He said &quot;a &amp; &lt;b&gt;bold&lt;\/b&gt;&quot;/, surface);
        assert.match(html, /<a class="title" href="\/example\/item\/tricky">He said &quot;a &amp; &lt;b&gt;bold&lt;\/b&gt;&quot;<\/a>/, surface);
        // hrefs with query strings: & → &amp; (entities survive Hono's
        // output) — the external original link is unchanged.
        assert.match(html, /<a class="original" href="https:\/\/canonical\.example\/p\?q=1&amp;r=2&amp;s=&lt;t&gt;" target="_blank" rel="noopener">original<\/a>/, surface);
        // The LLM slot's href is built from the percent-encoded internal
        // item path (here: no escaping needed for a plain hash), no target.
        assert.match(html, /<a class="llm" href="\/example\/item\/tricky\/llm">LLMextraction<\/a>/, surface);
        // No title link points outside the cleaned view, and none is dead.
        assert.doesNotMatch(html, /<a class="title" href="https?:/, surface);
        assert.match(html, /<a class="title" href="\/example\/item\/tricky">/, surface);
      }
    },
  );
});