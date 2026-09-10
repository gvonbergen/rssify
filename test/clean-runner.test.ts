import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanHtml,
  type JsdomWarningSink,
} from '../src/clean.ts';
import {
  cleanHtmlAsync,
  cleanRecycleLimits,
  cleanRunnerStats,
  currentCleanWorkerForTests,
  resetCleanRunnerForTests,
} from '../src/cleanRunner.ts';

const BASE = 'https://example.test/articles/one';

/** A well-formed article page readability can extract. */
const ARTICLE_PAGE =
  '<!doctype html><html><head><title>t</title></head><body><article>' +
  '<h1>Worker pool title</h1><p>' + 'word '.repeat(400) + '</p>' +
  '</article></body></html>';

/** A page whose stylesheet is malformed enough to trip jsdom's CSS parser. */
const BROKEN_CSS_PAGE =
  '<!doctype html><html><head><style>calc(100% - ; } .b { color: blue }</style></head>' +
  '<body><article><h1>Css title</h1><p>' + 'word '.repeat(400) + '</p></article></body></html>';

interface CapturedWarn {
  fields: Record<string, unknown>;
  msg: string;
}

function capturingSink(): { sink: JsdomWarningSink; warns: CapturedWarn[] } {
  const warns: CapturedWarn[] = [];
  return {
    warns,
    sink: {
      warn(fields, msg) {
        warns.push({ fields, msg });
      },
    },
  };
}

test('cleanHtmlAsync matches the synchronous cleanHtml result', async () => {
  await resetCleanRunnerForTests();
  const expected = cleanHtml(ARTICLE_PAGE, BASE);
  const actual = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
  assert.ok(expected);
  assert.ok(actual);
  assert.equal(actual.content, expected.content);
  assert.equal(actual.text, expected.text);
  await resetCleanRunnerForTests();
});

test('jsdom CSS parse warnings are attributed to the article URL and stay non-fatal', () => {
  const { sink, warns } = capturingSink();
  const result = cleanHtml(BROKEN_CSS_PAGE, BASE, { log: sink });
  // Non-fatal: the article is still extracted, valid CSS rules and all.
  assert.ok(result);
  assert.match(result.text, /Css title/);
  assert.ok(warns.length >= 1, 'expected at least one attributed jsdom warning');
  const cssWarn = warns.find((w) => w.msg.includes('Could not parse CSS stylesheet'));
  assert.ok(cssWarn, 'expected a "Could not parse CSS stylesheet" warning');
  assert.equal(cssWarn.fields.url, BASE);
  assert.equal(cssWarn.fields.jsdomErrorType, 'css-parsing');
  // The offending stylesheet snippet is attached so operators can see what broke.
  assert.match(String(cssWarn.fields.css), /calc\(100%/);
});

test('cleanHtmlAsync routes worker jsdom warnings back through the caller sink', async () => {
  await resetCleanRunnerForTests();
  const { sink, warns } = capturingSink();
  const result = await cleanHtmlAsync(BROKEN_CSS_PAGE, BASE, { log: sink });
  assert.ok(result);
  assert.ok(warns.length >= 1, 'expected warnings to cross the worker boundary');
  const cssWarn = warns.find((w) => w.msg.includes('Could not parse CSS stylesheet'));
  assert.ok(cssWarn);
  assert.equal(cssWarn.fields.url, BASE);
  await resetCleanRunnerForTests();
});

test('cleanHtmlAsync recycles its worker at the item budget and keeps producing results', async () => {
  await resetCleanRunnerForTests();
  const saved = { ...cleanRecycleLimits };
  cleanRecycleLimits.bytes = Number.MAX_SAFE_INTEGER;
  cleanRecycleLimits.items = 2;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
      assert.ok(r, `clean ${i} should succeed`);
      assert.match(r.text, /Worker pool title/);
    }
    const stats = cleanRunnerStats();
    // The worker is recycled ONCE when the budget crosses the 2-item limit;
    // the replacement then carries a fresh budget (no one-clean-per-worker
    // churn), so exactly one recycle happened across the five requests.
    assert.equal(stats.spawned, 2, `expected exactly 2 worker spawns, got ${stats.spawned}`);
    assert.equal(stats.recycled, 1, `expected exactly 1 recycle, got ${stats.recycled}`);
  } finally {
    Object.assign(cleanRecycleLimits, saved);
    await resetCleanRunnerForTests();
  }
});

