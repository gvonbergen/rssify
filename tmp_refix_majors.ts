/** Re-extract ALL "major" (<60% sim) LLM sidecars with the current
 *  max_input_chars=40000 / extract_max_tokens=32000 budget.
 *  These were extracted on Aug 16 under the old 12000-token cap, which is why
 *  the model "condensed" them. Skips items already refreshed this run class. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './src/logger.ts';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { textFromHtml, cleanHtml } from './src/clean.ts';
import { buildLlmExtractor } from './src/extract/llm.ts';
import { buildBackends } from './src/backends/index.ts';

const cfg = loadConfig();
const db = openDb(cfg);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function words(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of s.match(/\p{L}[\p{L}\p{N}]*/gu) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
function dice(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0, ta = 0, tb = 0;
  for (const c of wa.values()) ta += c;
  for (const c of wb.values()) tb += c;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const [w, c] of small) { const cb = big.get(w); if (cb !== undefined) inter += Math.min(c, cb); }
  return (2 * inter) / (ta + tb);
}

const CUTOFF = Date.now() - 60 * 60 * 1000; // refreshed within the last hour = done
const items = db.prepare('SELECT site, hash, url, content_path, raw_path FROM items').all() as Array<{
  site: string; hash: string; url: string; content_path: string; raw_path: string | null;
}>;

const targets: typeof items = [];
for (const it of items) {
  const llmPath = join(cfg.storage.data_dir, it.site, `${it.hash}.llm.json`);
  const htmlPath = resolve(ROOT, it.content_path);
  if (!existsSync(llmPath) || !existsSync(htmlPath)) continue;
  let llm: { text?: string | null; extractedAt?: number };
  try { llm = JSON.parse(readFileSync(llmPath, 'utf8')); } catch { continue; }
  const lt = norm(llm.text ?? '');
  const tt = norm(textFromHtml(readFileSync(htmlPath, 'utf8')));
  if (!lt || !tt) continue;
  if ((llm.extractedAt ?? 0) > CUTOFF) continue;
  const sim = dice(tt, lt);
  if (sim < 0.6) targets.push(it);
}
console.log(`major targets: ${targets.length}`);

const llmExtractor = buildLlmExtractor(cfg);
const backends = buildBackends(cfg, console);
let ok = 0, removed = 0, failed = 0;
for (const it of targets) {
  const llmPath = join(cfg.storage.data_dir, it.site, `${it.hash}.llm.json`);
  const started = Date.now();
  try {
    let raw: string;
    if (it.raw_path && existsSync(resolve(ROOT, it.raw_path))) {
      raw = readFileSync(resolve(ROOT, it.raw_path), 'utf8');
    } else {
      raw = await backends.camofox.fetch(it.url, { waitMs: 4000 });
      const rawPath = join(cfg.storage.data_dir, it.site, `${it.hash}.raw.html`);
      mkdirSync(join(cfg.storage.data_dir, it.site), { recursive: true });
      writeFileSync(rawPath, raw, 'utf8');
      console.log(`  (fetched raw ${it.url})`);
    }
    const cleaned = cleanHtml(raw, it.url, {});
    const llm = await llmExtractor(raw, it.url, cleaned?.text, cleaned?.content);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (llm) {
      mkdirSync(join(cfg.storage.data_dir, it.site), { recursive: true });
      writeFileSync(llmPath, JSON.stringify({
        title: llm.title, html: llm.html, text: llm.text, url: llm.url,
        publishedAt: llm.publishedAt, model: llm.model, extractedAt: llm.extractedAt,
      }, null, 2), 'utf8');
      ok++;
      console.log(`FIXED ${it.site} ${it.url}  text=${llm.text.length} (${secs}s)`);
    } else {
      rmSync(llmPath);
      removed++;
      console.log(`REMOVED ${it.site} ${it.url} (null → tag fallback, ${secs}s)`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${it.site} ${it.url}: ${String(e).slice(0, 100)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log(`done: re-extracted=${ok} removed-stale=${removed} failed=${failed}`);