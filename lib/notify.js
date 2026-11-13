/**
 * dsh-mailbox notification pipeline: turn newly arrived mail into one batched
 * "您有新的来信" message injected into a conversation, so the agent notices mail
 * without the user pasting it by hand.
 *
 * Safety properties:
 *  - email content is untrusted: only fixed templates + truncated plain-text
 *    previews leave this module (never HTML, never full bodies);
 *  - delivery failure or no active session never loses mail: the notification is
 *    persisted to the store and retried later;
 *  - batches / cooldown / per-hour budget prevent notification storms;
 *  - every message carries a plugin source, so it cannot be mistaken for a
 *    user-typed instruction.
 *
 * @module dsh-mailbox/lib/notify
 */

import { randomUUID } from 'node:crypto';
import { composeNotification } from './prompt.js';

/** Notification queue retry cadence when the host ticks the plugin. */
export const RETRY_INTERVAL_MS = 60 * 1000;
/** Maximum notifications delivered per rolling hour (security: anti-storm). */
export const MAX_NOTIFICATIONS_PER_HOUR = 20;
/** Maximum queued notifications retained on disk. */
export const MAX_QUEUED = 100;

/**
 * @typedef {object} NotificationTarget
 * @property {string} sessionId - target conversation.
 * @property {string} [title] - display title.
 * @property {string} [status] - agent status when known.
 * @property {string} [updatedAt] - last activity ISO timestamp.
 * @property {boolean} [isSubagent] - child sessions must be skipped.
 */

/**
 * Create the notification service.
 *
 * @param {object} options - wiring.
 * @param {object} options.store - mailbox store.
 * @param {() => object} options.getConfig - current normalized config.
 * @param {() => Promise<object>} options.getFriends - current friends document.
 * @param {{ listSessions: () => Promise<NotificationTarget[]>, deliver: (sessionId: string, text: string, meta: object) => Promise<boolean> }} options.host - host adapter.
 * @param {(line: string) => void} [options.log] - diagnostic logger.
 * @param {(sessionId: string) => Promise<void>} [options.onDedicatedSession] - persist the auto-created dedicated session id.
 * @param {() => number} [options.now] - clock injection for tests.
 */
