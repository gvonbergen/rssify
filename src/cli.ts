#!/usr/bin/env node
// Register the .js→.ts relative-import loader hook before anything loads.
import './loader.ts';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { ensureConfig, loadConfig, configSet } from './config.ts';
import {
  countItems,
  deleteOrphanItems,
  deleteSection,
  deleteSite,
  getSection,
  getSite,
  insertSection,
  insertSite,
  listSections,
  listSites,
  openDb,
  runsForSite,
  updateSiteConfig,
  updateSiteTitle,
  type Db,
} from './db.ts';
import { add, RESERVED } from './add.ts';
import { runSiteScrape, withRateLimit, buildBackends, delayBandMs } from './scraper.ts';
import { reprofileSite } from './extract/profile.ts';
import { buildLlmExtractor } from './extract/llm.ts';
import { createApp } from './server.ts';
import { Scheduler } from './scheduler.ts';
import { logger, siteLogger, type Logger, ROOT } from './logger.ts';
import { cleanHtml, extractMetadata } from './clean.ts';
import { sha1, slugify, isValidIdentifier, nowMs } from './util.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ItemRow } from './db.ts';

function withDb<T>(fn: (db: Db, config: ReturnType<typeof loadConfig>) => Promise<T> | T): Promise<T> {
  ensureConfig();
  const config = loadConfig();
  const db = openDb(config);
  return Promise.resolve(fn(db, config)).finally(() => db.close());
}

const program = new Command();
program
  .name('rssify')
  .description('Self-hosted scraper-to-RSS service (Phase 1 MVP).')
  .version('0.1.0');

program
  .command('add')
  .description('Register a site — the app auto-discovers its layout; pi is optional escalation.')
  .argument('<url>', 'index URL of the site or section area')
  .option('-n, --name <name>', 'display name for the feed (required for NEW sites; optional when adding a subcategory to an already-registered site — the existing site title is kept)')
  .action(async (url: string, opts: { name?: string }) => {
    await withDb(async (db, config) => {
      try { throw new Error('STACKTRACE_DEBUG'); } catch (e) { console.error('STACK', (e as Error).stack); }

      try { throw new Error('STACKTRACE_DEBUG'); } catch (e) { console.error('STACK', (e as Error).stack); }

      try {
        const result = await add(db, config, url, opts.name);
        // progress lines are echoed live to stderr by add(); stdout shows the result block
        console.log('\nFeed URLs:');
        console.log(`  merged feed:     http://127.0.0.1:3000/${result.site}`);
        console.log(`  section feed:    http://127.0.0.1:3000/${result.site}/${result.section}`);
        console.log(`  status:          http://127.0.0.1:3000/${result.site}/status\n`);
        console.log('Next: run `rssify scrape ' + result.site + '` for a manual scrape, or `rssify serve`.');
      } catch (e) {
        console.error(`\nadd failed: ${(e as Error).message}\n`);
        process.exitCode = 1;
      }
    });
  });

program
  .command('rename')
  .description('Set a site\'s display name (used as the feed <title>).')
  .argument('<site>', 'site identifier')
  .argument('<name>', 'new display name')
  .action(async (site: string, name: string) => {
    await withDb(async (db) => {
      if (!getSite(db, site)) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      const t = name.trim();
      if (!t) {
        console.error('name cannot be empty');
        process.exitCode = 1;
        return;
      }
      updateSiteTitle(db, site, t);
      console.log(`renamed ${site} → ${t}`);
    });
  });

program
  .command('list')
  .description('List registered sites.')
  .action(async () => {
    await withDb((db) => {
      const sites = listSites(db);
      if (!sites.length) {
        console.log('No sites registered yet. Run `rssify add <url>`.');
        return;
      }
      const header = ['site', '#sections', 'schedule', 'last_scrape', 'status', '#items'];
      const rows = sites.map((s) => {
        const sections = listSections(db, s.site).length;
        const items = countItems(db, s.site);
        return [
          s.site,
          String(sections),
          s.schedule,
          s.last_scrape_at ? new Date(s.last_scrape_at).toISOString() : '-',
          s.last_scrape_status ?? '-',
          String(items),
        ];
      });
      printTable(header, rows);
    });
  });

