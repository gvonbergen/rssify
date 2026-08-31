import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutize,
  cleanHtml,
  extractMetadata,
  sanitizeArticleHtml,
  stripAdBlocks,
  stripImages,
  stripPrintBoilerplate,
  textFromHtml,
  textToHtml,
} from '../src/clean.ts';

test('textToHtml escapes model text and makes deterministic paragraphs', () => {
  assert.equal(
    textToHtml('Hello <script>alert(1)</script>\nworld\n\nSecond & final.'),
    '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt; world</p>\n<p>Second &amp; final.</p>',
  );
  assert.equal(textToHtml('  \n\n  '), '');
});

test('sanitizeArticleHtml removes executable content and unsafe URLs', () => {
  const cleaned = sanitizeArticleHtml(`
    <article onclick="alert(1)">
      <script>alert(1)</script><style>body{display:none}</style>
      <p>safe</p><a href="javascript:alert(1)" onmouseover="x">bad link</a>
      <img src="data:image/png;base64,abc"><img src="https://cdn.test/a.png">
      <iframe src="https://evil.test"></iframe><svg><path /></svg>
    </article>`);
  assert.match(cleaned, /<p>safe<\/p>/);
  assert.match(cleaned, /bad link/);
  assert.match(cleaned, /<img src="https:\/\/cdn\.test\/a\.png">/);
  assert.doesNotMatch(cleaned, /script|style|iframe|svg|onclick|onmouseover|data:image|javascript:/i);
  assert.doesNotMatch(cleaned, /href=/);
});

test('image stripping removes image wrappers but preserves non-image content', () => {
  const html = '<div><figure><picture><source srcset="x"><img src="x"></picture><figcaption>Caption</figcaption></figure></div><p>keep</p><figure><table><tr><td>table</td></tr></table></figure>';
  const result = stripImages(html);
  assert.doesNotMatch(result, /picture|source|img|figcaption|Caption/);
  assert.match(result, /keep/);
  assert.match(result, /table/);
});

test('absolutize resolves links and srcset while leaving non-http schemes alone', () => {
  const result = absolutize(
    '<p><a href="/story">story</a><a href="mailto:a@example.test">mail</a><img src="images/a.png" srcset="/a.png 1x, /b.png 2x"><img src="data:image/png;base64,x">',
    'https://example.test/base/index.html',
  );
  assert.match(result, /href="https:\/\/example\.test\/story"/);
  assert.match(result, /src="https:\/\/example\.test\/a\.png"/);
  assert.doesNotMatch(result, /srcset=/);
  assert.match(result, /mailto:a@example\.test/);
  assert.match(result, /data:image\/png/);
});

test('targeted boilerplate and configured ad blocks are removed', () => {
  const html = '<!-- logo for print --><p><span>An article from</span> <img src="logo.png"></p><p>Real report</p><nav>breadcrumb</nav><div data-function-block="Footer">Contact us</div>';
  const boilerplate = stripPrintBoilerplate(html);
  assert.doesNotMatch(boilerplate, /An article from|breadcrumb|Contact us|logo for print/i);
  assert.match(boilerplate, /Real report/);

  const withAd = `<article><p>${'Intro text '.repeat(80)}</p><aside>Access deeper industry intelligence — Find out more</aside><p>${'Conclusion text '.repeat(80)}</p></article>`;
  const withoutAd = stripAdBlocks(withAd, ['access deeper industry intelligence']);
  assert.match(withoutAd, /Intro|Conclusion/);
  assert.doesNotMatch(withoutAd, /Access deeper/);
  assert.equal(stripAdBlocks(withAd, []), withAd);
});

test('textFromHtml strips chrome and preserves useful body text', () => {
  assert.equal(textFromHtml('<body><nav>Menu</nav><article>Hello <b>world</b></article><footer>Footer</footer><script>x</script></body>'), 'Hello world');
  assert.equal(textFromHtml('<p>Unicode — café 😀</p>'), 'Unicode — café 😀');
});

test('extractMetadata prefers typed JSON-LD and falls back to head/visible metadata', () => {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="/canonical?utm_source=x">
    <meta property="og:url" content="https://example.test/og">
    <meta property="og:title" content="OG title">
    <script type="application/ld+json">{"@graph":[{"@type":"BreadcrumbList","name":"crumb"},{"@type":"NewsArticle","headline":"Structured title","datePublished":"2026-08-05T12:00:00Z","author":{"name":"Jane"},"image":{"url":"/hero.jpg"}}]}</script>
  </head><body><time>August 5, 2026</time></body></html>`;
  assert.deepEqual(extractMetadata(html, 'https://example.test/story'), {
    canonical: 'https://example.test/canonical',
    ogUrl: 'https://example.test/og',
    title: 'Structured title',
    publishedAt: '2026-08-05T12:00:00Z',
    author: 'Jane',
    image: '/hero.jpg',
  });

  const fallback = extractMetadata('<html><head><meta property="og:title" content="Fallback"></head><body>Published July 28, 2026</body></html>', 'https://example.test/x');
  assert.equal(fallback.title, 'Fallback');
  assert.equal(fallback.publishedAt, 'July 28, 2026');
});

test('cleanHtml extracts readable article content and absolutizes relative assets', () => {
  const paragraph = 'This is a sufficiently long article paragraph with useful details for a reader. '.repeat(8);
  const result = cleanHtml(`<!doctype html><html><head><title>Article</title></head><body><header>Chrome</header><main><article><h1>Headline</h1><p>${paragraph}</p><img src="/hero.jpg"></article></main><footer>Footer</footer></body></html>`, 'https://example.test/news/story');
  assert.ok(result);
  assert.match(result.content, /Headline/);
  assert.match(result.content, /https:\/\/example\.test\/hero\.jpg/);
  assert.match(result.text, /useful details/);
  assert.doesNotMatch(result.text, /Chrome|Footer/);
});
