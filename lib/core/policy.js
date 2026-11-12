/**
 * dsh-mailbox policy core: friend classification, recipient admission,
 * suspicious-mail signals, auto-reply guards, thread/subject helpers and rate
 * limiting. Pure functions only — no I/O, no timers, no host services — so the
 * security-relevant rules are unit-testable in isolation.
 *
 * @module dsh-mailbox/lib/core/policy
 */

import { normalizeAddress, sameAddress, uniqueAddresses } from '../config.js';

/** Local parts that must never receive an automatic reply. */
const NO_REPLY_LOCALS = new Set([
  'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'no_reply', 'mailer-daemon',
  'postmaster', 'bounce', 'bounces', 'abuse', 'notifications', 'notification',
]);

/** Attachment extensions whose presence marks a message suspicious. */
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.scr', '.com', '.bat', '.cmd', '.msi', '.ps1', '.vbs', '.js', '.jse',
  '.jar', '.lnk', '.hta', '.reg', '.pif', '.cpl', '.dll', '.apk', '.dmg', '.pkg',
]);

/** Subject patterns used by automatic responders and mailing lists. */
const AUTO_SUBJECT_RE = /^(自动回复|自動回覆|自动答复|auto[\s-]?reply|automatic reply|out of office|autoreply)/i;

/** Mailbox folder names. */
export const FOLDERS = ['inbox', 'sent', 'quarantine', 'all'];

/** Strip our configured subject prefix; repeat for odd upstream prefixes. */
export function stripPrefix(subject, prefix) {
  let rest = String(subject ?? '').trim();
  const trimmedPrefix = String(prefix ?? '').trim();
  if (trimmedPrefix !== '') {
    while (rest.toLowerCase().startsWith(trimmedPrefix.toLowerCase())) {
      rest = rest.slice(trimmedPrefix.length).trim();
    }
  }
  return rest;
}

/**
 * Split a subject into its base text and reply state. Handles localized reply
 * markers (Re:, RE:, 回复:, 答复:) and strips our configured prefix.
 *
 * @param {string} subject - raw subject.
 * @param {string} [prefix] - configured subject prefix.
 * @returns {{ base: string, isReply: boolean, subject: string }} normalized.
 */
export function normalizeSubject(subject, prefix = '') {
  let rest = stripPrefix(subject, prefix);
  let isReply = false;
  const replyRe = /^(re|fw|fwd|aw|sv|回复|答复|转发)\s*(\[\d+\])?\s*[:：]\s*/i;
  let match = replyRe.exec(rest);
  while (match !== null) {
    isReply = true;
    rest = rest.slice(match[0].length).trim();
    match = replyRe.exec(rest);
  }
  return { base: rest, isReply, subject: rest };
}

/**
 * Compose an outgoing subject: optional prefix, optional `Re: ` marker, base.
 *
 * @param {string} base - subject without the configured prefix.
 * @param {{ prefix?: string, reply?: boolean }} [options] - composition flags.
 * @returns {string} wire subject.
 */
export function buildSubject(base, options = {}) {
  const prefix = typeof options.prefix === 'string' ? options.prefix : '';
  let text = String(base ?? '').trim();
  text = stripPrefix(text, prefix);
  const replyRe = /^(re|回复)\s*[:：]\s*/i;
  if (options.reply === true && !replyRe.test(text)) text = `Re: ${text}`;
  return `${prefix}${text}`.trim();
}

/** Root of a References chain: the thread identity used for grouping. */
export function threadRoot(messageId, references) {
  if (Array.isArray(references) && references.length > 0) {
    const first = references.find((item) => typeof item === 'string' && item.trim() !== '');
    if (first !== undefined) return first.trim().replace(/^<|>$/g, '');
  }
  return String(messageId ?? '').trim().replace(/^<|>$/g, '');
}

/** Reply depth derived from the References chain length. */
export function replyDepth(references) {
  return Array.isArray(references) ? references.length : 0;
}

