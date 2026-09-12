import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanHtml, extractMetadata, parseJsonLdLenient } from '../src/clean.ts';
import { looksLikeJunkBody } from '../src/quality.ts';

// Regression fixtures for the P1 generic extraction fixes (2026-09 six-page +
// last-100 audits): PANews-style Readability footer mis-selection and
// Moneycontrol-style malformed JSON-LD / articleBody-only / og:article
// date data. Both defects were live at HEAD and are fixed by GENERIC
// second-chance recovery — no site-specific code.
const FIXTURES = join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const panewsFixture = () => readFixture('panews-footer-selection.html');
const mcFixture = () => readFixture('moneycontrol-jsonld-raw.html');
const MC_URL = 'https://www.moneycontrol.com/news/business/ipo/nsdl-launches-demat-2-0-14028080.html';
const PANEWS_URL = 'https://www.panewslab.com/en/articles/01a08f43';

test('PANews-style footer mis-selection: second-chance <article> extraction recovers the brief', () => {
  const raw = readFixture('panews-footer-selection.html');
  // Root cause pinned: Readability selects the ~145-word SSR footer
  // disclaimer plate over the 358-char article brief; the disclaimer is junk
  // (footer-only plate leading the body), which arms the recovery.
  const disclaimerOnly = looksLikeJunkBody(
    'Not financial or tax advice. The content on this website is for general information and educational purposes only and does not constitute financial, investment, legal or tax advice of any kind. Disclosure: The author of this article may hold positions in some of the assets mentioned above at the time of publishing. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.',
  );
  assert.equal(disclaimerOnly.junk, true, 'the PANews disclaimer plate must classify junk');
  assert.match(disclaimerOnly.reason ?? '', /footer-only/);

  const cleaned = cleanHtml(raw, PANEWS_URL);
  assert.ok(cleaned, 'fixture should clean');
  // The recovered body is the actual one-paragraph brief …
  assert.match(cleaned.text, /President of Sberbank/);
  assert.match(cleaned.text, /rupees, and payments can be made in national currencies/);
  // … and the footer plate that Readability preferred is gone.
  assert.doesNotMatch(cleaned.text, /Not financial or tax advice|reCAPTCHA|Terms of Service apply/);
  assert.equal(looksLikeJunkBody(cleaned.text, cleaned.content).junk, false);
  // Metadata (date/author) were always fine on this page shape.
  const meta = extractMetadata(raw, PANEWS_URL);
  assert.equal(meta.publishedAt, '2026-09-11T06:55:00.000Z');
  assert.equal(meta.author, 'PA一线');
});

test('Moneycontrol-style malformed JSON-LD: lenient parse recovers date + author, articleBody becomes the body', () => {
  const raw = mcFixture();
  // The fixture carries Moneycontrol's exact defect: literal newlines inside
  // JSON string literals, which make strict JSON.parse throw.
  const ldText = raw.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
  assert.throws(() => JSON.parse(ldText), /control character/i);
  const meta = extractMetadata(raw, MC_URL);
  assert.equal(meta.publishedAt, '2026-09-11T17:50:39+05:30');
  assert.equal(meta.author, 'Khushi Keswani');
  assert.equal(meta.title, 'NSDL launches Demat 2.0: a next-generation platform for tokenised securities');

  // The DOM body is the consent-wall shape (junk), so the article-typed JSON-LD
  // `articleBody` is sanitized into the stored body.
  const cleaned = cleanHtml(raw, MC_URL);
  assert.ok(cleaned);
  assert.equal(looksLikeJunkBody(cleaned.text, cleaned.content).junk, false);
  assert.match(cleaned.text, /National Securities Depository Limited has launched Demat 2\.0/);
  assert.match(cleaned.text, /advises users to check with certified experts/);
  // The widget/consent DOM is NOT the body.
  assert.doesNotMatch(cleaned.text, /USER CONSENT|manage cookie preferences|Did our AI summary help/);
  // Sanitized: plain escaped paragraphs only — no attributes, tags, or raw
  // source markup from the articleBody survive.
  assert.doesNotMatch(cleaned.content, /<p [^>]*>|<script|<style|onerror=|href=/i);
  assert.equal((cleaned.content.match(/<p>/g) ?? []).length, 4);
});

test('og:article:published_time is recognized when no JSON-LD date exists', () => {
  const html = `<html><head>
    <meta property="og:title" content="T">
    <meta property="og:article:published_time" content="2026-09-11T17:50:39+05:30">
  </head><body>No structured date here</body></html>`;
  assert.equal(extractMetadata(html, 'https://example.test/x').publishedAt, '2026-09-11T17:50:39+05:30');
  // Plain `article:published_time` still wins when both are present.
  const both = `<html><head>
    <meta property="article:published_time" content="2026-09-10T00:00:00Z">
    <meta property="og:article:published_time" content="2026-09-11T00:00:00Z">
  </head><body></body></html>`;
  assert.equal(extractMetadata(both, 'https://example.test/x').publishedAt, '2026-09-10T00:00:00Z');
});

test('parseJsonLdLenient: strict-parseable blocks pass through untouched; other malformation stays discarded', () => {
  const wellFormed = '{"@type":"NewsArticle","headline":"ok"}';
  assert.deepEqual(parseJsonLdLenient(wellFormed), { '@type': 'NewsArticle', headline: 'ok' });
  // Literal newline inside a string literal → repaired, not discarded.
  const withRawNewline = '{"@type":"NewsArticle","articleBody":"line one\nline two"}';
  assert.throws(() => JSON.parse(withRawNewline));
  assert.equal((parseJsonLdLenient(withRawNewline) as { articleBody: string }).articleBody, 'line one\nline two');
  // Control characters that already have short escapes are preserved exactly.
  const preEscaped = '{"@type":"NewsArticle","articleBody":"a\\nb\\u0001c"}';
  assert.equal((parseJsonLdLenient(preEscaped) as { articleBody: string }).articleBody, 'a\nb\x01c');
  // Escaped quotes inside strings are never treated as string boundaries.
  const escapedQuotes = '{"headline":"say \\"hi\\",\n ok"}';
  assert.equal((parseJsonLdLenient(escapedQuotes) as { headline: string }).headline, 'say "hi",\n ok');
  // Structurally broken JSON (not a control-char problem) stays discarded.
  assert.equal(parseJsonLdLenient('{"headline": "truncated'), undefined);
  assert.equal(parseJsonLdLenient(''), undefined);
});

