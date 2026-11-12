/**
 * Zero-dependency minimal IMAP4rev1 client for dsh-mailbox.
 *
 * Scope (deliberately small, matches SPEC §7 sync flow):
 * - implicit TLS (993) / STARTTLS (143) / `none` for loopback test servers;
 * - LOGIN (with quoted strings, literal fallback for non-ASCII credentials),
 *   plus the IMAP `ID` command that 163/126 require after login;
 * - CAPABILITY, SELECT / EXAMINE (UIDVALIDITY, UIDNEXT, EXISTS, FLAGS);
 * - UID SEARCH (incl. `searchNew(lastUid)`), UID FETCH of UID/FLAGS/
 *   INTERNALDATE/RFC822.SIZE/BODY.PEEK[] (single or batch, full body or
 *   headers-only), UID STORE +FLAGS/-FLAGS (mark seen), LOGOUT;
 * - literal-aware response parser (FETCH bodies are IMAP literals);
 * - per-read timeout, AbortSignal cancellation, structured errors with the
 *   server's status text, credential redaction at the public boundary.
 *
 * Not implemented on purpose: APPEND, IDLE, MOVE, SORT/THREAD, UTF8=ACCEPT,
 * COMPRESS, SASL mechanisms other than LOGIN. Attachments are never downloaded
 * separately: BODY.PEEK[] is fetched whole or not at all.
 *
 * @module dsh-mailbox/lib/mail/imap
 */

import net from 'node:net';
import tls from 'node:tls';
import { redactSecrets, redactError } from './redact.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LITERAL_BYTES = 10 * 1024 * 1024;
const MAX_UID_SET_ITEMS = 1000;

/** IMAP protocol / transport error with the server's status attached. */
export class ImapError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {'config'|'connection'|'tls'|'timeout'|'aborted'|'auth'|'no'|'bad'|'protocol'} [details.kind]
   * @param {string} [details.status] - `OK` / `NO` / `BAD` when it is a tagged response.
   * @param {string} [details.command] - masked command that failed.
   * @param {string|null} [details.response] - server response text.
   * @param {Error} [details.cause]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ImapError';
    this.kind = details.kind ?? 'protocol';
    this.status = details.status ?? null;
    this.command = details.command ?? null;
    this.response = details.response ?? null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(host) {
  const value = String(host ?? '').toLowerCase();
  return LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost');
}

function abortedError() {
  return new ImapError('IMAP operation aborted', { kind: 'aborted' });
}

function tlsOptionsFor(host, tlsOptions = {}) {
  const options = { ...tlsOptions };
  if (options.rejectUnauthorized === undefined) options.rejectUnauthorized = true;
  if (options.servername === undefined && !net.isIP(host)) options.servername = host;
  return options;
}

/* ------------------------------------------------------------------------- *
 * Byte queue + buffered socket reader (literal aware)
 * ------------------------------------------------------------------------- */

/** FIFO byte queue with cheap prefix extraction (no O(n²) concatenation). */
class ByteQueue {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  indexOfByte(byte) {
    let offset = 0;
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(byte);
      if (index !== -1) return offset + index;
      offset += chunk.length;
    }
    return -1;
  }

  take(count) {
    const parts = [];
    let need = count;
    while (need > 0) {
      const head = this.chunks[0];
      if (head.length <= need) {
        parts.push(head);
        this.chunks.shift();
        need -= head.length;
        this.length -= head.length;
      } else {
        parts.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        this.length -= need;
        need = 0;
      }
    }
    if (parts.length === 0) return Buffer.alloc(0);
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  discard(count) {
    let need = count;
    while (need > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.length <= need) {
        this.chunks.shift();
        need -= head.length;
        this.length -= head.length;
      } else {
        this.chunks[0] = head.subarray(need);
        this.length -= need;
        need = 0;
      }
    }
  }
}

/**
 * Buffered reader over a socket: reads CRLF lines and raw byte literals with a
 * per-read timeout and abort support. Rejects all pending reads on connection
 * error, timeout or abort.
 */