program
  .command('delay')
  .description('View or set a site\'s random scrape-delay band in seconds (per-site).')
  .argument('<site>', 'site identifier')
  .argument('[lower]', 'lower bound in seconds (e.g. 15)')
  .argument('[upper]', 'upper bound in seconds (e.g. 30); defaults to lower')
  .action(async (site: string, lower?: string, upper?: string) => {
    await withDb(async (db, config) => {
      const s = getSite(db, site);
      if (!s) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(s.config_json);
      } catch {
        cfg = {};
      }
      const sc = cfg.scrape_delay && typeof cfg.scrape_delay === 'object' ? (cfg.scrape_delay as Record<string, unknown>) : undefined;
      const cur = sc ?? config.defaults.scrape_delay;
      if (lower === undefined) {
        const src = sc ? 'per-site override' : 'instance default (defaults.scrape_delay)';
        console.log(`${site}: scrape_delay = { lower_sec: ${cur.lower_sec}, upper_sec: ${cur.upper_sec} } (${src})`);
        return;
      }
      const lo = Number(lower);
      const up = Number(upper === undefined ? lower : upper);
      if (!Number.isFinite(lo) || !Number.isFinite(up) || lo < 0 || up < 0) {
        console.error('bounds must be non-negative numbers (seconds)');
        process.exitCode = 1;
        return;
      }
      cfg.scrape_delay = { lower_sec: lo, upper_sec: up };
      updateSiteConfig(db, site, JSON.stringify(cfg));
      console.log(`set ${site}: scrape_delay = { lower_sec: ${lo}, upper_sec: ${up} }`);
    });
  });

program
  .command('limit')
  .description("View or set a site's discovery candidate cap (per-site override of defaults.discover_max).")
  .argument('<site>', 'site identifier')
  .argument('[n]', 'candidate cap (e.g. 250), or "none" to clear the override')
  .action(async (site: string, n?: string) => {
    await withDb(async (db, config) => {
      const s = getSite(db, site);
      if (!s) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(s.config_json);
      } catch {
        cfg = {};
      }
      const ext =
        cfg.extract && typeof cfg.extract === 'object'
          ? (cfg.extract as Record<string, unknown>)
          : undefined;
      const perSite = typeof ext?.max === 'number' ? ext.max : undefined;
      if (n === undefined) {
        const eff = perSite ?? config.defaults.discover_max;
        const src =
          perSite !== undefined
            ? `per-site override (extract.max = ${perSite})`
            : `global default (defaults.discover_max = ${config.defaults.discover_max})`;
        console.log(`${site}: discover cap = ${eff} (${src})`);
        return;
      }
      if (n === 'none') {
        if (ext && 'max' in ext) {
          delete ext.max;
          updateSiteConfig(db, site, JSON.stringify(cfg));
          console.log(`cleared ${site}: per-site override removed; effective cap = ${config.defaults.discover_max} (global default)`);
        } else {
          console.log(`${site}: no per-site override to clear`);
        }
        return;
      }
      const v = Number(n);
      if (!Number.isFinite(v) || v < 1) {
        console.error('cap must be a positive integer, or "none"');
        process.exitCode = 1;
        return;
      }
      const next = { ...cfg, extract: { ...(ext ?? {}), max: Math.floor(v) } };
      updateSiteConfig(db, site, JSON.stringify(next));
      console.log(`set ${site}: discover cap = ${Math.floor(v)} (per-site override of defaults.discover_max)`);
    });
  });

