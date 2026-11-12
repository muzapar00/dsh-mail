/**
 * Email HTML sanitizer for dsh-mailbox (SPEC §0 T2/T3/T8).
 *
 * Email HTML is hostile input rendered inside the DSH Web UI, so this module is
 * deliberately whitelist-only and zero-tolerance:
 * - Tags: small whitelist; script/style/iframe/frame/object/embed/applet/form/
 *   input/button/select/textarea/meta/link/base/title/head/svg/math and friends
 *   are dropped WITH their content.
 * - All `on*` event handlers, ids, classes, `xmlns`, `srcset`, `background`,
 *   `formaction` are removed.
 * - URLs: only http/https (and mailto for `a`, cid:/safe data:image for `img`).
 *   All other schemes (`javascript:`, `vbscript:`, `data:`, `file:` ...) are
 *   dropped; HTML entities, control characters, zero-width and bidi characters
 *   are decoded/stripped first so protocol obfuscation cannot slip through.
 *   Relative and protocol-relative URLs are dropped (no trustworthy base).
 * - Remote images are NOT loaded by default: `src` is moved to
 *   `data-blocked-src` so the UI can offer a "load images" affordance.
 * - Safe inline CSS only (property whitelist + value sanitization; no url(),
 *   expression(), @import, backslash escapes, position/z-index/behavior).
 * - Links get `rel="noopener noreferrer"` and `target="_blank"`.
 *
 * Pure function, no DOM, no dependencies. Not a general HTML parser: it is a
 * conservative tokenizer that degrades safely on malformed markup.
 *
 * @module dsh-mailbox/lib/mail/html
 */

import { decodeHtmlEntities } from './mime.js';

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'b', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main',
  'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strike',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);

/** Tags whose ENTIRE content is discarded (script payloads, CSS, metadata). */
const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'base',
  'link', 'meta', 'title', 'head', 'template', 'svg', 'math', 'noscript', 'xmp',
  'plaintext', 'listing', 'marquee', 'portal', 'slot', 'canvas',
]);

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Elements HTML implicitly closes when the same element opens again. */
const AUTO_CLOSE_TAGS = new Set(['p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'option', 'optgroup', 'thead', 'tbody', 'tfoot']);

const GLOBAL_ATTRS = new Set(['style', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'bgcolor', 'color']);

const TAG_ATTRS = {
  a: new Set(['href', 'name', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'border', 'hspace', 'vspace']),
  table: new Set(['border', 'cellpadding', 'cellspacing', 'summary', 'frame', 'rules']),
  td: new Set(['colspan', 'rowspan', 'nowrap', 'headers']),
  th: new Set(['colspan', 'rowspan', 'nowrap', 'scope', 'abbr']),
  tr: new Set([]),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  font: new Set(['face', 'size']),
  ul: new Set(['type', 'start']),
  ol: new Set(['type', 'start', 'reversed']),
  li: new Set(['type', 'value']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
};

/** CSS properties that are safe and useful for email layout/typography. */
const SAFE_CSS_PROPS = new Set([
  'color', 'background-color', 'font', 'font-family', 'font-size', 'font-style',
  'font-weight', 'font-variant', 'line-height', 'letter-spacing', 'text-align',
  'text-decoration', 'text-indent', 'text-transform', 'white-space', 'word-break',
  'word-wrap', 'overflow-wrap', 'vertical-align', 'margin', 'margin-top',
  'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top',
  'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top',
  'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-collapse', 'border-spacing', 'border-radius', 'width',
  'max-width', 'min-width', 'height', 'max-height', 'min-height', 'display',
  'float', 'clear', 'list-style', 'list-style-type', 'list-style-position',
  'table-layout', 'caption-side', 'direction', 'opacity',
]);

const ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SAFE_CSS_VALUE_RE = /^[a-zA-Z0-9#%.,()\s'"+\-/!]+$/;
const MAX_STYLE_LEN = 2000;
const MAX_STYLE_PROPS = 60;
const MAX_ATTR_LEN = 8192;
const MAX_DEPTH = 100;

/** HTML5 named entities that matter for URL/protocol obfuscation. */
const URL_ENTITIES = {
  colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/',
  bsol: '\\', semi: ';', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ',
};

function decodeUrlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return entity;
        }
      }
      return entity;
    }
    return URL_ENTITIES[body.toLowerCase()] ?? decodeHtmlEntities(entity);
  });
}

