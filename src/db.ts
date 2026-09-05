import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ROOT } from './logger.ts';
import type { AppConfig } from './config.ts';

export type Db = Database.Database;

export interface SiteRow {
  site: string;
  url: string;
  title: string;
  description: string;
  schedule: string;
  config_json: string;
  module_path: string;
  private: number;
  created_at: number;
  last_scrape_at: number | null;
  last_scrape_status: string | null;
  last_error: string | null;
}

export interface SectionRow {
  site: string;
  section: string;
  index_url: string;
  title: string;
  description: string;
  created_at: number;
}

export interface ItemRow {
  site: string;
  hash: string;
  url: string;
  title: string;
  published_at: number | null;
  first_seen: number;
  content_path: string;
  content_hash: string | null;
  raw_path: string | null;
}

export interface RunRow {
  id: number;
  site: string;
  started_at: number;
  finished_at: number | null;
  status: string | null;
  discovered: number | null;
  new_items: number | null;
  error: string | null;
  log_excerpt: string | null;
  quality_json: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  site TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  module_path TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_scrape_at INTEGER,
  last_scrape_status TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS sections (
  site TEXT NOT NULL REFERENCES sites(site) ON DELETE CASCADE,
  section TEXT NOT NULL,
  index_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site, section)
);
CREATE TABLE IF NOT EXISTS items (
  site TEXT NOT NULL REFERENCES sites(site) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at INTEGER,
  first_seen INTEGER NOT NULL,
  content_path TEXT NOT NULL,
  content_hash TEXT,
  raw_path TEXT,
  PRIMARY KEY (site, hash)
);
CREATE INDEX IF NOT EXISTS items_site_firstseen ON items(site, first_seen DESC);
CREATE TABLE IF NOT EXISTS item_sections (
  site TEXT NOT NULL,
  section TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (site, section, hash),
  FOREIGN KEY (site, hash) REFERENCES items(site, hash) ON DELETE CASCADE,
  FOREIGN KEY (site, section) REFERENCES sections(site, section) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL REFERENCES sites(site) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT,
  discovered INTEGER,
  new_items INTEGER,
  error TEXT,
  log_excerpt TEXT,
  quality_json TEXT
);
CREATE TABLE IF NOT EXISTS scratch_kv (
  site TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (site, key)
);
`;

/** Open (creating if needed) the SQLite database and apply idempotent schema. */
export function openDb(config: AppConfig): Db {
  let dbPath = config.storage.db_path;
  if (!isAbsolute(dbPath)) dbPath = resolve(ROOT, dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Idempotent migration for DBs created before quality tracking existed.
  const cols = db.prepare('PRAGMA table_info(scrape_runs)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'quality_json')) {
    db.exec('ALTER TABLE scrape_runs ADD COLUMN quality_json TEXT');
  }
  const itemCols = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
  if (!itemCols.some((c) => c.name === 'raw_path')) {
    db.exec('ALTER TABLE items ADD COLUMN raw_path TEXT');
  }
  // Remove the legacy AI-summary column once no scrape is in flight (a run
  // started under old code may still INSERT with a summary value).
  if (itemCols.some((c) => c.name === 'summary')) {
    const active = db.prepare('SELECT COUNT(*) c FROM scrape_runs WHERE finished_at IS NULL').get() as { c: number };
    if (!active.c) {
      db.exec('ALTER TABLE items DROP COLUMN summary');
    }
  }
  return db;
}

/** Extract a sub-object or empty object from a site's config_json. */
export function parseSiteConfig(row: { config_json: string }): Record<string, unknown> {
  try {
    return JSON.parse(row.config_json || '{}');
  } catch {
    return {};
  }
}

// ---- sites ----
/**
 * The scrape engine is global (settings.defaults.engine) — no per-site engine.
 * Strip a legacy `engine` key before persisting any site config_json.
 */
export function sanitizeSiteConfig(configJson: string): string {
  try {
    const obj = JSON.parse(configJson || '{}');
    if (obj && typeof obj === 'object' && 'engine' in obj) {
      delete obj.engine;
      return JSON.stringify(obj);
    }
  } catch {
    /* leave malformed JSON as-is */
  }
  return configJson;
}

export function insertSite(db: Db, s: Omit<SiteRow, 'last_scrape_at' | 'last_scrape_status' | 'last_error'>): void {
  const row = { ...s, config_json: sanitizeSiteConfig(s.config_json) };
  db.prepare(
    `INSERT INTO sites (site,url,title,description,schedule,config_json,module_path,private,created_at)
     VALUES (@site,@url,@title,@description,@schedule,@config_json,@module_path,@private,@created_at)`,
  ).run(row);
}
export function getSite(db: Db, site: string): SiteRow | undefined {
  return db.prepare('SELECT * FROM sites WHERE site = ?').get(site) as SiteRow | undefined;
}
export function listSites(db: Db): SiteRow[] {
  return db.prepare('SELECT * FROM sites ORDER BY site').all() as SiteRow[];
}
export function deleteSite(db: Db, site: string): void {
  db.prepare('DELETE FROM sites WHERE site = ?').run(site);
}
export function updateSiteLastScrape(
  db: Db,
  site: string,
  at: number,
  status: string,
  error: string | null,
): void {
  db.prepare('UPDATE sites SET last_scrape_at=?, last_scrape_status=?, last_error=? WHERE site=?')
    .run(at, status, error, site);
}
/** Persist a site's config_json (e.g. `scrape_delay` set via `rssify delay`). */
export function updateSiteConfig(db: Db, site: string, configJson: string): void {
  db.prepare('UPDATE sites SET config_json=? WHERE site=?').run(sanitizeSiteConfig(configJson), site);
}
export function updateSiteTitle(db: Db, site: string, title: string): void {
  db.prepare('UPDATE sites SET title=? WHERE site=?').run(title, site);
}
/** Persist a site's cron schedule (read by the Scheduler on `rssify serve`). */
export function updateSiteSchedule(db: Db, site: string, schedule: string): void {
  db.prepare('UPDATE sites SET schedule=? WHERE site=?').run(schedule, site);
}
export function countItems(db: Db, site: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM items WHERE site=?').get(site) as { c: number }).c;
}
export function getSectionTitle(db: Db, site: string, section: string): string | undefined {
  const r = db.prepare('SELECT title FROM sections WHERE site=? AND section=?').get(site, section) as
    | { title: string }
    | undefined;
  return r?.title;
}

// ---- sections ----
export function insertSection(db: Db, s: SectionRow): void {
  db.prepare(
    `INSERT INTO sections (site,section,index_url,title,description,created_at)
     VALUES (@site,@section,@index_url,@title,@description,@created_at)`,
  ).run(s);
}
export function getSection(db: Db, site: string, section: string): SectionRow | undefined {
  return db.prepare('SELECT * FROM sections WHERE site=? AND section=?').get(site, section) as
    | SectionRow
    | undefined;
}
export function listSections(db: Db, site: string): SectionRow[] {
  return db.prepare('SELECT * FROM sections WHERE site=? ORDER BY created_at').all(site) as SectionRow[];
}
export function deleteSection(db: Db, site: string, section: string): void {
  db.prepare('DELETE FROM sections WHERE site=? AND section=?').run(site, section);
}
/** Delete item rows for a site that no longer belong to any remaining section. */
export function deleteOrphanItems(db: Db, site: string): void {
  db.prepare(
    `DELETE FROM items WHERE site=? AND hash NOT IN (
       SELECT hash FROM item_sections WHERE site=?
     )`,
  ).run(site, site);
}

// ---- items ----
export function getItem(db: Db, site: string, hash: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE site=? AND hash=?').get(site, hash) as ItemRow | undefined;
}
export function itemSectionHashes(db: Db, site: string, section: string): Set<string> {
  const rows = db.prepare('SELECT hash FROM item_sections WHERE site=? AND section=?').all(site, section) as {
    hash: string;
  }[];
  return new Set(rows.map((r) => r.hash));
}
export function itemBelongsToSite(db: Db, site: string, hash: string): boolean {
  return !!db.prepare('SELECT 1 FROM items WHERE site=? AND hash=?').get(site, hash);
}
export function insertItem(db: Db, it: ItemRow): void {
  db.prepare(
    `INSERT INTO items (site,hash,url,title,published_at,first_seen,content_path,content_hash,raw_path)
     VALUES (@site,@hash,@url,@title,@published_at,@first_seen,@content_path,@content_hash,@raw_path)`,
  ).run(it);
}
/** Delete one exact item; item_sections rows cascade through the foreign key. */
export function deleteItem(db: Db, site: string, hash: string): number {
  return db.prepare('DELETE FROM items WHERE site=? AND hash=?').run(site, hash).changes;
}
export function updateItemPublishedAtByUrl(db: Db, site: string, url: string, publishedAt: number): number {
  return db.prepare('UPDATE items SET published_at=? WHERE site=? AND url=?').run(publishedAt, site, url).changes;
}
export function updateItemPublishedAtByHash(db: Db, site: string, hash: string, publishedAt: number): number {
  return db.prepare('UPDATE items SET published_at=? WHERE site=? AND hash=?').run(publishedAt, site, hash).changes;
}
export function addItemSection(db: Db, site: string, section: string, hash: string): void {
  db.prepare('INSERT OR IGNORE INTO item_sections (site,section,hash) VALUES (?,?,?)').run(site, section, hash);
}
/** Recent items (optionally filtered to a section), with an optional offset. */
export function recentItems(
  db: Db,
  site: string,
  section: string | null,
  limit: number,
  offset = 0,
): ItemRow[] {
  let sql = `SELECT i.* FROM items i WHERE i.site=?`;
  const args: unknown[] = [site];
  if (section) {
    sql += ` AND i.hash IN (SELECT hash FROM item_sections WHERE site=? AND section=?)`;
    args.push(site, section);
  }
  // published_at may be null → sink undated items to the bottom instead of
  // letting their (fresher) first_seen push them to the top of the feed.
  sql += ` ORDER BY (i.published_at IS NULL) ASC, COALESCE(i.published_at, i.first_seen) DESC, i.first_seen DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  return db.prepare(sql).all(...args) as ItemRow[];
}

