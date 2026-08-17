import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';

export type { Logger };

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

const logDir = join(ROOT, 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'rssify.log');

/** Root logger: structured JSON to stdout and appended to logs/rssify.log. */
export const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: undefined,
  },
  pino.multistream([
    { stream: process.stdout },
    // sync:true avoids the async worker-thread destination, which raced an
    // immediate process.exit (e.g. `--version`) and printed a spurious
    // "sonic boom is not ready yet" warning.
    { stream: pino.destination({ dest: logFile, append: true, sync: true }) },
  ]),
);

/** Child logger bound to a site (and optionally section). */
export function siteLogger(site: string, extra?: Record<string, unknown>): Logger {
  return logger.child({ site, ...extra });
}