test('cleanHtmlAsync recycles at the byte budget', async () => {
  await resetCleanRunnerForTests();
  const saved = { ...cleanRecycleLimits };
  cleanRecycleLimits.bytes = 100;
  cleanRecycleLimits.items = Number.MAX_SAFE_INTEGER;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
      assert.ok(r);
    }
    const stats = cleanRunnerStats();
    assert.ok(stats.spawned >= 3, `expected >=3 worker spawns, got ${stats.spawned}`);
  } finally {
    Object.assign(cleanRecycleLimits, saved);
    await resetCleanRunnerForTests();
  }
});

test('cleanHtmlAsync resets the byte budget for each worker generation', async () => {
  await resetCleanRunnerForTests();
  const saved = { ...cleanRecycleLimits };
  // Two article payloads exceed the budget but one does not: the first two
  // cleans share a worker, the third trips the recycle, and the fourth must
  // reuse the fresh worker instead of churning a new one per request.
  cleanRecycleLimits.bytes = ARTICLE_PAGE.length + 10;
  cleanRecycleLimits.items = Number.MAX_SAFE_INTEGER;
  try {
    for (let i = 0; i < 4; i++) {
      const r = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
      assert.ok(r, `clean ${i} should succeed`);
    }
    const stats = cleanRunnerStats();
    assert.equal(stats.spawned, 2, `expected exactly 2 worker spawns, got ${stats.spawned}`);
    assert.equal(stats.recycled, 1, `expected exactly 1 recycle, got ${stats.recycled}`);
  } finally {
    Object.assign(cleanRecycleLimits, saved);
    await resetCleanRunnerForTests();
  }
});

test('cleanHtmlAsync never recycles a worker that still has requests in flight', async () => {
  await resetCleanRunnerForTests();
  const saved = { ...cleanRecycleLimits };
  // One article payload already spends the byte budget, so the second
  // concurrent clean crosses the limit while the first is still in flight.
  cleanRecycleLimits.bytes = Math.floor(ARTICLE_PAGE.length / 2);
  cleanRecycleLimits.items = Number.MAX_SAFE_INTEGER;
  try {
    const [a, b] = await Promise.all([
      cleanHtmlAsync(ARTICLE_PAGE, BASE),
      cleanHtmlAsync(ARTICLE_PAGE, BASE),
    ]);
    // The in-flight request must NOT be dropped by the recycle: both cleans
    // complete with real extraction results (never a spurious null).
    assert.ok(a, 'first in-flight clean must survive the recycle boundary');
    assert.match(a.text, /Worker pool title/);
    assert.ok(b, 'second clean must succeed on the replacement worker');
    assert.match(b.text, /Worker pool title/);
    const stats = cleanRunnerStats();
    assert.equal(stats.spawned, 2, `expected exactly 2 worker spawns, got ${stats.spawned}`);
    assert.equal(stats.recycled, 1, `expected exactly 1 recycle, got ${stats.recycled}`);
  } finally {
    Object.assign(cleanRecycleLimits, saved);
    await resetCleanRunnerForTests();
  }
});

test('cleanHtmlAsync recovers from a crashed worker', async () => {
  await resetCleanRunnerForTests();
  const first = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
  assert.ok(first);
  const w = currentCleanWorkerForTests();
  assert.ok(w, 'expected a live worker after the first clean');
  await w.terminate(); // simulate a worker crash mid-pool
  await resetCleanRunnerForTests();
  const second = await cleanHtmlAsync(ARTICLE_PAGE, BASE);
  assert.ok(second, 'next clean must respawn a worker and succeed');
  assert.match(second.text, /Worker pool title/);
  await resetCleanRunnerForTests();
});
