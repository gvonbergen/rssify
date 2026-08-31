import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import {
  insertItem,
  insertSection,
  insertSite,
  openDb,
  type Db,
  type ItemRow,
  type SectionRow,
  type SiteRow,
} from '../src/db.ts';

export async function makeTempDir(prefix = 'rssify-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function testConfig(dir: string, overrides: Partial<AppConfig['defaults']> = {}): AppConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.storage.data_dir = join(dir, 'data');
  config.storage.db_path = join(dir, 'state.sqlite');
  config.defaults = { ...config.defaults, ...overrides };
  return config;
}

export function openTempDb(dir: string, overrides: Partial<AppConfig['defaults']> = {}): {
  db: Db;
  config: AppConfig;
} {
  const config = testConfig(dir, overrides);
  return { db: openDb(config), config };
}

export function siteRow(site = 'example'): Omit<SiteRow, 'last_scrape_at' | 'last_scrape_status' | 'last_error'> {
  return {
    site,
    url: `https://${site}.test/news`,
    title: `${site} feed`,
    description: 'A test feed',
    schedule: '*/5 * * * *',
    config_json: '{}',
    module_path: 'sites/googlenews.ts',
    private: 0,
    created_at: 1_700_000_000_000,
  };
}

export function sectionRow(site = 'example', section = 'news'): SectionRow {
  return {
    site,
    section,
    index_url: `https://${site}.test/${section}`,
    title: `${section} section`,
    description: `${section} description`,
    created_at: 1_700_000_000_001,
  };
}

export function itemRow(site = 'example', hash = 'hash-1', contentPath = '/tmp/missing.html'): ItemRow {
  return {
    site,
    hash,
    url: `https://${site}.test/news/${hash}`,
    title: `Article ${hash}`,
    published_at: 1_700_000_000_100,
    first_seen: 1_700_000_000_200,
    content_path: contentPath,
    content_hash: `content-${hash}`,
    raw_path: null,
  };
}

export function seedSite(db: Db, site = 'example', section = 'news'): void {
  insertSite(db, siteRow(site));
  insertSection(db, sectionRow(site, section));
}

export async function seedItemFile(
  db: Db,
  dir: string,
  site = 'example',
  hash = 'hash-1',
  html = '<article><p>Article body</p></article>',
): Promise<ItemRow> {
  const contentPath = join(dir, `${hash}.html`);
  await writeFile(contentPath, html, 'utf8');
  const item = itemRow(site, hash, contentPath);
  insertItem(db, item);
  return item;
}
