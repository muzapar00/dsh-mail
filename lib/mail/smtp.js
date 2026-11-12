/**
 * Zero-dependency SMTP submission client for dsh-mailbox.
 *
 * Supports:
 * - implicit TLS (typical port 465) and STARTTLS (typical port 587/25);
 * - `security:'none'` for local test servers ONLY (hard-guarded to loopback);
 * - AUTH LOGIN (verified against QQ) and AUTH PLAIN;
 * - RFC 2047 encoded Subject / display names, RFC 5322 Date + Message-ID;
 * - multipart/alternative (text + HTML), optional multipart/related inline
 *   images (avatar via Content-ID) and multipart/mixed attachments;
 * - In-Reply-To / References for threading, custom headers;
 * - per-step timeouts (default 30s), AbortSignal cancellation, multiple
 *   recipients, and structured errors carrying the server reply.
 *
 * Security (SPEC §0): TLS verification is ON by default; credentials are never
 * logged and are scrubbed from every error message at the public boundary.
 *
 * @module dsh-mailbox/lib/mail/smtp
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { encodeWords, htmlToText } from './mime.js';
import { redactSecrets, redactError } from './redact.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

/** SMTP protocol / transport error with the server's reply attached. */
export class SmtpError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number|null} [details.code] - SMTP reply code (or null).
   * @param {'config'|'connection'|'tls'|'timeout'|'aborted'|'auth'|'recipient'|'protocol'} [details.kind]
   * @param {string} [details.step] - protocol step (`EHLO`, `AUTH LOGIN`, `DATA`, ...).
   * @param {string|null} [details.response] - server reply text (already scrubbed).
   * @param {string|null} [details.command] - masked command that failed.
   * @param {Error} [details.cause]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'SmtpError';
    this.code = details.code ?? null;
    this.kind = details.kind ?? 'protocol';
    this.step = details.step ?? '';
    this.response = details.response ?? null;
    this.command = details.command ?? null;
  }
}

/* ------------------------------------------------------------------------- *
 * Header / address helpers (also exported for tests and tooling)
 * ------------------------------------------------------------------------- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a Date as an RFC 5322 date-time with the local UTC offset.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatRfc5322Date(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${WEEKDAYS[date.getDay()]}, ${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/** Replace CR/LF with spaces to make a value safe for a single header line. */
