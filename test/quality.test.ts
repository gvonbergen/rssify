import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeJunkBody } from '../src/quality.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
  matchSkipPatterns,
  matchUrlBlacklist,
  matchesBlacklistEntry,
  matchesSkipPattern,
  resolveSkipUrlPatterns,
  resolveUrlBlacklist,
} from '../src/skip.ts';
import { blockMarkerHit, stripBoilerplateBlocks, withHeroImage } from '../src/clean.ts';

// ---------------------------------------------------------------------------
// Junk-body classification (src/quality.ts) — cases mirror the 2026-09
// extraction-quality audits (150-item Camofox recheck + prior audit).
// ---------------------------------------------------------------------------

test('gate/error markers classify as junk regardless of body length', () => {
  // MenAFN JS gate (14 words).
  assert.equal(looksLikeJunkBody('Javascript is required. Please enable javascript before you are allowed to see this page.').junk, true);
  // YouTube playback-error stub.
  assert.equal(looksLikeJunkBody("If playback doesn't begin shortly, try restarting your device.").junk, true);
  // Business Wire error page (32 words, "Reference Error ID").
  const bw = 'Please be advised that this page is unavailable. Reference Error ID: 0.57b62417. Client IP: 212.51.156.93. If you continue to experience problems, contact support with the reference error id above.';
  assert.equal(looksLikeJunkBody(bw).junk, true);
});

test('consent-dominated bodies are junk even at substantial length (Moneycontrol shape)', () => {
  const articleWords = 'The regulator published new guidance on stablecoin reserves on Tuesday clarifying that issuers must hold one-to-one high quality liquid assets and submit to monthly attestations. Industry participants welcomed the clarity while noting the attestation cadence is stricter than other jurisdictions require.'.split(' ');
  const consent = 'I agree to the updated privacy policy and terms of use and to receiving direct marketing communications via Emails and SMS. You can manage cookie preferences at any time in the settings centre. We and our partners process personal data such as IP address and device identifiers to personalise content. Choose accept all to consent or manage preferences to decline.';
  const text = `${articleWords.join(' ')} ${consent}`;
  // ~45 consent words out of ~100 total → the tail dominates the body.
  const verdict = looksLikeJunkBody(text);
  assert.equal(verdict.junk, true);
  assert.match(verdict.reason ?? '', /consent/);
});

test('a complete article with a small consent tail is NOT junk (Finextra shape)', () => {
  const body = `The European Banking Authority has published updated guidance on the treatment of electronic money institutions. ${'Clarifying capital requirements that apply when client funds are held overnight in segregated accounts. '.repeat(6)}`;
  const text = `${body} We use cookies to improve your experience. Accept or manage preferences.`;
  const verdict = looksLikeJunkBody(text);
  assert.equal(verdict.junk, false);
});

test('subscription-offer walls are junk even when long (FT syndication shape)', () => {
  const offer =
    'Subscribe to unlock this article. Choose a subscription plan that suits you. Already a subscriber? Sign in. ' +
    'Save 40% when you subscribe to unlock this article for a full year and continue reading this article and every report on the platform. ';
  const verdict = looksLikeJunkBody(offer.repeat(6));
  assert.equal(verdict.junk, true);
  assert.match(verdict.reason ?? '', /subscription-offer/);
});

test('a single subscription marker in a longer body is never junk on its own', () => {
  const body = `The publisher said it will subscribe to unlock additional funding for the newsroom expansion announced on Monday. ${'The expansion plan covers hiring across three regional bureaus and a data team. '.repeat(12)}`;
  assert.equal(looksLikeJunkBody(body).junk, false);
});

test('copyright/footer-only plates are junk; short real briefs are not (TradingView/CoinDesk vs complete brief)', () => {
  const footer = '© 2026 FactSet Research Systems Inc. and Intercontinental Exchange, Inc. All rights reserved. Disclosure: The author holds no positions. Reprinted with permission.';
  const verdict = looksLikeJunkBody(footer);
  assert.equal(verdict.junk, true);
  assert.match(verdict.reason ?? '', /footer-only/);
  // A complete 85-word brief (verified OK in the audit) is never junk: its
  // paragraphs are substantial.
  const brief = 'The payments firm said on Tuesday that its new settlement network had processed its first billion dollars in volume. ' +
    'The milestone came eight months after launch, driven by cross-border corridors between the EU and Southeast Asia. ' +
    'A company spokesperson said transaction volume had doubled quarter over quarter, and that the firm now serves forty institutional clients across nine currencies.';
  assert.equal(looksLikeJunkBody(brief).junk, false);
  // A real note ENDING with a disclosure line is not a footer plate: the
  // marker appears late in the body.
  const note = `${brief} Disclosure: the author holds no positions in the mentioned securities.`;
  assert.equal(looksLikeJunkBody(note).junk, false);
});

