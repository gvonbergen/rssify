import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.ts';
import { DeleteArticleError, deleteStoredArticle } from '../src/delete-article.ts';
import {
  addItemSection,
  countItems,
  getItem,
  getSection,
  getSite,
  insertItem,
  insertSection,
  recentItems,
} from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, sectionRow, seedSite } from './helpers.ts';

const TARGET_HASH = '1111111111111111111111111111111111111111';
const SIBLING_HASH = '2222222222222222222222222222222222222222';

async function responseText(app: ReturnType<typeof createApp>, path: string): Promise<{ status: number; text: string }> {
  const response = await app.request(`http://rssify.test${path}`);
  return { status: response.status, text: await response.text() };
}

test('deleteStoredArticle removes one article from DB, feeds, routes, and only its own artifacts', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir, { feed_source: 'llm' });
  try {
    seedSite(db);
    insertSection(db, sectionRow('example', 'other'));
    const siteDir = join(config.storage.data_dir, 'example');
    await mkdir(siteDir, { recursive: true });

    const targetContent = join(siteDir, `${TARGET_HASH}.html`);
    const targetRaw = join(siteDir, `${TARGET_HASH}.raw.html`);
    const siblingContent = join(siteDir, `${SIBLING_HASH}.html`);
    insertItem(db, {
      ...itemRow('example', TARGET_HASH, targetContent),
      title: 'Delete me',
      raw_path: targetRaw,
    });
    insertItem(db, { ...itemRow('example', SIBLING_HASH, siblingContent), title: 'Keep me' });
    addItemSection(db, 'example', 'news', TARGET_HASH);
    addItemSection(db, 'example', 'other', TARGET_HASH);
    addItemSection(db, 'example', 'news', SIBLING_HASH);

    await Promise.all([
      writeFile(targetContent, '<article>target cleaned</article>'),
      writeFile(targetRaw, '<html>target raw</html>'),
      writeFile(join(siteDir, `${TARGET_HASH}.meta.json`), '{"author":"Target"}'),
      writeFile(join(siteDir, `${TARGET_HASH}.llm.json`), JSON.stringify({ title: 'Target LLM', html: '<p>target llm</p>' })),
      writeFile(siblingContent, '<article>sibling cleaned</article>'),
      writeFile(join(siteDir, `${SIBLING_HASH}.raw.html`), '<html>sibling raw</html>'),
      writeFile(join(siteDir, `${SIBLING_HASH}.meta.json`), '{"author":"Sibling"}'),
      writeFile(join(siteDir, `${SIBLING_HASH}.llm.json`), JSON.stringify({ title: 'Sibling LLM', html: '<p>sibling llm</p>' })),
      writeFile(join(siteDir, 'unrelated.txt'), 'keep this'),
    ]);

    const app = createApp(db, config, { feedLimit: 0 });
    assert.match((await responseText(app, '/example')).text, new RegExp(TARGET_HASH));
    assert.equal((await responseText(app, `/example/item/${TARGET_HASH}`)).status, 200);
    assert.equal((await responseText(app, `/example/item/${TARGET_HASH}/llm`)).status, 200);

    const result = deleteStoredArticle(db, config, 'example', TARGET_HASH);
    assert.deepEqual(result, {
      site: 'example',
      hash: TARGET_HASH,
      title: 'Delete me',
      url: `https://example.test/news/${TARGET_HASH}`,
    });

    assert.equal(getItem(db, 'example', TARGET_HASH), undefined);
    assert.equal(countItems(db, 'example'), 1);
    assert.deepEqual(recentItems(db, 'example', 'news', 10).map((item) => item.hash), [SIBLING_HASH]);
    assert.deepEqual(recentItems(db, 'example', 'other', 10), []);
    assert.ok(getSite(db, 'example'));
    assert.ok(getSection(db, 'example', 'news'));
    assert.ok(getSection(db, 'example', 'other'));

    for (const suffix of ['.html', '.raw.html', '.meta.json', '.llm.json']) {
      assert.equal(existsSync(join(siteDir, `${TARGET_HASH}${suffix}`)), false);
      assert.equal(existsSync(join(siteDir, `${SIBLING_HASH}${suffix}`)), true);
    }
    assert.equal(await readFile(join(siteDir, 'unrelated.txt'), 'utf8'), 'keep this');
    assert.equal(existsSync(siteDir), true);

    for (const path of ['/', '/feed/example/articles', '/example']) {
      const response = await responseText(app, path);
      assert.equal(response.status, 200);
      assert.doesNotMatch(response.text, new RegExp(TARGET_HASH));
      assert.match(response.text, new RegExp(SIBLING_HASH));
    }
    assert.equal((await responseText(app, `/example/item/${TARGET_HASH}`)).status, 404);
    assert.equal((await responseText(app, `/example/item/${TARGET_HASH}.html`)).status, 404);
    assert.equal((await responseText(app, `/example/item/${TARGET_HASH}/llm`)).status, 404);
    assert.equal((await responseText(app, `/example/item/${SIBLING_HASH}`)).status, 200);
    assert.equal((await responseText(app, `/example/item/${SIBLING_HASH}/llm`)).status, 200);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('deleteStoredArticle safely rejects malformed, traversal, unknown, and not-found identities', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const siteDir = join(config.storage.data_dir, 'example');
    await mkdir(siteDir, { recursive: true });
    const content = join(siteDir, `${TARGET_HASH}.html`);
    await writeFile(content, 'preserved');
    insertItem(db, itemRow('example', TARGET_HASH, content));
    addItemSection(db, 'example', 'news', TARGET_HASH);

    const badRequests: Array<[string, string, RegExp]> = [
      ['../example', TARGET_HASH, /invalid site identifier/],
      ['example', '../state.sqlite', /invalid article hash/],
      ['example', TARGET_HASH.slice(0, 12), /invalid article hash/],
      ['example', 'A'.repeat(40), /invalid article hash/],
      ['missing', TARGET_HASH, /unknown site/],
      ['example', 'f'.repeat(40), /not found/],
    ];
    for (const [site, hash, expected] of badRequests) {
      assert.throws(() => deleteStoredArticle(db, config, site, hash), expected);
      assert.ok(getItem(db, 'example', TARGET_HASH));
      assert.equal(await readFile(content, 'utf8'), 'preserved');
    }
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('deleteStoredArticle tolerates absent optional artifacts and refuses mismatched stored paths', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const siteDir = join(config.storage.data_dir, 'example');
    await mkdir(siteDir, { recursive: true });
    const expectedContent = join(siteDir, `${TARGET_HASH}.html`);
    insertItem(db, { ...itemRow('example', TARGET_HASH, expectedContent), raw_path: join(siteDir, `${TARGET_HASH}.raw.html`) });
    addItemSection(db, 'example', 'news', TARGET_HASH);
    assert.doesNotThrow(() => deleteStoredArticle(db, config, 'example', TARGET_HASH));
    assert.equal(getItem(db, 'example', TARGET_HASH), undefined);

    const outside = join(dir, 'outside.html');
    await writeFile(outside, 'outside');
    insertItem(db, itemRow('example', SIBLING_HASH, outside));
    assert.throws(
      () => deleteStoredArticle(db, config, 'example', SIBLING_HASH),
      (error: unknown) => error instanceof DeleteArticleError && /content_path does not match/.test(error.message),
    );
    assert.ok(getItem(db, 'example', SIBLING_HASH));
    assert.equal(await readFile(outside, 'utf8'), 'outside');
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('deleteStoredArticle refuses cleanly when the site data dir is unusable (no partial deletion)', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    const dataDir = config.storage.data_dir;
    await mkdir(dataDir, { recursive: true });
    // Replace the site's data directory with a regular file so staging fails with ENOTDIR.
    const sitePath = join(dataDir, 'example');
    await writeFile(sitePath, 'not a directory');
    insertItem(db, itemRow('example', TARGET_HASH, join(sitePath, `${TARGET_HASH}.html`)));
    addItemSection(db, 'example', 'news', TARGET_HASH);

    assert.throws(
      () => deleteStoredArticle(db, config, 'example', TARGET_HASH),
      (error: unknown) => error instanceof DeleteArticleError && /could not stage article artifacts/.test(error.message),
    );
    assert.ok(getItem(db, 'example', TARGET_HASH));
    assert.ok(getSite(db, 'example'));
    assert.ok(getSection(db, 'example', 'news'));
    assert.equal(await readFile(sitePath, 'utf8'), 'not a directory');
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});


test('CLI exposes unambiguous delete-article grammar and preserves legacy remove grammar', () => {
  const top = spawnSync(process.execPath, ['src/cli.ts', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /delete-article/);
  assert.match(top.stdout, /remove/);

  const targeted = spawnSync(process.execPath, ['src/cli.ts', 'delete-article', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(targeted.status, 0, targeted.stderr);
  assert.match(targeted.stdout, /Usage: rssify delete-article \[options\] <site> <hash>/);

  const legacy = spawnSync(process.execPath, ['src/cli.ts', 'remove', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /Usage: rssify remove \[options\] <site> \[section\]/);
  assert.match(legacy.stdout, /--purge/);
});