export function sanitizeHeaderText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** Remove CR/LF from a filename / CID parameter value. */
function sanitizeParamText(value) {
  return String(value ?? '').replace(/[\r\n"]/g, '').trim();
}

/** Format a display name as an RFC 5322 phrase (quoted or RFC 2047 encoded). */
export function formatPhrase(name) {
  const text = sanitizeHeaderText(name);
  if (text === '') return '';
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(text)) return encodeWords(text);
  if (/[",;:<>@\\]/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return text;
}

/**
 * Validate and normalize one recipient. Accepts a string address or an object
 * `{ name, address }`.
 * @param {string|{name?: string, address?: string}} input
 * @returns {{name: string, address: string}}
 */
export function normalizeRecipient(input) {
  const source = typeof input === 'string' ? { address: input } : { ...(input ?? {}) };
  const address = String(source.address ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
  if (address === '') throw new SmtpError('recipient address is empty', { kind: 'config', step: 'RCPT' });
  // Header-injection and envelope-injection guards.
  if (/[\r\n<>]/.test(address)) {
    throw new SmtpError('recipient address contains illegal characters', { kind: 'config', step: 'RCPT' });
  }
  if (!/^[^\s,;:"]+@[^\s,;:"]+$/.test(address)) {
    throw new SmtpError(`invalid recipient address: ${address.slice(0, 120)}`, { kind: 'config', step: 'RCPT' });
  }
  return { name: sanitizeHeaderText(source.name ?? ''), address };
}

/** Normalize one or many recipients. */
function normalizeRecipients(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => item !== undefined && item !== null && item !== '').map(normalizeRecipient);
}

/** Normalize an In-Reply-To / References value into `<id>` strings. */
export function normalizeMessageIds(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (text === '') continue;
    if (/^<[^<>]+>$/.test(text)) {
      ids.push(text);
      continue;
    }
    const bracketed = [...text.matchAll(/<([^<>\s]+)>/g)].map((match) => `<${match[1]}>`);
    if (bracketed.length > 0) ids.push(...bracketed);
    else ids.push(`<${text.replace(/[<>\s]/g, '')}>`);
  }
  return ids;
}

/* ------------------------------------------------------------------------- *
 * MIME message builder
 * ------------------------------------------------------------------------- */

/** Wrap a base64 payload at the RFC 2045 76-character line limit. */
function wrap76(encoded) {
  const wrapped = encoded.match(/.{1,76}/g);
  return wrapped === null ? encoded : wrapped.join('\r\n');
}

/** Encode UTF-8 text as a base64 MIME body. */
function encodeBody(text) {
  return wrap76(Buffer.from(String(text), 'utf8').toString('base64'));
}

function assertSafeContentType(value, field) {
  const text = String(value ?? '').trim();
  // Accept bare `type/subtype` plus optional safe parameters (`; charset=utf-8`).
  // Parameters are validated token-by-token so no header injection can hide here.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*(\s*;\s*[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*=[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*)*$/.test(text)) {
    throw new SmtpError(`invalid ${field} content type: ${text.slice(0, 80)}`, { kind: 'config' });
  }
  return text.toLowerCase();
}

function normalizeInlineImages(value) {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return list.map((item) => {
    const contentType = assertSafeContentType(item?.contentType ?? 'image/png', 'inline image');
    if (!contentType.startsWith('image/')) {
      throw new SmtpError(`inline attachment must be an image: ${contentType}`, { kind: 'config' });
    }
    const cid = sanitizeParamText(item?.cid ?? '');
    if (cid === '' || /[<>\s]/.test(cid)) {
      throw new SmtpError('inline image requires a valid content id (cid)', { kind: 'config' });
    }
    const filename = sanitizeParamText(item?.filename ?? `${cid}.png`) || `${cid}.png`;
    const base64 = toBase64(item?.content ?? item?.base64, 'inline image');
    return { contentType, cid, filename, base64 };
  });
}

function normalizeAttachments(value) {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return list.map((item) => {
    const contentType = assertSafeContentType(item?.contentType ?? 'application/octet-stream', 'attachment');
    const filename = sanitizeParamText(item?.filename ?? '');
    if (filename === '') throw new SmtpError('attachment requires a filename', { kind: 'config' });
    const base64 = toBase64(item?.content ?? item?.base64, 'attachment');
    return { contentType, filename, base64 };
  });
}

function toBase64(content, field) {
  if (typeof content === 'string') {
    const cleaned = content.replace(/\s+/g, '');
    if (cleaned === '' || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
      throw new SmtpError(`${field} content must be base64 (or a Buffer)`, { kind: 'config' });
    }
    return cleaned;
  }
  if (content instanceof Uint8Array) return Buffer.from(content).toString('base64');
  throw new SmtpError(`${field} content must be base64 or a Buffer`, { kind: 'config' });
}

function textPart(contentType, text) {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(text),
  ].join('\r\n');
}

