/**
 * Bounded-memory front end for `cleanHtml`.
 *
 * jsdom 29.1.1 retains one window per `new JSDOM()` (~1 MB minimum, ~35–40x
 * the raw document size for real publisher pages) even after `window.close()`
 * and forced GC — an in-jsdom retention leak. A whole-backlog
 * `rssify reprocess` therefore walked the main-thread heap to the ~4 GB V8
 * old-space limit and died with `Ineffective mark-compacts near heap limit`
 * plus a core dump (observed on the googlenews reprocess, 2026-09).
 *
 * The mitigation is structural, not a bigger heap: every clean runs in a
 * dedicated worker thread that is terminated and respawned once it has
 * processed a bounded byte/item budget, so the retained windows — and any
 * in-worker crash — die with the worker instead of accumulating in the
 * process running the scrape/reprocess loop. Requests are answered in
 * submission order (the worker handles each message synchronously), and a
 * wedged request is dropped by a watchdog that recycles the worker.
 *
 * The worker is `ref()`ed only while requests are in flight and `unref()`ed
 * when idle, so a finished `rssify reprocess` (or test run) can still exit
 * instead of being kept alive by an idle worker thread.
 */
import { Worker } from 'node:worker_threads';
import { logger } from './logger.ts';
import type { CleanOpts, CleanResult, JsdomWarningSink } from './clean.ts';

const WORKER_URL = new URL('./cleanWorker.ts', import.meta.url);

/**
 * Recycle thresholds. jsdom retention measured at ~35–40x raw document size,
 * so 16 MB of processed HTML keeps retained windows under ~650 MB —
 * comfortably inside the default ~4 GB old-space limit — before the worker
 * is recycled. Mutable for tests (restore in a `finally`).
 */
export const cleanRecycleLimits = {
  bytes: 16 * 1024 * 1024,
  items: 200,
  /** Per-request watchdog; cleanHtml is synchronous CPU work, normally < 2s. */
  requestTimeoutMs: 120_000,
};

interface Pending {
  resolve: (r: CleanResult | null) => void;
  timer: NodeJS.Timeout;
  /** Where this request's jsdom warnings are logged (default: root logger). */
  sink: JsdomWarningSink | undefined;
  /** The worker this request was sent to (a recycle must not drop others). */
  owner: Worker;
}

let worker: Worker | null = null;
/** Workers whose budget is spent but which still have in-flight requests. */
let retiring: Worker[] = [];
let bytesSinceSpawn = 0;
let itemsSinceSpawn = 0;
let nextId = 1;
const pending = new Map<number, Pending>();
const stats = { spawned: 0, recycled: 0, failed: 0 };

function idleIfNoPending() {
  if (pending.size === 0) worker?.unref();
}

function hasPendingOn(w: Worker): boolean {
  for (const p of pending.values()) {
    if (p.owner === w) return true;
  }
  return false;
}

function retireWorker(w: Worker) {
  stats.recycled++;
  if (worker === w) worker = null;
  void w.terminate();
}

/**
 * Recycle `w` when its budget is spent, but never while requests are still in
 * flight on it — terminating mid-flight drops sibling requests with a spurious
 * null. A busy worker is parked in `retiring` and terminated once its pending
 * set drains (see `retireIdleWorkers`).
 */
function scheduleRetirement(w: Worker) {
  if (worker === w) worker = null;
  if (hasPendingOn(w)) {
    if (!retiring.includes(w)) retiring.push(w);
    return;
  }
  retireWorker(w);
}

/** Terminate parked workers whose in-flight requests have all drained. */
function retireIdleWorkers() {
  const done = retiring.filter((w) => !hasPendingOn(w));
  if (done.length === 0) return;
  retiring = retiring.filter((w) => !done.includes(w));
  for (const w of done) retireWorker(w);
}

function dropPending(owner?: Worker) {
  for (const [id, p] of pending) {
    if (owner && p.owner !== owner) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(null);
  }
  idleIfNoPending();
  retireIdleWorkers();
}

