/**
 * Persistent, best-effort event log for dsh-mailbox.
 *
 * One JSON object per line, one file per UTC day, under `<dataDir>/logs/`.
 * Design constraints (some learned from a friend's review):
 *
 *  - Portable file names: `events-YYYYMMDD.jsonl`, no colons (Windows), no
 *    locale-dependent formatting.
 *  - Field whitelist only: `ts`, `level`, `event`, `detail` (short bounded status
 *    line, never a mail body) plus a few numeric/opaque `data` keys. Message
 *    bodies, attachment names/content and credentials never reach this module.
 *  - Never on the mail path: callers never await; writes are queued
 *    asynchronously and the queue is bounded so a stuck disk cannot grow memory.
 *  - Failure bookkeeping: a failed or dropped write increments an in-memory
 *    counter; the next successful append records `log-recovered` with the count
 *    and the instant the streak began.
 *  - Rotation and caps: daily files; files older than `retentionDays` pruned once
 *    at startup; a per-file cap drops routine (`info`) lines first and keeps
 *    `warn`/`error` lines to the last, with a small bounded overflow.
 *  - Unload: `flush(timeoutMs)` waits at most a few hundred milliseconds.
 *
 * Known limit (accepted): the file log is best-effort, not a guarantee. When the
 * file is unwritable at unload, the drop count is reported through the host
 * logger; a hard kill before that logger flushes can still lose the line. A
 * dirty marker reconciled at startup would close that last gap, at the cost of
 * extra complexity on a path that must stay cheap.
 *
 * @module dsh-mailbox/lib/events
 */

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Bounded status detail; anything longer is truncated. */
const MAX_DETAIL_CHARS = 200;
/** Default per-day-file cap (2 MiB). */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How far important lines may overflow the cap (fraction of the cap). */
const IMPORTANT_OVERFLOW = 0.25;
/** Default bound on queued (not yet flushed) writes. */
const DEFAULT_MAX_PENDING = 200;
/** Default retention in days. */
const DEFAULT_RETENTION_DAYS = 14;
/** Levels kept when the per-file cap is reached. */
const IMPORTANT_LEVELS = new Set(['warn', 'error']);
/** Keys allowed inside `data`; everything else is dropped. */
const DATA_KEYS = ['sessionId', 'count', 'imported', 'dropped', 'source', 'mtime', 'version', 'since', 'until'];
/** Day-file name pattern; the date part is the only one parsed. */
const DAY_FILE = /^events-(\d{8})\.jsonl$/;

/** @returns {string} portable day stamp `YYYYMMDD` for one instant. */
function stampFor(instant) {
  return new Date(instant).toISOString().slice(0, 10).replaceAll('-', '');
}