export function createNotifier(options) {
  const { store, getConfig, getFriends, host } = options;
  const onDedicatedSession = typeof options.onDedicatedSession === 'function' ? options.onDedicatedSession : null;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;

  /** @type {Map<string, { row: object }>} pending batch of new mail */
  const batch = new Map();
  let batchTimer = null;
  let flushPromise = null;
  /** @type {number[]} delivery timestamps within the rolling hour */
  let deliveries = [];
  let disposed = false;

  /** Whether notifications are enabled right now. */
  function notificationEnabled() {
    const config = getConfig();
    return config.enabled === true && config.notify.enabled === true;
  }

  /** Drop delivery timestamps older than one hour. */
  function pruneDeliveries() {
    const cutoff = now() - 60 * 60 * 1000;
    deliveries = deliveries.filter((at) => at >= cutoff);
  }

  /**
   * Truncated preview for one arriving row; never includes HTML.
   *
   * @param {object} row - message index row.
   * @returns {string} plain text preview.
   */
  function preview(row) {
    const config = getConfig();
    const max = config.notify.maxPreviewChars;
    const text = typeof row.snippet === 'string' ? row.snippet : '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /**
   * Resolve the dedicated mailbox conversation. Once an id is stored, it is
   * reused even when the session is not currently listed or loaded: the notice
   * queues and retries until that conversation is available again. A new
   * conversation is created only when no id was ever stored — spawning a fresh
   * one on every restart would leave several live "邮箱通知" conversations
   * around, each of which may answer incoming mail.
   */
  async function resolveDedicated(sessions) {
    const config = getConfig();
    const ordinary = sessions.filter((session) => session.isSubagent !== true);
    const storedId = typeof config.notify.dedicatedSessionId === 'string' ? config.notify.dedicatedSessionId : '';
    if (storedId !== '') {
      const live = ordinary.find((session) => session.sessionId === storedId);
      if (live !== undefined) return [live];
      // A created-but-not-listed session can still be a live agent.
      const direct = await host.isLive?.(storedId);
      if (direct === true) return [{ sessionId: storedId, title: '邮箱通知', updatedAt: '' }];
      log(`[dsh-mailbox] dedicated notification session not available right now; queuing notice for ${storedId}`);
      return [{ sessionId: storedId, title: '邮箱通知', updatedAt: '' }];
    }
    if (typeof host.createSession === 'function') {
      const created = await host.createSession();
      if (typeof created === 'string' && created !== '') {
        if (onDedicatedSession !== null) await onDedicatedSession(created);
        return [{ sessionId: created, title: '邮箱通知', updatedAt: new Date(now()).toISOString() }];
      }
    }
    // Fall back to the latest live conversation so the notice is not lost.
    const sorted = [...ordinary].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
    return sorted.length === 0 ? [] : [sorted[0]];
  }

  /** Resolve which conversations should receive the notification. */
  async function resolveTargets() {
    const config = getConfig();
    const sessions = await host.listSessions().catch((error) => {
      log(`[dsh-mailbox] listSessions failed: ${error.message}`);
      return [];
    });
    const ordinary = sessions.filter((session) => session.isSubagent !== true);
    if (config.notify.target === 'dedicated') {
      try {
        return await resolveDedicated(sessions);
      } catch (error) {
        log(`[dsh-mailbox] dedicated session unavailable: ${error.message}`);
        const sorted = [...ordinary].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
        return sorted.length === 0 ? [] : [sorted[0]];
      }
    }
    if (config.notify.target === 'all') return ordinary;
    if (config.notify.target !== 'latest') {
      const wanted = ordinary.find((session) => session.sessionId === config.notify.target);
      return wanted === undefined ? [] : [wanted];
    }
    const sorted = [...ordinary].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
    return sorted.length === 0 ? [] : [sorted[0]];
  }

  /** Persist one queued notification entry. */
  async function persistQueue(text, messageIds) {
    const doc = await store.loadNotifications();
    doc.queue = [
      ...doc.queue,
      {
        id: randomUUID(),
        createdAt: new Date(now()).toISOString(),
        messageIds,
        text,
        attempts: 0,
        lastError: null,
      },
    ].slice(-MAX_QUEUED);
    await store.saveNotifications(doc);
  }

  /** Drop queued notifications whose message ids are now delivered. */
  async function removeQueued(ids) {
    const doc = await store.loadNotifications();
    if (!doc.queue.some((entry) => ids.includes(entry.id))) return;
    doc.queue = doc.queue.filter((entry) => !ids.includes(entry.id));
    await store.saveNotifications(doc);
  }

  /** Try delivering one prebuilt notification text to the chosen targets. */
  async function deliverText(text, meta, targets) {
    const resolved = Array.isArray(targets) ? targets : await resolveTargets();
    if (resolved.length === 0) return false;
    let delivered = false;
    for (const target of resolved) {
      try {
        const ok = await host.deliver(target.sessionId, text, meta);
        if (ok) delivered = true;
      } catch (error) {
        log(`[dsh-mailbox] notify ${target.sessionId} failed: ${error.message}`);
      }
    }
    return delivered;
  }

  /**
   * Deliver (or queue) one notification batch.
   *
   * @param {object[]} rows - message index rows in arrival order.
   * @param {{ kind: 'new-mail'|'test', text?: string }} [meta] - notification kind.
   * @returns {Promise<{ delivered: boolean, queued: boolean, targets: number }>}
   */
  async function flushRows(rows, meta = { kind: 'new-mail' }) {
    if (rows.length === 0) return { delivered: false, queued: false, targets: 0 };
    pruneDeliveries();
    const config = getConfig();
    const mails = rows
      .filter((row) => row.notify === true || row.notify === undefined)
      .map((row) => ({
        id: row.id,
        fromName: row.fromName ?? '',
        fromAddress: row.fromAddress ?? '',
        subject: row.subject ?? '',
        date: row.date ?? '',
        snippet: preview(row),
        friend: row.friend === true,
        suspicious: row.suspicious === true,
        suspiciousReasons: row.suspiciousReasons ?? [],
        automatic: row.automatic === true,
      }));
    if (mails.length === 0) return { delivered: false, queued: false, targets: 0 };

    const text = composeNotification(mails, config);
    if (text === '') return { delivered: false, queued: false, targets: 0 };
    const messageIds = rows.map((row) => row.id);
    const canDeliver = deliveries.length < MAX_NOTIFICATIONS_PER_HOUR;
    // Resolve once: a dedicated target may create a conversation here, and the
    // second resolve would otherwise create a duplicate.
    const targets = await resolveTargets();
    if (!canDeliver) {
      await persistQueue(text, messageIds);
      return { delivered: false, queued: true, targets: 0 };
    }
    const delivered = await deliverText(text, { kind: meta.kind ?? 'new-mail', ids: messageIds }, targets);
    if (delivered) {
      deliveries.push(now());
      await removeQueued(messageIds);
      return { delivered: true, queued: false, targets: targets.length };
    }
    await persistQueue(text, messageIds);
    return { delivered: false, queued: true, targets: targets.length };
  }

  /** Flush the in-memory batch now. */
  async function flush() {
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (flushPromise !== null) return flushPromise;
    const rows = [...batch.values()].map((entry) => entry.row);
    batch.clear();
    if (rows.length === 0) return { delivered: false, queued: false, targets: 0 };
    flushPromise = flushRows(rows, { kind: 'new-mail' }).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  /**
   * Queue newly arrived mail. Resolves immediately; delivery happens after the
   * configured batching window so bursts collapse into one message.
   *
   * @param {object[]} rows - newly stored index rows.
   * @returns {{ queued: number }}
   */
  function enqueue(rows) {
    if (disposed) return { queued: 0 };
    const config = getConfig();
    if (config.enabled !== true || config.notify.enabled !== true) return { queued: 0 };
    const interesting = rows.filter((row) => row.notify === true);
    for (const row of interesting) batch.set(row.id, { row });
    if (batch.size === 0) return { queued: 0 };
    if (batchTimer !== null) clearTimeout(batchTimer);
    const delay = Math.max(0, config.notify.batchSeconds) * 1000;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flush().catch((error) => log(`[dsh-mailbox] flush failed: ${error.message}`));
    }, delay);
    if (typeof batchTimer.unref === 'function') batchTimer.unref();
    return { queued: batch.size };
  }

  /** Periodically retry persisted notifications (host tick). */
  async function tick() {
    if (disposed || !notificationEnabled() || deliveries.length >= MAX_NOTIFICATIONS_PER_HOUR) return;
    const doc = await store.loadNotifications();
    if (doc.queue.length === 0) return;
    const entry = doc.queue[0];
    const delivered = await deliverText(entry.text, { kind: entry.kind ?? 'new-mail', ids: entry.messageIds });
    if (delivered) {
      deliveries.push(now());
      await removeQueued([entry.id]);
      log(`[dsh-mailbox] delivered queued notification ${entry.id}`);
    }
  }

  /**
   * Manually send a test notification (UI "通知测试"). Without an explicit
   * session id the configured target is resolved first, so the dedicated
   * mailbox conversation can be created by the test as well.
   */
  async function test(sessionId) {
    const config = getConfig();
    const text = config.prompt.language === 'en'
      ? 'This is a test notice from the dsh-mailbox plugin: the notification channel works.'
      : '这是一条来自 dsh-mailbox 插件的通知测试：通知链路正常。';
    let targetId = typeof sessionId === 'string' ? sessionId : '';
    if (targetId === '') {
      const targets = await resolveTargets();
      if (targets.length === 0) return { delivered: false, sessionId: '' };
      targetId = targets[0].sessionId;
    }
    const ok = await host.deliver(targetId, text, { kind: 'test' });
    return { delivered: ok, sessionId: targetId };
  }

  /** Status for the UI. */
  async function status() {
    const doc = await store.loadNotifications();
    pruneDeliveries();
    const config = getConfig();
    return {
      enabled: notificationEnabled(),
      queued: doc.queue.length,
      deliveredLastHour: deliveries.length,
      maxPerHour: MAX_NOTIFICATIONS_PER_HOUR,
      target: config.notify.target,
      dedicatedSessionId: config.notify.dedicatedSessionId ?? '',
    };
  }

  /** Stop timers; queued notifications stay on disk. */
  function dispose() {
    disposed = true;
    if (batchTimer !== null) clearTimeout(batchTimer);
    batchTimer = null;
  }

  return { enqueue, flush, flushRows, tick, test, status, dispose, resolveTargets };
}