function spawnWorker(): Worker {
  const w = new Worker(WORKER_URL);
  stats.spawned++;
  w.on('message', (res: Record<string, unknown> & { id?: number }) => {
    // jsdom warning bridge from the worker: log via the requesting call's
    // sink so site context survives the thread hop.
    if (res['type'] === 'jsdom-warning' && typeof res['id'] === 'number') {
      const p = pending.get(res['id']);
      const sink = p?.sink ?? logger;
      sink.warn(res['fields'] as Record<string, unknown>, res['msg'] as string);
      return;
    }
    const p = pending.get(res['id'] as number);
    if (!p) return;
    pending.delete(res['id'] as number);
    clearTimeout(p.timer);
    if (res['error'] !== undefined) {
      logger.warn({ error: res['error'] }, 'clean worker reported extraction failure');
    }
    idleIfNoPending();
    retireIdleWorkers();
    p.resolve((res['result'] as CleanResult | null) ?? null);
  });
  w.on('error', (e) => {
    stats.failed++;
    logger.error({ error: String((e as Error)?.message ?? e) }, 'clean worker crashed — recycling');
    dropPending(w);
    if (worker === w) worker = null;
  });
  w.on('exit', () => {
    // A graceful terminate() has no pending requests; a crash path already
    // dropped them via 'error'. Dropping again here is harmless insurance.
    dropPending(w);
    if (worker === w) worker = null;
  });
  // A fresh worker generation starts with a fresh budget; the retired
  // worker's spent counters must not carry over (otherwise the next request
  // immediately reverts the new worker — one clean per worker for the rest
  // of the run).
  bytesSinceSpawn = 0;
  itemsSinceSpawn = 0;
  return w;
}

/**
 * Clean `html` exactly like the synchronous `cleanHtml`, but inside a
 * recycled worker thread so jsdom's per-window retention cannot exhaust the
 * main process heap. Resolves null when extraction fails, the worker crashed
 * (respawned on the next call), or the request watchdog fired — the same
 * "no article" outcome callers already handle. Non-serializable options
 * (`log`) stay on this thread: the worker forwards jsdom warnings back and
 * they are logged here through `opts.log`.
 */
export function cleanHtmlAsync(
  html: string,
  baseUrl: string,
  opts: CleanOpts = {},
): Promise<CleanResult | null> {
  if (
    worker &&
    (bytesSinceSpawn > cleanRecycleLimits.bytes || itemsSinceSpawn > cleanRecycleLimits.items)
  ) {
    scheduleRetirement(worker);
  }
  if (!worker) worker = spawnWorker();
  const w = worker;
  w.ref(); // in flight again — an idle worker may have been unref()ed
  const id = nextId++;
  bytesSinceSpawn += html.length;
  itemsSinceSpawn++;
  // `log` is a pino logger (functions) and cannot cross the worker boundary.
  const { log: sink, ...wireOpts } = opts;
  const message = { id, html, baseUrl, opts: wireOpts };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      logger.error(
        { url: baseUrl, timeoutMs: cleanRecycleLimits.requestTimeoutMs },
        'clean worker timed out — recycling',
      );
      if (worker === w) {
        retireWorker(w);
      } else {
        // A parked (budget-spent) worker wedged: its own timed-out request
        // was just dropped, so force-recycle the wedged worker instead of
        // leaving it parked in `retiring` forever.
        const i = retiring.indexOf(w);
        if (i >= 0) {
          retiring.splice(i, 1);
          stats.recycled++;
          void w.terminate();
        }
      }
      resolve(null);
    }, cleanRecycleLimits.requestTimeoutMs);
    pending.set(id, { resolve, timer, sink, owner: w });
    try {
      w.postMessage(message);
    } catch (e) {
      // Non-serializable payload or dead thread: fail this clean like any
      // other extraction failure instead of orphaning the watchdog.
      pending.delete(id);
      clearTimeout(timer);
      logger.warn({ url: baseUrl, error: String((e as Error)?.message ?? e) }, 'clean worker request failed to send');
      if (worker === w) retireWorker(w);
      resolve(null);
    }
  });
}

/** Pool counters, for tests and operational sanity checks. */
export function cleanRunnerStats() {
  return {
    ...stats,
    bytesSinceSpawn,
    itemsSinceSpawn,
    workerAlive: worker !== null,
  };
}

/** Test seam: drop the worker and counters so each test starts isolated. */
export async function resetCleanRunnerForTests(): Promise<void> {
  if (worker) {
    const w = worker;
    worker = null;
    await w.terminate();
  }
  for (const w of retiring) void w.terminate();
  retiring = [];
  dropPending();
  bytesSinceSpawn = 0;
  itemsSinceSpawn = 0;
  nextId = 1;
  stats.spawned = 0;
  stats.recycled = 0;
  stats.failed = 0;
}

/** Test seam: the live worker handle, so tests can simulate crashes. */
export function currentCleanWorkerForTests(): Worker | null {
  return worker;
}