program
  .command('follow')
  .description("View or set a site's pagination-follow behavior (per-site override of defaults.follow / defaults.follow_depth / defaults.follow_until_404).")
  .argument('<site>', 'site identifier')
  .argument('[action]', 'on | off | until404 | <depth> | none')
  .action(async (site: string, action?: string) => {
    await withDb(async (db, config) => {
      const s = getSite(db, site);
      if (!s) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(s.config_json);
      } catch {
        cfg = {};
      }
      const ext =
        cfg.extract && typeof cfg.extract === 'object'
          ? (cfg.extract as Record<string, unknown>)
          : undefined;
      const perFollow = typeof ext?.follow === 'boolean' ? ext.follow : undefined;
      const perDepth = typeof ext?.followDepth === 'number' ? ext.followDepth : undefined;
      const perUntil404 = typeof ext?.followUntil404 === 'boolean' ? ext.followUntil404 : undefined;
      if (action === undefined) {
        const until = perUntil404 ?? config.defaults.follow_until_404;
        if (until) {
          const src =
            perUntil404 !== undefined
              ? `until-404 override (extract.followUntil404 = true)`
              : `global default (defaults.follow_until_404 = true)`;
          console.log(`${site}: follow = until-404 (crawl pagination until a page returns 404) — ${src}`);
          return;
        }
        const follow = perFollow ?? config.defaults.follow;
        const depth = perDepth ?? config.defaults.follow_depth;
        const src = [
          perFollow !== undefined ? `follow override (extract.follow = ${perFollow})` : `global default (defaults.follow = ${config.defaults.follow})`,
          perDepth !== undefined ? `depth override (extract.followDepth = ${perDepth})` : `global default (defaults.follow_depth = ${config.defaults.follow_depth})`,
        ].join('; ');
        console.log(`${site}: follow = ${follow ? 'on' : 'off'}, depth = ${depth} (fetches 1 index + ${depth} follow = ${depth + 1} pages) — ${src}`);
        return;
      }
      const next = { ...cfg, extract: { ...(ext ?? {}) } };
      if (action === 'on') {
        next.extract.follow = true;
        delete next.extract.followUntil404;
        updateSiteConfig(db, site, JSON.stringify(next));
        console.log(`set ${site}: follow = on (per-site override)`);
        return;
      }
      if (action === 'off') {
        next.extract.follow = false;
        delete next.extract.followUntil404;
        updateSiteConfig(db, site, JSON.stringify(next));
        console.log(`set ${site}: follow = off (per-site override — index page only)`);
        return;
      }
      if (action === 'until404' || action === 'until-404') {
        next.extract.follow = true;
        next.extract.followUntil404 = true;
        delete next.extract.followDepth;
        updateSiteConfig(db, site, JSON.stringify(next));
        console.log(`set ${site}: follow = until-404 (crawl pagination until a page returns 404)`);
        return;
      }
      if (action === 'none') {
        if (ext && ('follow' in ext || 'followDepth' in ext || 'followUntil404' in ext)) {
          delete next.extract.follow;
          delete next.extract.followDepth;
          delete next.extract.followUntil404;
          updateSiteConfig(db, site, JSON.stringify(next));
          console.log(`cleared ${site}: follow/depth/until-404 overrides removed; effective = ${config.defaults.follow_until_404 ? 'until-404' : `${config.defaults.follow ? 'on' : 'off'}, depth ${config.defaults.follow_depth}`} (global defaults)`);
        } else {
          console.log(`${site}: no follow/depth/until-404 overrides to clear`);
        }
        return;
      }
      const v = Number(action);
      if (!Number.isFinite(v) || v < 0 || v > 8) {
        console.error('action must be on | off | until404 | none, or a depth 0-8');
        process.exitCode = 1;
        return;
      }
      // Setting a depth implies following: enable it and set the page count.
      next.extract.follow = true;
      next.extract.followDepth = Math.floor(v);
      delete next.extract.followUntil404;
      updateSiteConfig(db, site, JSON.stringify(next));
      console.log(`set ${site}: follow = on, depth = ${Math.floor(v)} (fetches 1 index + ${Math.floor(v)} follow = ${Math.floor(v) + 1} pages)`);
    });
  });

program
  .command('images')
  .description("View or set whether a site's feeds strip pictures (per-site override of defaults.ignore_images).")
  .argument('<site>', 'site identifier')
  .argument('[action]', 'on (text-only) | off (keep pictures) | none')
  .action(async (site: string, action?: string) => {
    await withDb(async (db, config) => {
      const s = getSite(db, site);
      if (!s) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(s.config_json);
      } catch {
        cfg = {};
      }
      const perSite = typeof cfg.ignore_images === 'boolean' ? cfg.ignore_images : undefined;
      if (action === undefined) {
        const eff = perSite ?? config.defaults.ignore_images;
        const src =
          perSite !== undefined
            ? `per-site override (config_json.ignore_images = ${perSite})`
            : `global default (defaults.ignore_images = ${config.defaults.ignore_images})`;
        console.log(`${site}: pictures = ${eff ? 'stripped (text only)' : 'kept'} — ${src}`);
        return;
      }
      if (action === 'on') {
        cfg.ignore_images = true;
        updateSiteConfig(db, site, JSON.stringify(cfg));
        console.log(`set ${site}: pictures = stripped (text only) — applies to feeds + cleaned pages`);
        return;
      }
      if (action === 'off') {
        cfg.ignore_images = false;
        updateSiteConfig(db, site, JSON.stringify(cfg));
        console.log(`set ${site}: pictures = kept`);
        return;
      }
      if (action === 'none') {
        if ('ignore_images' in cfg) {
          delete cfg.ignore_images;
          updateSiteConfig(db, site, JSON.stringify(cfg));
          console.log(`cleared ${site}: override removed; effective = ${config.defaults.ignore_images ? 'stripped' : 'kept'} (global default)`);
        } else {
          console.log(`${site}: no ignore_images override to clear`);
        }
        return;
      }
      console.error('action must be on | off | none');
      process.exitCode = 1;
    });
  });