test('nav-only fragments are junk on structure, not length alone (DNA India shape)', () => {
  const nav = 'Markets; Crypto; Economy; Companies; Topics; Multimedia; More; Home; Latest; Trending; Live TV; Newsletter; Login';
  const verdict = looksLikeJunkBody(nav, `<div><span>${nav}</span></div>`);
  assert.equal(verdict.junk, true);
  assert.match(verdict.reason ?? '', /structure-thin/);
});

test('empty body is junk; plain substantial text never fires', () => {
  assert.equal(looksLikeJunkBody('').junk, true);
  const long = `Regulators published the final rule on reserve composition for payment stablecoin issuers today. ${'The rule requires issuers to hold reserves in short-dated government securities and insured deposits. '.repeat(8)}`;
  assert.equal(looksLikeJunkBody(long).junk, false);
});

// ---------------------------------------------------------------------------
// Configurable source-URL blacklist (YouTube by default)
// ---------------------------------------------------------------------------

test('default blacklist covers YouTube hosts and subdomains, nothing else', () => {
  const entries = resolveUrlBlacklist(DEFAULT_CONFIG, {});
  assert.deepEqual(entries, ['youtube.com', 'youtu.be']);
  for (const url of [
    'https://www.youtube.com/watch?v=Ic9Pq7FuoPw',
    'https://youtube.com/watch?v=abc',
    'https://m.youtube.com/watch?v=abc',
    'https://music.youtube.com/watch?v=abc',
    'https://youtu.be/Ic9Pq7FuoPw',
  ]) {
    const hit = matchUrlBlacklist(url, entries);
    assert.ok(hit, `expected ${url} to match the default blacklist`);
    assert.match(hit ?? '', /youtu/);
  }
  // Non-blacklisted hosts are untouched.
  assert.equal(matchUrlBlacklist('https://www.pymnts.com/news/a1', entries), null);
  assert.equal(matchUrlBlacklist('https://notyoutube.com/watch?v=1', entries), null);
  assert.equal(matchUrlBlacklist('https://youtube.com.evil.example/watch', entries), null);
});

test('blacklist entries may carry a path prefix to narrow the match', () => {
  assert.equal(matchesBlacklistEntry('https://www.youtube.com/shorts/abc', 'youtube.com/shorts'), true);
  assert.equal(matchesBlacklistEntry('https://www.youtube.com/watch?v=1', 'youtube.com/shorts'), false);
  // youtu.be is a distinct host: a youtube.com entry does not cover it.
  assert.equal(matchesBlacklistEntry('https://youtu.be/abc', 'youtube.com'), false);
  assert.equal(matchesBlacklistEntry('not a url', 'youtube.com'), false);
  assert.equal(matchesBlacklistEntry('https://example.com', ''), false);
});

test('per-site extract.urlBlacklist replaces the global list (empty disables)', () => {
  const siteCfg = { extract: { urlBlacklist: ['example.org/quotes'] } };
  assert.deepEqual(resolveUrlBlacklist(DEFAULT_CONFIG, siteCfg), ['example.org/quotes']);
  assert.deepEqual(resolveUrlBlacklist(DEFAULT_CONFIG, { extract: { urlBlacklist: [] } }), []);
  assert.deepEqual(resolveUrlBlacklist(DEFAULT_CONFIG, { extract: { url_blacklist: ['a.com'] } }), ['a.com']);
  // Non-array garbage falls back to the global list.
  assert.deepEqual(resolveUrlBlacklist(DEFAULT_CONFIG, { extract: { urlBlacklist: 'youtube.com' } }), ['youtube.com', 'youtu.be']);
});

// ---------------------------------------------------------------------------
// Narrow non-article URL-pattern filter
// ---------------------------------------------------------------------------

test('skip patterns match one URL shape without banning the host', () => {
  const patterns = ['cnbc.com/quote/*', 'en.macromicro.me/charts/*', 'marketscreener.com/quote/*'];
  assert.equal(matchSkipPatterns('https://www.cnbc.com/quote/USDJPY', patterns), 'cnbc.com/quote/*');
  assert.equal(matchSkipPatterns('https://www.cnbc.com/2026/09/11/an-article.html', patterns), null);
  assert.equal(matchSkipPatterns('https://en.macromicro.me/charts/12345/us-gdp', patterns), 'en.macromicro.me/charts/*');
  assert.equal(matchSkipPatterns('https://www.marketscreener.com/quote/stock/X/', patterns), 'marketscreener.com/quote/*');
});

