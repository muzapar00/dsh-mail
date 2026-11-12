/**
 * Outgoing attachment policy: limits, filename sanitization, content-type
 * guessing, and executable blocking. Pure helpers shared by the model tool
 * (`send_email`) and the browser composer.
 *
 * Security rationale: attachments are the easiest exfiltration vector. The
 * plugin allows them only towards the configured user or a whitelisted friend,
 * blocks executable payloads, caps size/count, and (for model-supplied paths)
 * confines reads to the session workspace.
 *
 * @module dsh-mailbox/lib/core/attachments
 */

/** Maximum number of attachments on one letter. */
export const MAX_ATTACHMENTS = 5;
/** Maximum decoded bytes for the whole attachment set (keeps the SMTP message bounded). */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Maximum decoded bytes for one attachment. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Maximum filename length stored/encoded. */
export const MAX_FILENAME_CHARS = 120;

/** Extension → MIME type for common, safe attachments. */
const CONTENT_TYPES = new Map(Object.entries({
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}));

/** Extensions that must never be sent as attachments (executable/script payloads). */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.scr', '.com', '.bat', '.cmd', '.msi', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.mjs', '.cjs', '.wsf', '.wsh', '.jar', '.lnk', '.hta', '.reg',
  '.pif', '.cpl', '.dll', '.sys', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.app',
  '.sh', '.bash', '.zsh', '.py', '.pyc', '.rb', '.pl', '.php',
]);

/** Filename fragments that mark credential/secret material. */
const SECRET_NAME_RE = /(^|[/._-])(id_rsa|id_dsa|id_ecdsa|id_ed25519|privatekey|private-key|secrets?|credentials?|authcode|auth-code|password|passwd|token)([/._-]|$)/i;

/** Invisible/control characters stripped from filenames. */
const CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;

/**
 * Normalize a filename: keep the last path segment, strip control/bidi chars,
 * collapse path separators, trim, cap length.
 *
 * @param {unknown} value - raw name (may include a path).
 * @returns {string} a safe display name, or ''.
 */
export function sanitizeFilename(value) {
  if (typeof value !== 'string') return '';
  let name = value.replace(CONTROL_RE, '').trim();
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/[\s]+/g, ' ');
  if (name === '' || name === '.' || name === '..') return '';
  const characters = [...name];
  const capped = characters.length > MAX_FILENAME_CHARS ? characters.slice(0, MAX_FILENAME_CHARS).join('') : name;
  return capped;
}

/** Lowercased extension including the dot, or ''. */
export function extensionOf(filename) {
  const name = String(filename ?? '');
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Guess a MIME type from the filename. */
export function guessContentType(filename) {
  return CONTENT_TYPES.get(extensionOf(filename)) ?? 'application/octet-stream';
}

/** Whether the filename looks like credential material. */
export function isSecretLikeName(filename) {
  return SECRET_NAME_RE.test(String(filename ?? ''));
}

/** Whether the attachment type is forbidden (executables/scripts). */
export function isBlockedAttachment(filename) {
  return BLOCKED_EXTENSIONS.has(extensionOf(filename));
}

/**
 * Validate and normalize one decoded attachment.
 *
 * @param {{ filename?: unknown, contentType?: unknown, content?: Buffer|Uint8Array|string }} raw - attachment candidate.
 * @param {{ allowBlockedExtensions?: boolean }} [options] - internal escape hatch (never exposed to the model).
 * @returns {{ ok: true, attachment: { filename: string, contentType: string, content: Buffer, size: number } } | { ok: false, reason: string }}
 */
export function normalizeAttachment(raw, options = {}) {
  const filename = sanitizeFilename(raw?.filename);
  if (filename === '') return { ok: false, reason: '附件名不合法' };
  if (raw?.content === undefined || raw?.content === null) return { ok: false, reason: `附件 ${filename} 没有内容` };
  let content;
  if (Buffer.isBuffer(raw.content)) content = raw.content;
  else if (raw.content instanceof Uint8Array) content = Buffer.from(raw.content);
  else if (typeof raw.content === 'string') content = Buffer.from(raw.content, 'base64');
  else return { ok: false, reason: `附件 ${filename} 内容类型不支持` };
  if (content.length === 0) return { ok: false, reason: `附件 ${filename} 是空文件` };
  if (content.length > MAX_FILE_BYTES) return { ok: false, reason: `附件 ${filename} 超过单文件上限（8 MB）` };
  if (!options.allowBlockedExtensions && isBlockedAttachment(filename)) {
    return { ok: false, reason: `不允许发送可执行/脚本类附件：${filename}` };
  }
  if (isSecretLikeName(filename)) {
    return { ok: false, reason: `附件名 ${filename} 看起来是密钥/凭据，拒绝发送` };
  }
  const declared = typeof raw.contentType === 'string' ? raw.contentType.trim().toLowerCase() : '';
  const contentType = declared !== '' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared) ? declared : guessContentType(filename);
  return { ok: true, attachment: { filename, contentType, content, size: content.length } };
}

/**
 * Validate a whole attachment set.
 *
 * @param {Array<{ filename?: unknown, contentType?: unknown, content?: unknown }>} list - candidates.
 * @param {{ allowBlockedExtensions?: boolean, maxCount?: number, maxTotalBytes?: number }} [options]
 * @returns {{ ok: true, attachments: Array<{filename:string,contentType:string,content:Buffer,size:number}> } | { ok: false, reason: string }}
 */
export function normalizeAttachments(list, options = {}) {
  if (list === undefined || list === null) return { ok: true, attachments: [] };
  if (!Array.isArray(list)) return { ok: false, reason: 'attachments 必须是数组' };
  const maxCount = Number.isInteger(options.maxCount) ? options.maxCount : MAX_ATTACHMENTS;
  if (list.length > maxCount) return { ok: false, reason: `最多 ${maxCount} 个附件` };
  const attachments = [];
  let total = 0;
  for (const raw of list) {
    const normalized = normalizeAttachment(raw, options);
    if (normalized.ok !== true) return normalized;
    total += normalized.attachment.size;
    if (total > (Number.isInteger(options.maxTotalBytes) ? options.maxTotalBytes : MAX_TOTAL_BYTES)) {
      return { ok: false, reason: '附件总大小超过 10 MB 上限' };
    }
    attachments.push(normalized.attachment);
  }
  return { ok: true, attachments };
}

/** Metadata-only view safe to persist or return to the model/UI. */
export function attachmentMetadata(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => ({
    filename: item.filename,
    contentType: item.contentType,
    size: item.size,
  }));
}