program
  .command('gnews')
  .description("Register Google News topics — each topic is backed by a Google Alerts Atom feed URL. Actions: add <topic> <feed-url> | list | rm <topic>")
  .argument('[action]', 'add | list | rm')
  .argument('[topic]', 'topic name, e.g. \"Stablecoin\" (an alert you configured on google.com/alerts)')
  .argument('[feedUrl]', "the topic's Google Alerts Atom feed URL (see below)")
  .action(async (action?: string, topic?: string, feedUrl?: string) => {
    // GNEWS_SITE is the fixed site identifier; each topic becomes a section.
    const GNEWS_SITE = 'googlenews';
    await withDb(async (db, config) => {
      const printList = () => {
        const s = getSite(db, GNEWS_SITE);
        if (!s) {
          console.log('no Google News topics registered yet — add one with `rssify gnews add <topic> <feed-url>`');
          return;
        }
        const sections = listSections(db, GNEWS_SITE);
        console.log(`${s.title} (${s.site}) — ${sections.length} topic(s)`);
        for (const sec of sections) {
          console.log(`  ${sec.title.trim() || sec.section}  ->  /${GNEWS_SITE}/${sec.section}`);
          console.log(`       ${sec.index_url}`);
        }
        console.log(`merged feed: http://127.0.0.1:3000/${GNEWS_SITE}`);
      };
      if (action === 'list') {
        printList();
        return;
      }
      if (action === 'rm') {
        if (!topic || !topic.trim()) {
          console.error('usage: rssify gnews rm <topic>');
          process.exitCode = 1;
          return;
        }
        const section = slugify(topic);
        if (!getSection(db, GNEWS_SITE, section)) {
          console.error(`no such topic '${topic}' (section '${section}') — use \`rssify gnews list\``);
          process.exitCode = 1;
          return;
        }
        deleteSection(db, GNEWS_SITE, section);
        deleteOrphanItems(db, GNEWS_SITE);
        console.log(`removed topic '${topic}' (/${GNEWS_SITE}/${section})`);
        return;
      }
      if (action === 'add') {
        if (!topic || !topic.trim() || !feedUrl || !feedUrl.trim()) {
          console.error('usage: rssify gnews add <topic> <feed-url>');
          console.error('feed-url example: https://www.google.com/alerts/feeds/<userid>/<alertid>');
          process.exitCode = 1;
          return;
        }
        const section = slugify(topic);
        if (!isValidIdentifier(section) || section.length === 0) {
          console.error(`invalid topic name '${topic}' → section id '${section}'`);
          process.exitCode = 1;
          return;
        }
        let feedUrlOk = false;
        try {
          const u = new URL(feedUrl);
          feedUrlOk = /^https?:$/i.test(u.protocol);
        } catch {
          feedUrlOk = false;
        }
        if (!feedUrlOk) {
          console.error(`invalid feed url: ${feedUrl}`);
          process.exitCode = 1;
          return;
        }
        const existing = getSite(db, GNEWS_SITE);
        if (!existing) {
          insertSite(db, {
            site: GNEWS_SITE,
            url: 'https://news.google.com/',
            title: 'Google News',
            description: 'Google News topics (indexed via Google Alerts feeds)',
            schedule: config.defaults.schedule,
            config_json: '{}',
            module_path: 'sites/googlenews.ts',
            private: 0,
            created_at: nowMs(),
          });
          console.log(`created site '${GNEWS_SITE}' (module sites/googlenews.ts)`);
        }
        if (getSection(db, GNEWS_SITE, section)) {
          console.error(`topic '${topic}' already registered (section '${section}') — use \`rssify gnews rm ${topic}\` first`);
          process.exitCode = 1;
          return;
        }
        const title = topic.trim();
        insertSection(db, {
          site: GNEWS_SITE,
          section,
          index_url: feedUrl.trim(),
          title,
          description: '',
          created_at: nowMs(),
        });
        console.log(`registered Google News topic '${title}' → /${GNEWS_SITE}/${section}`);
        console.log('  next: `rssify scrape ' + GNEWS_SITE + '` to fetch its articles');
        return;
      }
      console.error('usage: rssify gnews <add <topic> <feed-url> | list | rm <topic>>');
      process.exitCode = 1;
    });
  });

