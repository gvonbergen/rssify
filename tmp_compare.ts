/**
 * Compare LLM-extracted article text vs the "normal" (tag/readability) text
 * for every item that has an .llm.json sidecar.
 *
 *   tag text = textFromHtml(cleaned html at content_path)   [same as tag feed]
 *   llm text = .llm.json text (verbatim LLM extraction)
 *
 * Divergence score = 1 - word-multiset Dice similarity on whitespace-normalized
 * text. Output sorted by divergence, highest first.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { textFromHtml } from './src/clean.ts';

const cfg = loadConfig();
const db = openDb(cfg);
const dataDir = cfg.storage.data_dir;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function words(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of s.match(/\p{L}[\p{L}\p{N}]*/gu) ?? []) {
    m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  let ta = 0;
  let tb = 0;
  for (const [w, c] of wa) ta += c;
  for (const [w, c] of wb) tb += c;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const [w, c] of small) {
    const cb = big.get(w);
    if (cb !== undefined) inter += Math.min(c, cb);
  }
  return (2 * inter) / (ta + tb);
}

/** First divergence position (char index into normalized strings), or -1 if equal. */
function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

interface Row {
  site: string;
  hash: string;
  url: string;
  title: string;
  llmText: string;
  tagText: string;
  similar: number; // Dice
  kind: string;
  snippetTag: string;
  snippetLlm: string;
}

const SEV: Record<string, number> = {
  'stub': 0, 'major': 1, 'tag-prefix-of-llm': 2, 'llm-prefix-of-tag': 3,
  'moderate': 4, 'minor': 5, 'tag-failed-llm-ok': 6, 'equal': 7,
};

const items = db
  .prepare(`SELECT site, hash, url, title, content_path FROM items`)
  .all() as Array<{ site: string; hash: string; url: string; title: string; content_path: string }>;

const rows: Row[] = [];
let missingHtml = 0;
let missingLlm = 0;
let noText = 0;

for (const it of items) {
  const llmPath = join(dataDir, it.site, `${it.hash}.llm.json`);
  const htmlPath = it.content_path.startsWith('/') || it.content_path.startsWith('.')
    ? it.content_path
    : join(dataDir, it.site, `${it.hash}.html`);
  if (!existsSync(llmPath)) { missingLlm++; continue; }
  if (!existsSync(htmlPath)) { missingHtml++; continue; }
  let llm: { text?: string | null };
  let html: string;
  try {
    llm = JSON.parse(readFileSync(llmPath, 'utf8')) as { text?: string | null };
    html = readFileSync(htmlPath, 'utf8');
  } catch { continue; }
  const llmRaw = (llm.text ?? '').trim();
  const tagRaw = textFromHtml(html).trim();
  if (!llmRaw || !tagRaw) { noText++; continue; }

  const ln = norm(llmRaw);
  const tn = norm(tagRaw);
  const sim = dice(tn, ln);
  let kind: Row['kind'];
  const minLen = Math.min(ln.length, tn.length);
  const prefixLen = ln.length >= tn.length && ln.startsWith(tn) ? tn.length
    : tn.startsWith(ln) ? ln.length : 0;
  const ratio = ln.length / Math.max(1, tn.length);
  // LLM "extraction" that only produced a stub (title + a few chars) while the
  // tag path has a real body — accepted because the success check only requires
  // any one field, so no quality floor on the body.
  if (ln.length < 150 && tn.length >= 1000) kind = 'stub';
  else if (tn.length < 150 && ln.length >= 1000) kind = 'tag-failed-llm-ok';
  else if (sim >= 0.999) kind = 'equal';
  else if (prefixLen >= minLen * 0.98) kind = ratio > 1 ? 'tag-prefix-of-llm' : 'llm-prefix-of-tag';
  else if (sim >= 0.95) kind = 'minor';
  else if (sim >= 0.6) kind = 'moderate';
  else kind = 'major';

  // Snippet around the first divergence (in the longer text region).
  const fd = firstDiff(tn, ln);
  let snippetTag = '';
  let snippetLlm = '';
  if (fd >= 0) {
    snippetTag = tn.slice(Math.max(0, fd - 90), fd + 110);
    snippetLlm = ln.slice(Math.max(0, fd - 90), fd + 110);
  }
  rows.push({
    site: it.site, hash: it.hash, url: it.url, title: it.title,
    llmText: ln, tagText: tn, similar: sim, kind,
    snippetTag, snippetLlm,
  });
}

rows.sort((x, y) => SEV[x.kind] - SEV[y.kind] || (1 - y.similar) - (1 - x.similar) || (Math.abs(y.llmText.length - y.tagText.length) - Math.abs(x.llmText.length - x.tagText.length)));

const interesting = rows.filter(r => r.kind !== 'equal');
const outPath = '/tmp/llm_vs_tag_divergences.txt';
const out: string[] = [];
const push = (s: string) => { out.push(s); console.log(s); };

console.log(`missing llm sidecars: ${missingLlm} | missing html: ${missingHtml} | empty either side: ${noText}`);
const count = (k: Row['kind']) => rows.filter(r => r.kind === k).length;
console.log(`equal: ${count('equal')} · minor (>=95%): ${count('minor')} · moderate (60-95%): ${count('moderate')} · major (<60%): ${count('major')} · STUB(llm garbage): ${count('stub')} · truncation: ${count('llm-prefix-of-tag') + count('tag-prefix-of-llm')} (llm→tag ${count('llm-prefix-of-tag')}, tag→llm ${count('tag-prefix-of-llm')}) · tag-failed-llm-ok: ${count('tag-failed-llm-ok')}`);

const top = interesting.slice(0, 60);
for (let i = 0; i < top.length; i++) {
  const r = top[i];
  const simPct = (r.similar * 100).toFixed(1);
  const llmK = Math.round(r.llmText.length / 1000 * 10) / 10;
  const tagK = Math.round(r.tagText.length / 1000 * 10) / 10;
  push(`\n#${i + 1} [${r.kind}] sim=${simPct}% llm=${llmK}k tag=${tagK}k ${r.site} ${r.url}`);
  push(`  hash=${r.hash}  title: ${r.title.slice(0, 80)}`);
  if (r.snippetLlm || r.snippetTag) {
    push(`  LLM…: ${r.snippetLlm.slice(0, 140)}`);
    push(`  TAG…: ${r.snippetTag.slice(0, 140)}`);
  }
}
push(`\n(full list: ${outPath} — ${interesting.length} interesting / ${rows.length} total)`);
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, out.join('\n'), 'utf8');