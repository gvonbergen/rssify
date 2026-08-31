import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';

export type { Logger };

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

const logDir = join(ROOT, 'logs');
const logFile = join(logDir, 'rssify.log');

/**
 * Root logger: structured JSON to stdout and appended to logs/rssify.log.
 * The test runner opts into stdout-only logging so importing application
 * modules cannot create repository artifacts during isolated tests.
 */
const logStream = process.env.RSSIFY_TEST === '1'
  ? process.stdout
  : (() => {
      mkdirSync(logDir, { recursive: true });
      return pino.multistream([
        { stream: process.stdout },
        // sync:true avoids the async worker-thread destination, which raced an
        // immediate process.exit (e.g. `--version`) and printed a spurious
        // "sonic boom is not ready yet" warning.
        { stream: pino.destination({ dest: logFile, append: true, sync: true }) },
      ]);
    })();

export const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: undefined,
  },
  logStream,
);

/** Child logger bound to a site (and optionally section). */
export function siteLogger(site: string, extra?: Record<string, unknown>): Logger {
  return logger.child({ site, ...extra });
}