/** Trim a message body into a one-line notification preview. */
export function snippet(text, maxChars = 200) {
  const flat = String(text ?? '')
    .replace(/[\r\n\t ]+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Look a friend up by address. */
export function findFriend(friendsDoc, address) {
  if (!Array.isArray(friendsDoc?.friends)) return undefined;
  return friendsDoc.friends.find((friend) => sameAddress(friend.address, address));
}

/** Look a pending request up by address. */
export function findPending(friendsDoc, address) {
  if (!Array.isArray(friendsDoc?.pending)) return undefined;
  return friendsDoc.pending.find((request) => sameAddress(request.address, address));
}

/** @returns {boolean} whether the address is a friend. */
export function isFriend(friendsDoc, address) {
  return findFriend(friendsDoc, address) !== undefined;
}

/**
 * Classify an incoming sender against the whitelist. Friendship is decided by
 * the envelope From address only — never by the display name.
 *
 * @param {string} fromAddress - sender mailbox.
 * @param {object} friendsDoc - friends document from the store.
 * @returns {{ kind: 'friend'|'stranger', friend?: object }}
 */
export function classifySender(fromAddress, friendsDoc) {
  const friend = findFriend(friendsDoc, fromAddress);
  return friend === undefined ? { kind: 'stranger' } : { kind: 'friend', friend };
}

/**
 * Recipient admission for outgoing mail.
 *
 * `send_email` is used by the model; `mail.send` is used by the human UI. Both
 * share the same whitelist, but a human explicitly typing an address in the
 * UI may be allowed to reach strangers when the configuration says so.
 *
 * @param {string} toAddress - recipient mailbox.
 * @param {object} config - normalized config.
 * @param {object} friendsDoc - friends document.
 * @param {{ actor?: 'model'|'user', explicitUserRequest?: boolean }} [context]
 * @returns {{ ok: boolean, kind: 'owner'|'friend'|'stranger', reason: string }}
 */
export function admitRecipient(toAddress, config, friendsDoc, context = {}) {
  const address = normalizeAddress(toAddress);
  if (address === '') return { ok: false, kind: 'stranger', reason: '收件人不是有效的邮箱地址' };
  if (sameAddress(address, config.owner.address)) return { ok: true, kind: 'owner', reason: '' };
  if (isFriend(friendsDoc, address)) return { ok: true, kind: 'friend', reason: '' };
  const actor = context.actor === 'user' ? 'user' : 'model';
  if (actor === 'user') {
    return config.smtp.allowStrangerRecipients
      ? { ok: true, kind: 'stranger', reason: '' }
      : { ok: false, kind: 'stranger', reason: '对方不在好友白名单；若要发送，请在设置中开启「允许向陌生人发信」' };
  }
  const allowed = config.smtp.allowStrangerRecipients && context.explicitUserRequest === true;
  return {
    ok: allowed,
    kind: 'stranger',
    reason: allowed
      ? ''
      : '对方不在好友白名单：只有用户在会话里明确要求、且设置允许向陌生人发信时才能发送',
  };
}

/**
 * Detect automatic submissions that must never receive an auto-reply.
 *
 * @param {object} headers - lowercase header name → value (or array).
 * @param {object} [options] - `{ subject }` extra signal.
 * @returns {{ automatic: boolean, reasons: string[] }}
 */
export function detectAutoSubmission(headers, options = {}) {
  const reasons = [];
  const get = (name) => {
    if (headers === undefined || headers === null) return '';
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(' ') : String(value ?? '');
  };

  const autoSubmitted = get('auto-submitted').trim().toLowerCase();
  if (autoSubmitted !== '' && autoSubmitted !== 'no') reasons.push('Auto-Submitted 头表明是自动邮件');
  const precedence = get('precedence').trim().toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) reasons.push(`Precedence: ${precedence}`);
  if (get('list-unsubscribe') !== '' || get('list-id') !== '') reasons.push('邮件列表/退订头');
  if (get('x-auto-response-suppress') !== '') reasons.push('X-Auto-Response-Suppress');
  if (get('x-autoreply') !== '' || get('x-autorespond') !== '') reasons.push('自动回复头');

  const from = get('from');
  const local = from.includes('@') ? from.slice(0, from.lastIndexOf('@')).replace(/["<>]/g, '').trim().toLowerCase() : '';
  if (NO_REPLY_LOCALS.has(local)) reasons.push(`发件地址 ${local}@ 是机器人地址`);
  const subject = String(options.subject ?? get('subject') ?? '');
  if (AUTO_SUBJECT_RE.test(subject.trim())) reasons.push('主题是自动回复/外出通知');

  return { automatic: reasons.length > 0, reasons };
}

/**
 * Objective suspicion signals from the parsed message. Used to quarantine mail
 * before its content can steer any automatic behavior.
 *
 * @param {object} mail - parsed message: { headers, from, replyTo, attachments, links, text, html }
 * @param {object} friendsDoc - friends document (for display-name spoofing).
 * @returns {{ suspicious: boolean, reasons: string[] }}
 */
export function suspiciousSignals(mail, friendsDoc) {
  const reasons = [];
  const headers = mail?.headers ?? {};
  const authResults = String(headers['authentication-results'] ?? '');
  if (/spf\s*=\s*(fail|softfail|permerror)/i.test(authResults)) reasons.push('SPF 校验失败');
  if (/dkim\s*=\s*fail/i.test(authResults)) reasons.push('DKIM 校验失败');
  if (/dmarc\s*=\s*(fail|quarantine|reject)/i.test(authResults)) reasons.push('DMARC 校验失败');

  const fromAddress = normalizeAddress(mail?.from?.address ?? '');
  const replyTo = Array.isArray(mail?.replyTo) ? mail.replyTo : [];
  const replyToAddress = normalizeAddress(replyTo[0]?.address ?? '');
  if (replyToAddress !== '' && fromAddress !== '' && replyToAddress !== fromAddress) {
    const sameDomain = replyToAddress.split('@')[1] === fromAddress.split('@')[1];
    if (!sameDomain) reasons.push('Reply-To 与发件地址不一致');
  }

  const displayName = String(mail?.from?.name ?? '').trim();
  if (displayName !== '' && Array.isArray(friendsDoc?.friends)) {
    const spoof = friendsDoc.friends.find(
      (friend) => friend.name !== undefined && friend.name !== '' && friend.name === displayName && !sameAddress(friend.address, fromAddress),
    );
    if (spoof !== undefined) reasons.push('显示名冒充好友');
  }

  const attachments = Array.isArray(mail?.attachments) ? mail.attachments : [];
  for (const attachment of attachments) {
    const name = String(attachment?.filename ?? '').toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && DANGEROUS_EXTENSIONS.has(name.slice(dot))) {
      reasons.push(`附件 ${attachment.filename} 是可执行/脚本类型`);
      break;
    }
  }

  const links = Array.isArray(mail?.links) ? mail.links : [];
  if (links.length > 30) reasons.push('正文包含大量链接');
  const html = String(mail?.html ?? '');
  if (/<(form|input)[^>]*type\s*=\s*["']?password/i.test(html) || /<form[\s>]/i.test(html)) reasons.push('正文包含表单');
  if (/\b(punycode|xn--)/i.test(fromAddress) || /xn--/i.test(fromAddress)) reasons.push('域名包含 punycode');

  return { suspicious: reasons.length > 0, reasons };
}

/**
 * Whether this message may receive an automatic reply. Conservative by default:
 * only when the user explicitly enabled default auto-reply, the sender is a
 * friend, the message is not automatic, and the thread is shallow.
 *
 * @param {object} mail - parsed message plus `friend` classification.
 * @param {object} config - normalized config.
 * @param {object} friendsDoc - friends document.
 * @returns {{ ok: boolean, reason: string }}
 */
export function admitAutoReply(mail, config, friendsDoc) {
  if (!isFriend(friendsDoc, mail?.from?.address)) return { ok: false, reason: '发件人不在好友白名单' };
  const friend = findFriend(friendsDoc, mail.from.address);
  const autoReply = friend?.autoReply ?? config.friends.defaultAutoReply;
  if (autoReply !== true) return { ok: false, reason: '未开启自动回复' };
  const auto = detectAutoSubmission(mail?.headers, { subject: mail?.subject });
  if (auto.automatic) return { ok: false, reason: `自动邮件不回：${auto.reasons.join('；')}` };
  if (replyDepth(mail?.references) >= 5) return { ok: false, reason: '线程回复深度已达上限（5）' };
  return { ok: true, reason: '' };
}

/** Convert dangerous extension list for tests/diagnostics. */
export function dangerousAttachmentExtensions() {
  return [...DANGEROUS_EXTENSIONS];
}

/**
 * Fixed-window in-memory rate limiter. Security control: bounds outbound mail,
 * friend additions and sync-triggered work.
 */
export class RateLimiter {
  /**
   * @param {{ max: number, windowMs: number, name?: string }} options - limits.
   */
  constructor(options) {
    this.max = Math.max(1, options.max);
    this.windowMs = Math.max(1000, options.windowMs);
    this.name = options.name ?? 'rate';
    this.hits = [];
  }

  /**
   * Record one attempt.
   *
   * @param {number} [now] - clock injection for tests.
   * @returns {{ ok: boolean, retryAfterMs: number }}
   */
  take(now = Date.now()) {
    this.hits = this.hits.filter((at) => now - at < this.windowMs);
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(0, this.windowMs - (now - oldest)) };
    }
    this.hits.push(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /** Remaining attempts in the current window. */
  remaining(now = Date.now()) {
    this.hits = this.hits.filter((at) => now - at < this.windowMs);
    return Math.max(0, this.max - this.hits.length);
  }
}

/**
 * Merge duplicate recipients and produce the wire `To` list.
 *
 * @param {string[]} addresses - candidate recipients.
 * @returns {string[]} normalized, de-duplicated addresses.
 */
export function prepareRecipients(addresses) {
  return uniqueAddresses(addresses).slice(0, 20);
}