program
  .command('reprofile')
  .description('Re-probe a site and update its auto-adaptive extraction profile.')
  .argument('<site>', 'site identifier')
  .action(async (site: string) => {
    await withDb(async (db, config) => {
      if (!getSite(db, site)) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      const mode = await reprofileSite(db, config, site, {
        info: (m: string) => console.log(m),
        warn: (m: string) => console.warn(m),
      });
      if (mode === null) process.exitCode = 1;
    });
  });

program
  .command('reprocess')
  .description('Re-clean stored items from saved raw HTML — no re-scrape. Re-runs readability + metadata extraction on data/<site>/<hash>.raw.html and updates content, publish date, and title where they improved.')
  .argument('<site>', 'site identifier')
  .option('--refetch', 're-fetches each item through the engine (for sites scraped without saved raw)')
  .action(async (site: string, opts: { refetch?: boolean }) => {
    await withDb(async (db, config) => {
      if (!getSite(db, site)) {
        console.error(`no such site: ${site}`);
        process.exitCode = 1;
        return;
      }
      // Without --refetch, only items saved with raw HTML can be reprocessed
      // locally. With --refetch, saved raw is irrelevant — every stored item
      // is re-fetched through the engine (this is the path for sites scraped
      // before defaults.store_raw was enabled, where raw_path is NULL).
      const rows = (
        opts.refetch
          ? db.prepare('SELECT * FROM items WHERE site=?').all(site)
          : db.prepare('SELECT * FROM items WHERE site=? AND raw_path IS NOT NULL').all(site)
      ) as ItemRow[];
      if (rows.length === 0) {
        console.log(
          opts.refetch
            ? `no stored items for '${site}' to re-fetch`
            : `no items with saved raw HTML for '${site}' — raw is stored on scrape (defaults.store_raw)`,
        );
        return;
      }
      const log: Logger = siteLogger(site);
      const siteRow = getSite(db, site);
      let siteCfg: Record<string, unknown> = {};
      try {
        siteCfg = JSON.parse(siteRow?.config_json ?? '{}');
      } catch {
        siteCfg = {};
      }
      const band = delayBandMs(siteCfg, config.defaults.scrape_delay);
      const backends = withRateLimit(buildBackends(config, log), band, site, log);
      // LLM extraction runs in parallel with the tag-based re-clean: refresh
      // the .llm.json sidecar from the same raw HTML. Only when the site's
      // feedSource is 'llm' do LLM title/date also update the item row.
      const extCfg = (siteCfg['extract'] ?? {}) as Record<string, unknown>;
      const llmExtractEnabled =
        config.defaults.llm_extract && Boolean(config.ai.api_key) && extCfg['llm'] !== false;
      const llmExtractor = llmExtractEnabled ? buildLlmExtractor(config) : null;
      const feedSource =
        extCfg['feedSource'] === 'llm' || extCfg['feedSource'] === 'tags'
          ? extCfg['feedSource']
          : config.defaults.feed_source;
      let changed = 0;
      let same = 0;
      let failed = 0;
      for (const row of rows) {
        let raw: string;
        if (opts.refetch) {
          const engine = config.defaults.engine;
          if (engine === 'firecrawl') {
            const r = await backends.firecrawl.scrape(row.url);
            raw = r.html;
          } else if (engine === 'plain') {
            raw = await backends.plain.fetch(row.url);
          } else {
            raw = await backends.camofox.fetch(row.url);
          }
          // Persist the freshly fetched HTML alongside the cleaned article so
          // later reprocess runs are local (sites scraped before
          // defaults.store_raw was enabled have raw_path NULL). Only camofox/
          // plain carry raw page HTML — the firecrawl path returns already-
          // cleaned main content, so there is nothing raw to save there.
          if (!row.raw_path && engine !== 'firecrawl') {
            const dataDir = resolve(ROOT, config.storage.data_dir, site);
            mkdirSync(dataDir, { recursive: true });
            const rawFileName = `${row.hash}.raw.html`;
            writeFileSync(join(dataDir, rawFileName), raw, 'utf8');
            db.prepare('UPDATE items SET raw_path=? WHERE site=? AND hash=?').run(
              join(config.storage.data_dir, site, rawFileName),
              site,
              row.hash,
            );
          }
        } else {
          const rawPath = resolve(ROOT, row.raw_path as string);
          if (!existsSync(rawPath)) {
            failed++;
            console.log(`missing raw: ${row.url}`);
            continue;
          }
          raw = readFileSync(rawPath, 'utf8');
        }
          try {
          const ext = (siteCfg['extract'] ?? {}) as Record<string, unknown>;
          const adMarkers = Array.isArray(ext['ad_markers'])
            ? (ext['ad_markers'] as unknown[]).map(String)
            : [];
          const cleaned = cleanHtml(raw, row.url, { adMarkers });
          const meta = extractMetadata(raw, row.url);
          const updates: Record<string, unknown> = {};
          if (cleaned) {
            const newHash = sha1(cleaned.content);
            if (newHash !== row.content_hash) {
              const absContent = resolve(ROOT, row.content_path);
              mkdirSync(dirname(absContent), { recursive: true });
              writeFileSync(absContent, cleaned.content, 'utf8');
              updates.content_hash = newHash;
            }
          }
          if (meta.publishedAt) {
            const t = Date.parse(meta.publishedAt);
            if (Number.isFinite(t) && t !== row.published_at) updates.published_at = t;
          }
          if ((!row.title || row.title === 'Untitled') && meta.title) {
            updates.title = meta.title;
          }
          // --- LLM extraction (parallel path, best-effort) ---
          // Re-run the AI extraction on the same raw HTML and refresh the
          // sidecar so the /item/<hash>/llm route and an 'llm' feedSource see
          // the current result. Failures are logged, never fatal.
          const llmBits: string[] = [];
          if (llmExtractor) {
            try {
              const llm = await llmExtractor(raw, row.url, cleaned?.text ?? undefined, cleaned?.content ?? undefined);
              if (llm) {
                const llmDataDir = resolve(ROOT, config.storage.data_dir, site);
                mkdirSync(llmDataDir, { recursive: true });
                writeFileSync(
                  join(llmDataDir, `${row.hash}.llm.json`),
                  JSON.stringify(
                    {
                      title: llm.title,
                      html: llm.html,
                      text: llm.text,
                      url: llm.url,
                      publishedAt: llm.publishedAt,
                      model: llm.model,
                      extractedAt: llm.extractedAt,
                    },
                    null,
                    2,
                  ),
                  'utf8',
                );
                llmBits.push('llm');
                if (feedSource === 'llm') {
                  // LLM fields win over tag fields when the feed reads LLM.
                  if (llm.title) updates.title = llm.title;
                  if (llm.publishedAt) {
                    const t = Date.parse(llm.publishedAt);
                    if (Number.isFinite(t)) updates.published_at = t;
                  }
                }
              } else {
                console.log(`llm extract: nothing usable ${row.url}`);
              }
            } catch (e) {
              console.log(`llm extract FAIL ${String(e).slice(0, 160)} ${row.url}`);
            }
          }
          const keys = Object.keys(updates);
          if (keys.length === 0 && llmBits.length === 0) {
            same++;
            continue;
          }
          changed++;
          if (keys.length > 0) {
            const setSql = keys.map((k) => `${k}=@${k}`).join(', ');
            db.prepare(
              `UPDATE items SET ${setSql} WHERE site=@site AND hash=@hash`,
            ).run({ site, hash: row.hash, ...updates });
          }
          const bits = [
            updates.content_hash ? 'content' : '',
            updates.published_at
              ? `date=${new Date(updates.published_at as number).toISOString()}`
              : '',
            updates.title ? `title` : '',
            ...llmBits,
          ].filter(Boolean);
          console.log(`updated [${bits.join(', ')}] ${row.url}`);
        } catch (e) {
          failed++;
          console.log(`FAIL ${String(e).slice(0, 160)} ${row.url}`);
        }
      }
console.log(`done: changed=${changed} same=${same} missing/failed=${failed}`);
      });
  });

