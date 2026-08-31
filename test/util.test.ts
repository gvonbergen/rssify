import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIdentifier, normalizeUrl, rfc822, sha1, slugify } from '../src/util.ts';

test('normalizeUrl canonicalizes host/path, removes tracking params, and drops fragments', () => {
  assert.equal(
    normalizeUrl('HTTPS://WWW.Example.COM//news///story?utm_source=mail&Ref=home&keep=1#comments'),
    'https://www.example.com/news/story?keep=1',
  );
  assert.equal(normalizeUrl('//example.com/article?FBCLID=abc'), 'https://example.com/article');
  assert.equal(normalizeUrl('https://example.com/a?x=1&utm_medium=x&x=2'), 'https://example.com/a?x=1&x=2');
  assert.throws(() => normalizeUrl('not a URL'), TypeError);
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