/**
 * Sanitize a URL for use in an attribute.
 *
 * @param {unknown} value - raw attribute value (may contain HTML entities).
 * @param {object} [options]
 * @param {boolean} [options.allowCid=false] - allow `cid:` (inline images).
 * @param {boolean} [options.allowDataImage=false] - allow safe `data:image/*` payloads.
 * @param {boolean} [options.allowMailto=true] - allow `mailto:` links.
 * @returns {string|null} a safe URL, or null when it must be dropped.
 */
export function sanitizeUrl(value, options = {}) {
  if (value === undefined || value === null) return null;
  let url = decodeUrlEntities(String(value));
  // Collapse control characters, whitespace and invisibles used to split a
  // scheme (`java\tscript:`), strip bidi/zero-width overrides, then trim.
  url = url
    .replace(/[\u0000-\u0020\u007f-\u009f\u00ad]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/[\r\n]/g, '')
    .trim();
  if (url === '') return null;
  const lower = url.toLowerCase();
  if (options.allowCid === true && lower.startsWith('cid:')) {
    const cid = url.slice(4).replace(/[<>"\s]/g, '');
    return cid === '' ? null : `cid:${cid}`;
  }
  if (options.allowDataImage === true
    && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) {
    return url;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(lower);
  if (scheme !== null) {
    const name = scheme[1];
    if (name === 'http' || name === 'https') return url;
    if (options.allowMailto !== false && name === 'mailto') return url;
    return null;
  }
  // No scheme: relative, fragment or protocol-relative URL. No trustworthy base
  // exists inside a mail, so drop it (protocol-relative `//host` is remote too).
  return null;
}

/** Escape a string for use inside an HTML attribute value (double quoted). */
export function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text content. */
export function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Filter an inline CSS declaration list. Returns '' when nothing safe remains.
 *
 * @param {string} css
 * @returns {{css: string, dropped: number}}
 */
function sanitizeStyle(css) {
  const text = decodeHtmlEntities(String(css ?? ''));
  if (text === '') return { css: '', dropped: 0 };
  const declarations = [];
  let dropped = 0;
  for (const piece of text.split(';')) {
    const declaration = piece.trim();
    if (declaration === '') continue;
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      dropped += 1;
      continue;
    }
    if (declarations.length >= MAX_STYLE_PROPS) {
      dropped += 1;
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim();
    if (!SAFE_CSS_PROPS.has(property)) {
      dropped += 1;
      continue;
    }
    // No CSS escapes (backslash) => cannot spell url(/expression/position with
    // unicode escapes; no url()/@import/expression/javascript; no angle breaks.
    const value = rawValue.replace(/!important\s*$/i, '').trim();
    if (value === ''
      || value.length > 512
      || !SAFE_CSS_VALUE_RE.test(value)
      || /url\s*\(|expression|javascript|vbscript|@import|binding|behaviou?r|\\|<|>|\/\*/i.test(value)) {
      dropped += 1;
      continue;
    }
    const filtered = `${property}:${value}`;
    if (declarations.join(';').length + filtered.length > MAX_STYLE_LEN) {
      dropped += 1;
      continue;
    }
    declarations.push(filtered);
  }
  return { css: declarations.join(';'), dropped };
}

/** Whether a value is a plain safe dimension/number-ish attribute value. */
function sanitizeDimension(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (!/^\d{1,5}(?:\.\d{1,2})?(?:px|%|em|pt)?$/.test(text)) return null;
  return text;
}

const ALIGN_VALUES = new Set(['left', 'right', 'center', 'justify', 'top', 'middle', 'bottom', 'baseline', 'absmiddle', 'absbottom']);
const DIR_VALUES = new Set(['ltr', 'rtl', 'auto']);
const LANG_RE = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}|rgba?\([0-9,\s.%]{1,40}\))$/;
const INT_RE = /^\d{1,4}$/;

/**
 * Build the sanitized attribute string for one element.
 * @returns {{attrs: string, blockedImage: boolean, removed: number, hasHref: boolean}}
 */
function sanitizeAttributes(tag, rawAttrs, options) {
  const out = [];
  const allowedTagAttrs = TAG_ATTRS[tag] ?? new Set();
  let blockedImage = false;
  let removed = 0;
  let hasHref = false;
  const seen = new Set();
  for (const attr of rawAttrs) {
    const name = String(attr.name ?? '').toLowerCase();
    const value = attr.value === undefined ? '' : String(attr.value);
    if (name === '' || !ATTR_NAME_RE.test(name)) {
      removed += 1;
      continue;
    }
    if (seen.has(name)) {
      removed += 1;
      continue;
    }
    seen.add(name);
    if (name.startsWith('on')) {
      removed += 1;
      continue;
    }
    if (!allowedTagAttrs.has(name) && !GLOBAL_ATTRS.has(name)) {
      removed += 1;
      continue;
    }
    if (value.length > MAX_ATTR_LEN) {
      removed += 1;
      continue;
    }
    if (name === 'style') {
      const style = sanitizeStyle(value);
      if (style.css !== '') out.push(`style="${escapeAttribute(style.css)}"`);
      removed += style.dropped;
      continue;
    }
    if (name === 'href') {
      const safe = sanitizeUrl(value, { allowMailto: true });
      if (safe === null) {
        removed += 1;
        continue;
      }
      out.push(`href="${escapeAttribute(safe)}"`);
      hasHref = true;
      continue;
    }
    if (name === 'src') {
      const isCid = /^\s*cid:/i.test(value);
      const safe = sanitizeUrl(value, {
        allowCid: true,
        allowDataImage: options.allowDataImages === true,
        allowMailto: false,
      });
      if (safe === null) {
        blockedImage = true;
        removed += 1;
        const cid = /^\s*cid:([^"'\s]+)/i.exec(value)?.[1];
        if (cid !== undefined) {
          blockedImage = true;
          out.push(`data-blocked-src="${escapeAttribute(`cid:${cid}`)}"`);
        }
        continue;
      }
      if (!isCid && !lowerIsSafeLocalImage(safe, options)) {
        // Remote (http/https) or data image: blocked unless explicitly allowed.
        blockedImage = true;
        removed += 1;
        out.push(`data-blocked-src="${escapeAttribute(safe)}"`);
        continue;
      }
      out.push(`src="${escapeAttribute(safe)}"`);
      continue;
    }
    if (name === 'width' || name === 'height') {
      const safe = sanitizeDimension(value);
      if (safe !== null) out.push(`${name}="${escapeAttribute(safe)}"`);
      else removed += 1;
      continue;
    }
    if (name === 'colspan' || name === 'rowspan' || name === 'span' || name === 'start' || name === 'value') {
      if (INT_RE.test(value.trim())) out.push(`${name}="${escapeAttribute(value.trim())}"`);
      else removed += 1;
      continue;
    }
    if (name === 'align' || name === 'valign') {
      const lower = value.trim().toLowerCase();
      if (ALIGN_VALUES.has(lower)) out.push(`${name}="${lower}"`);
      else removed += 1;
      continue;
    }
    if (name === 'dir') {
      const lower = value.trim().toLowerCase();
      if (DIR_VALUES.has(lower)) out.push(`dir="${lower}"`);
      else removed += 1;
      continue;
    }
    if (name === 'lang') {
      if (LANG_RE.test(value.trim())) out.push(`lang="${escapeAttribute(value.trim())}"`);
      else removed += 1;
      continue;
    }
    if (name === 'bgcolor' || name === 'color') {
      if (COLOR_RE.test(value.trim())) out.push(`${name}="${escapeAttribute(value.trim())}"`);
      else removed += 1;
      continue;
    }
    if (name === 'alt' || name === 'title') {
      const trimmed = value.trim();
      if (trimmed.length <= MAX_ATTR_LEN) out.push(`${name}="${escapeAttribute(trimmed)}"`);
      else removed += 1;
      continue;
    }
    if (name === 'nowrap' || name === 'open' || name === 'reversed') {
      out.push(name);
      continue;
    }
    if (name === 'face' || name === 'size' || name === 'border' || name === 'cellpadding'
      || name === 'cellspacing' || name === 'scope' || name === 'summary'
      || name === 'frame' || name === 'rules' || name === 'type'
      || name === 'datetime' || name === 'abbr' || name === 'name'
      || name === 'hspace' || name === 'vspace' || name === 'headers') {
      const trimmed = value.trim();
      if (trimmed.length <= 200) out.push(`${name}="${escapeAttribute(trimmed)}"`);
      else removed += 1;
      continue;
    }
    if (name === 'target' || name === 'rel') {
      // Forced by the sanitizer for links; ignore whatever the email says.
      continue;
    }
    removed += 1;
  }
  return { attrs: out.join(' '), blockedImage, removed, hasHref };
}

function lowerIsSafeLocalImage(url, options) {
  if (/^cid:/i.test(url)) return true;
  if (options.allowRemoteImages === true) return true;
  return false;
}

/**
 * Scan one tag starting at `<`.
 * @returns {{closing: boolean, name: string, selfClosing: boolean, attrs: Array<{name: string, value?: string}>, end: number}|null}
 */
function scanTag(html, start) {
  let i = start + 1;
  let closing = false;
  if (html[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(i));
  if (nameMatch === null) return null;
  const name = nameMatch[0];
  i += name.length;
  const attrs = [];
  let selfClosing = false;
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) return null;
    if (html[i] === '>') return { closing, name, selfClosing, attrs, end: i + 1 };
    if (html[i] === '/' && html[i + 1] === '>') {
      selfClosing = true;
      return { closing, name, selfClosing, attrs, end: i + 2 };
    }
    const attrMatch = /^[^\s=/>]+/.exec(html.slice(i));
    if (attrMatch === null) return null;
    const attrName = attrMatch[0];
    i += attrName.length;
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (html[i] === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end === -1) return null;
        attrs.push({ name: attrName, value: html.slice(i + 1, end) });
        i = end + 1;
      } else {
        const valueMatch = /^[^\s>]*/.exec(html.slice(i));
        attrs.push({ name: attrName, value: valueMatch[0] });
        i += valueMatch[0].length;
      }
    } else {
      attrs.push({ name: attrName });
    }
  }
  return null;
}

/**
 * Skip past the closing tag of a dropped-content element (content discarded).
 * If the closing tag is missing, skip to the end of the document.
 */
function skipDroppedContent(html, start, name) {
  const re = new RegExp(`</${name}\\s*>`, 'ig');
  re.lastIndex = start;
  const match = re.exec(html);
  return match === null ? html.length : match.index + match[0].length;
}

/**
 * Sanitize an email HTML body and return the cleaned HTML.
 *
 * @param {string} html - untrusted email HTML.
 * @param {object} [options]
 * @param {boolean} [options.allowRemoteImages=false] - keep remote `<img src>` (still no scripts).
 * @param {boolean} [options.allowDataImages=false] - allow `data:image/(png|jpeg|gif|webp);base64,...` in img.
 * @param {((cid: string) => string|null)} [options.resolveCid] - map `cid:` references to data/http URLs.
 * @param {number} [options.maxLength=2_000_000] - output length cap.
 * @returns {string} safe HTML.
 */
export function sanitizeHtml(html, options = {}) {
  return sanitizeHtmlDetailed(html, options).html;
}

/**
 * Sanitize HTML and report what was neutralized (for UI warnings / tests).
 *
 * @param {string} html
 * @param {object} [options] - see sanitizeHtml.
 * @returns {{html: string, blockedImages: number, removedAttributes: number, droppedElements: number, droppedTags: string[], truncated: boolean}}
 */
export function sanitizeHtmlDetailed(html, options = {}) {
  if (typeof html !== 'string' || html === '') {
    return { html: '', blockedImages: 0, removedAttributes: 0, droppedElements: 0, droppedTags: [], truncated: false };
  }
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 2_000_000;
  const output = [];
  let outLength = 0;
  let truncated = false;
  const stack = [];
  const droppedTags = [];
  let removedAttributes = 0;
  let blockedImages = 0;
  let droppedElements = 0;
  let i = 0;

  const append = (chunk) => {
    if (truncated) return;
    if (outLength + chunk.length > maxLength) {
      truncated = true;
      return;
    }
    output.push(chunk);
    outLength += chunk.length;
  };

  const closeTo = (name) => {
    const index = stack.lastIndexOf(name);
    if (index === -1) return;
    while (stack.length > index) {
      const closing = stack.pop();
      append(`</${closing}>`);
    }
  };

  while (i < html.length) {
    if (truncated) break;
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      append(html.slice(i));
      break;
    }
    if (lt > i) append(html.slice(i, lt));
    i = lt;
    // Comments / declarations
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = scanTag(html, i);
    if (tag === null) {
      append('&lt;');
      i += 1;
      continue;
    }
    i = tag.end;
    const name = tag.name.toLowerCase();

    if (name === 'html' || name === 'body') {
      // Wrapper element: drop the tag, keep the content (no </html> either).
      if (!tag.closing) {
        // fall through to attribute removal, but do not push a wrapper tag
      }
      droppedElements += 1;
      continue;
    }

    if (tag.closing) {
      closeTo(name);
      continue;
    }

    if (DROP_CONTENT_TAGS.has(name)) {
      droppedElements += 1;
      if (droppedTags.length < 50) droppedTags.push(name);
      // Void elements (base/link/meta/input/embed/frame) have no content: drop
      // just the tag, never scan forward for a closing tag (which would delete
      // the rest of the message).
      if (!VOID_TAGS.has(name)) i = skipDroppedContent(html, i, name);
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      droppedElements += 1;
      droppedTags.push(name);
      continue;
    }

    if (stack.length >= MAX_DEPTH) {
      droppedElements += 1;
      continue;
    }

    if (AUTO_CLOSE_TAGS.has(name) && stack.lastIndexOf(name) !== -1) {
      closeTo(name);
    }

    const attrs = sanitizeAttributes(name, tag.attrs, options);
    removedAttributes += attrs.removed;
    if (name === 'img') {
      if (attrs.blockedImage) blockedImages += 1;
      if (options.resolveCid !== undefined && typeof options.resolveCid === 'function') {
        // resolveCid is applied by replacing cid: src, which sanitizeAttributes
        // already kept when allowCid is on.
      }
    }
    let attrText = attrs.attrs;
    if (name === 'a') {
      // Force safe link semantics; appending after sanitizeAttributes ensures a
      // hostile `target`/`rel` cannot survive (they are ignored there).
      attrText = `${attrText}${attrText === '' ? '' : ' '}target="_blank" rel="noopener noreferrer"`;
    }
    if (name === 'img') {
      if (/\bsrc="cid:/i.test(attrText) && typeof options.resolveCid === 'function') {
        const cidMatch = /\bsrc="cid:([^"]*)"/i.exec(attrText);
        const cid = cidMatch === null ? '' : decodeHtmlEntities(cidMatch[1]);
        let mapped = null;
        try {
          mapped = options.resolveCid(cid);
        } catch {
          mapped = null;
        }
        // The CID resolver is trusted plugin code (it maps to a data: URI or
        // plugin-served URL), so data:image is allowed for its output.
        let safeMapped = mapped === null || mapped === undefined
          ? null
          : sanitizeUrl(mapped, { allowDataImage: true, allowMailto: false });
        if (safeMapped !== null && /^https?:/i.test(safeMapped) && options.allowRemoteImages !== true) {
          safeMapped = null;
        }
        if (safeMapped !== null) {
          attrText = attrText.replace(/\bsrc="[^"]*"/i, `src="${escapeAttribute(safeMapped)}"`);
        } else {
          attrText = attrText
            .replace(/\bsrc="[^"]*"/i, '')
            .replace(/\s+/g, ' ')
            .trim();
          attrText = `${attrText}${attrText === '' ? '' : ' '}data-blocked-src="cid:${escapeAttribute(cid)}" class="dsh-mailbox-blocked-image"`;
          blockedImages += 1;
        }
      }
      if (/^src="https?:/i.test(attrText)) {
        attrText = `${attrText} loading="lazy" referrerpolicy="no-referrer"`;
      }
      if (attrs.blockedImage && !/class="dsh-mailbox-blocked-image"/.test(attrText)) {
        attrText = `${attrText}${attrText === '' ? '' : ' '}class="dsh-mailbox-blocked-image"`;
      }
    }
    const open = attrText === '' ? `<${name}>` : `<${name} ${attrText}>`;
    append(open);
    if (VOID_TAGS.has(name) || tag.selfClosing) {
      // self-closing non-void tags are dropped as empty containers
      if (tag.selfClosing && !VOID_TAGS.has(name)) append(`</${name}>`);
    } else {
      stack.push(name);
    }
    if (truncated) break;
  }

  while (stack.length > 0) {
    const closing = stack.pop();
    append(`</${closing}>`);
  }

  return {
    html: output.join(''),
    blockedImages,
    removedAttributes,
    droppedElements,
    droppedTags,
    truncated,
  };
}

/** The attribute/class name the UI uses to render a "load images" placeholder. */
export const BLOCKED_IMAGE_CLASS = 'dsh-mailbox-blocked-image';

export default { sanitizeHtml, sanitizeHtmlDetailed, sanitizeUrl, escapeAttribute, escapeText, BLOCKED_IMAGE_CLASS };