test('matchesSkipPattern: wildcard + case-insensitive + malformed inputs', () => {
  // A bare-host pattern matches subdomains too (www.), but still only its
  // own URL shape when a path prefix is present.
  assert.equal(matchesSkipPattern('https://www.Thepaypers.com/reports/xyz', 'thepaypers.com/reports/*'), true);
  assert.equal(matchesSkipPattern('https://www.cnbc.com/quote/USDJPY', 'cnbc.com/quote/*'), true);
  assert.equal(matchesSkipPattern('https://thepaypers.com/other/page', 'thepaypers.com/reports/*'), false);
  assert.equal(matchesSkipPattern('https://a.com/quote', 'a.com/quote'), true);
  assert.equal(matchesSkipPattern('https://a.com/quotex', 'a.com/quote'), false);
  assert.equal(matchesSkipPattern('https://a.com/x', ''), false);
  assert.equal(matchesSkipPattern('garbage', 'a.com/*'), false);
  // '*' matches across separators, including the host part.
  assert.equal(matchesSkipPattern('https://cdn.dealroom.co/reports/widget/1', '*.dealroom.co/*'), true);
});

test('per-site extract.skipUrlPatterns replaces the global list', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.defaults.skip_url_patterns = ['cnbc.com/quote/*'];
  assert.deepEqual(resolveSkipUrlPatterns(cfg, { extract: { skipUrlPatterns: ['a.com/charts/*'] } }), ['a.com/charts/*']);
  assert.deepEqual(resolveSkipUrlPatterns(cfg, {}), ['cnbc.com/quote/*']);
});

// ---------------------------------------------------------------------------
// Boilerplate block trimming
// ---------------------------------------------------------------------------

test('blockMarkerHit: phrase markers substring-match, single-token markers match on word boundaries', () => {
  assert.equal(blockMarkerHit('Advt', 'advt'), true);
  assert.equal(blockMarkerHit(' Download our app today', 'download our app'), true);
  assert.equal(blockMarkerHit('Read the ADVENTURE of a lifetime', 'advt'), false);
  assert.equal(blockMarkerHit('anything', ''), false);
});

test('stripBoilerplateBlocks removes audit-identified recurring blocks without touching article text', () => {
  const html = `<p>${'Real article body sentence. '.repeat(6)}</p>
    <aside><p>Add to Google Preferred Sources</p><p>Once added, BigGo Finance appears first in Google Search Top Stories.</p></aside>
    <p>${'More real reporting follows here. '.repeat(8)}</p>`;
  const out = stripBoilerplateBlocks(html, ['add to google preferred sources', 'appears first in google search top stories']);
  assert.doesNotMatch(out, /Preferred Sources/);
  assert.match(out, /Real article body sentence/);
  assert.match(out, /More real reporting follows/);
});

test('stripBoilerplateBlocks never removes long article text that quotes a marker phrase', () => {
  const longParagraph = `The senator said, "we use cookies and similar tracking technologies across our government portals," and then spent the remainder of the hearing on data protection enforcement. ${'Additional testimony covered state privacy statutes at length. '.repeat(12)}`;
  const out = stripBoilerplateBlocks(`<p>${longParagraph}</p>`, ['we use cookies']);
  assert.match(out, /senator said/);
});

test('empty marker list leaves HTML untouched', () => {
  const html = '<aside><p>we use cookies</p></aside>';
  assert.equal(stripBoilerplateBlocks(html, []), html);
});

// ---------------------------------------------------------------------------
// og:image hero recovery
// ---------------------------------------------------------------------------

test('withHeroImage injects the source-declared hero only when the article has no image', () => {
  const doc = '<html><head></head><body><p>Body text.</p></body></html>';
  const withHero = withHeroImage(doc, 'https://cdn.example/hero.jpg', 'https://example.test/a');
  assert.match(withHero, /^<html><head><\/head><body><figure><img src="https:\/\/cdn\.example\/hero\.jpg"><\/figure>/);
  // Relative og:image URLs are absolutized against the article URL.
  const rel = withHeroImage(doc, '/img/hero.jpg', 'https://example.test/a/b');
  assert.match(rel, /src="https:\/\/example\.test\/img\/hero\.jpg"/);
  // An article that already carries an image is never modified.
  const hasImg = '<body><p>x</p><img src="inline.jpg"></body>';
  assert.equal(withHeroImage(hasImg, 'https://cdn.example/hero.jpg', 'https://example.test/a'), hasImg);
  // Unsafe schemes and garbage are ignored.
  assert.equal(withHeroImage(doc, 'data:image/png;base64,xxx', 'https://example.test/a'), doc);
  assert.equal(withHeroImage(doc, undefined, 'https://example.test/a'), doc);
  assert.equal(withHeroImage(doc, '', 'https://example.test/a'), doc);
  // Fragments (no <body>) get the figure prepended.
  assert.equal(
    withHeroImage('<p>frag</p>', 'https://cdn.example/h.png', 'https://example.test/a'),
    '<figure><img src="https://cdn.example/h.png"></figure><p>frag</p>',
  );
});