class SocketReader {
  constructor(socket, { timeoutMs, signal, onFatal }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.onFatal = onFatal;
    this.queue = new ByteQueue();
    this.pending = null; // {minBytes, needLine, resolve, reject, timer}
    this.failure = null;
    this.closed = false;

    this.onData = (chunk) => {
      this.queue.push(chunk);
      this._pump();
    };
    this.onError = (error) => {
      this._fail(new ImapError(`IMAP socket error: ${error.message}`, { kind: 'connection', cause: error }));
    };
    this.onClose = () => {
      this.closed = true;
      this._fail(new ImapError('IMAP connection closed unexpectedly', { kind: 'connection' }));
    };
    this.onAbort = () => this._fail(abortedError());
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  _fail(error) {
    if (this.failure !== null) return;
    this.failure = error;
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.onFatal?.(error);
  }

  _pump() {
    const pending = this.pending;
    if (pending === null) return;
    if (pending.needLine) {
      const index = this.queue.indexOfByte(0x0a);
      if (index === -1) return;
      this.pending = null;
      clearTimeout(pending.timer);
      let line = this.queue.take(index + 1).toString('latin1');
      if (line.endsWith('\r\n')) line = line.slice(0, -2);
      else if (line.endsWith('\n')) line = line.slice(0, -1);
      pending.resolve(line);
      return;
    }
    if (this.queue.length < pending.minBytes) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(this.queue.take(pending.minBytes));
  }

  _wait({ minBytes = 0, needLine = false, step = 'read' }) {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === null) return;
        this.pending = null;
        reject(new ImapError(`IMAP ${step} timed out after ${this.timeoutMs}ms`, { kind: 'timeout' }));
        this.socket.destroy();
      }, this.timeoutMs);
      this.pending = { minBytes, needLine, resolve, reject, timer };
      this._pump();
    });
  }

  /** Read one CRLF-terminated line as a latin1 string (without terminator). */
  readLine(step = 'read') {
    return this._wait({ needLine: true, step });
  }

  /**
   * Read exactly `count` raw bytes.
   * Literals larger than `maxKeep` are consumed but discarded (protocol stays in
   * sync, memory stays bounded); `null` is returned in that case.
   */
  async readBytes(count, { maxKeep = DEFAULT_MAX_LITERAL_BYTES, step = 'literal' } = {}) {
    if (count <= maxKeep) return this._wait({ minBytes: count, step });
    // Discard in chunks to avoid allocating the whole literal.
    let remaining = count;
    while (remaining > 0) {
      const chunk = await this._wait({ minBytes: Math.min(remaining, 256 * 1024), step });
      remaining -= chunk.length;
    }
    return null;
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.signal?.removeEventListener('abort', this.onAbort);
    this._fail(new ImapError('IMAP reader detached for STARTTLS', { kind: 'protocol' }));
  }

  destroy() {
    this._fail(new ImapError('IMAP connection closed', { kind: 'connection' }));
    this.socket.destroy();
  }
}

/* ------------------------------------------------------------------------- *
 * Low-level connection helpers
 * ------------------------------------------------------------------------- */

function connectTcp({ host, port, timeoutMs, signal }) {
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
      reject(new ImapError(`TCP connection to ${host}:${port} timed out`, { kind: 'timeout' }));
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
      socket.off('connect', onConnect);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ImapError(`TCP connection to ${host}:${port} failed: ${error.message}`, { kind: 'connection', cause: error }));
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

function connectTls({ host, port, timeoutMs, signal, tlsOptions }) {
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
      reject(new ImapError(`TLS connection to ${host}:${port} timed out`, { kind: 'timeout' }));
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
      socket.off('secureConnect', onSecure);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ImapError(`TLS connection to ${host}:${port} failed: ${error.message}`, { kind: 'tls', cause: error }));
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
      reject(new ImapError('IMAP STARTTLS negotiation timed out', { kind: 'timeout' }));
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
      secureSocket.off('secureConnect', onSecure);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ImapError(`IMAP STARTTLS failed: ${error.message}`, { kind: 'tls', cause: error }));
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

/* ------------------------------------------------------------------------- *
 * IMAP syntax helpers
 * ------------------------------------------------------------------------- */

/** Quote a string for IMAP; throws on CR/LF (command-injection guard). */
function quoteString(value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) {
    throw new ImapError('IMAP string contains CR/LF (command injection blocked)', { kind: 'config' });
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Count parentheses in a line, ignoring quoted strings and literals. */
function parenBalance(line) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return depth;
}

const TAGGED_RE = /^(\S+) (OK|NO|BAD)(?:\s|$)/;

function classifyResponseStart(line) {
  if (line.startsWith('* ')) return { kind: 'untagged' };
  if (line.startsWith('+')) return { kind: 'continuation' };
  const tagged = TAGGED_RE.exec(line);
  if (tagged !== null) return { kind: 'tagged', tag: tagged[1], status: tagged[2] };
  return null;
}