program
  .command('scrape')
  .description('Run a manual scrape for a site — whole site, or one section (`scrape <site>` | `scrape <site>/<section>` | `scrape <site> <section>`).')
  .argument('<site>', 'site identifier — optionally `<site>/<section>`')
  .argument('[section]', 'only scrape this section')
  .option('--force', 're-discovers even if due time not reached (manual runs always scrape)')
  .action(async (site: string, section: string | undefined, opts: { force?: boolean }) => {
    let siteArg = site;
    let sectionArg = section;
    if (site.includes('/')) {
      const parts = site.split('/').filter((p) => p.length > 0);
      if (parts.length !== 2) {
        console.error(`invalid site/section '${site}' — expected <site>/<section>`);
        process.exitCode = 1;
        return;
      }
      siteArg = parts[0];
      if (sectionArg !== undefined && sectionArg !== parts[1]) {
        console.error(`section given twice with different values: '${site}' and '${section}'`);
        process.exitCode = 1;
        return;
      }
      sectionArg = parts[1];
    }
    await withDb(async (db, config) => {
      if (!getSite(db, siteArg)) {
        console.error(`unknown site '${siteArg}'`);
        process.exitCode = 1;
        return;
      }
      if (sectionArg !== undefined && !getSection(db, siteArg, sectionArg)) {
        console.error(`unknown section '${sectionArg}' on site '${siteArg}' — register it first: \`rssify add <section-index-url>\``);
        process.exitCode = 1;
        return;
      }
      console.log(`scraping ${siteArg}${sectionArg ? '/' + sectionArg : ''}…`);
      const result = await runSiteScrape(db, config, siteArg, sectionArg);
      if (!result) {
        console.log('skipped: another scrape already in flight for this site');
        return;
      }
      console.log(
        `done: status=${result.status} discovered=${result.discovered} new_items=${result.newItems}`,
      );
      if (result.error) console.log(`last error: ${result.error}`);
    });
  });

