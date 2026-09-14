import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIdentifier, normalizeUrl, resolveHref, rfc822, sha1, slugify } from '../src/util.ts';

test('normalizeUrl canonicalizes host/path, removes tracking params, and drops fragments', () => {
  assert.equal(
    normalizeUrl('HTTPS://WWW.Example.COM//news///story?utm_source=mail&Ref=home&keep=1#comments'),
    'https://www.example.com/news/story?keep=1',
  );
  assert.equal(normalizeUrl('//example.com/article?FBCLID=abc'), 'https://example.com/article');
  assert.equal(normalizeUrl('https://example.com/a?x=1&utm_medium=x&x=2'), 'https://example.com/a?x=1&x=2');
  assert.throws(() => normalizeUrl('not a URL'), TypeError);
});

test('resolveHref repairs scheme-less www. hostname links before relative resolution', () => {
  // Reported regression: a scheme-less hostname link must not be resolved as a
  // relative path that doubles the base path
  // (https://site/assets/www.site/assets/article.php).
  assert.equal(
    resolveHref(
      'www.assetservicingtimes.com/assetservicesnews/digitalassetsarticle.php?article_id=18324',
      'https://www.assetservicingtimes.com/assetservicesnews/',
    ),
    'https://www.assetservicingtimes.com/assetservicesnews/digitalassetsarticle.php?article_id=18324',
  );
  // Port, bare-host and query variants.
  const b = 'https://www.example.com/assets/news/';
  assert.equal(resolveHref('www.example.com:8080/news/a?x=1', b), 'https://www.example.com:8080/news/a?x=1');
  assert.equal(resolveHref('www.example.com', b), 'https://www.example.com/');
  // Neighboring forms resolve exactly as before:
  assert.equal(resolveHref('https://example.com/a/b?q=1', b), 'https://example.com/a/b?q=1');
  assert.equal(resolveHref('http://example.com/a', b), 'http://example.com/a');
  assert.equal(resolveHref('/root/a?x=1', b), 'https://www.example.com/root/a?x=1');
  assert.equal(resolveHref('plain-relative', b), 'https://www.example.com/assets/news/plain-relative');
  assert.equal(resolveHref('../sibling', b), 'https://www.example.com/assets/sibling');
  assert.equal(resolveHref('//other.example.com/a', b), 'https://other.example.com/a');
  assert.equal(resolveHref('?page=2', b), 'https://www.example.com/assets/news/?page=2');
  assert.equal(resolveHref('#frag', b), 'https://www.example.com/assets/news/#frag');
  // A single-label "www.foo" stays a plain word.
  assert.equal(resolveHref('www.foo', b), 'https://www.example.com/assets/news/www.foo');
});

test('resolveHref repairs whitespace-padded hostname links', () => {
  const href = 'www.assetservicingtimes.com/assetservicesnews/digitalassetsarticle.php?article_id=18324';
  const base = 'https://www.assetservicingtimes.com/assetservicesnews/';
  for (const padding of [' ', '\t', '\r\n', ' \t\n']) {
    assert.equal(resolveHref(`${padding}${href}${padding}`, base), `https://${href}`);
  }
  assert.equal(resolveHref(' /story?x=1 ', base), new URL('/story?x=1', base).href);
});

test('slugify and identifier validation handle punctuation and boundaries', () => {
  assert.equal(slugify('  Payments & Risk — News!  '), 'payments-risk-news');
  assert.equal(slugify('Already---Slug'), 'already-slug');
  assert.equal(slugify('日本語'), '');
  assert.equal(isValidIdentifier('a-1'), true);
  assert.equal(isValidIdentifier('', 40), false);
  assert.equal(isValidIdentifier('A-1'), false);
  assert.equal(isValidIdentifier('a_1'), false);
  assert.equal(isValidIdentifier('a'.repeat(41)), false);
  assert.equal(isValidIdentifier('a'.repeat(40)), true);
});

test('sha1 and RFC-822 formatting are stable', () => {
  assert.equal(sha1('rssify'), '28b9b4622460b5b011cc04d3b5580ac5c2abfdfb');
  assert.equal(rfc822(Date.parse('2026-08-05T12:34:56Z')), 'Wed, 05 Aug 2026 12:34:56 GMT');
});