/** @returns {number} epoch ms at the UTC start of a `YYYYMMDD` stamp. */
function dayStart(stamp) {
  return Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z`);
}

/**
 * Create the logger bound to one data directory.
 *
 * @param {string} dataDir - mailbox data directory (the plugin data dir).
 * @param {{ now?: () => number, maxFileBytes?: number, maxPending?: number, retentionDays?: number }} [options]
 * @returns {{ dir: string, write: Function, info: Function, warn: Function, error: Function, flush: Function, lastError: Function, stats: Function }}
 */
export function createEventLog(dataDir, options = {}) {
  const dir = join(dataDir, 'logs');
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES;
  const maxPending = Number.isInteger(options.maxPending) && options.maxPending > 0
    ? options.maxPending
    : DEFAULT_MAX_PENDING;
  const retentionDays = Number.isInteger(options.retentionDays) && options.retentionDays > 0
    ? options.retentionDays
    : DEFAULT_RETENTION_DAYS;
  // Error-storm guard: repeated important lines with the same event+detail collapse
  // into one first line plus a summary line carrying the count. 0 disables.
  const dedupeWindowMs = Number.isInteger(options.dedupeWindowMs) && options.dedupeWindowMs >= 0
    ? options.dedupeWindowMs
    : 60000;
  const capCeiling = maxFileBytes + Math.floor(maxFileBytes * IMPORTANT_OVERFLOW);

  let lastError = '';
  /** Writes lost since the last successful append (failures + cap/queue drops). */
  let dropped = 0;
  /** ISO instant of the first drop in the current unrecovered streak. */
  let droppedSince = '';
  /** Day stamp of the file currently being appended to. */
  let currentDay = '';
  /** Bytes appended to the current day file. */
  let appending = 0;
  /** Open repeat streaks for the error-storm guard (event+detail -> counts). */
  const repeatStreaks = new Map();
  /** Writes enqueued but not yet settled. */
  let pending = 0;
  let queue = Promise.resolve();

  /** Count one lost write; remember when the streak started. */
  function noteDrop(ms) {
    dropped += 1;
    if (droppedSince === '') droppedSince = new Date(ms).toISOString();
  }

  /** Best-effort removal of day files older than the retention window. */
  async function pruneOld(keepStamp) {
    const cutoff = dayStart(keepStamp) - retentionDays * 24 * 60 * 60 * 1000;
    const names = await readdir(dir);
    for (const name of names) {
      const match = DAY_FILE.exec(name);
      if (match === null) continue;
      const at = dayStart(match[1]);
      if (Number.isFinite(at) && at < cutoff) await unlink(join(dir, name)).catch(() => {});
    }
  }

  /**
   * Normalize a status detail for the dedupe key and the summary line: the same
   * error class usually repeats with different ports, addresses, paths, ids or
   * timestamps, so those are templated out before comparing.
   */
  function normalizeDetail(text) {
    return String(text ?? '')
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<addr>')
      .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '<path>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+\b/g, '<n>')
      .slice(0, MAX_DETAIL_CHARS);
  }

  function buildRecord(level, event, detail, extra) {
    const ms = clock();
    const record = { ts: new Date(ms).toISOString(), level: level === 'warn' || level === 'error' ? level : 'info', event: String(event ?? 'log').slice(0, 64) };
    if (typeof detail === 'string' && detail !== '') record.detail = detail.slice(0, MAX_DETAIL_CHARS);
    if (extra !== undefined && typeof extra === 'object' && extra !== null) {
      const safe = {};
      for (const key of DATA_KEYS) {
        const value = extra[key];
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) safe[key] = value;
      }
      if (Object.keys(safe).length > 0) record.data = safe;
    }
    return { ms, line: `${JSON.stringify(record)}\n`, level: record.level };
  }

  /** Append one `log-recovered` line for the pending drop streak. */
  async function appendRecovery(ms, stamp) {
    const recovered = {
      ts: new Date(ms).toISOString(),
      level: 'info',
      event: 'log-recovered',
      data: { dropped, since: droppedSince === '' ? new Date(ms).toISOString() : droppedSince },
    };
    const recoveredLine = `${JSON.stringify(recovered)}\n`;
    await appendFile(join(dir, `events-${stamp}.jsonl`), recoveredLine, 'utf8');
    appending += Buffer.byteLength(recoveredLine, 'utf8');
    dropped = 0;
    droppedSince = '';
  }

  /** Write one summary line for a suppressed repeat streak. */
  async function emitSummary(streak, stamp) {
    if (streak.count <= 1) return;
    const record = {
      ts: new Date(streak.first).toISOString(),
      level: streak.level,
      event: streak.event,
      detail: streak.detail,
      data: { count: streak.count, since: new Date(streak.first).toISOString(), until: new Date(streak.last).toISOString() },
    };
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(join(dir, `events-${stamp}.jsonl`), line, 'utf8');
    if (stamp === currentDay) appending += Buffer.byteLength(line, 'utf8');
  }

  /** Flush every summary that is still open, then clear the streak table. */
  async function flushSummaries(stamp) {
    const open = [...repeatStreaks.values()];
    repeatStreaks.clear();
    for (const streak of open) {
      try {
        await emitSummary(streak, stamp);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function appendOne(level, event, detail, extra) {
    const { ms, line, level: safeLevel } = buildRecord(level, event, detail, extra);
    const stamp = stampFor(ms);
    if (stamp !== currentDay) {
      currentDay = stamp;
      appending = 0;
    }
    // Error-storm guard for important lines: first occurrence is written, repeats
    // inside the window are counted, and one summary line is written when the
    // streak ends (window elapsed, day rollover, or unload).
    if (dedupeWindowMs > 0 && IMPORTANT_LEVELS.has(safeLevel)) {
      const normalizedDetail = normalizeDetail(typeof detail === 'string' ? detail : '');
      const key = `${String(event ?? 'log')}\u0000${normalizedDetail}`;
      const previous = repeatStreaks.get(key);
      if (previous !== undefined && ms - previous.last <= dedupeWindowMs) {
        previous.count += 1;
        previous.last = ms;
        return;
      }
      if (previous !== undefined) {
        repeatStreaks.delete(key);
        await emitSummary(previous, stamp).catch(() => {});
      }
      repeatStreaks.set(key, { level: safeLevel, event, detail: normalizedDetail, count: 1, first: ms, last: ms });
    }
    const size = Buffer.byteLength(line, 'utf8');
    // Cap policy: routine lines are dropped; important lines keep a bounded overflow.
    if (appending + size > maxFileBytes) {
      const important = IMPORTANT_LEVELS.has(safeLevel);
      if (!important || appending + size > capCeiling) {
        noteDrop(ms);
        return;
      }
    }
    await mkdir(dir, { recursive: true });
    const file = join(dir, `events-${stamp}.jsonl`);
    await appendFile(file, line, 'utf8');
    appending += size;
    if (dropped > 0) {
      try {
        await appendRecovery(clock(), stamp);
      } catch {
        // Keep the streak; the next successful append or close() retries.
      }
    }
  }

  function enqueue(level, event, detail, extra) {
    const ms = clock();
    // Bounded queue: a stuck disk must not grow memory; count and move on.
    if (pending >= maxPending) {
      noteDrop(ms);
      return;
    }
    pending += 1;
    queue = queue
      .then(() => appendOne(level, event, detail, extra))
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        noteDrop(clock());
      })
      .finally(() => {
        pending -= 1;
      });
  }

  // Prune once at startup (not on every write); best effort, off the mail path.
  queue = queue.then(() => pruneOld(stampFor(clock()))).catch(() => {});

  return {
    dir,
    write: (level, event, detail, extra) => enqueue(level, event, detail, extra),
    info: (event, detail, extra) => enqueue('info', event, detail, extra),
    warn: (event, detail, extra) => enqueue('warn', event, detail, extra),
    error: (event, detail, extra) => enqueue('error', event, detail, extra),
    /** Wait for queued writes, but never longer than `timeoutMs` (default 300 ms). */
    flush: (timeoutMs = 300) => Promise.race([
      queue,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]),
    /** Unload path: drain briefly, then try once more to record the drop streak. */
    close: async (timeoutMs = 300) => {
      const work = (async () => {
        await queue.catch(() => {});
        if (repeatStreaks.size > 0) {
          await flushSummaries(currentDay === '' ? stampFor(clock()) : currentDay).catch(() => {});
        }
        if (dropped > 0) {
          try {
            const stamp = currentDay === '' ? stampFor(clock()) : currentDay;
            await mkdir(dir, { recursive: true });
            await appendRecovery(clock(), stamp);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      })();
      const timer = new Promise((resolve) => {
        const timerId = setTimeout(resolve, timeoutMs);
        if (typeof timerId.unref === 'function') timerId.unref();
      });
      await Promise.race([work, timer]);
      return { dropped, droppedSince, lastError };
    },
    lastError: () => lastError,
    stats: () => ({ dropped, pending, lastError, droppedSince, appending, currentDay }),
  };
}

// HMR touch for unload-during-readonly test