test('negative: a junk <article> element is never promoted over a junk primary', () => {
  // Both candidates are consent-wall junk: the second chance must reject the
  // <article> candidate — the final result stays a junk body, so nothing is
  // promoted as good article content (and the fetch cascade can still advance).
  const consent = 'We use cookies to personalize content and measure audience insights. '.repeat(12) + 'manage cookie preferences to continue.';
  const raw = `<!doctype html><html><head><title>t</title></head><body>
    <div>${'Unrelated scaffold fragment. '.repeat(6)}</div>
    <article class="lede">${consent}</article>
  </body></html>`;
  const cleaned = cleanHtml(raw, 'https://example.test/x');
  assert.ok(cleaned);
  assert.match(cleaned.text, /Unrelated scaffold fragment/);
  assert.equal(looksLikeJunkBody(cleaned.text, cleaned.content).junk, true);
});

test('negative: articleBody is not used when the cleaned body is fine, too small, or picture-shaped', () => {
  const goodBody = `<p>${'A complete and well-formed article paragraph with plenty of detail. '.repeat(6)}</p>`;
  const ldBody = '{"@type":"NewsArticle","articleBody":"National Securities Depository Limited has launched Demat 2.0, a next-generation platform that supports tokenised securities and extends the demat framework."}';

  // Healthy primary: the JSON-LD articleBody must never replace it.
  const healthy = `<!doctype html><html><head><script type="application/ld+json">${ldBody}</script></head><body>${goodBody}</body></html>`;
  const r1 = cleanHtml(healthy, 'https://example.test/a');
  assert.ok(r1);
  assert.match(r1.text, /well-formed article paragraph/);
  assert.doesNotMatch(r1.text, /Demat 2\.0|tokenised securities/);

  // A trivial (<200 char) articleBody never replaces anything.
  const tinyLd = '{"@type":"NewsArticle","articleBody":"Too short to be a body."}';
  const tiny = `<!doctype html><html><head><script type="application/ld+json">${tinyLd}</script></head><body><div>${'Short scaffold line. '.repeat(4)}</div></body></html>`;
  const r2 = cleanHtml(tiny, 'https://example.test/b');
  assert.ok(r2);
  assert.doesNotMatch(r2.text, /Too short to be a body/);
  assert.match(r2.text, /Short scaffold line/);

  // Picture-item guard: a near-empty body carrying an image is a legitimate
  // photo card — the articleBody text must never replace it.
  const picture = `<!doctype html><html><head><script type="application/ld+json">{"@type":"NewsArticle","articleBody":"National Securities Depository Limited has launched Demat 2.0, a next-generation platform that supports tokenised securities and extends the existing demat framework for investors."}</script></head><body><figure><img src="/photo.jpg"><figcaption>A photograph caption for the wire card.</figcaption></figure></body></html>`;
  const r3 = cleanHtml(picture, 'https://example.test/c');
  assert.ok(r3);
  assert.match(r3.content, /<img src="https:\/\/example\.test\/photo\.jpg">/);
  assert.doesNotMatch(r3.text, /Demat 2\.0/);
});

test('negative: boilerplate markers apply to a recovered articleBody; recovered content is sanitized', () => {
  // A promo line inside the JSON-LD body matching a configured boilerplate
  // marker must be trimmed from the recovered body like any other block.
  const ld = '{"@type":"NewsArticle","articleBody":"National Securities Depository Limited has launched Demat 2.0, a next-generation platform that supports tokenised securities and extends the existing demat framework for onchain settlement of fund units.\\nMarket Mastery Webinar: Register now for the live session."}';
  const raw = `<!doctype html><html><head><script type="application/ld+json">${ld}</script></head><body><div>${'Short scaffold line. '.repeat(4)}</div></body></html>`;
  const cleaned = cleanHtml(raw, 'https://example.test/d', {
    boilerplateMarkers: ['market mastery webinar'],
  });
  assert.ok(cleaned);
  assert.match(cleaned.text, /launched Demat 2\.0/);
  assert.doesNotMatch(cleaned.text, /Market Mastery Webinar/);

  // Markup inside the articleBody never survives: it is treated as text and
  // re-escaped, so no injected tag/attribute reaches the stored content.
  const hostile = '{"@type":"NewsArticle","articleBody":"National Securities Depository Limited has launched Demat 2.0, a next-generation platform that supports tokenised securities and extends the demat framework for onchain settlement of fund units and equities. <img src=x onerror=alert(1)>"}';
  const raw2 = `<!doctype html><html><head><script type="application/ld+json">${hostile}</script></head><body><div>${'Short scaffold line. '.repeat(4)}</div></body></html>`;
  const cleaned2 = cleanHtml(raw2, 'https://example.test/e');
  assert.ok(cleaned2);
  assert.match(cleaned2.text, /launched Demat 2\.0/);
  // Markup inside the articleBody never survives: cheerio text extraction
  // drops tags wholesale, so an injected <img onerror=…> contributes nothing
  // to the stored content.
  assert.doesNotMatch(cleaned2.content, /<img|onerror|&lt;img/);
});
