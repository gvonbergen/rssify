import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { CONFIG_PATH, ENV_PATH } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { insertItem, type Db } from '../src/db.ts';
import { rfc822 } from '../src/util.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedSite } from '../test/helpers.ts';

/**
 * Regression fixture mirroring the production divergence: a site whose
 * feedSource is 'llm' with stored LLM sidecars (googlenews), whose
 * hallucinated `publishedAt` values used to override the RSS <pubDate> while
 * the HTML overview kept the database date — so feeds and overviews showed
 * the same articles at different dates/order.
 */
const FUTURE_SIDECAR_DATE = '2032-01-01T00:00:00Z';
const PAST_SIDECAR_DATE = '2009-09-09T09:09:09Z';

interface RssItem {
  hash: string;
  title: string;
  link: string;
  pubDate: number; // epoch ms from <pubDate>
}
function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const guid = /<guid isPermaLink="false">([^<]+)<\/guid>/.exec(m[1])?.[1] ?? '';
    const pubDate = /<pubDate>([^<]+)<\/pubDate>/.exec(m[1])?.[1] ?? '';
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? '';
    const link = /<link>([^<]+)<\/link>/.exec(m[1])?.[1] ?? '';
    items.push({ hash: guid, title, link, pubDate: Date.parse(pubDate) });
  }
  return items;
}

interface HtmlRow {
  hash: string;
  date: string; // verbatim <span class="date"> text
}
/** Extract the article rows of an HTML overview (main index or feed page).
 *  The hash comes from any \/example\/item\/<hash> link in the row: a
 *  sidecar-backed row carries it in the title href, and every row carries
 *  the cleaned link, so rows whose title points at an external URL are
 *  still identified. */
