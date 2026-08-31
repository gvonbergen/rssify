import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addItemSection,
  countItems,
  deleteOrphanItems,
  deleteSection,
  deleteSite,
  finishRun,
  getItem,
  getSection,
  getSite,
  insertItem,
  insertRun,
  insertSection,
  insertSite,
  itemSectionHashes,
  kvDel,
  kvGet,
  kvSet,
  listSections,
  listSites,
  openDb,
  parseSiteConfig,
  recentItems,
  sanitizeSiteConfig,
  updateItemPublishedAtByHash,
  updateItemPublishedAtByUrl,
  updateSiteConfig,
  updateSiteLastScrape,
  updateSiteSchedule,
  updateSiteTitle,
} from '../src/db.ts';
import { itemRow, makeTempDir, openTempDb, removeTempDir, sectionRow, seedSite, siteRow } from './helpers.ts';

test('SQLite schema supports site/section CRUD and enforces foreign keys', async () => {
  const dir = await makeTempDir();
  const { db } = openTempDb(dir);
  try {
    assert.deepEqual(listSites(db), []);
    insertSite(db, siteRow());
    insertSection(db, sectionRow());
    assert.equal(getSite(db, 'example')?.title, 'example feed');
    assert.equal(getSection(db, 'example', 'news')?.title, 'news section');
    assert.deepEqual(listSections(db, 'example').map((s) => s.section), ['news']);
    assert.throws(() => insertSite(db, siteRow()), /UNIQUE constraint failed/);
    assert.throws(() => insertSection(db, sectionRow()), /UNIQUE constraint failed/);
    assert.throws(() => insertSection(db, sectionRow('missing', 'news')), /FOREIGN KEY constraint failed/);
    deleteSite(db, 'example');
    assert.equal(getSite(db, 'example'), undefined);
    assert.equal(listSections(db, 'example').length, 0);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('items are unique per site/hash, section membership is idempotent, and ordering is stable', async () => {
  const dir = await makeTempDir();
  const { db } = openTempDb(dir);
  try {
    seedSite(db);
    insertSection(db, sectionRow('example', 'other'));
    const newest = itemRow('example', 'newest', '/tmp/newest');
    const undated = { ...itemRow('example', 'undated', '/tmp/undated'), published_at: null, first_seen: newest.first_seen + 10_000 };
    const oldest = { ...itemRow('example', 'oldest', '/tmp/oldest'), published_at: newest.published_at! - 10_000 };
    insertItem(db, oldest);
    insertItem(db, undated);
    insertItem(db, newest);
    addItemSection(db, 'example', 'news', oldest.hash);
    addItemSection(db, 'example', 'news', oldest.hash);
    addItemSection(db, 'example', 'other', oldest.hash);
    addItemSection(db, 'example', 'news', newest.hash);
    addItemSection(db, 'example', 'other', undated.hash);
    assert.deepEqual([...itemSectionHashes(db, 'example', 'news')].sort(), ['newest', 'oldest']);
    assert.deepEqual(recentItems(db, 'example', null, 10).map((i) => i.hash), ['newest', 'oldest', 'undated']);
    assert.deepEqual(recentItems(db, 'example', 'news', 1).map((i) => i.hash), ['newest']);
    assert.equal(countItems(db, 'example'), 3);
    assert.throws(() => insertItem(db, newest), /UNIQUE constraint failed/);
    assert.equal(getItem(db, 'example', 'nope'), undefined);
    assert.equal(updateItemPublishedAtByHash(db, 'example', 'undated', newest.published_at!), 1);
    assert.equal(updateItemPublishedAtByUrl(db, 'example', undated.url, newest.published_at! + 1), 1);
    assert.equal(getItem(db, 'example', 'undated')?.published_at, newest.published_at! + 1);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('section deletion plus orphan cleanup preserves shared items and removes unreferenced rows', async () => {
  const dir = await makeTempDir();
  const { db } = openTempDb(dir);
  try {
    seedSite(db);
    insertSection(db, sectionRow('example', 'other'));
    insertItem(db, itemRow('example', 'shared', '/tmp/shared'));
    insertItem(db, itemRow('example', 'only-news', '/tmp/only-news'));
    insertItem(db, itemRow('example', 'orphan', '/tmp/orphan'));
    addItemSection(db, 'example', 'news', 'shared');
    addItemSection(db, 'example', 'other', 'shared');
    addItemSection(db, 'example', 'news', 'only-news');
    deleteSection(db, 'example', 'news');
    deleteOrphanItems(db, 'example');
    assert.ok(getItem(db, 'example', 'shared'));
    assert.equal(getItem(db, 'example', 'only-news'), undefined);
    assert.equal(getItem(db, 'example', 'orphan'), undefined);
    deleteSection(db, 'example', 'other');
    deleteOrphanItems(db, 'example');
    assert.equal(getItem(db, 'example', 'shared'), undefined);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('site settings, run quality, and per-site KV persistence round-trip', async () => {
  const dir = await makeTempDir();
  const { db } = openTempDb(dir);
  try {
    seedSite(db);
    updateSiteTitle(db, 'example', 'Renamed');
    updateSiteSchedule(db, 'example', '0 * * * *');
    updateSiteConfig(db, 'example', '{"engine":"plain","extract":{"max":2}}');
    updateSiteLastScrape(db, 'example', 123, 'partial', 'temporary failure');
    const site = getSite(db, 'example');
    assert.equal(site?.title, 'Renamed');
    assert.equal(site?.schedule, '0 * * * *');
    assert.equal(site?.last_scrape_status, 'partial');
    assert.equal(site?.last_error, 'temporary failure');
    assert.deepEqual(parseSiteConfig(site!), { extract: { max: 2 } });
    assert.equal(sanitizeSiteConfig('{bad'), '{bad');

    kvSet(db, 'example', 'cursor', 'one');
    kvSet(db, 'example', 'cursor', 'two');
    assert.equal(kvGet(db, 'example', 'cursor'), 'two');
    assert.equal(kvGet(db, 'other', 'cursor'), null);
    kvDel(db, 'example', 'cursor');
    assert.equal(kvGet(db, 'example', 'cursor'), null);

    const runId = insertRun(db, 'example', 1000);
    finishRun(db, runId, 2000, 'partial', {
      discovered: 5, newItems: 2, error: 'one error', excerpt: 'log excerpt', quality: { parsed: 4, bodyGood: 3, dateGood: 2 },
    });
    const run = db.prepare('SELECT * FROM scrape_runs WHERE id=?').get(runId) as Record<string, unknown>;
    assert.equal(run.status, 'partial');
    assert.deepEqual(JSON.parse(String(run.quality_json)), { parsed: 4, bodyGood: 3, dateGood: 2 });
    assert.equal(run.finished_at, 2000);
  } finally {
    db.close();
    await removeTempDir(dir);
  }
});

test('schema is reusable when reopened and retains data', async () => {
  const dir = await makeTempDir();
  const first = openTempDb(dir);
  seedSite(first.db);
  first.db.close();
  const second = openDb(first.config);
  try {
    assert.equal(getSite(second, 'example')?.site, 'example');
    const tables = second.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    assert.deepEqual(tables.map((t) => t.name), ['item_sections', 'items', 'scrape_runs', 'scratch_kv', 'sections', 'sites', 'sqlite_sequence']);
  } finally {
    second.close();
    await removeTempDir(dir);
  }
});
