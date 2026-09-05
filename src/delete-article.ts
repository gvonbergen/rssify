import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from './config.ts';
import { deleteItem, getItem, getSite, type Db, type ItemRow } from './db.ts';
import { ROOT } from './logger.ts';
import { isValidIdentifier } from './util.ts';

export interface DeletedArticle {
  site: string;
  hash: string;
  title: string;
  url: string;
}

export class DeleteArticleError extends Error {}

const ARTICLE_HASH = /^[a-f0-9]{40}$/;
const ARTIFACT_SUFFIXES = ['.html', '.raw.html', '.meta.json', '.llm.json'] as const;

function absolutePath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
}

function expectedArtifactPaths(config: AppConfig, site: string, hash: string): string[] {
  const siteDir = resolve(ROOT, config.storage.data_dir, site);
  return ARTIFACT_SUFFIXES.map((suffix) => join(siteDir, `${hash}${suffix}`));
}

/**
 * Delete one exact article and its artifacts without touching site-level state.
 *
 * Existing files are first renamed within the site directory. This makes them
 * inaccessible to HTTP readers while retaining a rollback path until the item
 * row and its cascading section memberships commit. Missing artifacts are
 * harmless. A cleanup error after commit is reported rather than claiming a
 * fully successful deletion.
 */
export function deleteStoredArticle(
  db: Db,
  config: AppConfig,
  site: string,
  hash: string,
): DeletedArticle {
  if (!isValidIdentifier(site)) {
    throw new DeleteArticleError(`invalid site identifier '${site}'`);
  }
  if (!ARTICLE_HASH.test(hash)) {
    throw new DeleteArticleError('invalid article hash: expected exactly 40 lowercase hexadecimal characters');
  }
  if (!getSite(db, site)) {
    throw new DeleteArticleError(`unknown site '${site}'`);
  }
  const item = getItem(db, site, hash);
  if (!item) {
    throw new DeleteArticleError(`article '${hash}' not found in site '${site}'`);
  }

  const expected = expectedArtifactPaths(config, site, hash);
  validateStoredPath(item, 'content_path', expected[0]);
  if (item.raw_path !== null) validateStoredPath(item, 'raw_path', expected[1]);

  const staged: Array<{ original: string; tombstone: string }> = [];
  try {
    for (const original of expected) {
      try {
        lstatSync(original);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        throw error;
      }
      const tombstone = join(
        resolve(ROOT, config.storage.data_dir, site),
        `.delete-${hash}-${randomUUID()}-${basename(original)}`,
      );
      renameSync(original, tombstone);
      staged.push({ original, tombstone });
    }
  } catch (error) {
    restoreStaged(staged);
    throw new DeleteArticleError(`could not stage article artifacts: ${message(error)}`);
  }

  try {
    db.transaction(() => {
      if (deleteItem(db, site, hash) !== 1) {
        throw new Error('article changed before it could be deleted');
      }
    })();
  } catch (error) {
    try {
      restoreStaged(staged);
    } catch (restoreError) {
      throw new DeleteArticleError(
        `database deletion failed and artifact rollback failed: ${message(error)}; ${message(restoreError)}`,
      );
    }
    throw new DeleteArticleError(`database deletion failed; artifacts restored: ${message(error)}`);
  }

  try {
    for (const { tombstone } of staged) unlinkSync(tombstone);
  } catch (error) {
    throw new DeleteArticleError(
      `article '${hash}' was removed from storage, but artifact cleanup failed: ${message(error)}`,
    );
  }

  return { site, hash, title: item.title, url: item.url };
}

function validateStoredPath(item: ItemRow, field: 'content_path' | 'raw_path', expected: string): void {
  const value = item[field];
  if (value === null || absolutePath(value) !== expected) {
    throw new DeleteArticleError(
      `refusing to delete article '${item.hash}': stored ${field} does not match its site/hash artifact path`,
    );
  }
}

function restoreStaged(staged: Array<{ original: string; tombstone: string }>): void {
  for (const { original, tombstone } of [...staged].reverse()) renameSync(tombstone, original);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