function inlineImagePart(image) {
  return [
    `Content-Type: ${image.contentType}; name="${image.filename}"`,
    `Content-ID: <${image.cid}>`,
    `Content-Disposition: inline; filename="${image.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(image.base64),
  ].join('\r\n');
}

function attachmentPart(attachment) {
  return [
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(attachment.base64),
  ].join('\r\n');
}

/** Join MIME parts between boundary delimiters. */
function multipartBody(boundary, parts) {
  const lines = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    lines.push(part);
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

/** Embed a nested entity as a MIME part (Content-Type header + body). */
function embedEntity(entity) {
  return `Content-Type: ${entity.contentType}\r\n\r\n${entity.body}`;
}

const RESERVED_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version',
  'content-type', 'content-transfer-encoding', 'reply-to', 'in-reply-to',
  'references',
]);

/**
 * Build a complete RFC 5322 message.
 *
 * @param {object} options
 * @param {string} options.from - sender address (envelope + header).
 * @param {string} [options.fromName=''] - display name.
 * @param {string|string[]|{name?:string,address:string}[]} options.to
 * @param {string|string[]} [options.cc]
 * @param {string|string[]} [options.bcc]
 * @param {string} [options.subject='']
 * @param {string} [options.text=''] - plain-text body.
 * @param {string|null} [options.html=null] - HTML body.
 * @param {string} [options.replyTo] - Reply-To address (or list).
 * @param {string|null} [options.messageId=null] - custom Message-ID.
 * @param {string|string[]|null} [options.inReplyTo=null]
 * @param {string|string[]|null} [options.references=null]
 * @param {Date} [options.date] - Date header (default now).
 * @param {Record<string,string>} [options.headers] - extra headers.
 * @param {{cid: string, filename?: string, contentType?: string, content?: string|Buffer, base64?: string}} [options.avatar]
 * @param {object[]} [options.inline] - inline images (same shape as avatar).
 * @param {object[]} [options.attachments] - `{filename, contentType, content}`.
 * @param {number} [options.maxMessageBytes=20MB]
 * @returns {{messageId: string, raw: string, envelope: {from: string, to: string[]}}}
 */
export function buildMessage(options = {}) {
  const from = normalizeRecipient(options.from).address;
  const fromName = sanitizeHeaderText(options.fromName ?? '');
  const to = normalizeRecipients(options.to);
  const cc = normalizeRecipients(options.cc);
  const bcc = normalizeRecipients(options.bcc);
  if (to.length + cc.length + bcc.length === 0) {
    throw new SmtpError('message has no recipients', { kind: 'config', step: 'RCPT' });
  }

  const subject = sanitizeHeaderText(options.subject ?? '');
  const text = options.text === undefined || options.text === null ? '' : String(options.text);
  let html = options.html === undefined || options.html === null ? null : String(options.html);
  // Always provide a plain-text alternative: derive it from HTML when missing.
  const plainText = text !== '' ? text : (html === null ? '' : htmlToText(html));

  const inlineImages = [
    ...(options.avatar === undefined || options.avatar === null ? [] : normalizeInlineImages(options.avatar)),
    ...normalizeInlineImages(options.inline ?? []),
  ];
  const attachments = normalizeAttachments(options.attachments ?? []);

  const domain = from.split('@')[1] || 'localhost';
  const messageId = options.messageId === undefined || options.messageId === null || options.messageId === ''
    ? `<${randomUUID()}@${domain}>`
    : (() => {
      const ids = normalizeMessageIds(options.messageId);
      return ids[0] ?? `<${randomUUID()}@${domain}>`;
    })();

  let entity;
  if (html !== null && html.trim() !== '') {
    const altBoundary = `alt-${randomUUID()}`;
    entity = {
      contentType: `multipart/alternative; boundary="${altBoundary}"`,
      body: multipartBody(altBoundary, [
        textPart('text/plain', plainText),
        textPart('text/html', html),
      ]),
    };
  } else {
    entity = {
      contentType: 'text/plain',
      body: encodeBody(plainText),
    };
  }

  if (inlineImages.length > 0) {
    const relBoundary = `rel-${randomUUID()}`;
    const type = html !== null && html.trim() !== ''
      ? 'multipart/alternative'
      : 'text/plain';
    entity = {
      contentType: `multipart/related; boundary="${relBoundary}"; type="${type}"`,
      body: multipartBody(relBoundary, [
        embedEntity(entity),
        ...inlineImages.map(inlineImagePart),
      ]),
    };
  }

  if (attachments.length > 0) {
    const mixBoundary = `mix-${randomUUID()}`;
    entity = {
      contentType: `multipart/mixed; boundary="${mixBoundary}"`,
      body: multipartBody(mixBoundary, [
        embedEntity(entity),
        ...attachments.map(attachmentPart),
      ]),
    };
  }

  const headerLines = [];
  headerLines.push(`From: ${formatPhrase(fromName) === '' ? '' : `${formatPhrase(fromName)} `}<${from}>`);
  headerLines.push(`To: ${to.map((recipient) => `${formatPhrase(recipient.name) === '' ? '' : `${formatPhrase(recipient.name)} `}<${recipient.address}>`).join(', ')}`);
  if (cc.length > 0) {
    headerLines.push(`Cc: ${cc.map((recipient) => `${formatPhrase(recipient.name) === '' ? '' : `${formatPhrase(recipient.name)} `}<${recipient.address}>`).join(', ')}`);
  }
  headerLines.push(`Subject: ${encodeWords(subject)}`);
  headerLines.push(`Date: ${formatRfc5322Date(options.date instanceof Date ? options.date : new Date())}`);
  headerLines.push(`Message-ID: ${messageId}`);
  const replyTo = normalizeRecipients(options.replyTo);
  if (replyTo.length > 0) {
    headerLines.push(`Reply-To: ${replyTo.map((recipient) => `<${recipient.address}>`).join(', ')}`);
  }
  const inReplyTo = normalizeMessageIds(options.inReplyTo);
  if (inReplyTo.length > 0) headerLines.push(`In-Reply-To: ${inReplyTo.join(' ')}`);
  const references = normalizeMessageIds(options.references ?? options.inReplyTo);
  if (references.length > 0) headerLines.push(`References: ${references.join(' ')}`);
  for (const [rawName, rawValue] of Object.entries(options.headers ?? {})) {
    const name = String(rawName ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,75}$/.test(name)) {
      throw new SmtpError(`invalid custom header name: ${name.slice(0, 80)}`, { kind: 'config' });
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new SmtpError(`custom header overrides a reserved header: ${name}`, { kind: 'config' });
    }
    headerLines.push(`${name}: ${sanitizeHeaderText(rawValue)}`);
  }
  headerLines.push('MIME-Version: 1.0');
  headerLines.push(`Content-Type: ${entity.contentType}`);
  if (entity.contentType.startsWith('text/')) headerLines.push('Content-Transfer-Encoding: base64');

  const raw = `${headerLines.join('\r\n')}\r\n\r\n${entity.body}`;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (Buffer.byteLength(raw, 'utf8') > maxMessageBytes) {
    throw new SmtpError(`message too large: ${Buffer.byteLength(raw, 'utf8')} bytes (limit ${maxMessageBytes})`, { kind: 'config' });
  }
  return {
    messageId,
    raw,
    envelope: {
      from,
      to: [...to, ...cc, ...bcc].map((recipient) => recipient.address),
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Socket + protocol plumbing
 * ------------------------------------------------------------------------- */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(host) {
  const value = String(host ?? '').toLowerCase();
  return LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost');
}

function abortedError() {
  return new SmtpError('SMTP operation aborted', { kind: 'aborted' });
}

function timeoutError(step) {
  return new SmtpError(`SMTP ${step} timed out`, { kind: 'timeout', step });
}

/** Build TLS options with strict certificate verification by default. */
function tlsOptionsFor(host, tlsOptions = {}) {
  const options = { ...tlsOptions };
  if (options.rejectUnauthorized === undefined) options.rejectUnauthorized = true;
  if (options.servername === undefined && !net.isIP(host)) options.servername = host;
  return options;
}

function connectTcp({ host, port, timeoutMs, signal, step }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new SmtpError(`TCP connection to ${host}:${port} timed out`, { kind: 'timeout', step }));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(abortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('connect', onConnect);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SmtpError(`TCP connection to ${host}:${port} failed: ${error.message}`, { kind: 'connection', step, cause: error }));
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function connectTls({ host, port, timeoutMs, signal, step, tlsOptions }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const socket = tls.connect({ host, port, ...tlsOptionsFor(host, tlsOptions) });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new SmtpError(`TLS connection to ${host}:${port} timed out`, { kind: 'timeout', step }));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(abortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('secureConnect', onSecure);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SmtpError(`TLS connection to ${host}:${port} failed: ${error.message}`, { kind: 'tls', step, cause: error }));
    };
    const onSecure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('secureConnect', onSecure);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Upgrade an existing plain socket to TLS (STARTTLS). */
function upgradeTls({ socket, host, timeoutMs, signal, tlsOptions }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const secureSocket = tls.connect({ socket, ...tlsOptionsFor(host, tlsOptions) });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      secureSocket.destroy();
      reject(new SmtpError('STARTTLS negotiation timed out', { kind: 'timeout', step: 'STARTTLS' }));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      secureSocket.destroy();
      reject(abortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      secureSocket.off('error', onError);
      secureSocket.off('secureConnect', onSecure);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SmtpError(`STARTTLS failed: ${error.message}`, { kind: 'tls', step: 'STARTTLS', cause: error }));
    };
    const onSecure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(secureSocket);
    };
    secureSocket.once('error', onError);
    secureSocket.once('secureConnect', onSecure);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Line-oriented SMTP channel: reads replies (multiline aware), writes commands,
 * enforces per-read timeout and abort. One pending read at a time.
 */
function createChannel(socket, { timeoutMs, signal }) {
  let buffer = Buffer.alloc(0);
  let pending = null;
  let failure = null;
  let closed = false;

  const fail = (error) => {
    if (failure !== null) return;
    failure = error;
    if (pending !== null) {
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (pending !== null) {
      const index = buffer.indexOf(0x0a);
      if (index !== -1) {
        let line = buffer.subarray(0, index).toString('latin1');
        buffer = buffer.subarray(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const waiter = pending;
        pending = null;
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  };
  const onError = (error) => fail(new SmtpError(`SMTP socket error: ${error.message}`, { kind: 'connection', cause: error }));
  const onClose = () => {
    closed = true;
    fail(new SmtpError('SMTP connection closed unexpectedly', { kind: 'connection' }));
  };
  const onAbort = () => fail(abortedError());

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });

  const readLine = () => {
    if (failure !== null) return Promise.reject(failure);
    if (pending !== null) {
      return Promise.reject(new SmtpError('concurrent SMTP read (internal bug)', { kind: 'protocol' }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending === null) return;
        pending = null;
        reject(timeoutError('read'));
        socket.destroy();
      }, timeoutMs);
      pending = { resolve, reject, timer };
      if (buffer.indexOf(0x0a) !== -1) {
        const index = buffer.indexOf(0x0a);
        let line = buffer.subarray(0, index).toString('latin1');
        buffer = buffer.subarray(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pending = null;
        clearTimeout(timer);
        resolve(line);
      }
    });
  };

  const readReply = async () => {
    const lines = [];
    for (;;) {
      const line = await readLine();
      const match = /^(\d{3})([- ])(.*)$/.exec(line);
      if (match === null) {
        if (line.trim() === '') continue;
        throw new SmtpError(`malformed SMTP reply: ${line.slice(0, 200)}`, { kind: 'protocol' });
      }
      lines.push(match[3]);
      if (match[2] === ' ') return { code: Number(match[1]), text: lines.join('\n') };
    }
  };

  return {
    socket,
    readReply,
    write(line) {
      if (closed || failure !== null) throw failure ?? new SmtpError('SMTP connection is closed', { kind: 'connection' });
      socket.write(`${line}\r\n`);
    },
    writeRaw(text) {
      if (closed || failure !== null) throw failure ?? new SmtpError('SMTP connection is closed', { kind: 'connection' });
      socket.write(text);
    },
    fail,
    destroy(error) {
      fail(error ?? new SmtpError('SMTP connection closed', { kind: 'connection' }));
      socket.destroy();
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      fail(new SmtpError('SMTP channel detached for STARTTLS', { kind: 'protocol' }));
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Capabilities / auth
 * ------------------------------------------------------------------------- */

/** Parse EHLO capabilities (first line is the server hostname). */
export function parseCapabilities(text) {
  const capabilities = {};
  const lines = String(text ?? '').split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    const space = line.indexOf(' ');
    const name = (space === -1 ? line : line.slice(0, space)).toUpperCase();
    const value = space === -1 ? '' : line.slice(space + 1);
    if (name in capabilities) capabilities[name] = `${capabilities[name]} ${value}`.trim();
    else capabilities[name] = value;
  }
  return capabilities;
}

/** Extract the advertised AUTH mechanisms from parsed EHLO capabilities. */
export function advertisedAuthMethods(capabilities) {
  const methods = new Set();
  for (const [name, value] of Object.entries(capabilities ?? {})) {
    if (!name.startsWith('AUTH')) continue;
    const rest = name.slice(4).replace(/^=/, '').trim();
    if (rest !== '') methods.add(rest.toUpperCase());
    for (const method of String(value).split(/\s+/)) {
      if (method !== '') methods.add(method.toUpperCase());
    }
  }
  return [...methods];
}

async function authenticate(channel, { user, pass, authMethod, capabilities }) {
  const advertised = advertisedAuthMethods(capabilities);
  let method = authMethod ?? 'auto';
  if (method === 'auto') {
    if (advertised.length === 0) method = 'login';
    else if (advertised.includes('LOGIN')) method = 'login';
    else if (advertised.includes('PLAIN')) method = 'plain';
    else method = 'login';
  }
  if (method === 'plain') {
    const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
    channel.write(`AUTH PLAIN ${token}`);
    const reply = await channel.readReply();
    if (reply.code !== 235) {
      throw new SmtpError(`authentication failed (${reply.code}): ${reply.text}`, {
        kind: 'auth', step: 'AUTH PLAIN', code: reply.code, response: reply.text,
      });
    }
    return 'PLAIN';
  }
  channel.write('AUTH LOGIN');
  let reply = await channel.readReply();
  if (reply.code !== 334) {
    throw new SmtpError(`AUTH LOGIN rejected (${reply.code}): ${reply.text}`, {
      kind: 'auth', step: 'AUTH LOGIN', code: reply.code, response: reply.text,
    });
  }
  channel.write(Buffer.from(user, 'utf8').toString('base64'));
  reply = await channel.readReply();
  if (reply.code !== 334) {
    throw new SmtpError(`AUTH LOGIN username rejected (${reply.code}): ${reply.text}`, {
      kind: 'auth', step: 'AUTH LOGIN', code: reply.code, response: reply.text,
    });
  }
  channel.write(Buffer.from(pass, 'utf8').toString('base64'));
  reply = await channel.readReply();
  if (reply.code !== 235) {
    throw new SmtpError(`authentication failed (${reply.code}): ${reply.text}`, {
      kind: 'auth', step: 'AUTH LOGIN', code: reply.code, response: reply.text,
    });
  }
  return 'LOGIN';
}

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

function normalizeOptions(options = {}) {
  const security = String(options.security ?? 'tls').toLowerCase();
  if (!['tls', 'starttls', 'none'].includes(security)) {
    throw new SmtpError(`unsupported security mode: ${security} (expected tls|starttls|none)`, { kind: 'config' });
  }
  if (options.host === undefined || String(options.host).trim() === '') {
    throw new SmtpError('SMTP host is required', { kind: 'config' });
  }
  const host = String(options.host).trim();
  if (security === 'none' && !isLoopbackHost(host)) {
    throw new SmtpError('security "none" is only allowed for localhost test servers', { kind: 'config' });
  }
  const port = Number(options.port ?? (security === 'tls' ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SmtpError(`invalid SMTP port: ${options.port}`, { kind: 'config' });
  }
  return {
    host,
    port,
    security,
    user: options.user === undefined ? '' : String(options.user),
    pass: options.pass === undefined ? '' : String(options.pass),
    authMethod: options.authMethod ?? 'auto',
    ehloName: options.ehloName ?? 'localhost',
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    tlsOptions: options.tlsOptions ?? {},
  };
}

/**
 * Open a connection (implicit TLS or plain), say EHLO, STARTTLS when required
 * and authenticate. Returns the live session used by sendMail / verifySmtp.
 */
async function openSession(options) {
  if (options.signal?.aborted) throw abortedError();
  let socket;
  let greeting;
  if (options.security === 'tls') {
    socket = await connectTls({
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      step: 'connect',
      tlsOptions: options.tlsOptions,
    });
  } else {
    socket = await connectTcp({
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      step: 'connect',
    });
  }
  let channel = createChannel(socket, { timeoutMs: options.timeoutMs, signal: options.signal });
  try {
    greeting = await channel.readReply();
    if (greeting.code !== 220) {
      throw new SmtpError(`unexpected SMTP greeting (${greeting.code}): ${greeting.text}`, {
        kind: 'protocol', step: 'greeting', code: greeting.code, response: greeting.text,
      });
    }
    const ehlo = async () => {
      channel.write(`EHLO ${options.ehloName}`);
      let reply = await channel.readReply();
      if (reply.code !== 250) {
        channel.write(`HELO ${options.ehloName}`);
        reply = await channel.readReply();
        if (reply.code !== 250) {
          throw new SmtpError(`EHLO/HELO failed (${reply.code}): ${reply.text}`, {
            kind: 'protocol', step: 'EHLO', code: reply.code, response: reply.text,
          });
        }
        return {};
      }
      return parseCapabilities(reply.text);
    };
    let capabilities = await ehlo();

    if (options.security === 'starttls') {
      if (!('STARTTLS' in capabilities)) {
        throw new SmtpError('server does not advertise STARTTLS', { kind: 'tls', step: 'STARTTLS' });
      }
      channel.write('STARTTLS');
      const reply = await channel.readReply();
      if (reply.code !== 220) {
        throw new SmtpError(`STARTTLS rejected (${reply.code}): ${reply.text}`, {
          kind: 'tls', step: 'STARTTLS', code: reply.code, response: reply.text,
        });
      }
      channel.detach();
      const secureSocket = await upgradeTls({
        socket,
        host: options.host,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        tlsOptions: options.tlsOptions,
      });
      socket = secureSocket;
      channel = createChannel(socket, { timeoutMs: options.timeoutMs, signal: options.signal });
      capabilities = await ehlo();
    }

    let authMethod = null;
    if (options.user !== '' && options.pass !== '') {
      authMethod = await authenticate(channel, {
        user: options.user,
        pass: options.pass,
        authMethod: options.authMethod,
        capabilities,
      });
    }
    return { socket, channel, greeting: greeting.text, capabilities, authMethod };
  } catch (error) {
    channel.destroy(error instanceof SmtpError ? error : new SmtpError(error.message, { kind: 'connection', cause: error }));
    throw error;
  }
}

/**
 * Send one email.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} [options.port=465]
 * @param {'tls'|'starttls'|'none'} [options.security='tls'] - `none` only for localhost.
 * @param {string} [options.user]
 * @param {string} [options.pass] - authorization code / password.
 * @param {'auto'|'login'|'plain'} [options.authMethod='auto']
 * @param {string} options.from
 * @param {string} [options.fromName]
 * @param {string|string[]|object[]} options.to
 * @param {string|string[]} [options.cc]
 * @param {string|string[]} [options.bcc]
 * @param {string} [options.subject]
 * @param {string} [options.text]
 * @param {string|null} [options.html]
 * @param {string} [options.replyTo]
 * @param {string|string[]} [options.inReplyTo]
 * @param {string|string[]} [options.references]
 * @param {string|null} [options.messageId]
 * @param {Date} [options.date]
 * @param {Record<string,string>} [options.headers]
 * @param {object} [options.avatar] - `{cid, filename, contentType, base64|content}`
 * @param {object[]} [options.inline]
 * @param {object[]} [options.attachments]
 * @param {number} [options.timeoutMs=30000]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.tlsOptions] - extra `tls.connect` options (`rejectUnauthorized` defaults true).
 * @param {number} [options.maxMessageBytes=20MB]
 * @returns {Promise<{messageId: string, accepted: string[], rejected: Array<{address: string, code: number, text: string}>, response: string, server: {greeting: string, capabilities: object, authMethod: string|null}}>}
 */
export async function sendMail(options = {}) {
  const config = normalizeOptions(options);
  const secrets = [config.pass, config.user];
  let envelope;
  try {
    envelope = buildMessage(options);
  } catch (error) {
    if (error instanceof SmtpError) throw redactError(error, secrets);
    throw new SmtpError(`failed to build message: ${error.message}`, { kind: 'config', cause: error });
  }
  try {
    const session = await openSession(config);
    const { channel } = session;
    try {
      channel.write(`MAIL FROM:<${envelope.envelope.from}>`);
      const mailReply = await channel.readReply();
      if (mailReply.code !== 250) {
        throw new SmtpError(`MAIL FROM rejected (${mailReply.code}): ${mailReply.text}`, {
          kind: 'protocol', step: 'MAIL FROM', code: mailReply.code, response: mailReply.text,
        });
      }
      const accepted = [];
      const rejected = [];
      for (const address of envelope.envelope.to) {
        channel.write(`RCPT TO:<${address}>`);
        const reply = await channel.readReply();
        if (reply.code === 250 || reply.code === 251) accepted.push(address);
        else rejected.push({ address, code: reply.code, text: reply.text });
      }
      if (accepted.length === 0) {
        throw new SmtpError(
          `all recipients were rejected: ${rejected.map((item) => `${item.address} (${item.code} ${item.text})`).join('; ')}`,
          { kind: 'recipient', step: 'RCPT TO', code: rejected[0]?.code ?? null, response: rejected[0]?.text ?? null },
        );
      }
      channel.write('DATA');
      const dataReply = await channel.readReply();
      if (dataReply.code !== 354) {
        throw new SmtpError(`DATA rejected (${dataReply.code}): ${dataReply.text}`, {
          kind: 'protocol', step: 'DATA', code: dataReply.code, response: dataReply.text,
        });
      }
      // Dot-stuff: every line starting with "." gets an extra dot (RFC 5321 §4.5.2).
      const stuffed = envelope.raw.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
      channel.writeRaw(`${stuffed}\r\n.\r\n`);
      const acceptedReply = await channel.readReply();
      if (acceptedReply.code !== 250) {
        throw new SmtpError(`message rejected (${acceptedReply.code}): ${acceptedReply.text}`, {
          kind: 'protocol', step: 'message body', code: acceptedReply.code, response: acceptedReply.text,
        });
      }
      try {
        channel.write('QUIT');
        await channel.readReply();
      } catch {
        // QUIT is best-effort; the message was already accepted.
      }
      return {
        messageId: envelope.messageId,
        accepted,
        rejected,
        response: acceptedReply.text,
        server: {
          greeting: session.greeting,
          capabilities: session.capabilities,
          authMethod: session.authMethod,
        },
      };
    } finally {
      channel.destroy();
    }
  } catch (error) {
    if (error instanceof SmtpError) throw redactError(error, secrets);
    throw redactError(new SmtpError(`SMTP send failed: ${error.message}`, { kind: 'connection', cause: error }), secrets);
  }
}

/**
 * Test a SMTP configuration without sending mail: connect, EHLO, optional
 * STARTTLS, AUTH, QUIT.
 *
 * @param {object} options - same connection fields as sendMail.
 * @returns {Promise<{ok: true, greeting: string, capabilities: object, authMethod: string|null}>}
 */
export async function verifySmtp(options = {}) {
  const config = normalizeOptions(options);
  const secrets = [config.pass, config.user];
  try {
    const session = await openSession(config);
    try {
      try {
        session.channel.write('QUIT');
        await session.channel.readReply();
      } catch {
        // best effort
      }
      return {
        ok: true,
        greeting: session.greeting,
        capabilities: session.capabilities,
        authMethod: session.authMethod,
      };
    } finally {
      session.channel.destroy();
    }
  } catch (error) {
    if (error instanceof SmtpError) throw redactError(error, secrets);
    throw redactError(new SmtpError(`SMTP verification failed: ${error.message}`, { kind: 'connection', cause: error }), secrets);
  }
}

export default { sendMail, verifySmtp, buildMessage, SmtpError, formatRfc5322Date, formatPhrase, normalizeRecipient, normalizeMessageIds, parseCapabilities, advertisedAuthMethods, sanitizeHeaderText };
