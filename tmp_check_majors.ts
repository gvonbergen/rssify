/** Deep re-check of the "major" (<60% similarity) LLM-vs-tag items.
 *  For each: sidecar freshness, text AND html lengths vs tag text, similarity,
 *  and a verdict on which side actually carries the article. */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './src/logger.ts';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { textFromHtml } from './src/clean.ts';

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

const items = db.prepare('SELECT site, hash, url, title, content_path FROM items').all() as Array<{
  site: string; hash: string; url: string; title: string; content_path: string;
}>;

const CUTOFF = Date.parse('2026-08-17T07:30:00Z');
const out: string[] = [];
for (const it of items) {
  const llmPath = join(cfg.storage.data_dir, it.site, `${it.hash}.llm.json`);
  const htmlPath = resolve(ROOT, it.content_path);
  if (!existsSync(llmPath) || !existsSync(htmlPath)) continue;
  let llm: { text?: string | null; html?: string | null; extractedAt?: number; model?: string };
  try { llm = JSON.parse(readFileSync(llmPath, 'utf8')); } catch { continue; }
  const lt = norm(llm.text ?? '');
  const tt = norm(textFromHtml(readFileSync(htmlPath, 'utf8')));
  if (!lt || !tt) continue;
  const sim = dice(tt, lt);
  if (sim >= 0.6) continue; // only majors
  const lh = norm(textFromHtml(llm.html ?? ''));
  const fresh = (llm.extractedAt ?? 0) >= CUTOFF;
  const ratioText = lt.length / Math.max(1, tt.length);
  const ratioHtml = lh.length / Math.max(1, tt.length);
  let verdict: string;
  if (tt.length < 1000) {
    verdict = lt.length > tt.length ? 'tag-garbage/llm-better' : 'both-tiny';
  } else if (ratioHtml >= 0.8 && ratioText < 0.6) {
    verdict = 'html-full-text-short';
  } else if (ratioText < 0.6) {
    verdict = 'condensed-both';
  } else {
    verdict = 'other';
  }
  const fd = (() => { for (let i = 0; i < Math.min(lt.length, tt.length); i++) if (lt[i] !== tt[i]) return i; return -1; })();
  out.push(`\n[${verdict}${fresh ? ' RE-EXTRACTED' : ' OLD'}] sim=${(sim * 100).toFixed(1)}% text=${lt.length} (${(ratioText * 100).toFixed(0)}%) html=${lh.length} (${(ratioHtml * 100).toFixed(0)}%) tag=${tt.length} ${it.site} ${it.url}`);
  out.push(`  title: ${it.title.slice(0, 70)}`);
  if (fd >= 0) {
    out.push(`  LLM…: ${lt.slice(Math.max(0, fd - 60), fd + 90)}`);
    out.push(`  TAG…: ${tt.slice(Math.max(0, fd - 60), fd + 90)}`);
  } else {
    out.push(`  (same start; diff later)`);
  }
}

const text = out.join('\n');
console.log(text);
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/majors_recheck.txt', text, 'utf8');
console.log('\n(wrote /tmp/majors_recheck.txt)');
const verdictCount = (v: string) => (text.match(new RegExp(`^\\[${v}`, 'gm')) ?? []).length;
console.log('verdicts — condensed-both:', verdictCount('condensed-both'),
  '| html-full-text-short:', verdictCount('html-full-text-short'),
  '| tag-garbage/llm-better:', verdictCount('tag-garbage/llm-better'),
  '| both-tiny:', verdictCount('both-tiny'),
  '| other:', verdictCount('other'),
  '| re-extracted:', (text.match(/RE-EXTRACTED/g) ?? []).length);