program
  .command('serve')
  .description('Start the HTTP server + scheduler.')
  .option('--port <port>', 'port to bind', undefined)
  .option('--host <host>', 'host to bind', undefined)
  .option('--all', 'serve every stored article in each feed (overrides defaults.feed_item_limit)')
  .option('--limit <n>', 'serve at most n articles per feed (0 = all)', undefined)
  .action(async (opts: { port?: string; host?: string; all?: boolean; limit?: string }) => {
    ensureConfig();
    const config = loadConfig();
    const port = Number(opts.port ?? config.server.port);
    const host = opts.host ?? config.server.host;
    if (opts.all && opts.limit !== undefined) {
      console.error('pass either --all or --limit, not both');
      process.exit(1);
    }
    let feedLimit: number | undefined;
    if (opts.all) feedLimit = 0; // 0 = all, see createApp
    if (opts.limit !== undefined) {
      feedLimit = Number(opts.limit);
      if (!Number.isInteger(feedLimit) || feedLimit < 0) {
        console.error(`--limit must be a non-negative integer, got: ${opts.limit}`);
        process.exit(1);
      }
    }
    const db = openDb(config);
    const app = createApp(db, config, feedLimit !== undefined ? { feedLimit } : {});
    const scheduler = new Scheduler(db, config);
    scheduler.start();

    const feedNote = feedLimit === 0 ? 'all articles' : feedLimit !== undefined ? `${feedLimit} articles/feed` : `${config.defaults.feed_item_limit} articles/feed (default)`;
    serve({ fetch: app.fetch, port: Number(port), hostname: host } as never, (info) => {
      logger.info({ host, port }, `rssify serving — feeds at http://${host}:${port}/<site> (${feedNote})`);
    });

    const shutdown = () => {
      logger.info('shutting down');
      scheduler.stop();
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Keep the process alive (serve already does; this guards streamed pino fds).
  });

program
  .command('remove')
  .description('Unregister a site (cascades rows; keeps data/ by default) or one section.')
  .argument('<site>', 'site identifier')
  .argument('[section]', 'remove only this section')
  .option('--purge', 'additionally delete data/<site>/ from disk')
  .action(async (site: string, section: string | undefined, opts: { purge?: boolean }) => {
    await withDb((db, config) => {
      if (!getSite(db, site)) {
        console.error(`unknown site '${site}'`);
        process.exitCode = 1;
        return;
      }
      if (section) {
        if (!getSite(db, site)) return;
        deleteSection(db, site, section);
        deleteOrphanItems(db, site);
        console.log(`removed section '${section}' from '${site}'`);
        return;
      }
      deleteSite(db, site);
      rmSync(join(ROOT, 'sites', `${site}.ts`), { force: true });
      rmSync(join(ROOT, 'sites', `${site}.config.json`), { force: true });
      if (opts.purge) {
        rmSync(join(ROOT, config.storage.data_dir, site), { recursive: true, force: true });
        console.log(`removed site '${site}' (module + sidecar + data purged)`);
      } else {
        console.log(`removed site '${site}' (module + sidecar deleted; data/<site>/ kept on disk)`);
      }
    });
  });

program
  .command('logs')
  .description('Recent scrape runs + log lines for a site.')
  .argument('<site>', 'site identifier')
  .option('--tail <n>', 'number of log lines to tail', '50')
  .action(async (site: string, opts: { tail: string }) => {
    await withDb((db) => {
      if (!getSite(db, site)) {
        console.error(`unknown site '${site}'`);
        process.exitCode = 1;
        return;
      }
      const runs = runsForSite(db, site, 20);
      if (runs.length) {
        console.log('\nRecent scrape runs:');
        printTable(
          ['id', 'started', 'status', 'discovered', 'new', 'quality', 'error'],
          runs.map((r) => {
            let q = '-';
            if (r.quality_json) {
              try {
                const qq = JSON.parse(r.quality_json) as { parsed?: number; bodyGood?: number; dateGood?: number };
                q = qq.parsed ? `${qq.bodyGood}/${qq.parsed} body, ${qq.dateGood}/${qq.parsed} date` : '-';  
              } catch {
                /* ignore */
              }
            }
            return [
              String(r.id),
              new Date(r.started_at).toISOString(),
              r.status ?? '-',
              String(r.discovered ?? '-'),
              String(r.new_items ?? '-'),
              q,
              (r.error ?? '').slice(0, 60) || '-',
            ];
          }),
        );
      }
      // Tail matching lines from the pino log file.
      const logFile = join(ROOT, 'logs', 'rssify.log');
      if (existsSync(logFile)) {
        const n = Math.max(1, parseInt(opts.tail, 10) || 50);
        const all = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        const lines = all
          .map((l) => {
            try {
              return JSON.parse(l) as { site?: string; time?: number; msg?: string; level?: number };
            } catch {
              return null;
            }
          })
          .filter((x): x is NonNullable<typeof x> => !!x && x.site === site)
          .slice(-n);
        if (lines.length) {
          console.log(`\nLast ${lines.length} log lines for '${site}':`);
          for (const l of lines) {
            console.log(
              `  ${new Date(l.time ?? Date.now()).toISOString()} ${lvl(l.level)} ${l.msg ?? ''}`,
            );
          }
        }
      }
      console.log('');
    });
  });

program
  .command('config')
  .description('Show or edit configuration (config.yaml + .env).')
  .argument('[action]', "show | set", 'show')
  .argument('[key]', 'dotted config path, e.g. ai.model')
  .argument('[value]', 'value to set')
  .action(async (action: string, key?: string, value?: string) => {
    ensureConfig();
    if (action === 'show') {
      const config = loadConfig();
      const printObj = (obj: unknown, prefix = '') => {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            if (v && typeof v === 'object') printObj(v, prefix + k + '.');
            else {
              // Mask secrets
              const path = prefix + k;
              const redacted = /key|secret|token/i.test(path) && v ? '***' : String(v);
              console.log(`  ${path} = ${redacted}`);
            }
          }
        }
      };
      console.log('config.yaml + .env (secrets masked):');
      printObj(config);
      console.log('\n  env file: .env');
      console.log('  use `rssify config set <key> <value>` to change (api_key values go to .env)');
      return;
    }
    if (action === 'set') {
      if (!key) {
        console.error('usage: rssify config set <key> <value>');
        process.exitCode = 1;
        return;
      }
      if (value === undefined) {
        console.error('usage: rssify config set <key> <value>');
        process.exitCode = 1;
        return;
      }
      try {
        const envKey = configSet(key, value);
        if (envKey) console.log(`set ${key} → .env (${envKey})`);
        else console.log(`set ${key} → config.yaml`);
        console.log('note: a running `serve` process does not hot-reload config — restart it.');
      } catch (e) {
        console.error(`config set failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    console.error(`unknown config action '${action}' (use show or set)`);
    process.exitCode = 1;
  });

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

function lvl(n: number | undefined): string {
  if (n === undefined) return '?';
  return n === 10 ? 'trace' : n === 20 ? 'debug' : n === 30 ? 'info' : n === 40 ? 'warn' : n === 50 ? 'error' : 'fatal';
}

program.parseAsync(process.argv).catch((e) => {
  console.error('fatal:', (e as Error).stack || (e as Error).message);
  process.exit(1);
});