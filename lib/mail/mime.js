/**
 * Zero-dependency MIME / RFC 5322 / RFC 2047 parser for dsh-mailbox.
 *
 * Design goals:
 * - Never throw on malformed mail: real-world messages are messy, the parser
 *   degrades instead of failing (only a non-string/non-Buffer input throws).
 * - Lossless enough for storage: keeps all unfolded raw headers, decoded
 *   subject/addresses, plain-text AND HTML bodies, attachment metadata,
 *   threading headers and auto-reply detection fields.
 * - Pure functions, no I/O. Byte input is a Buffer (IMAP `BODY[]` literal);
 *   string input is treated as UTF-8 text.
 *
 * @module dsh-mailbox/lib/mail/mime
 */

const MAX_HEADER_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_PARTS = 500;
const DEFAULT_MAX_TEXT_CHARS = 1024 * 1024;
const DEFAULT_MAX_HEADER_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_HEADERS = 2000;
const DEFAULT_PARSE_BUDGET_MS = 5000;
const DEFAULT_SNIPPET_CHARS = 160;

/**
 * Structured MIME error. `code` is stable for programmatic handling:
 * `invalid-input` | `too-large` | `parse-budget`.
 */
export class MimeError extends Error {
  constructor(message, code = 'invalid-input', options) {
    super(message, options);
    this.name = 'MimeError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- *
 * Charset decoding
 * ------------------------------------------------------------------------- */

/** Map legacy/alias charset labels onto labels TextDecoder understands. */
function normalizeCharset(charset) {
  if (charset === undefined || charset === null) return 'utf-8';
  const label = String(charset).trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (label === '') return 'utf-8';
  switch (label) {
    case 'utf8':
    case 'utf-8':
    case 'us-ascii':
    case 'ascii':
    case 'unicode-1-1-utf-8':
      return 'utf-8';
    case 'gb2312':
    case 'gbk':
    case 'x-gbk':
    case 'cp936':
    case 'windows-936':
    case 'gb18030':
      return 'gb18030';
    case 'big5':
    case 'big-5':
    case 'x-x-big5':
      return 'big5';
    case 'latin1':
    case 'latin-1':
    case 'iso8859-1':
    case 'iso-8859-1':
    case 'iso_8859-1':
      return 'iso-8859-1';
    case 'shift-jis':
    case 'shift_jis':
    case 'sjis':
    case 'x-sjis':
      return 'shift_jis';
    case 'euc-jp':
    case 'eucjp':
      return 'euc-jp';
    case 'iso-2022-jp':
    case 'csiso2022jp':
      return 'iso-2022-jp';
    case 'euc-kr':
    case 'ks_c_5601-1987':
    case 'ksc5601':
    case 'cp949':
      return 'euc-kr';
    default:
      return label;
  }
}

/**
 * Decode bytes with the declared charset, falling back to UTF-8 for unknown
 * or broken labels (TextDecoder replaces invalid sequences, it never throws).
 *
 * @param {Buffer|Uint8Array|string} bytes - raw bytes.
 * @param {string} [charset] - MIME charset label.
 * @returns {string}
 */
export function decodeCharset(bytes, charset) {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
  let decoder;
  try {
    decoder = new TextDecoder(normalizeCharset(charset));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(buffer);
}

/* ------------------------------------------------------------------------- *
 * Transfer encodings, RFC 2047 encoded words
 * ------------------------------------------------------------------------- */

/**
 * Decode a quoted-printable body into raw bytes.
 * Handles `=HH`, soft line breaks (`=\r\n` / `=\n`) and stray `=`.
 *
 * @param {string|Buffer} input
 * @returns {Buffer}
 */
export function decodeQuotedPrintable(input) {
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('latin1');
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '=') {
      out.push(text.charCodeAt(i) & 0xff);
      continue;
    }
    const next = text[i + 1];
    if (next === '\r' && text[i + 2] === '\n') {
      i += 2;
      continue;
    }
    if (next === '\n') {
      i += 1;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(0x3d);
  }
  return Buffer.from(out);
}

/** Decode one RFC 2047 `Q` encoded word payload into bytes. */
function decodeQWord(payload) {
  const bytes = [];
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch === '_') {
      bytes.push(0x20);
      continue;
    }
    if (ch === '=') {
      const hex = payload.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      bytes.push(0x3d);
      continue;
    }
    bytes.push(payload.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD_RE = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

function decodeWord(charset, encoding, payload) {
  try {
    const bytes = encoding === 'B' || encoding === 'b'
      ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
      : decodeQWord(payload);
    return decodeCharset(bytes, charset);
  } catch {
    return '';
  }
}

/**
 * Decode all RFC 2047 encoded words in a header value. Whitespace between two
 * adjacent encoded words is dropped, as the RFC requires for long values that
 * were split across words.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeWords(value) {
  const text = String(value ?? '');
  if (!text.includes('=?')) return text;
  const matches = [...text.matchAll(ENCODED_WORD_RE)];
  if (matches.length === 0) return text;
  let out = '';
  let pos = 0;
  let previousWasWord = false;
  for (const match of matches) {
    const between = text.slice(pos, match.index);
    if (between !== '') {
      if (!(previousWasWord && /^[ \t\r\n]+$/.test(between))) out += between;
    }
    out += decodeWord(match[1], match[2], match[3]);
    pos = match.index + match[0].length;
    previousWasWord = true;
  }
  out += text.slice(pos);
  return out;
}

/**
 * Encode a header value for SMTP using RFC 2047 UTF-8 base64 words.
 * ASCII-only values are returned unchanged. Used for Subject / display names.
 *
 * @param {string} value - plain text.
 * @param {number} [maxEncodedBytes] - bytes per encoded word (default 45).
 * @returns {string}
 */
export function encodeWords(value, maxEncodedBytes = 45) {
  const text = String(value ?? '');
  if (text === '') return '';
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(text)) return text;
  const chunks = [];
  let current = '';
  for (const char of text) {
    if (current !== '' && Buffer.byteLength(current + char, 'utf8') > maxEncodedBytes) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/* ------------------------------------------------------------------------- *
 * Header block parsing
 * ------------------------------------------------------------------------- */

/**
 * Locate the header/body separator (two consecutive line breaks).
 * A CRLF is treated as one line break — naive regexes split it into `\r` + `\n`
 * across the two groups and match a single blank line, so we scan deliberately.
 *
 * @param {string} text - structural text.
 * @returns {{ start: number, end: number }|null} separator byte range.
 */
function findHeaderSeparator(text) {
  const lineBreak = /\r\n|\n|\r/g;
  let match = lineBreak.exec(text);
  while (match !== null) {
    const after = match.index + match[0].length;
    const next = /^(?:\r\n|\n|\r)/.exec(text.slice(after));
    if (next !== null) return { start: match.index, end: after + next[0].length };
    match = lineBreak.exec(text);
  }
  return null;
}

/**
 * Split a raw message into its header block and body.
 *
 * @param {string} text - structural text (latin1: 1 char === 1 byte).
 * @param {number} [maxHeaderBytes=1MB]
 * @returns {{ headerText: string, bodyText: string, headerBytes: number, truncated: boolean }}
 */
function splitHeaderBody(text, maxHeaderBytes = MAX_HEADER_BYTES) {
  const separator = findHeaderSeparator(text);
  if (separator !== null) {
    if (separator.start <= maxHeaderBytes) {
      return {
        headerText: text.slice(0, separator.start),
        bodyText: text.slice(separator.end),
        headerBytes: separator.start,
        truncated: false,
      };
    }
    // Header block is absurdly large: keep a truncated slice, mark suspicious,
    // and still recover the body which starts after the blank line.
    return {
      headerText: text.slice(0, maxHeaderBytes),
      bodyText: text.slice(separator.end),
      headerBytes: maxHeaderBytes,
      truncated: true,
    };
  }
  // No blank line at all, or a monstrous "header": treat a leading blank line
  // as empty headers, otherwise treat everything as headers with an empty body.
  if (/^(?:\r\n|\n|\r)/.test(text)) {
    return {
      headerText: '',
      bodyText: text.replace(/^(?:\r\n|\n|\r)/, ''),
      headerBytes: 0,
      truncated: false,
    };
  }
  return {
    headerText: text,
    bodyText: '',
    headerBytes: Buffer.byteLength(text, 'latin1'),
    truncated: Buffer.byteLength(text, 'latin1') > maxHeaderBytes,
  };
}

/**
 * Parse a header block into an ordered list of unfolded name/value pairs.
 * Header names are lower-cased; continuation lines are unfolded with one space.
 * Physical lines longer than `maxLineBytes` and headers beyond `maxHeaders`
 * are dropped and reported via the `truncated` flag (never throws).
 *
 * @param {string} block
 * @param {object} [options]
 * @param {number} [options.maxLineBytes=64KB] - unfolded value cap per header.
 * @param {number} [options.maxHeaders=2000] - maximum header count.
 * @returns {{ list: Array<{name: string, value: string}>, map: Map<string, string[]>, bytes: number, truncated: boolean }}
 */
export function parseHeaders(block, options = {}) {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_HEADER_LINE_BYTES;
  const maxHeaders = options.maxHeaders ?? DEFAULT_MAX_HEADERS;
  const text = String(block ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const list = [];
  let truncated = false;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line[0] === ' ' || line[0] === '\t') {
      if (list.length > 0) {
        const last = list[list.length - 1];
        if (Buffer.byteLength(last.value, 'latin1') >= maxLineBytes) {
          truncated = true;
          continue;
        }
        last.value += ` ${line.trim()}`;
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (list.length >= maxHeaders) {
      truncated = true;
      break;
    }
    let value = line.slice(colon + 1).trim();
    if (Buffer.byteLength(value, 'latin1') > maxLineBytes) {
      value = Buffer.from(value, 'latin1').subarray(0, maxLineBytes).toString('latin1');
      truncated = true;
    }
    list.push({ name: line.slice(0, colon).trim(), value });
  }
  const map = new Map();
  for (const header of list) {
    const key = header.name.toLowerCase();
    const values = map.get(key);
    if (values === undefined) map.set(key, [header.value]);
    else values.push(header.value);
  }
  return { list, map, bytes: Buffer.byteLength(text, 'latin1'), truncated };
}

/* ------------------------------------------------------------------------- *
 * Parameterized headers (Content-Type / Content-Disposition)
 * ------------------------------------------------------------------------- */

/** Strip RFC 822 comments (nesting aware, quote aware). */
function stripComments(input) {
  const text = String(input ?? '');
  let out = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\' && i + 1 < text.length) {
        if (depth === 0) out += ch + text[i + 1];
        i += 1;
        continue;
      }
      if (depth === 0) out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (depth === 0) out += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Split on semicolons that are outside quotes / comments. */
function splitSemicolons(input) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Unquote and unescape a MIME parameter value. */
function unquoteValue(raw) {
  let value = String(raw ?? '').trim();
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    value = value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/** RFC 2231 extended parameter: `charset'lang'percent-encoded`. */
function decodeRfc2231(value) {
  const match = /^([^']*)'([^']*)'(.*)$/s.exec(value);
  let charset = 'utf-8';
  let encoded = value;
  if (match !== null) {
    charset = match[1] || 'utf-8';
    encoded = match[3];
  }
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === '%' && /^[0-9a-fA-F]{2}$/.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
  }
  return decodeCharset(Buffer.from(bytes), charset);
}

/**
 * Parse `type/subtype; a=b; c="d"` style headers (Content-Type) or
 * `attachment; filename="x.zip"` (Content-Disposition) into parts + params.
 *
 * RFC 2231 extended parameters (`filename*`, `filename*0*` continuations) are
 * decoded into the plain parameter, and RFC 2047 words in parameter values are
 * decoded too (some clients put them in filenames).
 *
 * @param {string} value
 * @returns {{ value: string, params: Record<string, string> }}
 */
function parseParameterized(value) {
  const cleaned = stripComments(String(value ?? ''));
  const pieces = splitSemicolons(cleaned);
  const main = unquoteValue(pieces.shift() ?? '').toLowerCase();
  const rawParams = {};
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    if (key === '') continue;
    rawParams[key] = unquoteValue(piece.slice(eq + 1));
  }
  // Collect RFC 2231 continuations such as filename*0*=, filename*1=
  const continuations = new Map();
  for (const [key, paramValue] of Object.entries(rawParams)) {
    const match = /^([a-z0-9-]+)\*(\d+)(\*)?$/.exec(key);
    if (match === null) continue;
    const list = continuations.get(match[1]) ?? [];
    list.push({ index: Number(match[2]), encoded: match[3] === '*', value: paramValue });
    continuations.set(match[1], list);
  }
  const params = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (!key.includes('*')) params[key] = decodeWords(paramValue);
  }
  for (const [name, parts] of continuations) {
    parts.sort((a, b) => a.index - b.index);
    if (parts.some((part) => part.encoded)) {
      const joined = parts.map((part) => part.value).join('');
      params[name] = decodeRfc2231(joined);
    } else {
      params[name] = decodeWords(parts.map((part) => part.value).join(''));
    }
  }
  for (const [key, paramValue] of Object.entries(rawParams)) {
    // Simple `filename*` (no continuation) and `filename*0*` handled above;
    // decode any remaining values that look like RFC 2047.
    if (key.endsWith('*') && !params[key.slice(0, -1)]) {
      params[key.slice(0, -1)] = decodeRfc2231(paramValue);
    }
  }
  return { value: main, params };
}

/**
 * Parse a Content-Type value.
 *
 * @param {string} value
 * @returns {{ type: string, subtype: string, value: string, params: Record<string,string> }}
 */
export function parseContentType(value) {
  const parsed = parseParameterized(value);
  const slash = parsed.value.indexOf('/');
  let type = slash === -1 ? parsed.value : parsed.value.slice(0, slash);
  let subtype = slash === -1 ? '' : parsed.value.slice(slash + 1);
  type = type.trim().toLowerCase();
  subtype = subtype.trim().toLowerCase();
  if (type === '') type = 'text';
  if (subtype === '') subtype = type === 'text' ? 'plain' : 'octet-stream';
  return { type, subtype, value: `${type}/${subtype}`, params: parsed.params };
}

/** Parse a Content-Disposition value. */
export function parseContentDisposition(value) {
  const parsed = parseParameterized(value);
  const disposition = parsed.value.trim().toLowerCase();
  return { disposition, params: parsed.params };
}

/* ------------------------------------------------------------------------- *
 * Address parsing
 * ------------------------------------------------------------------------- */

/** Split an address list on commas outside quotes / angle brackets / comments. */
function splitAddressList(input) {
  const text = String(input ?? '');
  const parts = [];
  let current = '';
  let quote = null;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (comment > 0) {
      current += ch;
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '(') comment += 1;
      else if (ch === ')') comment -= 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      comment += 1;
      current += ch;
      continue;
    }
    if (ch === '<') {
      angle += 1;
      current += ch;
      continue;
    }
    if (ch === '>') {
      if (angle > 0) angle -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && angle === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Parse one address token into `{ name, address }`. */
function parseOneAddress(token) {
  let text = String(token ?? '').trim();
  if (text === '') return null;

  // Group syntax is stripped by parseAddressList(); only remove a trailing
  // group terminator here.
  text = text.replace(/;+\s*$/, '').trim();

  let name = '';
  let address = '';
  const angleMatch = /^(.*?)<([^<>]*)>\s*$/s.exec(text);
  if (angleMatch !== null) {
    name = angleMatch[1].trim();
    address = angleMatch[2].trim();
    name = name.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
  } else {
    // Bare address with optional trailing comment: `a@b (Name)`
    const commentMatch = /^([^()]*?)\s*\(([^()]*)\)\s*$/.exec(text);
    if (commentMatch !== null && commentMatch[1].includes('@')) {
      address = commentMatch[1].trim();
      name = commentMatch[2].trim();
    } else if (text.includes('@')) {
      address = text;
    } else {
      address = text;
    }
    address = address.replace(/[<>]/g, '').trim();
  }
  name = decodeWords(stripComments(name)).trim();
  address = address.replace(/^["']|["']$/g, '').trim();
  if (address === '' && name === '') return null;
  return { name, address };
}

/**
 * Parse an address list header (From / To / Cc / Bcc / Reply-To).
 * Tolerant: returns `[{ name, address }]`, never throws.
 *
 * @param {string} value - unfolded raw header value.
 * @returns {Array<{name: string, address: string}>}
 */
export function parseAddressList(value) {
  const text = String(value ?? '');
  if (text.trim() === '') return [];
  // Strip group labels: `Group Name: a@x, b@y;` -> `a@x, b@y;`
  const withoutGroups = text
    .replace(/(^|,)(\s*)[^,<>"@:;]+:\s*/g, '$1$2')
    .replace(/;\s*(?=,|$)/g, ' ');
  const result = [];
  for (const token of splitAddressList(withoutGroups)) {
    const parsed = parseOneAddress(token);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

/* ------------------------------------------------------------------------- *
 * Date / message ids / auto-reply detection
 * ------------------------------------------------------------------------- */

/** Parse a Date header value; returns `null` for unparseable dates. */
export function parseDateHeader(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const date = new Date(String(value).trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Strip angle brackets from a Message-ID-ish value.
 * @param {string} value
 * @returns {string}
 */
export function normalizeMessageId(value) {
  return String(value ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
}

/**
 * Stable key for message-id based de-duplication (bracket-free, lower-case).
 * @param {string} value
 * @returns {string}
 */
export function messageIdKey(value) {
  return normalizeMessageId(value).toLowerCase();
}

/** Extract one or more message ids from a header like References / In-Reply-To. */
function extractMessageIds(value) {
  if (value === undefined || value === null) return [];
  const text = String(value);
  const bracketed = [...text.matchAll(/<([^<>\s]+)>/g)].map((match) => `<${match[1]}>`);
  if (bracketed.length > 0) return bracketed;
  return text
    .split(/[\s,]+/)
    .map((piece) => normalizeMessageId(piece))
    .filter((piece) => piece !== '')
    .map((piece) => `<${piece}>`);
}

const NO_REPLY_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|auto(?:matic)?-?repl(?:y|ies)|donotreply)$/i;

/**
 * Detect auto-generated / bulk mail, which the prompt policy must not reply to.
 *
 * @param {object} input - parsed header values.
 * @returns {{
 *   isAutoReply: boolean,
 *   autoSubmitted: string|null,
 *   precedence: string|null,
 *   listUnsubscribe: boolean,
 *   listId: string|null,
 *   xAutoResponseSuppress: string|null,
 *   noReplyAddress: boolean,
 *   reasons: string[],
 * }}
 */
export function detectAutoReply(input) {
  const get = (name) => input[name] ?? null;
  const autoSubmitted = get('auto-submitted');
  const precedence = get('precedence');
  const listUnsubscribe = get('list-unsubscribe');
  const listId = get('list-id');
  const xAutoResponseSuppress = get('x-auto-response-suppress');
  const reasons = [];

  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') {
    reasons.push(`Auto-Submitted: ${autoSubmitted.trim()}`);
  }
  if (precedence !== null && /^(bulk|list|junk|auto_reply)$/i.test(precedence.trim())) {
    reasons.push(`Precedence: ${precedence.trim()}`);
  }
  if (xAutoResponseSuppress !== null) reasons.push('X-Auto-Response-Suppress');
  if (listUnsubscribe !== null) reasons.push('List-Unsubscribe');
  if (listId !== null) reasons.push('List-Id');

  const fromList = Array.isArray(input.fromAddresses) ? input.fromAddresses : [];
  let noReplyAddress = false;
  for (const address of fromList) {
    const local = String(address.address ?? '').split('@')[0] ?? '';
    if (NO_REPLY_LOCAL_RE.test(local)) {
      noReplyAddress = true;
      reasons.push(`no-reply sender: ${address.address}`);
      break;
    }
  }

  return {
    isAutoReply: reasons.length > 0,
    autoSubmitted: autoSubmitted === null ? null : autoSubmitted.trim(),
    precedence: precedence === null ? null : precedence.trim(),
    listUnsubscribe: listUnsubscribe !== null,
    listId: listId === null ? null : listId.trim(),
    xAutoResponseSuppress: xAutoResponseSuppress === null ? null : xAutoResponseSuppress.trim(),
    noReplyAddress,
    reasons,
  };
}

/* ------------------------------------------------------------------------- *
 * HTML -> text
 * ------------------------------------------------------------------------- */

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7',
  eacute: '\u00e9', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', times: '\u00d7', divide: '\u00f7', laquo: '\u00ab',
  raquo: '\u00bb', zwnj: '\u200c', zwj: '\u200d', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009',
};

/**
 * Decode HTML character references (named + numeric).
 * @param {string} text
 * @returns {string}
 */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const value = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
        try {
          return String.fromCodePoint(value);
        } catch {
          return entity;
        }
      }
      return entity;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * Convert an HTML mail body to readable plain text (for AI consumption and
 * snippet generation). Not a renderer: block elements become newlines,
 * list items become `• `, everything else is stripped.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (html === undefined || html === null) return '';
  let text = String(html);
  if (text === '') return '';
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|head|title|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n• ');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|pre|section|article|header|footer|dd|dt|ul|ol|dl)\s*>/gi, '\n');
  text = text.replace(/<(td|th)\b[^>]*>/gi, ' ');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Build a single-line snippet from text (or HTML when text is missing).
 *
 * @param {string} text
 * @param {number} [maxChars] - hard cap in characters.
 * @returns {string}
 */
export function makeSnippet(text, maxChars = DEFAULT_SNIPPET_CHARS) {
  const flat = String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
  if (maxChars <= 0) return '';
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}\u2026`;
}

/* ------------------------------------------------------------------------- *
 * Message body walking
 * ------------------------------------------------------------------------- */

/** Turn raw structural text into bytes (latin1 round-trip). */
function textToBytes(text) {
  return Buffer.from(text, 'latin1');
}

/** Decode one leaf body according to transfer encoding + charset. */
function decodePartBody(bodyText, transferEncoding, charset) {
  const encoding = String(transferEncoding ?? '').trim().toLowerCase().split(';')[0].trim();
  if (encoding === 'base64') {
    return Buffer.from(bodyText.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (encoding === 'quoted-printable' || encoding === 'quoted_printable') {
    return decodeQuotedPrintable(bodyText);
  }
  return textToBytes(bodyText);
}

/** Parse a raw part (header text + body text) into a structural part. */
function structuralPart(headerText, bodyText, limits = {}) {
  const parsed = parseHeaders(headerText, {
    maxLineBytes: limits.maxHeaderLineBytes,
    maxHeaders: limits.maxHeaders,
  });
  const getFirst = (name) => parsed.map.get(name)?.[0];
  const contentType = parseContentType(getFirst('content-type') ?? 'text/plain');
  const disposition = parseContentDisposition(getFirst('content-disposition') ?? '');
  const filename = disposition.params.filename ?? contentType.params.name ?? null;
  const contentIdRaw = getFirst('content-id') ?? '';
  const contentId = normalizeMessageId(contentIdRaw) || null;
  return {
    headers: parsed,
    headerTruncated: parsed.truncated,
    bodyText,
    contentType,
    disposition,
    filename,
    contentId,
    transferEncoding: getFirst('content-transfer-encoding') ?? '7bit',
    get: (name) => parsed.map.get(name)?.[0],
  };
}

/** Split a multipart body on its delimiter lines. */
function splitMultipart(bodyText, boundary) {
  if (typeof boundary !== 'string' || boundary === '') return null;
  const normalized = bodyText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delimiter = `--${boundary}`;
  const closing = `${delimiter}--`;
  const chunks = [];
  let current = null;
  for (const line of normalized.split('\n')) {
    const stripped = line.replace(/[ \t]+$/, '');
    if (stripped === delimiter) {
      if (current !== null) chunks.push(current.join('\n'));
      current = [];
      continue;
    }
    if (stripped === closing) {
      if (current !== null) chunks.push(current.join('\n'));
      current = null;
      break;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) chunks.push(current.join('\n'));
  return chunks;
}

/** Whether a part can act as the message body instead of an attachment. */
function isPotentialBody(part) {
  if (part.contentType.type === 'multipart') return true;
  if (part.disposition.disposition === 'attachment') return false;
  if (part.contentType.type === 'text') {
    return part.filename === null;
  }
  return false;
}

function addAttachment(ctx, part, decodedSize, inlineHint) {
  if (ctx.attachments.length >= ctx.limits.maxParts) return;
  const inline = inlineHint ?? (
    part.disposition.disposition !== 'attachment' && part.contentId !== null
  );
  ctx.attachments.push({
    filename: part.filename ?? null,
    contentType: part.contentType.value,
    size: decodedSize,
    cid: part.contentId,
    disposition: part.disposition.disposition === '' ? (inline ? 'inline' : 'attachment') : part.disposition.disposition,
    inline,
    encoding: String(part.transferEncoding).trim().toLowerCase(),
  });
}

/**
 * Walk one MIME part, collecting bodies and attachment metadata into ctx.
 * Resource guards: max depth, max parts, parse deadline. Exceeding a guard
 * marks the message truncated/suspicious instead of throwing.
 *
 * @param {object} part - structural part.
 * @param {object} ctx - collector state.
 * @param {'body'|'attachment'|'inline'} role
 * @param {number} depth - recursion depth (multipart nesting).
 */
function walkPart(part, ctx, role, depth = 0) {
  if (part.headerTruncated) ctx.headerTruncated = true;
  if (Date.now() > ctx.deadline) {
    ctx.budgetExceeded = true;
    ctx.truncated = true;
    return;
  }
  if (depth > ctx.limits.maxDepth) {
    ctx.depthExceeded = true;
    ctx.truncated = true;
    return;
  }
  if (ctx.parts >= ctx.limits.maxParts) {
    ctx.partsExceeded = true;
    ctx.truncated = true;
    return;
  }
  ctx.parts += 1;
  const { type, subtype, params } = part.contentType;

  if (role !== 'body') {
    const rawBytes = textToBytes(part.bodyText);
    let size = rawBytes.length;
    try {
      size = decodePartBody(part.bodyText, part.transferEncoding, params.charset).length;
    } catch {
      // keep raw size
    }
    addAttachment(ctx, part, size, role === 'inline');
    return;
  }

  if (type === 'multipart') {
    const chunks = splitMultipart(part.bodyText, params.boundary);
    if (chunks === null || chunks.length === 0) {
      // Broken multipart: fall back to treating the whole body as plain text.
      if (part.bodyText !== '') {
        ctx.texts.push(decodeCharset(textToBytes(part.bodyText), params.charset));
      }
      return;
    }
    const children = [];
    for (const chunk of chunks) {
      if (chunk === '') continue;
      const split = splitHeaderBody(chunk);
      if (split.truncated) ctx.headerTruncated = true;
      if (split.bodyText === '' && split.headerText.trim() === '') continue;
      children.push(structuralPart(split.headerText, split.bodyText, ctx.limits));
    }
    if (subtype === 'alternative') {
      for (const child of children) walkPart(child, ctx, 'body', depth + 1);
      return;
    }
    if (subtype === 'related') {
      let rootIndex = 0;
      const start = normalizeMessageId(params.start ?? '');
      if (start !== '') {
        const found = children.findIndex((child) => child.contentId === start);
        if (found !== -1) rootIndex = found;
      }
      children.forEach((child, index) => {
        walkPart(child, ctx, index === rootIndex ? 'body' : 'inline', depth + 1);
      });
      return;
    }
    // mixed / digest / signed / encrypted / unknown: the first body candidate
    // is the body, everything else is an attachment.
    let assigned = false;
    for (const child of children) {
      if (!assigned && isPotentialBody(child)) {
        assigned = true;
        walkPart(child, ctx, 'body', depth + 1);
      } else {
        walkPart(child, ctx, 'attachment', depth + 1);
      }
    }
    return;
  }

  if (type === 'message' && subtype === 'rfc822') {
    const rawBytes = textToBytes(part.bodyText);
    addAttachment(ctx, part, rawBytes.length, false);
    return;
  }

  const isText = type === 'text';
  if (!isText || part.disposition.disposition === 'attachment') {
    let size = textToBytes(part.bodyText).length;
    try {
      size = decodePartBody(part.bodyText, part.transferEncoding, params.charset).length;
    } catch {
      // keep raw size
    }
    addAttachment(ctx, part, size, false);
    return;
  }

  const decodedBytes = decodePartBody(part.bodyText, part.transferEncoding, params.charset);
  const text = decodeCharset(decodedBytes, params.charset);
  if (subtype === 'html') {
    ctx.htmls.push(text);
  } else {
    ctx.texts.push(text);
  }
}

/* ------------------------------------------------------------------------- *
 * Public entry point
 * ------------------------------------------------------------------------- */

/** Convert string/Buffer input to bytes. */
function toBytes(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (raw === undefined || raw === null) return Buffer.alloc(0);
  throw new MimeError('parseMessage expects a string, Buffer or Uint8Array', 'invalid-input');
}

/**
 * Build the security/anti-phishing signal block from parsed headers.
 * Never throws: everything is best-effort heuristics for the policy layer.
 *
 * @param {object} input
 * @returns {object}
 */
function buildSecurity(input) {
  const reasons = [];
  const authentication = { dkim: null, spf: null, dmarc: null };
  const values = Array.isArray(input.authenticationResults) ? input.authenticationResults : [];
  for (const value of values) {
    for (const match of String(value).matchAll(/\b(dkim|spf|dmarc)\s*=\s*([a-zA-Z]+)/g)) {
      const mechanism = match[1].toLowerCase();
      const verdict = match[2].toLowerCase();
      // Keep the worst verdict: fail/softfail/temperror/permerror win over pass.
      if (authentication[mechanism] === null || /^(fail|softfail|temperror|permerror)$/.test(verdict)) {
        authentication[mechanism] = verdict;
      }
    }
  }
  const authFailed = ['dkim', 'spf', 'dmarc'].filter(
    (mechanism) => authentication[mechanism] !== null
      && /^(fail|softfail|temperror|permerror)$/.test(authentication[mechanism]),
  );
  if (authFailed.length > 0) reasons.push(`authentication failed: ${authFailed.join(', ')}`);

  const fromAddress = input.from?.[0]?.address ?? '';
  const replyToAddress = input.replyTo?.[0]?.address ?? '';
  const replyToMismatch = fromAddress !== ''
    && replyToAddress !== ''
    && fromAddress.toLowerCase() !== replyToAddress.toLowerCase();
  if (replyToMismatch) {
    reasons.push(`Reply-To (${replyToAddress}) differs from From (${fromAddress})`);
  }

  const returnPath = input.returnPath ?? '';
  const returnPathMismatch = fromAddress !== ''
    && returnPath !== ''
    && fromAddress.toLowerCase() !== returnPath.toLowerCase();

  const autoReply = input.autoReply;
  if (autoReply?.isAutoReply) reasons.push(`auto-generated mail: ${autoReply.reasons.join('; ')}`);
  if (input.truncated) reasons.push('message truncated by size/complexity limits');

  const domainOf = (address) => {
    const at = String(address).lastIndexOf('@');
    return at === -1 ? '' : String(address).slice(at + 1).toLowerCase();
  };

  return {
    suspicious: reasons.length > 0,
    reasons,
    authentication,
    authenticationFailed: authFailed,
    authenticationResults: values,
    receivedCount: input.receivedCount ?? 0,
    returnPath,
    returnPathMismatch,
    replyToAddress,
    replyToMismatch,
    fromAddress,
    fromDomain: domainOf(fromAddress),
    replyToDomain: domainOf(replyToAddress),
    autoReply,
    truncated: Boolean(input.truncated),
  };
}

/**
 * Parse a complete RFC 5322 message (headers + body, possibly multipart).
 *
 * Resource limits are enforced defensively (SPEC §0 T7): oversized messages are
 * truncated and flagged, never thrown, except for a wrong input type and an
 * explicit `strict:true` mode.
 *
 * @param {string|Buffer|Uint8Array} raw - full message bytes (IMAP BODY[]).
 * @param {object} [options]
 * @param {number} [options.maxBytes=5MB] - hard cap; larger input is truncated + flagged.
 * @param {number} [options.maxDepth=20] - multipart nesting limit.
 * @param {number} [options.maxParts=500] - total part limit (DoS guard).
 * @param {number} [options.maxTextChars=1MB] - cap decoded text/html body length.
 * @param {number} [options.maxHeaderLineBytes=64KB] - per-header length cap.
 * @param {number} [options.maxHeaders=2000] - header count cap.
 * @param {number} [options.maxParseMs=5000] - wall-clock parse budget (soft).
 * @param {number} [options.snippetChars=160] - snippet length.
 * @param {boolean} [options.strict=false] - throw MimeError (code `too-large`) instead of truncating.
 * @returns {object} parsed message:
 * - `headers`: lower-case name -> first unfolded raw value (object, insertion order)
 * - `headerList`: `[{name, value}]` in original order
 * - `from`/`to`/`cc`/`bcc`/`replyTo`: `[{name, address}]`
 * - `subject`: RFC 2047 decoded
 * - `date` (Date|null), `dateIso` (string|null)
 * - `messageId`, `inReplyTo`, `references`: `<id>` strings (messageId '' when absent)
 * - `text` (string|null): plain-text body (derived from HTML when HTML-only)
 * - `html` (string|null): HTML body, NOT sanitized
 * - `attachments`: `[{filename, contentType, size, cid, disposition, inline, encoding}]`
 * - `autoReply`: auto-generated-mail detection (`isAutoReply`, `reasons`, ...)
 * - `security`: suspicious-mail / anti-phishing signals (`suspicious`, reasons, auth results, Reply-To mismatch, ...)
 * - `snippet`, `size` (raw bytes), `parsedBytes`, `truncated` (boolean), `suspicious` (boolean)
 */
export function parseMessage(raw, options = {}) {
  let bytes = toBytes(raw);
  const originalSize = bytes.length;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    if (options.strict === true) {
      throw new MimeError(`message too large: ${bytes.length} bytes (limit ${maxBytes})`, 'too-large');
    }
    bytes = bytes.subarray(0, maxBytes);
  }
  const inputTruncated = bytes.length !== originalSize;

  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxParts: options.maxParts ?? DEFAULT_MAX_PARTS,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    maxHeaderLineBytes: options.maxHeaderLineBytes ?? DEFAULT_MAX_HEADER_LINE_BYTES,
    maxHeaders: options.maxHeaders ?? DEFAULT_MAX_HEADERS,
  };
  const text = bytes.toString('latin1');
  const split = splitHeaderBody(text, options.maxHeaderBytes ?? MAX_HEADER_BYTES);
  const headerTruncated = split.truncated || inputTruncated;
  const parsedHeaders = parseHeaders(split.headerText, {
    maxLineBytes: limits.maxHeaderLineBytes,
    maxHeaders: limits.maxHeaders,
  });

  const headers = {};
  for (const [key, values] of parsedHeaders.map) headers[key] = values[0];

  const getRaw = (name) => parsedHeaders.map.get(name)?.[0];
  const getAllRaw = (name) => parsedHeaders.map.get(name) ?? [];
  const getDecoded = (name) => {
    const values = getAllRaw(name);
    if (values.length === 0) return null;
    return values.map((value) => decodeWords(value)).join(', ');
  };

  const from = parseAddressList(getAllRaw('from').join(', '));
  const to = parseAddressList(getAllRaw('to').join(', '));
  const cc = parseAddressList(getAllRaw('cc').join(', '));
  const bcc = parseAddressList(getAllRaw('bcc').join(', '));
  const replyTo = parseAddressList(getAllRaw('reply-to').join(', '));

  const date = parseDateHeader(getRaw('date'));
  const messageIdRaw = getRaw('message-id') ?? '';
  const messageId = messageIdRaw.trim() === ''
    ? ''
    : `<${normalizeMessageId(messageIdRaw)}>`;

  const root = structuralPart(split.headerText, split.bodyText, limits);
  const ctx = {
    limits,
    deadline: Date.now() + (options.maxParseMs ?? DEFAULT_PARSE_BUDGET_MS),
    parts: 0,
    texts: [],
    htmls: [],
    attachments: [],
    truncated: inputTruncated || parsedHeaders.truncated || split.truncated,
    headerTruncated,
    depthExceeded: false,
    partsExceeded: false,
    budgetExceeded: false,
  };
  walkPart(root, ctx, 'body', 0);
  if (parsedHeaders.truncated || root.headerTruncated) ctx.headerTruncated = true;

  const capText = (value) => {
    if (value === null) return null;
    if (value.length <= limits.maxTextChars) return value;
    ctx.truncated = true;
    return value.slice(0, limits.maxTextChars);
  };

  let html = ctx.htmls.length > 0 ? capText(ctx.htmls[ctx.htmls.length - 1]) : null;
  let bodyTextOut = ctx.texts.length > 0 ? capText(ctx.texts[0]) : null;
  if (bodyTextOut === null && html !== null) bodyTextOut = capText(htmlToText(html));
  if (html !== null) html = capText(html);

  const autoReply = detectAutoReply({
    'auto-submitted': getRaw('auto-submitted'),
    precedence: getRaw('precedence'),
    'list-unsubscribe': getRaw('list-unsubscribe'),
    'list-id': getRaw('list-id'),
    'x-auto-response-suppress': getRaw('x-auto-response-suppress'),
    fromAddresses: from,
  });

  const returnPathRaw = getRaw('return-path') ?? '';
  const returnPathAddress = parseAddressList(returnPathRaw)[0]?.address ?? '';

  const security = buildSecurity({
    from,
    replyTo,
    autoReply,
    authenticationResults: getAllRaw('authentication-results').map((value) => decodeWords(value)),
    receivedCount: getAllRaw('received').length,
    returnPath: returnPathAddress,
    truncated: ctx.truncated,
  });

  const subject = getDecoded('subject') ?? '';
  const snippetBase = bodyTextOut ?? (html !== null ? htmlToText(html) : '');
  const result = {
    headers,
    headerList: parsedHeaders.list,
    contentType: root.contentType.value,
    charset: root.contentType.params.charset ?? null,
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    date,
    dateIso: date === null ? null : date.toISOString(),
    messageId,
    inReplyTo: extractMessageIds(getRaw('in-reply-to')),
    references: extractMessageIds(getRaw('references')),
    text: bodyTextOut,
    html,
    attachments: ctx.attachments,
    autoReply,
    security,
    snippet: makeSnippet(snippetBase, options.snippetChars ?? DEFAULT_SNIPPET_CHARS),
    size: originalSize,
    parsedBytes: bytes.length,
    truncated: ctx.truncated,
    suspicious: security.suspicious,
  };
  // Convenience aliases used by the sync/store layer.
  result.hasHtml = result.html !== null && result.html.trim() !== '';
  result.hasText = result.text !== null && result.text.trim() !== '';
  result.fromAddress = result.from[0]?.address ?? '';
  result.fromName = result.from[0]?.name ?? '';
  return result;
}

export default {
  parseMessage,
  parseHeaders,
  parseAddressList,
  decodeCharset,
  decodeWords,
  encodeWords,
  decodeQuotedPrintable,
  decodeHtmlEntities,
  htmlToText,
  makeSnippet,
  parseDateHeader,
  normalizeMessageId,
  messageIdKey,
  MimeError,
};
