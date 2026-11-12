/**
 * dsh-mailbox host service: the single business layer shared by the model tools
 * and the browser UI. It owns the runtime configuration, credential resolution,
 * message bookkeeping, friend whitelist mutations, send/receive operations and
 * the HTTP action dispatch.
 *
 * Security boundaries live here:
 *  - authorization codes never leave `maskedConfig()` and never enter errors;
 *  - every send goes through recipient admission + hourly send budget;
 *  - AI friend additions are policy-gated, daily-capped and audited;
 *  - mail bodies are untrusted data: only sanitized HTML/text is stored/served;
 *  - the plugin master switch (`enabled`) removes operational capabilities.
 *
 * @module dsh-mailbox/lib/service
 */

import {
  connectionStatus,
  defaultConfig,
  deepMerge,
  maskConfig,
  normalizeAddress,
  normalizeConfig,
  presetForUi,
  sameAddress,
  clone,
} from './config.js';
import {
  admitRecipient,
  buildSubject,
  detectAutoSubmission,
  findFriend,
  findPending,
  normalizeSubject,
  RateLimiter,
  snippet,
} from './core/policy.js';
import { attachmentMetadata, normalizeAttachments } from './core/attachments.js';
import { composeLetter, FORMATS, MAX_CONTENT_CHARS, plainSummary } from './compose.js';
import { apiError, ERROR_CODES } from './server.js';
import { incomingMessageId, outgoingMessageId } from './store.js';
import { THREAD_REPLY_DEPTH_LIMIT } from './prompt.js';

/** Returned tool names (kept in one place for diagnostics). */
export const TOOL_NAMES = [
  'send_email',
  'mail_list',
  'mail_read',
  'mail_reply',
  'mail_check',
  'mail_friend_list',
  'mail_friend_add',
  'mail_friend_remove',
  'mail_status',
];

/** Maximum subject length on the wire. */
const MAX_SUBJECT_CHARS = 300;
const ENV_SMTP = ['DSH_SMTP_AUTH_CODE', 'SMTP_AUTH_CODE'];
const ENV_IMAP = ['DSH_IMAP_AUTH_CODE', 'IMAP_AUTH_CODE'];