// ---- scrape_runs ----
export function insertRun(db: Db, site: string, startedAt: number): number {
  const r = db
    .prepare('INSERT INTO scrape_runs (site, started_at) VALUES (?, ?)')
    .run(site, startedAt);
  return Number(r.lastInsertRowid);
}
export interface ScrapeQuality {
  parsed: number; // article pages parsed OK
  bodyGood: number; // ...with a substantial cleaned body (>= MIN_QUALITY_BODY)
  dateGood: number; // ...with a parsed published date
}

export function finishRun(
  db: Db,
  id: number,
  finishedAt: number,
  status: string,
  opts: {
    discovered?: number;
    newItems?: number;
    error?: string;
    excerpt?: string;
    quality?: ScrapeQuality | null;
  },
): void {
  db.prepare(
    `UPDATE scrape_runs SET finished_at=?, status=?, discovered=?, new_items=?, error=?, log_excerpt=?, quality_json=?
     WHERE id=?`,
  ).run(
    finishedAt,
    status,
    opts.discovered ?? null,
    opts.newItems ?? null,
    opts.error ?? null,
    opts.excerpt ?? null,
    opts.quality ? JSON.stringify(opts.quality) : null,
    id,
  );
}
export function runsForSite(db: Db, site: string, limit = 50): RunRow[] {
  return db.prepare('SELECT * FROM scrape_runs WHERE site=? ORDER BY id DESC LIMIT ?').all(site, limit) as RunRow[];
}

// ---- scratch_kv (per-site module persistence) ----
export function kvGet(db: Db, site: string, key: string): string | null {
  const r = db.prepare('SELECT value FROM scratch_kv WHERE site=? AND key=?').get(site, key) as
    | { value: string }
    | undefined;
  return r ? r.value : null;
}
export function kvSet(db: Db, site: string, key: string, value: string): void {
  db.prepare(
    'INSERT INTO scratch_kv (site,key,value) VALUES (?,?,?) ON CONFLICT(site,key) DO UPDATE SET value=excluded.value',
  ).run(site, key, value);
}
export function kvDel(db: Db, site: string, key: string): void {
  db.prepare('DELETE FROM scratch_kv WHERE site=? AND key=?').run(site, key);
}
