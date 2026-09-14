import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { discoverCandidates } from '../src/extract/discover.ts';
import { persistArticle } from '../src/scraper.ts';
import { recentItems } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import type { Backends } from '../src/contract.ts';
import type { Logger } from '../src/logger.ts';
import { makeTempDir, openTempDb, removeTempDir, seedSite } from './helpers.ts';

test('scheme-less publisher links survive discovery, metadata persistence and article history', async () => {
  const href = 'www.assetservicingtimes.com/assetservicesnews/digitalassetsarticle.php?article_id=18324';
  const expected = `https://${href}`;
  const base = 'https://www.assetservicingtimes.com/assetservicesnews/';
  const evidence = process.env.RSSIFY_URL_EVIDENCE_DIR;
  const observations: unknown[] = [];
  for (const identity of ['canonical', 'og:url']) {
    const dir = await makeTempDir();
    const { db, config } = openTempDb(dir);
    try {
      seedSite(db);
      const candidates = discoverCandidates(`<a href=" \t${href}\n ">Nickel: Increased digital asset allocations hinge on improved security</a>`, base, { max: 10 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].url, expected);
      const tag = identity === 'canonical'
        ? `<link rel="canonical" href=" \t${href}\n ">`
        : `<meta property="og:url" content=" \t${href}\n ">`;
      const html = `<html><head><title>Digital asset security</title>${tag}</head><body><article><h1>Digital asset security</h1><p>${'Investors are evaluating digital asset security and custody arrangements before increasing allocations. '.repeat(12)}</p></article></body></html>`;
      const result = await persistArticle(db, config, 'example', 'news', candidates[0],
        { url: expected, title: 'Digital asset security', html },
        {} as Backends, { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger);
      assert.equal(result.inserted, 1);
      const stored = recentItems(db, 'example', null, 10);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].url, expected);
      const response = await createApp(db, config).request('/feed/example/articles');
      assert.equal(response.status, 200);
      const history = await response.text();
      const $ = load(history);
      const original = $('a').filter((_, el) => $(el).text() === 'original').attr('href');
      assert.equal(original, expected);
      observations.push({ identity, listingHref: ` \t${href}\n `, discoveredUrl: candidates[0].url, storedUrl: stored[0].url, historyOriginalLink: original });
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, `${identity.replace(':', '-')}-history.html`), history);
      }
    } finally {
      db.close();
      await removeTempDir(dir);
    }
  }
  if (evidence) await writeFile(join(evidence, 'url-persistence.json'), JSON.stringify(observations, null, 2));
});
