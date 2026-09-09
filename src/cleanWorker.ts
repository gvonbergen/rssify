/**
 * Worker-thread entry for `cleanHtmlAsync` (src/cleanRunner.ts). Runs the
 * synchronous JSDOM + Readability pipeline off the main thread and is
 * recycled by the runner once its byte/item budget is spent, because jsdom
 * 29 retains per-window memory (~35–40x the document size) even after
 * `window.close()` + GC — the runner's docs describe the reprocess crash
 * this caused.
 *
 * jsdom warnings (recoverable CSS parse failures) are posted back to the
 * parent thread so they are logged by the CALLER's logger — with site
 * context when the caller passed one — instead of the worker's root logger.
 */
import { parentPort } from 'node:worker_threads';
import { cleanHtml, type CleanOpts, type CleanResult, type JsdomWarningSink } from './clean.ts';

export interface CleanRequest {
  id: number;
  html: string;
  baseUrl: string;
  /** Serializable clean options (`log` is stripped by the runner). */
  opts: Omit<CleanOpts, 'log'>;
}

export type CleanWorkerMessage =
  | ({ type: 'jsdom-warning'; id: number } & { fields: Record<string, unknown>; msg: string })
  | { id: number; result: CleanResult | null; error?: string };

const port = parentPort;
if (!port) throw new Error('cleanWorker.ts must run as a worker thread');

port.on('message', (req: CleanRequest) => {
  // Bridge sink: forward jsdom warnings to the parent thread, attributed to
  // this request id. Warnings are non-fatal; cleanHtml keeps the valid parts.
  const sink: JsdomWarningSink = {
    warn(fields, msg) {
      port.postMessage({ type: 'jsdom-warning', id: req.id, fields, msg });
    },
  };
  let result: CleanResult | null = null;
  let error: string | undefined;
  try {
    result = cleanHtml(req.html, req.baseUrl, { ...req.opts, log: sink });
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  const res: CleanWorkerMessage = { id: req.id, result, error };
  port.postMessage(res);
});