/** Compress a UID list into an IMAP set (`1,2,3,5` -> `1:3,5`). */
export function formatUidSet(uids) {
  const numbers = [...new Set(uids.map(Number))].filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b);
  if (numbers.length === 0) return '';
  if (numbers.length > MAX_UID_SET_ITEMS) {
    throw new ImapError(`too many UIDs in one FETCH/STORE (${numbers.length})`, { kind: 'config' });
  }
  const ranges = [];
  let start = numbers[0];
  let previous = numbers[0];
  for (let index = 1; index < numbers.length; index += 1) {
    const current = numbers[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}:${previous}`);
    start = current;
    previous = current;
  }
  ranges.push(start === previous ? `${start}` : `${start}:${previous}`);
  return ranges.join(',');
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse an IMAP INTERNALDATE (`12-Nov-2026 10:00:00 +0800`). */
export function parseInternalDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const month = MONTHS[match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase()];
  if (month === undefined) return null;
  const offsetMinutes = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === '-' ? -1 : 1);
  const utcMs = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  return new Date(utcMs - offsetMinutes * 60 * 1000);
}

/** Parse FLAGS payload `(\Seen \Answered)` into `['\\Seen','\\Answered']`. */
function parseFlags(payload) {
  const trimmed = String(payload ?? '').trim();
  if (trimmed === '') return [];
  return trimmed.split(/\s+/).filter((flag) => flag !== '');
}

/* ------------------------------------------------------------------------- *
 * ImapClient
 * ------------------------------------------------------------------------- */

/**
 * Minimal IMAP client. Construct with connection options, then `await client.open()`
 * (connect + STARTTLS + LOGIN + optional ID). All network methods time out and
 * honour `options.signal`.
 */
export class ImapClient {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port] - default 993 for tls, 143 for starttls/none.
   * @param {'tls'|'starttls'|'none'} [options.security='tls'] - `none` loopback only.
   * @param {string} [options.user]
   * @param {string} [options.pass] - authorization code / password.
   * @param {number} [options.timeoutMs=30000] - per-read timeout.
   * @param {AbortSignal} [options.signal]
   * @param {object} [options.tlsOptions] - `rejectUnauthorized` defaults true.
   * @param {number} [options.maxLiteralBytes=10MB] - larger BODY[] literals are
   *   drained and discarded (raw body comes back as null + `truncated:true`).
   * @param {boolean|'auto'} [options.sendId='auto'] - IMAP ID command after login
   *   (auto = when the server advertises ID or is 163/126/yeah.net).
   * @param {string} [options.mailbox='INBOX'] - default mailbox for select.
   */
  constructor(options = {}) {
    const security = String(options.security ?? 'tls').toLowerCase();
    if (!['tls', 'starttls', 'none'].includes(security)) {
      throw new ImapError(`unsupported security mode: ${security} (expected tls|starttls|none)`, { kind: 'config' });
    }
    if (options.host === undefined || String(options.host).trim() === '') {
      throw new ImapError('IMAP host is required', { kind: 'config' });
    }
    const host = String(options.host).trim();
    if (security === 'none' && !isLoopbackHost(host)) {
      throw new ImapError('security "none" is only allowed for localhost test servers', { kind: 'config' });
    }
    const port = Number(options.port ?? (security === 'tls' ? 993 : 143));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ImapError(`invalid IMAP port: ${options.port}`, { kind: 'config' });
    }
    this.options = {
      host,
      port,
      security,
      user: options.user === undefined ? '' : String(options.user),
      pass: options.pass === undefined ? '' : String(options.pass),
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      tlsOptions: options.tlsOptions ?? {},
      maxLiteralBytes: Number.isFinite(options.maxLiteralBytes)
        ? options.maxLiteralBytes
        : DEFAULT_MAX_LITERAL_BYTES,
      sendId: options.sendId ?? 'auto',
      mailbox: options.mailbox ?? 'INBOX',
      clientName: options.clientName ?? 'dsh-mailbox',
      clientVersion: options.clientVersion ?? '0.1',
    };
    this.secrets = [this.options.pass, this.options.user];
    this.socket = null;
    this.reader = null;
    this.tagCounter = 0;
    this.capabilities = [];
    this.greeting = '';
    this.authenticated = false;
    this.currentMailbox = null;
    this.uidValidity = null;
    this.uidNext = null;
    this.closed = false;
  }

  /**
   * Connect, STARTTLS if requested, LOGIN and send ID.
   * @returns {Promise<ImapClient>}
   */
  static async open(options = {}) {
    const client = new ImapClient(options);
    await client.open();
    return client;
  }

  /**
   * Full connect + auth sequence.
   * @returns {Promise<ImapClient>}
   */
  async open() {
    try {
      await this._openSocket();
      await this._readGreeting();
      if (this.options.security === 'starttls') {
        // The greeting may not advertise capabilities; ask before deciding
        // whether STARTTLS is available.
        if (this.capabilities.length === 0) await this._refreshCapabilities();
        await this._startTls();
      }
      await this._refreshCapabilities();
      if (!this.authenticated) await this._login();
      await this._maybeSendId();
      return this;
    } catch (error) {
      this._destroySocket();
      throw this._decorate(error);
    }
  }

  /* --------------------------- connection --------------------------- */

  async _openSocket() {
    if (this.options.signal?.aborted) throw abortedError();
    const { host, port, security, timeoutMs, signal, tlsOptions } = this.options;
    this.socket = security === 'tls'
      ? await connectTls({ host, port, timeoutMs, signal, tlsOptions })
      : await connectTcp({ host, port, timeoutMs, signal });
    this._attachReader();
  }

  _attachReader() {
    this.closed = false;
    this.reader = new SocketReader(this.socket, {
      timeoutMs: this.options.timeoutMs,
      signal: this.options.signal,
      onFatal: () => {
        this.closed = true;
      },
    });
  }

  _destroySocket() {
    try {
      this.reader?.destroy();
    } catch {
      // ignore
    }
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
    this.reader = null;
    this.closed = true;
  }

  _writeLine(line) {
    if (this.socket === null || this.closed) {
      throw new ImapError('IMAP client is not connected', { kind: 'connection' });
    }
    if (/[\r\n]/.test(line)) {
      throw new ImapError('IMAP command contains CR/LF (injection blocked)', { kind: 'config' });
    }
    this.socket.write(`${line}\r\n`);
  }

  _nextTag() {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  /* --------------------------- response parsing --------------------------- */

  /**
   * Read one complete IMAP response, consuming literals.
   * @returns {Promise<{tag: string, status: string|null, text: string, lines: string[], literals: Buffer[]}>}
   */
  async _readResponse() {
    if (this.reader === null) throw new ImapError('IMAP client is not connected', { kind: 'connection' });
    const lines = [];
    const literals = [];
    let depth = 0;
    let first = true;
    for (;;) {
      const line = await this.reader.readLine();
      lines.push(line);
      const literalMatch = /\{(\d+)\+?\}$/.exec(line);
      let literal = null;
      if (literalMatch !== null) {
        const size = Number(literalMatch[1]);
        literal = await this.reader.readBytes(size, { maxKeep: this.options.maxLiteralBytes });
        literals.push(literal);
      }
      if (first) {
        if (classifyResponseStart(line) === null) {
          throw new ImapError(`malformed IMAP response: ${line.slice(0, 200)}`, { kind: 'protocol' });
        }
        first = false;
      }
      depth += parenBalance(line);
      if (literal === null && depth <= 0) break;
    }
    const firstLine = lines[0] ?? '';
    const classified = classifyResponseStart(firstLine);
    const tag = classified?.kind === 'tagged' ? classified.tag : (firstLine.startsWith('+') ? '+' : '*');
    const status = classified?.kind === 'tagged' ? classified.status : null;
    const text = lines
      .map((line, index) => {
        if (index === 0) return line;
        return line;
      })
      .join('\n');
    return { tag, status, text, lines, literals };
  }

  async _collectUntilTag(tag) {
    const untagged = [];
    for (;;) {
      const response = await this._readResponse();
      if (response.tag === '+') {
        throw new ImapError(`unexpected IMAP continuation while waiting for ${tag}`, { kind: 'protocol' });
      }
      if (response.tag === tag) {
        return { response, untagged };
      }
      untagged.push(response);
    }
  }

  /**
   * Send one tagged command and collect its responses.
   * @param {string} command - command text after the tag.
   * @returns {Promise<{status: string, text: string, lines: string[], literals: Buffer[], untagged: object[]}>}
   */
  async _execute(command) {
    if (this.reader === null || this.closed) {
      throw new ImapError('IMAP client is not connected', { kind: 'connection' });
    }
    const tag = this._nextTag();
    this._writeLine(`${tag} ${command}`);
    const { response, untagged } = await this._collectUntilTag(tag);
    const statusLine = response.lines[response.lines.length - 1] ?? '';
    const statusText = statusLine.replace(TAGGED_RE, '').trim();
    const result = {
      tag,
      status: response.status ?? 'UNKNOWN',
      text: response.text,
      statusText,
      lines: response.lines,
      literals: response.literals,
      untagged,
      command,
    };
    if (result.status !== 'OK') {
      throw this._statusError(result);
    }
    return result;
  }

  _statusError(result) {
    const kind = result.status === 'NO' ? 'no' : result.status === 'BAD' ? 'bad' : 'protocol';
    const isAuth = this.authenticated === false && /LOGIN/i.test(result.command);
    return new ImapError(
      `${isAuth ? 'IMAP authentication failed' : `IMAP command failed (${result.status})`}: ${result.statusText || result.text}`,
      {
        kind: isAuth ? 'auth' : kind,
        status: result.status,
        command: /LOGIN/i.test(result.command) ? 'LOGIN "***" "***"' : result.command,
        response: result.statusText || result.text,
      },
    );
  }

  /* --------------------------- auth / capabilities --------------------------- */

  async _readGreeting() {
    const response = await this._readResponse();
    if (!response.text.startsWith('* ')) {
      throw new ImapError(`unexpected IMAP greeting: ${response.text.slice(0, 200)}`, { kind: 'protocol' });
    }
    if (/^\* (OK|PREAUTH)/i.test(response.text)) {
      this.greeting = response.text;
      if (/^\* PREAUTH/i.test(response.text)) this.authenticated = true;
      // Servers may advertise CAPABILITY in the greeting: needed to know whether
      // STARTTLS is available before the first CAPABILITY command.
      const capability = /\[CAPABILITY ([^\]]+)\]/i.exec(response.text);
      if (capability !== null) {
        this.capabilities = capability[1].trim().split(/\s+/).filter((item) => item !== '');
      }
      return;
    }
    if (/^\* BYE/i.test(response.text)) {
      throw new ImapError(`IMAP server rejected the connection: ${response.text.slice(0, 200)}`, { kind: 'connection' });
    }
    throw new ImapError(`unexpected IMAP greeting: ${response.text.slice(0, 200)}`, { kind: 'protocol' });
  }

  async _refreshCapabilities() {
    const result = await this._execute('CAPABILITY');
    const capabilities = [];
    for (const response of result.untagged) {
      const match = /^\* CAPABILITY (.*)$/i.exec(response.text);
      if (match !== null) capabilities.push(...match[1].trim().split(/\s+/).filter((item) => item !== ''));
    }
    this.capabilities = capabilities;
    return capabilities;
  }

  getCapability(name) {
    const upper = String(name).toUpperCase();
    return this.capabilities.find((capability) => capability.toUpperCase() === upper) ?? null;
  }

  async _startTls() {
    if (this.getCapability('STARTTLS') === null) {
      throw new ImapError('server does not advertise STARTTLS', { kind: 'tls' });
    }
    await this._execute('STARTTLS');
    const socket = this.socket;
    this.reader.detach();
    this.socket = await upgradeTls({
      socket,
      host: this.options.host,
      timeoutMs: this.options.timeoutMs,
      signal: this.options.signal,
      tlsOptions: this.options.tlsOptions,
    });
    this._attachReader();
    this.capabilities = [];
    this.authenticated = false;
  }

  async _sendLiteralCommand(commandPrefix, literals) {
    // Used only for non-ASCII LOGIN credentials. IMAP literal syntax:
    //   TAG LOGIN {n}\r\n<user bytes> {m}\r\n<pass bytes>\r\n
    const tag = this._nextTag();
    let prefix = `${tag} ${commandPrefix}`;
    for (let index = 0; index < literals.length; index += 1) {
      const bytes = literals[index];
      this._writeLine(`${prefix} {${bytes.length}}`);
      const continuation = await this._readResponse();
      if (continuation.tag !== '+') {
        throw new ImapError(`expected IMAP continuation, got: ${continuation.text.slice(0, 200)}`, {
          kind: 'protocol',
          command: 'LOGIN "***" "***"',
        });
      }
      this.socket.write(bytes);
      // The next argument starts with a single space; after the final literal a
      // CRLF terminates the command.
      prefix = '';
    }
    this._writeLine('');
    const { response, untagged } = await this._collectUntilTag(tag);
    const result = {
      tag,
      status: response.status ?? 'UNKNOWN',
      text: response.text,
      statusText: response.lines[response.lines.length - 1].replace(TAGGED_RE, '').trim(),
      lines: response.lines,
      literals: response.literals,
      untagged,
      command: 'LOGIN "***" "***"',
    };
    if (result.status !== 'OK') throw this._statusError(result);
    this.authenticated = true;
    return result;
  }

  async _login() {
    const { user, pass } = this.options;
    if (user === '' || pass === '') {
      throw new ImapError('IMAP user and pass (authorization code) are required', { kind: 'config' });
    }
    const needsLiteral = /[^\x20-\x7e]/.test(user) || /[^\x20-\x7e]/.test(pass);
    if (needsLiteral) {
      await this._sendLiteralCommand('LOGIN', [
        Buffer.from(user, 'utf8'),
        Buffer.from(pass, 'utf8'),
      ]);
      return;
    }
    const result = await this._execute(`LOGIN ${quoteString(user)} ${quoteString(pass)}`);
    this.authenticated = true;
    return result;
  }

  _shouldSendId() {
    if (this.options.sendId === false) return false;
    const advertised = this.capabilities.some((capability) => capability.toUpperCase() === 'ID');
    if (this.options.sendId === true) return true;
    if (advertised) return true;
    return /(^|\.)(163|126)\.com$|(^|\.)yeah\.net$/i.test(this.options.host);
  }

  async _maybeSendId() {
    if (!this._shouldSendId()) return;
    const params = [
      '"name"', quoteString(this.options.clientName),
      '"version"', quoteString(this.options.clientVersion),
      '"vendor"', quoteString('dsh-mailbox'),
    ].join(' ');
    try {
      await this._execute(`ID (${params})`);
    } catch (error) {
      // 163 requires ID; other servers may answer BAD/NO. Never fatal: select
      // will surface the real failure if ID was mandatory.
      if (error instanceof ImapError && (error.kind === 'bad' || error.kind === 'no')) return;
      throw error;
    }
  }

  /* --------------------------- public commands --------------------------- */

  /**
   * SELECT or EXAMINE a mailbox and expose UIDVALIDITY / UIDNEXT.
   * @param {string} [mailbox=this.options.mailbox]
   * @param {{readOnly?: boolean}} [options]
   * @returns {Promise<{mailbox: string, exists: number, recent: number, uidValidity: number|null, uidNext: number|null, flags: string[], permanentFlags: string[], readOnly: boolean}>}
   */
  async select(mailbox = this.options.mailbox, options = {}) {
    return this._guard(async () => {
      const readOnly = options.readOnly === true;
      const result = await this._execute(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quoteString(mailbox)}`);
      const state = {
        mailbox,
        exists: 0,
        recent: 0,
        uidValidity: null,
        uidNext: null,
        unseen: null,
        flags: [],
        permanentFlags: [],
        readOnly,
      };
      const lastLine = result.lines[result.lines.length - 1] ?? '';
      if (/\[READ-ONLY\]/i.test(lastLine)) state.readOnly = true;
      if (/\[READ-WRITE\]/i.test(lastLine)) state.readOnly = false;
      for (const response of result.untagged) {
        for (const line of response.lines) {
          let match = /^\* (\d+) EXISTS$/i.exec(line);
          if (match !== null) state.exists = Number(match[1]);
          else if ((match = /^\* (\d+) RECENT$/i.exec(line)) !== null) state.recent = Number(match[1]);
          else if ((match = /^\* FLAGS \(([^)]*)\)/i.exec(line)) !== null) state.flags = parseFlags(match[1]);
          else if ((match = /^\* OK \[UIDVALIDITY (\d+)\]/i.exec(line)) !== null) state.uidValidity = Number(match[1]);
          else if ((match = /^\* OK \[UIDNEXT (\d+)\]/i.exec(line)) !== null) state.uidNext = Number(match[1]);
          else if ((match = /^\* OK \[UNSEEN (\d+)\]/i.exec(line)) !== null) state.unseen = Number(match[1]);
          else if ((match = /^\* OK \[PERMANENTFLAGS \(([^)]*)\)\]/i.exec(line)) !== null) state.permanentFlags = parseFlags(match[1]);
        }
      }
      this.currentMailbox = mailbox;
      this.uidValidity = state.uidValidity;
      this.uidNext = state.uidNext;
      return state;
    });
  }

  /** SELECT a mailbox read-only (EXAMINE). */
  async examine(mailbox = this.options.mailbox) {
    return this.select(mailbox, { readOnly: true });
  }

  /**
   * `UID SEARCH <criteria>`.
   * @param {string} [criteria='ALL']
   * @returns {Promise<number[]>}
   */
  async uidSearch(criteria = 'ALL') {
    return this._guard(() => this._uidSearch(criteria));
  }

  async _uidSearch(criteria) {
    const safeCriteria = String(criteria ?? 'ALL');
    if (/[\r\n]/.test(safeCriteria) || safeCriteria === '') {
      throw new ImapError('invalid IMAP search criteria', { kind: 'config' });
    }
    const result = await this._execute(`UID SEARCH ${safeCriteria}`);
    const uids = [];
    for (const response of result.untagged) {
      const match = /^\* SEARCH(?: (.*))?$/i.exec(response.text);
      if (match === null) continue;
      for (const piece of (match[1] ?? '').trim().split(/\s+/)) {
        if (piece === '') continue;
        const uid = Number(piece);
        if (Number.isInteger(uid)) uids.push(uid);
      }
    }
    return uids;
  }

  /**
   * Find mailboxes with UID greater than `lastUid` (for polling).
   * Call `select()` first; callers should verify UIDVALIDITY before trusting it.
   * @param {number} lastUid - highest UID already processed (0 for first sync).
   * @returns {Promise<number[]>} new UIDs, ascending.
   */
  async searchNew(lastUid) {
    const start = Math.max(1, Math.floor(Number(lastUid) || 0) + 1);
    const uids = await this.uidSearch(`UID ${start}:*`);
    return uids.filter((uid) => uid >= start).sort((a, b) => a - b);
  }

  /** Find unseen UIDs. */
  async searchUnseen() {
    return this.uidSearch('UNSEEN');
  }

  /**
   * Fetch messages by UID.
   * @param {number[]|number} uids
   * @param {object} [options]
   * @param {boolean} [options.body=true] - fetch BODY.PEEK[] (full raw message).
   * @param {boolean} [options.headersOnly=false] - fetch BODY.PEEK[HEADER] instead.
   * @returns {Promise<Array<{uid: number, seq: number|null, flags: string[], internalDate: Date|null, size: number|null, raw: Buffer|null, headersRaw: Buffer|null, truncated: boolean}>>}
   */
  async fetchByUid(uids, options = {}) {
    const list = Array.isArray(uids) ? uids : [uids];
    return this._guard(() => this._fetchByUid(list, options));
  }

  async _fetchByUid(uids, options) {
    const list = [...new Set((Array.isArray(uids) ? uids : [uids]).map(Number))]
      .filter((uid) => Number.isInteger(uid) && uid > 0);
    if (list.length === 0) return [];
    const set = formatUidSet(list);
    const body = options.body !== false;
    const headersOnly = options.headersOnly === true;
    const items = ['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
    if (body) items.push(headersOnly ? 'BODY.PEEK[HEADER]' : 'BODY.PEEK[]');
    const result = await this._execute(`UID FETCH ${set} (${items.join(' ')})`);
    const messages = [];
    for (const response of result.untagged) {
      const firstLine = response.lines[0] ?? '';
      const seqMatch = /^\* (\d+) FETCH \(/.exec(firstLine);
      if (seqMatch === null) continue;
      const seq = Number(seqMatch[1]);
      let literalIndex = 0;
      const text = response.lines
        .map((line) => {
          if (/\{\d+\+?\}$/.test(line)) {
            const placeholder = `\u0000LIT${literalIndex}\u0000`;
            literalIndex += 1;
            return line.replace(/\{\d+\+?\}$/, '');
          }
          return line;
        })
        .join('\n');
      const uidMatch = /\bUID (\d+)/.exec(text);
      const uid = uidMatch === null ? null : Number(uidMatch[1]);
      if (uid === null) continue;
      const flagsMatch = /\bFLAGS \(([^)]*)\)/.exec(text);
      const dateMatch = /\bINTERNALDATE "([^"]*)"/.exec(text);
      const sizeMatch = /\bRFC822\.SIZE (\d+)/.exec(text);
      const literal = response.literals[0] ?? null;
      const truncated = body && literal === null;
      messages.push({
        uid,
        seq,
        flags: flagsMatch === null ? [] : parseFlags(flagsMatch[1]),
        internalDate: dateMatch === null ? null : parseInternalDate(dateMatch[1]),
        size: sizeMatch === null ? null : Number(sizeMatch[1]),
        raw: body && !headersOnly ? literal : null,
        headersRaw: body && headersOnly ? literal : null,
        truncated,
      });
    }
    messages.sort((a, b) => a.uid - b.uid);
    return messages;
  }

  /**
   * Fetch up to `limit` most recent messages in the selected mailbox.
   * @param {number} [limit=20]
   * @param {object} [options] - same as fetchByUid (`body`, `headersOnly`).
   * @returns {Promise<Array<object>>} messages ascending by UID.
   */
  async fetchRecent(limit = 20, options = {}) {
    return this._guard(async () => {
      const uids = await this._uidSearch('ALL');
      if (uids.length === 0) return [];
      const sorted = [...new Set(uids)].sort((a, b) => a - b);
      const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
      const selected = safeLimit === 0 ? [] : sorted.slice(-safeLimit);
      return this._fetchByUid(selected, options);
    });
  }

  /**
   * STORE flags on UIDs.
   * @param {number[]|number} uids
   * @param {string[]} flags - `['\\Seen']` or `['Seen']`.
   * @param {'+FLAGS'|'-FLAGS'|'FLAGS'} [mode='+FLAGS']
   * @returns {Promise<{updated: number}>}
   */
  async storeFlags(uids, flags, mode = '+FLAGS') {
    return this._guard(async () => {
      const list = (Array.isArray(uids) ? uids : [uids]).map(Number).filter((uid) => Number.isInteger(uid) && uid > 0);
      if (list.length === 0) return { updated: 0 };
      const upperMode = String(mode).toUpperCase();
      if (!['+FLAGS', '-FLAGS', 'FLAGS'].includes(upperMode)) {
        throw new ImapError(`invalid STORE mode: ${mode}`, { kind: 'config' });
      }
      const normalizedFlags = (Array.isArray(flags) ? flags : [flags]).map((flag) => {
        const text = String(flag ?? '').trim();
        if (text === '' || /[\r\n()]/.test(text)) {
          throw new ImapError('invalid IMAP flag', { kind: 'config' });
        }
        return text.startsWith('\\') ? text : `\\${text}`;
      });
      if (normalizedFlags.length === 0) return { updated: 0 };
      const result = await this._execute(`UID STORE ${formatUidSet(list)} ${upperMode} (${normalizedFlags.join(' ')})`);
      let updated = 0;
      for (const response of result.untagged) {
        if (/^\* \d+ FETCH \(/i.test(response.lines[0] ?? '')) updated += 1;
      }
      return { updated };
    });
  }

  /** Mark UIDs as seen (`UID STORE +FLAGS (\Seen)`). */
  async markSeen(uids) {
    return this.storeFlags(uids, ['\\Seen'], '+FLAGS');
  }

  /** Mark UIDs as unseen. */
  async markUnseen(uids) {
    return this.storeFlags(uids, ['\\Seen'], '-FLAGS');
  }

  /** Send LOGOUT and tear the connection down. Never throws. */
  async logout() {
    try {
      if (this.socket !== null && !this.closed) {
        const tag = this._nextTag();
        try {
          this._writeLine(`${tag} LOGOUT`);
          for (;;) {
            const response = await this._readResponse();
            if (response.tag === tag || /^\* BYE/i.test(response.text)) break;
          }
        } catch {
          // best effort
        }
      }
    } finally {
      this._destroySocket();
    }
  }

  /** Immediately destroy the connection (no LOGOUT). */
  close() {
    this._destroySocket();
  }

  /* --------------------------- error decoration --------------------------- */

  _decorate(error) {
    if (error instanceof ImapError) return redactError(error, this.secrets);
    const wrapped = new ImapError(`IMAP operation failed: ${error.message}`, { kind: 'connection', cause: error });
    return redactError(wrapped, this.secrets);
  }

  async _guard(fn) {
    try {
      return await fn();
    } catch (error) {
      throw this._decorate(error);
    }
  }
}

/**
 * Convenience: construct, connect and authenticate in one call.
 * @param {object} options - see ImapClient.
 * @returns {Promise<ImapClient>}
 */
export async function openImap(options = {}) {
  return ImapClient.open(options);
}

export default { ImapClient, openImap, ImapError, formatUidSet, parseInternalDate };
