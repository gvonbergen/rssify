/**
 * Fix-1/2 follow-up: re-extract LLM sidecars for the affected items.
 *
 * Groups (both driven by the same comparison as tmp_compare.ts):
 *   - stub:        llm body < 100 chars while tag text >= 1000 (model returned
 *                  "..." placeholders, accepted before the quality floor)
 *   - truncation:  llm text is a prefix of the tag text and much shorter
 *                  (previous extract_max_tokens=12000 cut outputs mid-sentence)
 *
 * For each item: read saved raw HTML (refetch via camofox when no raw exists),
 * re-run cleanHtml + LLM extraction with the new input/output limits, then
 * write the fresh sidecar — or REMOVE the stale one when the new extraction
 * returns nothing usable (the feed falls back to the tag text).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './src/logger.ts';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { textFromHtml, cleanHtml } from './src/clean.ts';
import { buildLlmExtractor } from './src/extract/llm.ts';
import { buildBackends } from './src/backends/index.ts';

const cfg = loadConfig();
const db = openDb(cfg);
const dataDir = cfg.storage.data_dir;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const items = db.prepare('SELECT site, hash, url, content_path, raw_path FROM items').all() as Array<{
  site: string; hash: string; url: string; content_path: string; raw_path: string | null;
}>;

const stubs: typeof items = [];
const truncs: typeof items = [];
for (const it of items) {
  const llmPath = join(dataDir, it.site, `${it.hash}.llm.json`);
  const htmlPath = resolve(ROOT, it.content_path);
  if (!existsSync(llmPath) || !existsSync(htmlPath)) continue;
  let llm: { text?: string | null };
  try { llm = JSON.parse(readFileSync(llmPath, 'utf8')); } catch { continue; }
  const llmText = norm(llm.text ?? '');
  const tagText = norm(textFromHtml(readFileSync(htmlPath, 'utf8')));
  if (!llmText || !tagText) continue;
  if (llmText.length < 100 && tagText.length >= 1000) stubs.push(it);
  else if (tagText.startsWith(llmText) && llmText.length < tagText.length * 0.99) truncs.push(it);
}
// Skip items that a previous run already fixed (fresh sidecar no longer
// matching the problem signature — cheap to re-check, avoids re-burning
// model credits on identical inputs).
const NOW = Date.now();
const stillBroken = (it: (typeof items)[number]) => {
  const llmPath = join(dataDir, it.site, `${it.hash}.llm.json`);
  if (!existsSync(llmPath)) return true;
  try {
    const llm = JSON.parse(readFileSync(llmPath, 'utf8')) as { text?: string | null; extractedAt?: number };
    const tagText = norm(textFromHtml(readFileSync(resolve(ROOT, it.content_path), 'utf8')));
    const llmText = norm(llm.text ?? '');
    if (!tagText) return false;
    if ((llm.extractedAt ?? 0) > NOW - 60 * 60 * 1000) return false; // fresh = done
    if (llmText.length < 100 && tagText.length >= 1000) return true;
    if (tagText.startsWith(llmText) && llmText.length < tagText.length * 0.99) return true;
    return false;
  } catch {
    return true;
  }
};
const fixList = { stubs: stubs.filter(stillBroken), truncs: truncs.filter(stillBroken) };
console.log(`targets: stubs=${stubs.length} truncations=${truncs.length} | to process: stubs=${fixList.stubs.length} truncs=${fixList.truncs.length}`);
const all = [...fixList.stubs, ...fixList.truncs];
if (all.length === 0) process.exit(0);

const llmExtractor = buildLlmExtractor(cfg);
const backends = buildBackends(cfg, console);

let ok = 0;
let removed = 0;
let failed = 0;
for (const it of all) {
  const llmPath = join(dataDir, it.site, `${it.hash}.llm.json`);
  try {
    // 1) raw HTML — saved sidecar or a fresh fetch (only needed for items
    //    stored before raw capture, e.g. one electronicpaymentsinternational).
    let raw: string;
    if (it.raw_path && existsSync(resolve(ROOT, it.raw_path))) {
      raw = readFileSync(resolve(ROOT, it.raw_path), 'utf8');
    } else {
      raw = await backends.camofox.fetch(it.url, { waitMs: 4000 });
      const rawPath = join(dataDir, it.site, `${it.hash}.raw.html`);
      mkdirSync(join(dataDir, it.site), { recursive: true });
      writeFileSync(rawPath, raw, 'utf8');
      console.log(`  (fetched raw ${it.url})`);
    }
    // 2) tag path (for the quality-floor comparison) + LLM re-extraction.
    const cleaned = cleanHtml(raw, it.url, {});
    const llm = await llmExtractor(raw, it.url, cleaned?.text, cleaned?.content);
    if (llm) {
      mkdirSync(join(dataDir, it.site), { recursive: true });
      writeFileSync(llmPath, JSON.stringify({
        title: llm.title, html: llm.html, text: llm.text, url: llm.url,
        publishedAt: llm.publishedAt, model: llm.model, extractedAt: llm.extractedAt,
      }, null, 2), 'utf8');
      ok++;
      console.log(`FIXED ${it.site} ${it.url}  text=${llm.text.length}${llm.publishedAt ? ' date=' + llm.publishedAt : ''}`);
    } else {
      // Keep nothing stale: without a sidecar the feed falls back to tag
      // text (an empty-object sidecar would NOT fall back — it would serve
      // a null description).
      if (existsSync(llmPath)) {
        const { rmSync } = await import('node:fs');
        rmSync(llmPath);
      }
      removed++;
      console.log(`REMOVED ${it.site} ${it.url} (re-extraction unusable → tag fallback)`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${it.site} ${it.url}: ${String(e).slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 2500)); // brief backoff on errors
  }
}

console.log(`done: re-extracted=${ok} removed-stale=${removed} failed=${failed}`);