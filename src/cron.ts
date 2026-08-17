import cron from 'node-cron';

/** Validate a cron expression (5-field, node-cron syntax). */
export function validateCron(expr: string): boolean {
  try {
    return cron.validate(expr);
  } catch {
    return false;
  }
}

type FieldMatch = (v: number) => boolean;

/**
 * Parse one cron field into a predicate. Supports wildcard, slash-step
 * (e.g. /15), fixed values, ranges (N-M, optionally stepped), and comma lists.
 */
function parseField(spec: string | undefined, min: number, max: number): FieldMatch {
  const s = (spec ?? '*').trim();
  if (s === '*') return () => true;
  const mStep = s.match(/^\*\/(\d+)$/);
  if (mStep) {
    const step = Math.max(1, +mStep[1]);
    return (v) => v % step === 0;
  }
  const mRange = s.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
  if (mRange) {
    const lo = +mRange[1];
    const hi = +mRange[2];
    const step = mRange[3] ? Math.max(1, +mRange[3]) : 1;
    return (v) => v >= lo && v <= hi && (v - lo) % step === 0;
  }
  const list = s.split(',').map(Number);
  if (list.length > 1 && list.every((n) => Number.isFinite(n) && n >= min && n <= max)) {
    return (v) => list.includes(v);
  }
  const single = Number(s);
  if (Number.isFinite(single)) return (v) => v === single;
  return () => false;
}

/**
 * Next run time (ms epoch) after `afterMs` for a 5-field cron expression.
 * Handles the common subset node-cron accepts for our schedules (wildcard,
 * step, fixed values, ranges, lists). When both day-of-month and day-of-week are
 * restricted, a day matches if EITHER does (Vixie-cron semantics).
 */
export function nextCronRun(expr: string, afterMs: number): number {
  const parts = expr.trim().split(/\s+/);
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  const domRestricted = parts[2] !== undefined && parts[2].trim() !== '*';
  const dowRestricted = parts[4] !== undefined && parts[4].trim() !== '*';

  let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000; // next minute boundary
  const horizon = t + 5 * 366 * 24 * 3600 * 1000; // scan at most 5 years
  for (; t <= horizon; t += 60_000) {
    const d = new Date(t);
    if (!month(d.getMonth() + 1)) continue;
    const domHit = dom(d.getDate());
    const dowHit = dow(d.getDay()) || (d.getDay() === 0 && dow(7));
    const dayHit = domRestricted && dowRestricted ? domHit || dowHit : domHit && dowHit;
    if (!dayHit) continue;
    if (!hour(d.getHours())) continue;
    if (!minute(d.getMinutes())) continue;
    return t;
  }
  // No match found — degrade to hourly from the request time rather than never.
  return afterMs + 3600 * 1000;
}
