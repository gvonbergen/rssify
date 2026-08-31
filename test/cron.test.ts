import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCronRun, validateCron } from '../src/cron.ts';

const at = (iso: string): number => Date.parse(iso);

test('validateCron accepts supported schedules and rejects malformed fields', () => {
  assert.equal(validateCron('*/15 * * * *'), true);
  assert.equal(validateCron('0 9 * * 1-5'), true);
  assert.equal(validateCron('not a cron'), false);
  assert.equal(validateCron('60 * * * *'), false);
  assert.equal(validateCron(''), false);
});

test('nextCronRun advances to the next minute and honors steps/ranges', () => {
  assert.equal(
    nextCronRun('*/15 * * * *', at('2026-08-05T12:34:56.789Z')),
    at('2026-08-05T12:45:00.000Z'),
  );
  assert.equal(
    nextCronRun('0 9 * * 1-5', at('2026-08-05T12:00:00.000Z')),
    at('2026-08-06T09:00:00.000Z'),
  );
  assert.equal(
    nextCronRun('15-45/15 8 * * *', at('2026-08-05T08:15:00.000Z')),
    at('2026-08-05T08:30:00.000Z'),
  );
});

test('nextCronRun uses OR semantics when both day-of-month and day-of-week are restricted', () => {
  assert.equal(
    nextCronRun('0 0 1 * 0', at('2026-08-02T00:01:00.000Z')),
    at('2026-08-09T00:00:00.000Z'),
  );
  assert.equal(
    nextCronRun('0 0 1 1 *', at('2026-08-05T00:00:00.000Z')),
    at('2027-01-01T00:00:00.000Z'),
  );
});