/** Keep one safe error line free of credentials. */
function errorLine(error) {
  const message = String(error?.message ?? error);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

/** Simple integer clamp. */
function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Create the mailbox service.
 *
 * @param {object} options - wiring.
 * @param {object} options.store - mailbox store.
 * @param {object} options.host - host adapter: `listSessions()`, `deliver(sessionId, text, meta)`.
 * @param {object} options.mail - mail engine adapter: `sendMail`, `verifySmtp`, `openImap`, `sanitizeHtml`.
 * @param {() => Promise<{cid:string,filename:string,contentType:string,base64:string}|undefined>} [options.loadAvatar]
 * @param {() => object} [options.getSync] - sync service getter.
 * @param {() => object} [options.getNotifier] - notifier getter.
 * @param {(next: object) => Promise<void>} [options.onConfigApplied] - reload prompt/timers hook.
 * @param {() => string} [options.getVersion] - plugin version.
 * @param {(line: string) => void} [options.log] - diagnostic logger.
 * @param {unknown} [options.initialConfig] - normalized config override.
 */
export function createMailboxService(options) {
  const { store, host, mail } = options;
  const log = options.log ?? (() => {});
  const getVersion = options.getVersion ?? (() => '0.1.0');
  let config = options.initialConfig ?? defaultConfig();
  let secrets = { version: 1, smtp: { authCode: '' }, imap: { authCode: '' } };
  let sendLimiter = new RateLimiter({ max: config.security.maxSendsPerHour, windowMs: 60 * 60 * 1000, name: 'send' });
  let friendLimiter = new RateLimiter({ max: config.security.maxFriendAddsPerDay, windowMs: 24 * 60 * 60 * 1000, name: 'friend-add' });
  let avatarCache;

  const getSync = () => (typeof options.getSync === 'function' ? options.getSync() : undefined);
  const getNotifier = () => (typeof options.getNotifier === 'function' ? options.getNotifier() : undefined);
  const getRegisteredTools = () => (typeof options.getRegisteredTools === 'function' ? options.getRegisteredTools() : []);
  const getStatusExtras = () => (typeof options.getStatusExtras === 'function' ? options.getStatusExtras() : {});
  /** Notify the host half that the friend whitelist changed (prompt cache). */
  const notifyFriendsChanged = async () => {
    if (typeof options.onFriendsChanged === 'function') {
      try {
        await options.onFriendsChanged();
      } catch {
        // A stale prompt cache must never fail a whitelist mutation.
      }
    }
  };

  /** Strip plaintext credentials before persisting config.json. */
  function persistedConfig(value) {
    const copy = clone(value);
    copy.smtp.authCode = '';
    copy.imap.authCode = '';
    delete copy.secrets;
    return copy;
  }

  /** Recreate rate limiters after a config change. */
  function rebuildLimiters() {
    sendLimiter = new RateLimiter({ max: config.security.maxSendsPerHour, windowMs: 60 * 60 * 1000, name: 'send' });
    friendLimiter = new RateLimiter({ max: config.security.maxFriendAddsPerDay, windowMs: 24 * 60 * 60 * 1000, name: 'friend-add' });
  }

  /** Persist the current non-secret configuration. */
  async function persistConfig() {
    await store.saveConfig(persistedConfig(config));
  }

  /** Load config, seed and secrets; migrate plaintext credentials into secrets.json. */
  async function init() {
    const stored = await store.loadConfig();
    const seed = stored === null ? await store.loadSeed() : null;
    const seedConfig = seed !== null && typeof seed === 'object' ? (seed.config ?? seed) : null;
    const raw = stored ?? seedConfig ?? {};
    const normalized = normalizeConfig(raw);
    config = normalized.value;
    for (const warning of normalized.warnings) log(`[dsh-mailbox] config: ${warning}`);
    for (const issue of normalized.issues) log(`[dsh-mailbox] config issue: ${issue.path}: ${issue.message}`);

    const loadedSecrets = await store.loadSecrets();
    let secretsChanged = false;
    if (typeof loadedSecrets.smtp.authCode === 'string' && loadedSecrets.smtp.authCode !== '') {
      secrets.smtp.authCode = loadedSecrets.smtp.authCode;
    }
    if (typeof loadedSecrets.imap.authCode === 'string' && loadedSecrets.imap.authCode !== '') {
      secrets.imap.authCode = loadedSecrets.imap.authCode;
    }
    const seedSecrets = seed !== null && typeof seed === 'object' ? seed.secrets : null;
    if (seedSecrets !== null && typeof seedSecrets === 'object') {
      if (typeof seedSecrets.smtp?.authCode === 'string' && seedSecrets.smtp.authCode !== '') {
        secrets.smtp.authCode = seedSecrets.smtp.authCode;
        secretsChanged = true;
      }
      if (typeof seedSecrets.imap?.authCode === 'string' && seedSecrets.imap.authCode !== '') {
        secrets.imap.authCode = seedSecrets.imap.authCode;
        secretsChanged = true;
      }
    }
    // Legacy configs stored authCode inline; move it into secrets.json at once.
    if (typeof config.smtp.authCode === 'string' && config.smtp.authCode !== '') {
      secrets.smtp.authCode = config.smtp.authCode;
      secretsChanged = true;
    }
    if (typeof config.imap.authCode === 'string' && config.imap.authCode !== '') {
      secrets.imap.authCode = config.imap.authCode;
      secretsChanged = true;
    }
    if (secretsChanged) await store.saveSecrets(secrets);
    if (stored === null) await persistConfig();
    rebuildLimiters();
    return config;
  }

  // ------------------------------------------------------------- config API

  /** Current normalized config (read-only by convention). */
  function getConfig() {
    return config;
  }

  /** Plugin data directory (attachment reads must never come from here). */
  function getDataDir() {
    return store.dataDir;
  }

  /** Current secrets document (never exposed through HTTP). */
  function getSecrets() {
    return secrets;
  }

  /** Resolve an authorization code for one protocol. */
  async function resolveSecret(protocol) {
    const section = protocol === 'imap' ? config.imap : config.smtp;
    const direct = protocol === 'imap' ? secrets.imap.authCode : secrets.smtp.authCode;
    if (direct !== '') return { value: direct, source: 'secrets' };
    if (section.authCodeFile !== '') {
      try {
        const { readFile } = await import('node:fs/promises');
        const value = (await readFile(section.authCodeFile, 'utf8')).trim();
        if (value !== '') return { value, source: 'file' };
      } catch (error) {
        throw apiError(ERROR_CODES.NOT_CONFIGURED, `无法读取授权码文件：${errorLine(error)}`);
      }
    }
    for (const name of protocol === 'imap' ? ENV_IMAP : ENV_SMTP) {
      const value = (process.env[name] ?? '').trim();
      if (value !== '') return { value, source: 'env' };
    }
    if (protocol === 'imap' && secrets.smtp.authCode !== '') return { value: secrets.smtp.authCode, source: 'smtp-fallback' };
    return { value: '', source: '' };
  }

  /** Secret presence/source summary (safe for the UI). */
  async function secretStatus() {
    const status = { smtp: { configured: false, source: '' }, imap: { configured: false, source: '' } };
    for (const protocol of ['smtp', 'imap']) {
      try {
        const resolved = await resolveSecret(protocol);
        status[protocol] = { configured: resolved.value !== '', source: resolved.source };
      } catch {
        status[protocol] = { configured: false, source: '' };
      }
    }
    return status;
  }

  /** UI-safe configuration copy. */
  async function maskedConfig() {
    const status = await secretStatus();
    const safe = maskConfig(config, status);
    safe.security = clone(config.security);
    return safe;
  }

  /** Apply a partial config patch from the UI. */
  async function saveConfig(params = {}) {
    const patch = params.patch !== undefined ? params.patch : params.config ?? params;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw apiError(ERROR_CODES.INPUT_INVALID, '配置必须是对象');
    }
    const merged = deepMerge(config, patch);
    const normalized = normalizeConfig(merged);
    if (normalized.issues.length > 0) {
      const error = apiError(
        ERROR_CODES.INPUT_INVALID,
        `配置校验失败：${normalized.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')}`,
      );
      error.issues = normalized.issues;
      throw error;
    }
    const next = normalized.value;
    // Extract secrets from the patch (never persisted into config.json).
    const secretPatch = params.secrets ?? {};
    let secretsChanged = false;
    const nextSecrets = clone(secrets);
    const smtpCode = typeof secretPatch.smtpAuthCode === 'string' ? secretPatch.smtpAuthCode.trim() : typeof patch.smtp?.authCode === 'string' ? patch.smtp.authCode.trim() : '';
    const imapCode = typeof secretPatch.imapAuthCode === 'string' ? secretPatch.imapAuthCode.trim() : typeof patch.imap?.authCode === 'string' ? patch.imap.authCode.trim() : '';
    if (smtpCode !== '') {
      nextSecrets.smtp.authCode = smtpCode;
      secretsChanged = true;
    }
    if (imapCode !== '') {
      nextSecrets.imap.authCode = imapCode;
      secretsChanged = true;
    }
    if (params.clearSecrets === true) {
      nextSecrets.smtp.authCode = '';
      nextSecrets.imap.authCode = '';
      secretsChanged = true;
    }
    config = next;
    await persistConfig();
    if (secretsChanged) {
      secrets = nextSecrets;
      await store.saveSecrets(secrets);
    }
    rebuildLimiters();
    if (typeof options.onConfigApplied === 'function') await options.onConfigApplied(config);
    log('[dsh-mailbox] config saved');
    return { config: await maskedConfig(), saved: true };
  }

  /**
   * Persist the auto-created dedicated notification conversation id. This is a
   * runtime bookkeeping write: it must not restart polling/prompt timers.
   *
   * @param {string} sessionId - created conversation.
   */
  async function setDedicatedSession(sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,}$/.test(sessionId)) return;
    if (config.notify.dedicatedSessionId === sessionId) return;
    config = { ...config, notify: { ...config.notify, dedicatedSessionId: sessionId } };
    await persistConfig();
    log(`[dsh-mailbox] dedicated notification session: ${sessionId}`);
  }

  /** Restore defaults for non-secret configuration (credentials are kept). */
  async function resetConfig() {
    config = defaultConfig();
    await persistConfig();
    rebuildLimiters();
    if (typeof options.onConfigApplied === 'function') await options.onConfigApplied(config);
    return { config: await maskedConfig(), reset: true };
  }

  // ------------------------------------------------------------- health/state

  /** Cheap health probe used by the client boot sequence. */
  async function health() {
    const status = await secretStatus();
    return {
      ok: true,
      version: getVersion(),
      enabled: config.enabled === true,
      configured: {
        smtp: status.smtp.configured,
        imap: status.imap.configured,
        mailbox: config.mailbox.address !== '',
        owner: config.owner.address !== '',
      },
      dataDir: store.dataDir,
      capabilities: { send: status.smtp.configured, receive: config.imap.enabled === true && status.imap.configured },
    };
  }

  /** Message counts by folder for badges and empty states. */
  async function counts() {
    const { messages } = await store.loadIndex();
    const inbox = messages.filter((row) => row.folder === 'inbox');
    const sent = messages.filter((row) => row.folder === 'sent');
    const quarantine = messages.filter((row) => row.folder === 'quarantine');
    return {
      inbox: inbox.length,
      unread: inbox.filter((row) => row.unread === true).length,
      quarantine: quarantine.length,
      sent: sent.length,
      friends: (await store.loadFriends()).friends.length,
      pending: (await store.loadFriends()).pending.length,
    };
  }

  /** Full state snapshot for the UI. */
  async function state() {
    const [secretFlags, notificationStatus, syncStatus, messageCounts, friendsDoc] = await Promise.all([
      secretStatus(),
      getNotifier()?.status?.() ?? Promise.resolve(null),
      getSync()?.status?.() ?? Promise.resolve(null),
      counts(),
      store.loadFriends(),
    ]);
    const connections = connectionStatus(config);
    return {
      version: getVersion(),
      enabled: config.enabled === true,
      config: maskConfig(config, secretFlags),
      presets: presetForUi(config.ui.locale === 'en' ? 'en' : 'zh'),
      connections: {
        smtp: { ...connections.smtp, configured: secretFlags.smtp.configured },
        imap: { ...connections.imap, configured: secretFlags.imap.configured },
      },
      sync: syncStatus,
      notifications: notificationStatus,
      counts: { ...messageCounts, friends: friendsDoc.friends.length, pending: friendsDoc.pending.length },
      friendPolicy: config.friends.policy,
      dataDir: store.dataDir,
      tools: TOOL_NAMES,
      registeredTools: getRegisteredTools(),
      ...getStatusExtras(),
    };
  }

  /** Provider presets and authorization-code guidance for the UI. */
  function presets() {
    return { locale: config.ui.locale === 'en' ? 'en' : 'zh', presets: presetForUi(config.ui.locale === 'en' ? 'en' : 'zh') };
  }

  /** Diagnostics bundle (no secrets, no message bodies). */
  async function diagnostics() {
    const [storeDiag, syncStatus, notificationStatus] = await Promise.all([
      store.diagnostics(),
      getSync()?.status?.() ?? Promise.resolve(null),
      getNotifier()?.status?.() ?? Promise.resolve(null),
    ]);
    return {
      version: getVersion(),
      node: process.version,
      platform: process.platform,
      pluginEnabled: config.enabled === true,
      dataDir: store.dataDir,
      store: storeDiag,
      sync: syncStatus,
      notifications: notificationStatus,
      tools: TOOL_NAMES,
      registeredTools: getRegisteredTools(),
      ...getStatusExtras(),
      connections: connectionStatus(config),
      secrets: await secretStatus(),
    };
  }

  // ------------------------------------------------------------------ messages

  /** Filter and paginate index rows. */
  async function listMessages(params = {}) {
    const { messages } = await store.loadIndex();
    const folder = ['inbox', 'sent', 'quarantine', 'all'].includes(params.folder) ? params.folder : 'inbox';
    const unreadOnly = params.unreadOnly === true || params.unreadOnly === 'true';
    const search = typeof params.search === 'string' ? params.search.trim().toLowerCase() : '';
    let rows = messages;
    if (folder !== 'all') rows = rows.filter((row) => row.folder === folder);
    if (unreadOnly) rows = rows.filter((row) => row.unread === true);
    if (search !== '') {
      rows = rows.filter((row) => `${row.fromName ?? ''} ${row.fromAddress ?? ''} ${row.subject ?? ''} ${row.snippet ?? ''}`.toLowerCase().includes(search));
    }
    const total = rows.length;
    const limit = clamp(params.limit, 1, 100, 30);
    const offset = clamp(params.offset, 0, 100000, 0);
    return {
      folder,
      total,
      unread: messages.filter((row) => row.folder === 'inbox' && row.unread === true).length,
      messages: rows.slice(offset, offset + limit).map((row) => ({
        id: row.id,
        folder: row.folder,
        direction: row.direction,
        fromName: row.fromName ?? '',
        fromAddress: row.fromAddress ?? '',
        toAddresses: row.toAddresses ?? [],
        subject: row.subject ?? '',
        date: row.date ?? '',
        snippet: row.snippet ?? '',
        unread: row.unread === true,
        friend: row.friend === true,
        suspicious: row.suspicious === true,
        automatic: row.automatic === true,
        hasAttachments: row.hasAttachments === true,
        threadId: row.threadId ?? '',
        attachments: row.attachments ?? undefined,
        messageId: row.messageId ?? '',
      })),
    };
  }

  /** Load one full message body. */
  async function getMessage(params = {}) {
    const id = typeof params.id === 'string' ? params.id : '';
    if (id === '') throw apiError(ERROR_CODES.INPUT_INVALID, '缺少邮件 id');
    const body = await store.readMessage(id);
    if (body === null) throw apiError(ERROR_CODES.NOT_FOUND, '邮件不存在或已被清理');
    const { messages } = await store.loadIndex();
    const row = messages.find((item) => item.id === id) ?? null;
    return { message: body, row };
  }

  /** Change the read flag. */
  async function markRead(params = {}) {
    const id = typeof params.id === 'string' ? params.id : '';
    if (id === '') throw apiError(ERROR_CODES.INPUT_INVALID, '缺少邮件 id');
    const read = params.read !== false;
    const body = await store.readMessage(id);
    if (body === null) throw apiError(ERROR_CODES.NOT_FOUND, '邮件不存在或已被清理');
    body.unread = !read;
    await store.writeMessage(body);
    const row = await store.updateIndexRow(id, { unread: !read });
    return { id, read, row };
  }

  /** Delete one message (UI only; model tools do not expose deletion). */
  async function deleteMessage(params = {}) {
    const id = typeof params.id === 'string' ? params.id : '';
    if (id === '') throw apiError(ERROR_CODES.INPUT_INVALID, '缺少邮件 id');
    await store.deleteMessage(id);
    await store.removeIndexRow(id);
    return { deleted: true, id };
  }

  // ------------------------------------------------------------------ sending

  /** Ensure the configured prefix appears exactly once. */
  function withPrefix(subject) {
    const prefix = config.mailbox.subjectPrefix;
    const bare = normalizeSubject(subject, prefix).base;
    return buildSubject(bare, { prefix });
  }

  /** Load the inline avatar once (undefined disables the letterhead image). */
  async function loadAvatar() {
    if (typeof options.loadAvatar !== 'function') return undefined;
    if (avatarCache === undefined) avatarCache = await options.loadAvatar();
    return avatarCache ?? undefined;
  }

  /** SMTP connection parameters resolved from config + secrets. */
  async function smtpConnection(override = {}) {
    const host = typeof override.host === 'string' && override.host !== '' ? override.host : config.smtp.host;
    const port = Number.isInteger(override.port) ? override.port : config.smtp.port;
    const security = ['tls', 'starttls', 'none'].includes(override.security) ? override.security : config.smtp.security;
    const user = typeof override.user === 'string' && override.user !== '' ? override.user : config.smtp.user;
    if (host === '' || user === '') throw apiError(ERROR_CODES.NOT_CONFIGURED, 'SMTP 未配置：请先在设置里填写发信邮箱与服务器');
    let pass = typeof override.authCode === 'string' ? override.authCode.trim() : '';
    if (pass === '') {
      const resolved = await resolveSecret('smtp');
      pass = resolved.value;
    }
    if (pass === '') throw apiError(ERROR_CODES.NOT_CONFIGURED, '未配置 SMTP 授权码：请在设置里填写授权码，或配置授权码文件/环境变量');
    return { host, port, security, user, pass };
  }

  /** IMAP connection parameters resolved from config + secrets. */
  async function imapConnection(override = {}) {
    const host = typeof override.host === 'string' && override.host !== '' ? override.host : config.imap.host;
    const port = Number.isInteger(override.port) ? override.port : config.imap.port;
    const security = ['tls', 'starttls', 'none'].includes(override.security) ? override.security : config.imap.security;
    const user = typeof override.user === 'string' && override.user !== '' ? override.user : config.imap.user;
    if (host === '' || user === '') throw apiError(ERROR_CODES.NOT_CONFIGURED, 'IMAP 未配置：请先在设置里填写收信邮箱与服务器');
    let pass = typeof override.authCode === 'string' ? override.authCode.trim() : '';
    if (pass === '') {
      const resolved = await resolveSecret('imap');
      pass = resolved.value;
    }
    if (pass === '') throw apiError(ERROR_CODES.NOT_CONFIGURED, '未配置 IMAP 授权码：请在设置里填写授权码');
    return { host, port, security, user, pass, mailbox: config.imap.mailbox };
  }

  /**
   * Send one letter. Shared by `send_email`, `mail_reply` and the UI composer.
   *
   * @param {object} params - `{ to, subject, content, replyToId, actor }`.
   * @returns {Promise<object>} send receipt.
   */
  async function sendMail(params = {}) {
    if (config.enabled !== true) throw apiError(ERROR_CODES.FORBIDDEN, '插件已停用：请先在邮箱设置里开启插件');
    if (typeof params.content !== 'string' || params.content.trim() === '') throw apiError(ERROR_CODES.INPUT_INVALID, '正文不能为空');
    const content = params.content.trim();
    if (content.length > MAX_CONTENT_CHARS) throw apiError(ERROR_CODES.INPUT_INVALID, `正文过长（上限 ${MAX_CONTENT_CHARS} 字符）`);
    // Author-chosen format: markdown by default (works for AI and human UI).
    const format = FORMATS.includes(params.format) ? params.format : 'markdown';
    const attachmentInput = Array.isArray(params.attachments)
      ? params.attachments.map((item) => {
        if (item === null || typeof item !== 'object') return item;
        if (item.content !== undefined) return item;
        if (typeof item.base64 === 'string') {
          return { filename: item.filename, contentType: item.contentType, content: Buffer.from(item.base64, 'base64') };
        }
        return item;
      })
      : params.attachments;
    const attachmentCheck = normalizeAttachments(attachmentInput, {
      maxCount: config.security.maxAttachments,
      maxTotalBytes: config.security.maxAttachmentBytes,
    });
    if (attachmentCheck.ok !== true) throw apiError(ERROR_CODES.INPUT_INVALID, attachmentCheck.reason);
    const attachments = attachmentCheck.attachments;
    const actor = params.actor === 'user' ? 'user' : 'model';
    const friends = await store.loadFriends();

    // Resolve reply parent first: it fixes the recipient and the thread headers.
    let parent = null;
    if (typeof params.replyToId === 'string' && params.replyToId !== '') {
      parent = await store.readMessage(params.replyToId);
      if (parent === null) throw apiError(ERROR_CODES.NOT_FOUND, '要回复的邮件不存在');
    }
    if (parent !== null && actor === 'model') {
      if (parent.automatic === true || detectAutoSubmission(parent.headers).automatic) {
        throw apiError(ERROR_CODES.FORBIDDEN, '这是自动邮件（自动回复/通知/群发），不要回复');
      }
      const referenceDepth = Array.isArray(parent.headers?.references) ? parent.headers.references.length : 0;
      if (referenceDepth >= THREAD_REPLY_DEPTH_LIMIT) {
        throw apiError(ERROR_CODES.FORBIDDEN, `该线程回复层级已达上限（${THREAD_REPLY_DEPTH_LIMIT}），请先问用户是否继续`);
      }
    }

    const to = parent !== null
      ? parent.from.address
      : (typeof params.to === 'string' && params.to.trim() !== '' ? params.to.trim() : config.owner.address);
    if (to === '') throw apiError(ERROR_CODES.NOT_CONFIGURED, '没有收件人：请配置用户邮箱或填写收件人');
    const admission = parent !== null && actor === 'user'
      ? { ok: true, kind: 'reply', reason: '' }
      : admitRecipient(to, config, friends, { actor, explicitUserRequest: typeof params.to === 'string' && params.to.trim() !== '' });
    if (!admission.ok) throw apiError(ERROR_CODES.FORBIDDEN, admission.reason);
    const limit = sendLimiter.take();
    if (!limit.ok) throw apiError(ERROR_CODES.RATE_LIMITED, `发信频率超限（每小时 ${config.security.maxSendsPerHour} 封），请稍后再试`);

    const recipientLabel = parent !== null ? parent.from.name || parent.from.address : '';
    const baseSubject = parent !== null
      ? (normalizeSubject(parent.subject, config.mailbox.subjectPrefix).base || plainSummary(content).slice(0, 60) || `回复：${config.mailbox.displayName}`)
      : (typeof params.subject === 'string' && params.subject.trim() !== '' ? params.subject.trim() : plainSummary(content).slice(0, 60) || `${config.mailbox.displayName} 的来信`);
    const subject = parent !== null ? buildSubject(baseSubject, { prefix: config.mailbox.subjectPrefix, reply: true }) : withPrefix(baseSubject);
    if (subject.length > MAX_SUBJECT_CHARS) throw apiError(ERROR_CODES.INPUT_INVALID, '主题过长');

    const headers = { messageId: '', inReplyTo: '', references: [] };
    if (parent !== null) {
      headers.inReplyTo = parent.messageId ?? parent.headers?.messageId ?? '';
      const references = Array.isArray(parent.headers?.references) ? parent.headers.references.slice(-10) : [];
      headers.references = [...references, parent.headers?.messageId ?? parent.messageId].filter(Boolean);
    }

    // The author owns the format and style: Markdown, plain text or sanitized
    // HTML. The plugin adds no salutation, signature, date or letterhead.
    const inlineImage = config.mailbox.letterhead === true ? await loadAvatar() : undefined;
    const letter = composeLetter({
      content,
      format,
      inlineImage: inlineImage === undefined ? undefined : { cid: inlineImage.cid, alt: config.mailbox.displayName },
    });

    const connection = await smtpConnection();
    let result;
    try {
      result = await mail.sendMail({
        host: connection.host,
        port: connection.port,
        security: connection.security,
        user: connection.user,
        pass: connection.pass,
        from: config.mailbox.address || connection.user,
        fromName: config.mailbox.displayName,
        to,
        subject,
        text: letter.text,
        html: letter.html,
        avatar: inlineImage,
        attachments: attachments.map((item) => ({ filename: item.filename, contentType: item.contentType, content: item.content })),
        inReplyTo: headers.inReplyTo,
        references: headers.references,
      });
    } catch (error) {
      throw apiError(ERROR_CODES.SMTP_FAILED, `发信失败：${errorLine(error)}`);
    }

    const friend = findFriend(friends, to);
    const id = outgoingMessageId();
    const messageId = result?.messageId ?? headers.messageId;
    const nowIso = new Date().toISOString();
    const body = {
      id,
      direction: 'out',
      messageId,
      from: { name: config.mailbox.displayName, address: config.mailbox.address || connection.user },
      to: [{ name: recipientLabel, address: to }],
      cc: [],
      replyTo: [],
      subject,
      date: nowIso,
      receivedAt: nowIso,
      text: letter.text,
      html: letter.html,
      format: letter.format,
      snippet: snippet(letter.text, config.notify.maxPreviewChars),
      attachments: attachmentMetadata(attachments),
      headers: { messageId, inReplyTo: headers.inReplyTo, references: headers.references },
      friend: friend !== undefined || sameAddress(to, config.owner.address),
      suspicious: false,
      suspiciousReasons: [],
      automatic: false,
      unread: false,
      threadId: headers.references[0] ?? messageId,
      size: Buffer.byteLength(letter.text, 'utf8') + attachments.reduce((sum, item) => sum + item.size, 0),
      replyToId: parent?.id ?? null,
    };
    await store.writeMessage(body);
    const row = {
      id,
      folder: 'sent',
      direction: 'out',
      messageId,
      fromAddress: body.from.address,
      fromName: body.from.name,
      toAddresses: [to],
      subject,
      date: nowIso,
      snippet: body.snippet,
      unread: false,
      friend: body.friend,
      suspicious: false,
      automatic: false,
      hasAttachments: attachments.length > 0,
      attachments: body.attachments,
      threadId: body.threadId,
      notify: false,
      size: body.size,
    };
    await store.appendIndex(row, { maxMessages: config.security.maxMessagesRetained });
    log(`[dsh-mailbox] sent to ${to} (${admission.kind})`);
    return {
      id,
      from: body.from.address,
      to,
      subject,
      messageId,
      kind: admission.kind,
      replyToId: parent?.id ?? null,
      attachments: attachmentMetadata(attachments),
      format: letter.format,
    };
  }

  /** Reply to a stored inbound message (model tool). */
  async function replyMail(params = {}) {
    const id = typeof params.id === 'string' ? params.id : '';
    if (id === '') throw apiError(ERROR_CODES.INPUT_INVALID, '缺少要回复的邮件 id');
    return sendMail({ content: params.content, replyToId: id, actor: 'model', attachments: params.attachments, format: params.format });
  }

  // ------------------------------------------------------------- connections

  /** Test SMTP connectivity and authentication without sending mail. */
  async function testSmtp(params = {}) {
    const connection = await smtpConnection(params);
    try {
      await mail.verifySmtp({
        host: connection.host,
        port: connection.port,
        security: connection.security,
        user: connection.user,
        pass: connection.pass,
      });
    } catch (error) {
      throw apiError(ERROR_CODES.SMTP_FAILED, `SMTP 测试失败：${errorLine(error)}`);
    }
    return { ok: true, host: connection.host, port: connection.port, security: connection.security, user: connection.user, message: 'SMTP 连接与认证成功' };
  }

  /** Test IMAP login and mailbox selection. */
  async function testImap(params = {}) {
    const connection = await imapConnection(params);
    let client = null;
    try {
      client = await mail.openImap({
        host: connection.host,
        port: connection.port,
        security: connection.security,
        user: connection.user,
        pass: connection.pass,
        mailbox: connection.mailbox,
      });
      const selected = await (client.select ? client.select(connection.mailbox) : client.selectMailbox(connection.mailbox));
      return {
        ok: true,
        host: connection.host,
        port: connection.port,
        security: connection.security,
        user: connection.user,
        mailbox: connection.mailbox,
        uidValidity: selected?.uidValidity ?? null,
        exists: selected?.exists ?? null,
        message: 'IMAP 连接与认证成功',
      };
    } catch (error) {
      throw apiError(ERROR_CODES.IMAP_FAILED, `IMAP 测试失败：${errorLine(error)}`);
    } finally {
      if (client !== null) {
        try {
          await (client.logout ? client.logout() : client.close?.());
        } catch {
          // best effort
        }
      }
    }
  }

  // ------------------------------------------------------------------- friend

  /** Friends document plus policy and audit log. */
  async function listFriends() {
    const doc = await store.loadFriends();
    return {
      policy: config.friends.policy,
      defaultAutoReply: config.friends.defaultAutoReply,
      friends: doc.friends,
      pending: doc.pending,
      aiAddLog: doc.aiAddLog.slice(-50),
    };
  }

  /** Add one friend for the user or for the agent (policy-gated). */
  async function addFriend(params = {}) {
    const address = normalizeAddress(params.address);
    if (address === '') throw apiError(ERROR_CODES.INPUT_INVALID, '请输入有效的邮箱地址');
    if (sameAddress(address, config.mailbox.address) || sameAddress(address, config.owner.address)) {
      return { status: 'skipped', address, reason: '该地址是用户或本机邮箱，无需加为好友' };
    }
    const doc = await store.loadFriends();
    const existing = findFriend(doc, address);
    if (existing !== undefined) return { status: 'already', address, friend: existing };
    const pending = findPending(doc, address);
    if (pending !== undefined) return { status: 'pending', address, request: pending };

    const actor = params.actor === 'ai' ? 'ai' : 'user';
    const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : '';
    const note = typeof params.note === 'string' ? params.note.trim().slice(0, 200) : '';
    const reason = typeof params.reason === 'string' ? params.reason.trim().slice(0, 300) : '';
    const nowIso = new Date().toISOString();

    if (actor === 'ai') {
      if (config.friends.policy === 'manual') {
        throw apiError(ERROR_CODES.FORBIDDEN, '当前好友策略是 manual：只有用户能手动添加好友');
      }
      const daily = doc.aiAddLog.filter((entry) => typeof entry.at === 'string' && Date.now() - Date.parse(entry.at) < 24 * 60 * 60 * 1000);
      const budget = friendLimiter.take();
      if (!budget.ok || daily.length >= config.security.maxFriendAddsPerDay) {
        throw apiError(ERROR_CODES.RATE_LIMITED, `AI 加好友已达每日上限（${config.security.maxFriendAddsPerDay} 个），请让用户手动添加或明天再试`);
      }
      if (config.friends.policy === 'ask') {
        doc.pending.push({ address, name, note, reason, requestedBy: 'ai', requestedAt: nowIso });
        await store.saveFriends(doc);
        await notifyFriendsChanged();
        return { status: 'pending', address, policy: 'ask', message: '已生成待用户确认的好友申请' };
      }
      const friend = { address, name, note, reason, addedBy: 'ai', addedAt: nowIso, autoReply: config.friends.defaultAutoReply };
      doc.friends.push(friend);
      doc.aiAddLog.push({ address, at: nowIso, reason, action: 'added' });
      await store.saveFriends(doc);
      await notifyFriendsChanged();
      return { status: 'added', address, friend, policy: 'auto', message: '已加为好友（AI 判断）' };
    }

    const friend = { address, name, note, addedBy: 'user', addedAt: nowIso, autoReply: config.friends.defaultAutoReply };
    doc.friends.push(friend);
    await store.saveFriends(doc);
    await notifyFriendsChanged();
    return { status: 'added', address, friend, message: '已加为好友' };
  }

  /** Remove one friend. */
  async function removeFriend(params = {}) {
    const address = normalizeAddress(params.address);
    if (address === '') throw apiError(ERROR_CODES.INPUT_INVALID, '请输入有效的邮箱地址');
    const doc = await store.loadFriends();
    const friend = findFriend(doc, address);
    if (friend === undefined) throw apiError(ERROR_CODES.NOT_FOUND, '该地址不在好友白名单里');
    doc.friends = doc.friends.filter((item) => !sameAddress(item.address, address));
    doc.pending = doc.pending.filter((item) => !sameAddress(item.address, address));
    if (params.actor === 'ai') {
      doc.aiAddLog.push({ address, at: new Date().toISOString(), reason: typeof params.reason === 'string' ? params.reason.slice(0, 300) : '', action: 'removed' });
    }
    await store.saveFriends(doc);
    await notifyFriendsChanged();
    return { removed: true, address };
  }

  /** Update a friend's display fields (UI only). */
  async function updateFriend(params = {}) {
    const address = normalizeAddress(params.address);
    if (address === '') throw apiError(ERROR_CODES.INPUT_INVALID, '请输入有效的邮箱地址');
    const doc = await store.loadFriends();
    const friend = findFriend(doc, address);
    if (friend === undefined) throw apiError(ERROR_CODES.NOT_FOUND, '该地址不在好友白名单里');
    const patch = params.patch ?? {};
    if (typeof patch.name === 'string') friend.name = patch.name.trim().slice(0, 80);
    if (typeof patch.note === 'string') friend.note = patch.note.trim().slice(0, 200);
    if (typeof patch.autoReply === 'boolean') friend.autoReply = patch.autoReply;
    friend.updatedAt = new Date().toISOString();
    await store.saveFriends(doc);
    await notifyFriendsChanged();
    return { updated: true, friend };
  }

  /** Approve one pending AI friend request. */
  async function approveFriend(params = {}) {
    const address = normalizeAddress(params.address);
    if (address === '') throw apiError(ERROR_CODES.INPUT_INVALID, '请输入有效的邮箱地址');
    const doc = await store.loadFriends();
    const request = findPending(doc, address);
    if (request === undefined) throw apiError(ERROR_CODES.NOT_FOUND, '没有这个待确认申请');
    doc.pending = doc.pending.filter((item) => !sameAddress(item.address, address));
    const friend = {
      address,
      name: request.name ?? '',
      note: request.note ?? '',
      reason: request.reason ?? '',
      addedBy: 'user-approved-ai',
      addedAt: new Date().toISOString(),
      autoReply: config.friends.defaultAutoReply,
    };
    doc.friends.push(friend);
    doc.aiAddLog.push({ address, at: friend.addedAt, reason: request.reason ?? '', action: 'approved' });
    await store.saveFriends(doc);
    await notifyFriendsChanged();
    return { approved: true, friend };
  }

  /** Reject one pending AI friend request. */
  async function rejectFriend(params = {}) {
    const address = normalizeAddress(params.address);
    if (address === '') throw apiError(ERROR_CODES.INPUT_INVALID, '请输入有效的邮箱地址');
    const doc = await store.loadFriends();
    if (findPending(doc, address) === undefined) throw apiError(ERROR_CODES.NOT_FOUND, '没有这个待确认申请');
    doc.pending = doc.pending.filter((item) => !sameAddress(item.address, address));
    doc.aiAddLog.push({ address, at: new Date().toISOString(), reason: '', action: 'rejected' });
    await store.saveFriends(doc);
    await notifyFriendsChanged();
    return { rejected: true, address };
  }

  // ------------------------------------------------------------------ receive

  /** Trigger one IMAP sync round now. */
  async function syncNow() {
    if (config.enabled !== true) throw apiError(ERROR_CODES.FORBIDDEN, '插件已停用');
    const sync = getSync();
    if (sync === undefined) throw apiError(ERROR_CODES.INTERNAL, '收信服务未就绪');
    const summary = await sync.trigger('manual');
    return { summary };
  }

  /** Model-facing mail check: sync and report what arrived. */
  async function checkMail() {
    const { summary } = await syncNow();
    return {
      ok: summary.ok !== false,
      error: summary.error ?? '',
      imported: summary.imported ?? 0,
      baseline: summary.baseline === true,
      newMail: summary.arrivals ?? [],
    };
  }

  /** Compact status for the `mail_status` tool. */
  async function mailStatus() {
    const [syncStatus, notificationStatus, messageCounts, secretFlags] = await Promise.all([
      getSync()?.status?.() ?? Promise.resolve(null),
      getNotifier()?.status?.() ?? Promise.resolve(null),
      counts(),
      secretStatus(),
    ]);
    return {
      enabled: config.enabled === true,
      mailbox: config.mailbox.address,
      owner: config.owner.address,
      smtpConfigured: secretFlags.smtp.configured,
      imapConfigured: secretFlags.imap.configured,
      imapEnabled: config.imap.enabled === true,
      friendPolicy: config.friends.policy,
      counts: messageCounts,
      sync: syncStatus,
      notifications: notificationStatus,
    };
  }

  /** Sessions that can receive notifications (UI picker + notifier). */
  async function sessions() {
    const list = await host.listSessions();
    return { sessions: list };
  }

  /** Manual notification test. */
  async function notifyTest(params = {}) {
    if (config.enabled !== true) throw apiError(ERROR_CODES.FORBIDDEN, '插件已停用');
    const notifier = getNotifier();
    if (notifier === undefined) throw apiError(ERROR_CODES.INTERNAL, '通知服务未就绪');
    return notifier.test(typeof params.sessionId === 'string' ? params.sessionId : '');
  }

  /** Clear mailbox data (messages/index/notifications); config and friends survive. */
  async function clearData(params = {}) {
    await store.clearData({ includeFriends: params.includeFriends === true });
    return { cleared: true };
  }

  // ----------------------------------------------------------------- dispatch

  /** Actions that stay available while the plugin master switch is off. */
  const ALWAYS_ALLOWED = new Set(['state', 'health', 'config.save', 'config.reset', 'diagnostics', 'presets', 'sessions']);

  /**
   * HTTP action dispatch. Every action validates its own parameters and throws
   * `apiError` with a stable code on failure.
   *
   * @param {string} action - allow-listed action name.
   * @param {object} params - JSON parameters.
   * @param {{ enabled: boolean }} context - master switch state.
   * @returns {Promise<object>} response payload merged into `{ ok: true }`.
   */
  async function dispatch(action, params = {}, context = { enabled: true }) {
    if (context.enabled !== true && !ALWAYS_ALLOWED.has(action)) {
      throw apiError(ERROR_CODES.FORBIDDEN, '插件已停用：请先在邮箱设置里开启插件');
    }
    switch (action) {
      case 'health':
        return health();
      case 'state':
        return state();
      case 'presets':
        return presets();
      case 'diagnostics':
        return diagnostics();
      case 'sessions':
        return sessions();
      case 'messages':
        return listMessages(params);
      case 'message':
        return getMessage(params);
      case 'friends':
        return listFriends();
      case 'config.save':
        return saveConfig(params);
      case 'config.reset':
        return resetConfig();
      case 'test.smtp':
        return testSmtp(params);
      case 'test.imap':
        return testImap(params);
      case 'message.read':
        return markRead(params);
      case 'message.delete':
        return deleteMessage(params);
      case 'mail.send':
        return sendMail({ ...params, actor: 'user' });
      case 'sync.now':
        return syncNow();
      case 'notify.test':
        return notifyTest(params);
      case 'friends.add':
        return addFriend({ ...params, actor: 'user' });
      case 'friends.remove':
        return removeFriend({ ...params, actor: 'user' });
      case 'friends.update':
        return updateFriend(params);
      case 'friends.approve':
        return approveFriend(params);
      case 'friends.reject':
        return rejectFriend(params);
      case 'data.clear':
        return clearData(params);
      default:
        throw apiError(ERROR_CODES.BAD_REQUEST, `未知操作：${action}`);
    }
  }

  return {
    init,
    getConfig,
    getDataDir,
    getSecrets,
    setDedicatedSession,
    resolveSecret,
    secretStatus,
    maskedConfig,
    saveConfig,
    resetConfig,
    health,
    state,
    presets,
    diagnostics,
    counts,
    listMessages,
    getMessage,
    markRead,
    deleteMessage,
    sendMail,
    replyMail,
    testSmtp,
    testImap,
    listFriends,
    addFriend,
    removeFriend,
    updateFriend,
    approveFriend,
    rejectFriend,
    syncNow,
    checkMail,
    mailStatus,
    sessions,
    notifyTest,
    clearData,
    dispatch,
    /** Send budget snapshot (diagnostics). */
    limits: () => ({ sendsRemaining: sendLimiter.remaining(), friendAddsRemaining: friendLimiter.remaining() }),
  };
}
