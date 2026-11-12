/**
 * dsh-mailbox receive pipeline: poll IMAP, decode untrusted mail, classify it
 * against the friend whitelist, persist it, and hand new arrivals to the
 * notifier.
 *
 * Security properties:
 *  - one sync at a time; bounded fetch; explicit timeouts;
 *  - raw bodies parsed with hard resource limits (mail/mime.js) and sanitized
 *    HTML before storage — the UI never receives raw remote HTML;
 *  - suspicious mail is quarantined and never triggers automatic behavior;
 *  - failures update `state.lastError` only, never crash the host;
 *  - the first successful sync imports a baseline without notifying.
 *
 * @module dsh-mailbox/lib/sync
 */

import { incomingMessageId } from './store.js';
import { classifySender, threadRoot, snippet } from './core/policy.js';

/** Hard wall-clock budget for one sync round. */
export const SYNC_TIMEOUT_MS = 90 * 1000;
/** Store at most this many messages per round regardless of inbox size. */
export const MAX_IMPORT_PER_ROUND = 20;

/** Compose a safe error line (never includes credentials). */
function errorLine(error) {
  const message = String(error?.message ?? error);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

/**
 * Create the IMAP sync service.
 *
 * @param {object} options - wiring.
 * @param {object} options.store - mailbox store.
 * @param {() => object} options.getConfig - current normalized config.
 * @param {() => Promise<{ smtp: { authCode: string }, imap: { authCode: string } }>} options.getSecrets - resolved authorization codes.
 * @param {() => Promise<object>} options.getFriends - friends document.
 * @param {(connection: object) => Promise<object>} options.openImap - IMAP client factory (mail/imap.js adapter).
 * @param {(raw: Buffer|string) => object} options.parseMessage - MIME parser.
 * @param {(html: string, options?: object) => string} options.sanitizeHtml - HTML sanitizer.
 * @param {(service: object) => void} [options.onNewMail] - notifier hook (usually `rows => notifier.enqueue(rows)`).
 * @param {(line: string) => void} [options.log] - diagnostic logger.
 * @param {() => number} [options.now] - clock injection.
 */
export function createSyncService(options) {
  const { store, getConfig, getSecrets, getFriends, openImap, parseMessage, sanitizeHtml } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  let running = false;
  let disposed = false;
  let lastSummary = null;

  /** Normalize whatever the IMAP client exposes into the adapter shape. */
  function call(client, names, ...args) {
    for (const name of names) {
      if (typeof client?.[name] === 'function') return client[name](...args);
    }
    throw new Error(`IMAP 客户端缺少方法：${names.join(' / ')}`);
  }

  /** Open an IMAP connection for the current configuration (openImap logs in). */
  async function connect(config, secrets) {
    const pass = config.imap.authCode !== '' ? config.imap.authCode : secrets.imap.authCode;
    if (pass === '') throw new Error('未配置 IMAP 授权码：请在设置里填写');
    const client = await openImap({
      host: config.imap.host,
      port: config.imap.port,
      security: config.imap.security,
      user: config.imap.user,
      pass,
      mailbox: config.imap.mailbox,
      timeoutMs: 30 * 1000,
    });
    return { client, pass };
  }

  /** Parse + sanitize one raw message; returns null when unusable. */
  function decode(raw, friends) {
    const parsed = parseMessage(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const safeHtml = typeof parsed.html === 'string' && parsed.html !== '' ? sanitizeHtml(parsed.html) : '';
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const fromAddress = parsed.from?.[0]?.address ?? '';
    const classification = classifySender(fromAddress, friends);
    const security = parsed.security ?? {};
    const suspicious = security.suspicious === true || parsed.suspicious === true;
    const automatic = parsed.autoReply?.isAutoReply === true || security.autoReply?.isAutoReply === true;
    return {
      parsed,
      text,
      safeHtml,
      fromAddress,
      classification,
      suspicious,
      suspiciousReasons: Array.isArray(security.reasons) ? security.reasons.slice(0, 8) : [],
      automatic,
    };
  }

  /** Persist one decoded message and return its index row. */
  async function persist(decoded, uid, config) {
    const { parsed, text, safeHtml, fromAddress, classification, suspicious, suspiciousReasons, automatic } = decoded;
    const date = parsed.dateIso ?? new Date(now()).toISOString();
    const id = incomingMessageId(parsed.messageId, uid, date);
    const references = Array.isArray(parsed.references) ? parsed.references : [];
    const friend = classification.kind === 'friend';
    const notifyPolicy = config.notify.strangerMail;
    const notify = friend
      ? true
      : notifyPolicy === 'notify' && !suspicious;
    const folder = suspicious
      ? 'quarantine'
      : (!friend && notifyPolicy === 'quarantine' ? 'quarantine' : 'inbox');

    const body = {
      id,
      direction: 'in',
      uid,
      messageId: parsed.messageId ?? '',
      from: parsed.from?.[0] ?? { name: '', address: fromAddress },
      to: Array.isArray(parsed.to) ? parsed.to : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc : [],
      replyTo: Array.isArray(parsed.replyTo) ? parsed.replyTo : [],
      subject: parsed.subject ?? '',
      date,
      receivedAt: new Date(now()).toISOString(),
      text,
      html: safeHtml,
      snippet: parsed.snippet ?? snippet(text, config.notify.maxPreviewChars),
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      headers: {
        messageId: parsed.messageId ?? '',
        inReplyTo: parsed.inReplyTo ?? '',
        references,
        autoReply: automatic,
        suspicious,
      },
      friend,
      suspicious,
      suspiciousReasons,
      automatic,
      unread: true,
      threadId: threadRoot(parsed.messageId, references),
      size: parsed.size ?? 0,
      truncated: parsed.truncated === true,
    };

    await store.writeMessage(body);
    const row = {
      id,
      folder,
      direction: 'in',
      messageId: body.messageId,
      fromAddress,
      fromName: body.from.name ?? '',
      toAddresses: body.to.map((item) => item.address).filter((value) => typeof value === 'string'),
      subject: body.subject,
      date,
      snippet: body.snippet,
      unread: true,
      friend,
      suspicious,
      suspiciousReasons,
      automatic,
      hasAttachments: body.attachments.length > 0,
      threadId: body.threadId,
      notify,
      size: body.size,
    };
    const { evicted } = await store.appendIndex(row, { maxMessages: 500 });
    for (const id_ of evicted) await store.deleteMessage(id_);
    return row;
  }

  /** Whether the message id is already known in the index. */
  function alreadyKnown(index, messageId) {
    if (typeof messageId !== 'string' || messageId === '') return false;
    return index.messages.some((row) => row.messageId === messageId);
  }

  /**
   * Run one sync round.
   *
   * @param {{ reason?: string }} [trigger] - diagnostics label.
   * @returns {Promise<{ ok: boolean, checked: number, imported: number, notified: number, baseline: boolean, error?: string }>}
   */
  async function sync(trigger = {}) {
    if (disposed) return { ok: false, checked: 0, imported: 0, notified: 0, baseline: false, error: '插件已停用' };
    if (running) return { ok: false, checked: 0, imported: 0, notified: 0, baseline: false, error: 'already-running' };
    running = true;
    const startedAt = now();
    const config = getConfig();
    const summary = { ok: false, checked: 0, imported: 0, notified: 0, baseline: false, arrivals: [], error: undefined };
    let client = null;
    try {
      if (config.enabled !== true) throw new Error('插件总开关已关闭');
      if (config.imap.enabled !== true) throw new Error('IMAP 收信未启用');
      const secrets = await getSecrets();
      const friends = await getFriends();
      const state = await store.loadState();
      const index = await store.loadIndex();
      const connection = await connect(config, secrets);
      client = connection.client;
      // openImap() is already connected and logged in; select the configured mailbox.
      const mailbox = await call(client, ['select', 'selectMailbox', 'openMailbox'], config.imap.mailbox, { readOnly: config.imap.markSeen !== true });
      const uidValidity = mailbox?.uidValidity ?? null;
      const reset = state.uidValidity !== null && uidValidity !== null && String(state.uidValidity) !== String(uidValidity);
      const baseline = reset || state.lastUid === 0 || state.lastSyncAt === null;
      const limit = Math.min(config.imap.fetchLimit, MAX_IMPORT_PER_ROUND);

      let fetched = [];
      try {
        if (baseline) {
          // Baseline: newest N messages for an initial inbox, without notifying.
          fetched = await call(client, ['fetchRecent'], limit, { body: true });
        } else {
          // Incremental: grow UID contiguous from lastUid; take the oldest slice
          // first so a small fetchLimit never skips mail permanently.
          const found = await call(client, ['searchNew'], state.lastUid);
          const uids = (Array.isArray(found) ? found : [])
            .filter((value) => Number.isInteger(value) || /^\d+$/.test(String(value)))
            .map((value) => Number(value))
            .sort((left, right) => left - right)
            .slice(0, limit);
          if (uids.length > 0) fetched = await call(client, ['fetchByUid'], uids, { body: true });
        }
      } catch (error) {
        throw new Error(`收取邮件失败：${errorLine(error)}`);
      }

      const arrivals = [];
      let maxUid = state.lastUid;
      const seenUids = [];
      for (const item of Array.isArray(fetched) ? fetched : []) {
        if (item === null || item === undefined) continue;
        const uid = Number(item.uid);
        if (!Number.isInteger(uid) || uid <= 0) continue;
        summary.checked += 1;
        if (uid > maxUid) maxUid = uid;
        const raw = item.raw ?? item.body;
        if (raw === undefined || raw === null) {
          seenUids.push(uid);
          continue;
        }
        let decoded;
        try {
          decoded = decode(raw, friends);
        } catch (error) {
          log(`[dsh-mailbox] parse uid ${uid} failed: ${errorLine(error)}`);
          continue;
        }
        if (decoded === null) continue;
        if (alreadyKnown(index, decoded.parsed.messageId)) {
          seenUids.push(uid);
          continue;
        }
        const row = await persist(decoded, uid, config);
        seenUids.push(uid);
        summary.imported += 1;
        if (!baseline && row.notify) arrivals.push(row);
      }
      if (config.imap.markSeen && seenUids.length > 0) {
        try {
          await call(client, ['markSeen'], seenUids);
        } catch (error) {
          log(`[dsh-mailbox] markSeen failed: ${errorLine(error)}`);
        }
      }

      const nextState = {
        version: 1,
        uidValidity,
        lastUid: maxUid,
        lastSyncAt: new Date(now()).toISOString(),
        lastError: null,
        lastSuccessAt: new Date(now()).toISOString(),
      };
      await store.saveState(nextState);
      summary.ok = true;
      summary.baseline = baseline;
      summary.durationMs = now() - startedAt;
      summary.arrivals = arrivals.map((row) => ({
        id: row.id,
        fromName: row.fromName,
        fromAddress: row.fromAddress,
        subject: row.subject,
        date: row.date,
        snippet: row.snippet,
        friend: row.friend,
        suspicious: row.suspicious,
        folder: row.folder,
      }));
      if (arrivals.length > 0 && typeof options.onNewMail === 'function') {
        try {
          await options.onNewMail(arrivals, { kind: 'new-mail', trigger: trigger.reason ?? 'poll' });
          summary.notified = arrivals.length;
        } catch (error) {
          log(`[dsh-mailbox] notifier failed: ${errorLine(error)}`);
        }
      } else if (arrivals.length > 0) {
        summary.notified = 0;
      }
      lastSummary = summary;
      if (summary.imported > 0 || baseline) log(`[dsh-mailbox] sync ok: ${summary.imported} imported, baseline=${baseline}`);
      return summary;
    } catch (error) {
      const state = await store.loadState().catch(() => null);
      if (state !== null) {
        state.lastError = errorLine(error);
        state.lastSyncAt = new Date(now()).toISOString();
        await store.saveState(state).catch(() => {});
      }
      summary.error = errorLine(error);
      lastSummary = summary;
      log(`[dsh-mailbox] sync failed: ${summary.error}`);
      return summary;
    } finally {
      if (client !== null) {
        try {
          await call(client, ['logout', 'close', 'disconnect']);
        } catch {
          // Closing is best effort.
        }
      }
      running = false;
    }
  }

  /** Run one sync round, swallowing the reason argument when given a string. */
  function trigger(reason = 'manual') {
    return sync({ reason });
  }

  /** Sync status for tools and the UI. */
  async function status() {
    const state = await store.loadState();
    const config = getConfig();
    return {
      enabled: config.enabled === true && config.imap.enabled === true,
      running,
      host: config.imap.host,
      mailbox: config.imap.mailbox,
      pollIntervalSeconds: config.imap.pollIntervalSeconds,
      lastUid: state.lastUid,
      lastSyncAt: state.lastSyncAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      lastSummary,
    };
  }

  /** Stop accepting new rounds (in-flight work continues). */
  function dispose() {
    disposed = true;
  }

  /** Whether the plugin wants an IMAP poll right now. */
  function shouldPoll() {
    const config = getConfig();
    return config.enabled === true && config.imap.enabled === true && !disposed;
  }

  return { sync, trigger, status, dispose, shouldPoll, isRunning: () => running };
}
