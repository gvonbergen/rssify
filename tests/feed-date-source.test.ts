import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { CONFIG_PATH, ENV_PATH } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { insertItem, type Db } from '../src/db.ts';
import { rfc822 } from '../src/util.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, seedSite } from '../test/helpers.ts';

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

test('a normal article (no sidecar) shows the same date on feed and both overviews', async () => {
  const dir = await makeTempDir();
  const { db, config } = openTempDb(dir);
  try {
    seedSite(db);
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
    seedSite(db);

    const dated = itemRow('example', 'dated', join(dir, 'dated.html'));
    dated.published_at = 1_700_000_000_000;
    insertItem(db, dated);

    // Undated item whose first_seen is far fresher than every published_at
    // (would rank FIRST if ordering fell back to first_seen).
    const undated = itemRow('example', 'undated', join(dir, 'undated.html'));
    undated.published_at = null;
    undated.first_seen = 9_000_000_000_000;
    insertItem(db, undated);

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
    // Its feed date falls back to first_seen.
    assert.equal(rss.find((i) => i.hash === 'undated')!.pubDate, undated.first_seen);
    // The overview derives the same instant from first_seen.
    assert.equal(root.find((i) => i.hash === 'undated')!.date, overviewDate(undated.first_seen));
    assert.equal(page.find((i) => i.hash === 'undated')!.date, overviewDate(undated.first_seen));
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

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

test('reprocess never writes a future in-text page date into published_at', async () => {
  // Production reproduction (googlenews): the raw page carries NO structured
  // publish metadata, so extractMetadata's visible-text fallback grabs the
  // first "Month D, YYYY" string in the body — here a FUTURE in-text date
  // (a law's effective date / an event registration date). The old unguarded
  // reprocess write let Date.parse() of that string replace published_at,
  // bubbling the item to the top of feed and overview.
  const dir = await makeTempDir();
  // The CLI loads ROOT/config.yaml and ROOT/.env at fixed paths, so the test
  // temporarily points them at this isolated temp dir. Preserve whatever a
  // developer has there and put it back afterwards.
  const preserved = await Promise.all(
    [CONFIG_PATH, ENV_PATH].map(async (p) => ({
      path: p,
      existed: existsSync(p),
      original: existsSync(p) ? await readFile(p, 'utf8') : null,
    })),
  );
  try {
    // No AI extraction is configured anymore (subsystem removed); this
    // isolates the meta.publishedAt (page metadata) write path.
    await writeFile(
      CONFIG_PATH,
      YAML.stringify({
        storage: { data_dir: join(dir, 'data'), db_path: join(dir, 'state.sqlite') },
      }),
      'utf8',
    );
    const { db } = openTempDb(dir);
    const siteDir = join(dir, 'data', 'example');
    await mkdir(siteDir, { recursive: true });
    seedSite(db);

    const FUTURE_IN_TEXT = 'February 4, 2027'; // the FSC press-release date
    const discoveredAt = Date.parse('2026-09-04T10:00:00Z'); // sane discovery date

    // Item whose raw page mentions only a FUTURE in-text date.
    const futureRawPath = join(siteDir, 'future-in-text.raw.html');
    await writeFile(
      futureRawPath,
      '<html><body><article><h1>Press release</h1>' +
        `<p>The act takes effect on ${FUTURE_IN_TEXT}.</p></article></body></html>`,
      'utf8',
    );
    const futureItem = itemRow('example', 'future-in-text', join(dir, 'future-in-text.html'));
    futureItem.published_at = discoveredAt - 3600_000;
    futureItem.first_seen = discoveredAt;
    futureItem.raw_path = futureRawPath;
    insertItem(db, futureItem);

    // Control: a page date slightly BEFORE discovery stays writable — the
    // guard must not freeze legitimate metadata improvements.
    const pastRawPath = join(siteDir, 'past-in-text.raw.html');
    await writeFile(
      pastRawPath,
      '<html><body><article><h1>Press release</h1>' +
        '<p>Published on September 3, 2026 by the newsroom.</p></article></body></html>',
      'utf8',
    );
    const pastItem = itemRow('example', 'past-in-text', join(dir, 'past-in-text.html'));
    pastItem.published_at = null; // no date yet; reprocess should supply it
    pastItem.first_seen = discoveredAt;
    pastItem.raw_path = pastRawPath;
    insertItem(db, pastItem);
    db.close();

    const run = await runCli(['src/cli.ts', 'reprocess', 'example']);
    assert.equal(run.status, 0, `${run.stderr} ${run.stdout}`);

    const reopened = openTempDb(dir);
    try {
      const rows = reopened.db
        .prepare('SELECT hash, published_at FROM items WHERE site=? AND hash IN (?,?)')
        .all('example', 'future-in-text', 'past-in-text') as { hash: string; published_at: number | null }[];
      const future = rows.find((r) => r.hash === 'future-in-text')!;
      const past = rows.find((r) => r.hash === 'past-in-text')!;
      // The future in-text date never reached published_at.
      assert.equal(future.published_at, discoveredAt - 3600_000);
      assert.notEqual(future.published_at, Date.parse(FUTURE_IN_TEXT));
      // A plausible past page date still lands (guard is narrow).
      assert.equal(past.published_at, Date.parse('September 3, 2026'));
    } finally {
      reopened.db.close();
    }
  } finally {
    for (const p of preserved) {
      if (p.existed && p.original !== null) await writeFile(p.path, p.original, 'utf8');
      else if (!p.existed) await rm(p.path, { force: true });
    }
    await removeTempDir(dir);
  }
});

test('reprocess heals an already-polluted future published_at back to first_seen and preserves RSS-derived dates', async () => {
  // Production state at deploy time (googlenews, PR #8 aftermath): the
  // affected items already carry a FUTURE published_at — the pre-fix reprocess
  // wrote an in-text page date (e.g. 'February 4, 2027') over the stored
  // value. For such a row the guard alone computes Date.parse(meta) === the
  // stored value and skips the UPDATE, so nothing would ever correct it; the
  // heal branch must reset it to first_seen. A near-first_seen date (what the
  // Google Alerts Atom <published> hint stores) is NOT pollution and must stay.
  const dir = await makeTempDir();
  const preserved = await Promise.all(
    [CONFIG_PATH, ENV_PATH].map(async (p) => ({
      path: p,
      existed: existsSync(p),
      original: existsSync(p) ? await readFile(p, 'utf8') : null,
    })),
  );
  try {
    await writeFile(
      CONFIG_PATH,
      YAML.stringify({
        storage: { data_dir: join(dir, 'data'), db_path: join(dir, 'state.sqlite') },
      }),
      'utf8',
    );
    const { db } = openTempDb(dir);
    const siteDir = join(dir, 'data', 'example');
    await mkdir(siteDir, { recursive: true });
    seedSite(db);

    const futureInText = 'February 4, 2027';
    const discoveredAt = Date.parse('2026-09-04T10:00:00Z');

    // The real polluted state: published_at is already IN THE FUTURE, and the
    // raw page's only date is another future in-text date.
    const pollutedRawPath = join(siteDir, 'polluted.raw.html');
    await writeFile(
      pollutedRawPath,
      '<html><body><article><h1>Press release</h1>' +
        `<p>The act takes effect on ${futureInText}.</p></article></body></html>`,
      'utf8',
    );
    const pollutedItem = itemRow('example', 'polluted', join(dir, 'polluted.html'));
    pollutedItem.published_at = Date.parse(futureInText);
    pollutedItem.first_seen = discoveredAt;
    pollutedItem.raw_path = pollutedRawPath;
    insertItem(db, pollutedItem);

    // Control: stored published_at is the sane Google Alerts RSS date (just
    // before discovery); the heal must leave it alone even though the raw page
    // again mentions only a future in-text date.
    const rssRawPath = join(siteDir, 'rss-date.raw.html');
    await writeFile(
      rssRawPath,
      '<html><body><article><h1>News</h1>' +
        `<p>An event is planned for ${futureInText}.</p></article></body></html>`,
      'utf8',
    );
    const rssItem = itemRow('example', 'rss-date', join(dir, 'rss-date.html'));
    rssItem.published_at = discoveredAt - 3600_000;
    rssItem.first_seen = discoveredAt;
    rssItem.raw_path = rssRawPath;
    insertItem(db, rssItem);
    db.close();

    const run = await runCli(['src/cli.ts', 'reprocess', 'example']);
    assert.equal(run.status, 0, `${run.stderr} ${run.stdout}`);

    const reopened = openTempDb(dir);
    try {
      const rows = reopened.db
        .prepare('SELECT hash, published_at, first_seen FROM items WHERE site=? AND hash IN (?,?)')
        .all('example', 'polluted', 'rss-date') as {
        hash: string;
        published_at: number | null;
        first_seen: number;
      }[];
      const polluted = rows.find((r) => r.hash === 'polluted')!;
      const rssDate = rows.find((r) => r.hash === 'rss-date')!;
      // The polluted future date is reset to first_seen.
      assert.equal(polluted.published_at, polluted.first_seen);
      assert.notEqual(polluted.published_at, Date.parse(futureInText));
      // The RSS/feed-derived date is preserved.
      assert.equal(rssDate.published_at, discoveredAt - 3600_000);
    } finally {
      reopened.db.close();
    }
  } finally {
    for (const p of preserved) {
      if (p.existed && p.original !== null) await writeFile(p.path, p.original, 'utf8');
      else if (!p.existed) await rm(p.path, { force: true });
    }
    await removeTempDir(dir);
  }
});