function parseHtmlOverview(html: string): HtmlRow[] {
  const rows: HtmlRow[] = [];
  const re = /<li class="item">([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const row = m[1];
    const date = /<span class="date">([^<]*)<\/span>/.exec(row)?.[1];
    const hash = row.match(/\/example\/item\/([^/"' >]+)/)?.[1];
    if (hash && date !== undefined) rows.push({ hash, date });
  }
  return rows;
}

/** Display date used by the HTML overview (server fmt; npm test pins TZ=UTC). */
const overviewDate = (epochMs: number): string =>
  new Date(epochMs).toLocaleString('en-GB', { timeZoneName: 'short' });

async function setupLlmSite(dir: string, db: Db): Promise<string> {
  seedSite(db);
  // Production path (googlenews): feedSource forced to 'llm' per-site.
  db.prepare('UPDATE sites SET config_json=? WHERE site=?').run(
    JSON.stringify({ extract: { feedSource: 'llm' } }),
    'example',
  );
  const siteDir = join(dir, 'data', 'example');
  await mkdir(siteDir, { recursive: true });
  return siteDir;
}

const writeSidecar = (siteDir: string, hash: string, sidecar: Record<string, unknown>): Promise<void> =>
  writeFile(join(siteDir, `${hash}.llm.json`), JSON.stringify(sidecar), 'utf8');

test('sidecar publishedAt never alters the feed date or order: feed and both overviews stay in sync', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    const siteDir = await setupLlmSite(dir, db);

    // Article with a stored sidecar whose extracted publishedAt is a
    // hallucinated FUTURE date (the googlenews reproduction).
    const future = itemRow('example', 'future-sidecar', join(dir, 'future-sidecar.html'));
    future.published_at = 1_700_000_000_000; // 2023-11-14T22:26:40Z
    future.first_seen = 1_700_000_000_000;
    insertItem(db, future);
    await writeSidecar(siteDir, 'future-sidecar', {
      title: 'LLM Future Title',
      url: 'https://llm.example/future',
      html: '<p>future body</p>',
      publishedAt: FUTURE_SIDECAR_DATE,
    });

    // A NEWER article whose sidecar carries a wildly stale date (2009): with
    // the old override this would rank it BELOW the future-sidecar item and
    // flip the visible order.
    const newer = itemRow('example', 'plain-newer', join(dir, 'newer.html'));
    newer.published_at = 2_000_000_000_000;
    newer.first_seen = 2_000_000_000_000;
    insertItem(db, newer);
    await writeSidecar(siteDir, 'plain-newer', {
      title: 'LLM Newer Title',
      url: 'https://llm.example/newer',
      text: 'newer body',
      publishedAt: PAST_SIDECAR_DATE,
    });

    const app = createApp(db, config);
    const rss = parseRss(await (await app.request('http://internal.test/example')).text());
    const root = parseHtmlOverview(await (await app.request('http://internal.test/')).text());
    const page = parseHtmlOverview(
      await (await app.request('http://internal.test/feed/example/articles')).text(),
    );

    // All three surfaces agree on the article list and its order: the sidecar
    // dates neither reordered the feed nor diverged it from the overviews.
    assert.deepEqual(rss.map((i) => i.hash), ['plain-newer', 'future-sidecar'], 'feed order');
    assert.deepEqual(root.map((i) => i.hash), ['plain-newer', 'future-sidecar'], 'index order');
    assert.deepEqual(page.map((i) => i.hash), ['plain-newer', 'future-sidecar'], 'feed-page order');

    // Feed dates come from the DB (published_at), never the sidecar.
    assert.equal(rss.find((i) => i.hash === 'future-sidecar')!.pubDate, future.published_at);
    assert.equal(rss.find((i) => i.hash === 'plain-newer')!.pubDate, newer.published_at);
    assert.notEqual(rss.find((i) => i.hash === 'future-sidecar')!.pubDate, Date.parse(FUTURE_SIDECAR_DATE));
    assert.notEqual(rss.find((i) => i.hash === 'plain-newer')!.pubDate, Date.parse(PAST_SIDECAR_DATE));

    // The HTML overviews show the very same DB date string.
    assert.equal(root.find((i) => i.hash === 'future-sidecar')!.date, overviewDate(future.published_at!));
    assert.equal(root.find((i) => i.hash === 'plain-newer')!.date, overviewDate(newer.published_at!));
    assert.equal(page.find((i) => i.hash === 'future-sidecar')!.date, overviewDate(future.published_at!));

    // Sidecar title/link overrides stay intact in the feed.
    assert.equal(rss.find((i) => i.hash === 'future-sidecar')!.title, 'LLM Future Title');
    assert.equal(rss.find((i) => i.hash === 'future-sidecar')!.link, 'https://llm.example/future');
    assert.equal(rss.find((i) => i.hash === 'plain-newer')!.title, 'LLM Newer Title');
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('a normal article (no sidecar) shows the same date on feed and both overviews', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
    config.defaults.feed_source = 'llm'; // no sidecars at all → tag fallback
    const normal = itemRow('example', 'plain', join(dir, 'plain.html'));
    normal.published_at = 1_750_000_000_000;
    normal.first_seen = 1_750_000_000_001;
    insertItem(db, normal);

    const app = createApp(db, config);
    const rss = parseRss(await (await app.request('http://internal.test/example')).text());
    const root = parseHtmlOverview(await (await app.request('http://internal.test/')).text());
    const page = parseHtmlOverview(
      await (await app.request('http://internal.test/feed/example/articles')).text(),
    );

    assert.equal(rss.length, 1);
    // Same instant everywhere: feed <pubDate> parses to the DB date, and both
    // overview surfaces display the identical date string derived from it.
    assert.equal(rss[0].pubDate, normal.published_at);
    assert.equal(rss[0].pubDate, Date.parse(rfc822(normal.published_at!)));
    assert.equal(root[0].date, overviewDate(normal.published_at!));
    assert.equal(page[0].date, overviewDate(normal.published_at!));
    // The two overview surfaces display byte-identical dates.
    assert.equal(root[0].date, page[0].date);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('undated items (published_at NULL) sink to the bottom on feed and overviews', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    const siteDir = await setupLlmSite(dir, db);

    const dated = itemRow('example', 'dated', join(dir, 'dated.html'));
    dated.published_at = 1_700_000_000_000;
    insertItem(db, dated);

    // Undated item whose first_seen is far fresher than every published_at
    // (would rank FIRST if ordering fell back to first_seen), plus a sidecar
    // that claims a plausible date (must not lift it either).
    const undated = itemRow('example', 'undated', join(dir, 'undated.html'));
    undated.published_at = null;
    undated.first_seen = 9_000_000_000_000;
    insertItem(db, undated);
    await writeSidecar(siteDir, 'undated', {
      title: 'LLM Undated',
      publishedAt: '2024-05-05T00:00:00Z',
      html: '<p>undated body</p>',
    });

    const app = createApp(db, config);
    const rss = parseRss(await (await app.request('http://internal.test/example')).text());
    const root = parseHtmlOverview(await (await app.request('http://internal.test/')).text());
    const page = parseHtmlOverview(
      await (await app.request('http://internal.test/feed/example/articles')).text(),
    );

    // Every surface keeps the undated item at the BOTTOM.
    assert.deepEqual(rss.map((i) => i.hash), ['dated', 'undated']);
    assert.deepEqual(root.map((i) => i.hash), ['dated', 'undated']);
    assert.deepEqual(page.map((i) => i.hash), ['dated', 'undated']);
    // Its feed date falls back to first_seen (never the sidecar date).
    assert.equal(rss.find((i) => i.hash === 'undated')!.pubDate, undated.first_seen);
    assert.notEqual(rss.find((i) => i.hash === 'undated')!.pubDate, Date.parse('2024-05-05T00:00:00Z'));
    // The overview derives the same instant from first_seen.
    assert.equal(root.find((i) => i.hash === 'undated')!.date, overviewDate(undated.first_seen));
    assert.equal(page.find((i) => i.hash === 'undated')!.date, overviewDate(undated.first_seen));
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

/** OpenAI-compatible mock that always answers with the future sidecar date. */
async function startMockLlm(publishedAt: string): Promise<{ port: number; close: () => Promise<void> }> {
  const reply = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'reprocess-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            title: 'LLM Future Reprocess Title',
            html: `<p>${'reproduced llm body '.repeat(30)}</p>`,
            url: 'https://example.test/news/reprocess-future',
            publishedAt,
          }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Promise((resolve, reject) => {
    const svc = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    svc.on('error', reject);
    svc.listen(0, '127.0.0.1', () => {
      const addr = svc.address();
      if (addr && typeof addr === 'object') {
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => svc.close(() => r())),
        });
      } else {
        reject(new Error('mock LLM server did not bind'));
      }
    });
  });
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

test('rssify reprocess never persists an LLM sidecar publishedAt into published_at', async () => {
  const dir = await makeTempDir();
  const llm = await startMockLlm(FUTURE_SIDECAR_DATE);
  try {
    // The CLI loads ROOT/config.yaml and ROOT/.env at fixed paths, so point
    // them at this isolated temp dir for the child process.
    await writeFile(
      CONFIG_PATH,
      YAML.stringify({
        ai: {
          base_url: `http://127.0.0.1:${llm.port}/v1`,
          api_key: 'test-key',
          model: 'reprocess-test',
        },
        storage: { data_dir: join(dir, 'data'), db_path: join(dir, 'state.sqlite') },
      }),
      'utf8',
    );
    const { db } = openTempDb(dir);
    await setupLlmSite(dir, db);
    const rawPath = join(dir, 'data', 'example', 'reprocess-future.raw.html');
    await writeFile(
      rawPath,
      '<html><body><article><h1>A reprocessed headline</h1>' +
        '<p>The article body that the tag path cleans.</p></article></body></html>',
      'utf8',
    );
    const item = itemRow('example', 'reprocess-future', join(dir, 'reprocess-future.html'));
    item.published_at = 1_700_000_000_000;
    item.first_seen = 1_700_000_000_000;
    item.raw_path = rawPath;
    insertItem(db, item);
    db.close();

    const run = await runCli(['src/cli.ts', 'reprocess', 'example']);
    assert.equal(run.status, 0, `${run.stderr} ${run.stdout}`);
    assert.match(run.stdout, /reprocess-future/);

    const reopened = openTempDb(dir);
    try {
      const row = reopened.db
        .prepare('SELECT * FROM items WHERE site=? AND hash=?')
        .get('example', 'reprocess-future') as { title: string; published_at: number | null };
      // The LLM branch really ran for the 'llm' feedSource (title override)…
      assert.equal(row.title, 'LLM Future Reprocess Title');
      // …but the hallucinated future publishedAt never reached published_at.
      assert.equal(row.published_at, item.published_at);
      assert.notEqual(row.published_at, Date.parse(FUTURE_SIDECAR_DATE));
    } finally {
      reopened.db.close();
    }
  } finally {
    await llm.close();
    for (const p of [CONFIG_PATH, ENV_PATH]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
    await removeTempDir(dir);
  }
});