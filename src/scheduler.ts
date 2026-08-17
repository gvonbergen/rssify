import type { Db, SiteRow } from './db.ts';
import { listSites } from './db.ts';
import type { AppConfig } from './config.ts';
import { runSiteScrape } from './scraper.ts';
import { siteLogger } from './logger.ts';
import { validateCron, nextCronRun } from './cron.ts';

/**
 * In-process scheduler: one staggered timer per site, ticked by `rssify serve`.
 * Instead of node-cron's fixed grid (which would fire all sites at the same
 * minute and burst the shared engine budget), each site's next run is the next
 * cron occurrence PLUS a per-site random jitter, so sites never collide.
 */
export class Scheduler {
  db: Db;
  config: AppConfig;
  timers = new Map<string, NodeJS.Timeout>();
  started = false;

  constructor(db: Db, config: AppConfig) {
    this.db = db;
    this.config = config;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const sites = listSites(this.db);
    for (const site of sites) this.scheduleSite(site);
    siteLogger('scheduler').info({ count: sites.length }, 'scheduler started');
  }

  /** (Re)register the staggered timer for one site from its stored schedule. */
  scheduleSite(site: SiteRow): void {
    this.unschedule(site.site);
    let expr = site.schedule;
    if (!validateCron(expr)) {
      siteLogger(site.site).warn({ schedule: expr }, 'invalid cron, falling back to default');
      expr = this.config.defaults.schedule;
    }
    const jitterMaxMs =
      Math.max(0, Number(this.config.defaults.schedule_jitter_seconds ?? 0) * 1000) || 0;

    const scheduleNext = (tick: () => void): void => {
      const now = Date.now();
      const base = nextCronRun(expr, now);
      const jitter = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
      const delay = Math.max(0, base + jitter - now);
      const timer = setTimeout(() => {
        this.timers.delete(site.site);
        tick();
      }, delay);
      this.timers.set(site.site, timer);
    };

    const tick = (): void => {
      siteLogger(site.site).info('scheduled tick');
      runSiteScrape(this.db, this.config, site.site).catch((e) => {
        siteLogger(site.site).error({ err: String(e) }, 'scheduled tick failed');
      });
      scheduleNext(tick);
    };

    scheduleNext(tick);
    siteLogger(site.site).info(
      { schedule: expr, jitterMaxSeconds: Math.round(jitterMaxMs / 1000) },
      'scheduled',
    );
  }

  unschedule(site: string): void {
    const t = this.timers.get(site);
    if (t) {
      clearTimeout(t);
      this.timers.delete(site);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.started = false;
    siteLogger('scheduler').info('scheduler stopped');
  }
}
