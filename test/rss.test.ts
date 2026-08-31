import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRss, ttlFromSchedule, type FeedMeta } from '../src/rss.ts';

const meta = (items: FeedMeta['items']): FeedMeta => ({
  title: 'A & <Feed>',
  description: 'News for "readers"',
  link: 'https://example.test/news?a=1&b=2',
  feedUrl: 'https://rss.test/example?x=1&y=2',
  ttlMinutes: 15,
  lastBuildDate: Date.parse('2026-08-05T12:00:00Z'),
  items,
});

test('buildRss escapes channel/item XML while preserving HTML in CDATA', () => {
  const xml = buildRss(meta([{
    title: 'AT&T <launch> "now"',
    link: 'https://example.test/a?x=1&y=2',
    guid: 'a&b<id>',
    pubDate: Date.parse('2026-08-05T12:34:56Z'),
    description: 'Text with <angle> & ampersand and ]]> terminator',
    contentHtml: '<p data-x="1">Hello & <strong>world</strong></p>]]><p>next</p>',
    author: 'A & B',
  }]));

  assert.match(xml, /<title>A &amp; &lt;Feed&gt;<\/title>/);
  assert.match(xml, /<description>News for &quot;readers&quot;<\/description>/);
  assert.match(xml, /<title>AT&amp;T &lt;launch&gt; &quot;now&quot;<\/title>/);
  assert.match(xml, /<description><!\[CDATA\[Text with <angle> & ampersand and \]\]\]\]><!\[CDATA\[> terminator\]\]><\/description>/);
  assert.match(xml, /<content:encoded><!\[CDATA\[<p data-x="1">Hello & <strong>world<\/strong><\/p>\]\]\]\]><!\[CDATA\[><p>next<\/p>\]\]><\/content:encoded>/);
  assert.match(xml, /<dc:creator>A &amp; B<\/dc:creator>/);
  assert.match(xml, /<ttl>15<\/ttl>/);
  assert.match(xml, /href="https:\/\/rss.test\/example\?x=1&amp;y=2"/);
});

test('buildRss emits empty description and omits absent optional content', () => {
  const xml = buildRss(meta([{
    title: 'Empty', link: 'https://example.test/empty', guid: 'empty',
    pubDate: 0, description: null, contentHtml: null,
  }]));
  assert.match(xml, /<description\/>/);
  assert.doesNotMatch(xml, /content:encoded/);
  assert.doesNotMatch(xml, /dc:creator/);
});

test('ttlFromSchedule handles the common minute cadence and falls back safely', () => {
  assert.equal(ttlFromSchedule('*/15 * * * *'), 15);
  assert.equal(ttlFromSchedule('*/0 * * * *'), 1);
  assert.equal(ttlFromSchedule('0 */6 * * *'), 15);
  assert.equal(ttlFromSchedule('*/5  * * * *'), 15);
});
