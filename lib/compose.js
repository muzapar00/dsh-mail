/**
 * Outgoing mail composition with **author-chosen format and style**.
 *
 * The AI (or the human UI) decides how a letter looks: Markdown, plain text or
 * HTML. Nothing is forced — no salutation, greeting, 此致/敬礼, signature, date
 * or letterhead is added by the plugin. Security still applies:
 *
 *  - Markdown/plain text are fully escaped and only http(s) links are activated;
 *    remote images are not rendered (anti-tracking / anti-phishing).
 *  - HTML mode runs through the same白名单 sanitizer used for inbound mail, so
 *    scripts, frames, forms and event handlers never leave this process.
 *  - The generated plain-text alternative is always present.
 *
 * @module dsh-mailbox/lib/compose
 */

import { sanitizeHtml } from './mail/html.js';
import { htmlToText } from './mail/mime.js';

/** Supported authoring formats. */
export const FORMATS = ['markdown', 'text', 'html'];
/** Default for model-authored mail (the UI defaults to plain text). */
export const DEFAULT_FORMAT = 'markdown';
/** Maximum raw content length accepted from the model/UI. */
export const MAX_CONTENT_CHARS = 50000;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape HTML text. */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Only http(s) URLs may become links; everything else stays text. */
function safeUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Render inline Markdown for HTML output: code, links, bold, italic.
 * The input is already HTML-escaped, so only controlled tags are introduced.
 *
 * @param {string} escaped - escaped inline text.
 * @returns {string} inline HTML.
 */
function renderInline(escaped) {
  const placeholders = [];
  const stash = (html) => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };
  let out = escaped;
  // Inline code first so `*` inside code is never treated as emphasis.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;border-radius:4px;padding:1px 4px;">${code}</code>`));
  // Links: [text](url) and bare URLs.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeUrl(url);
    if (href === '') return match;
    return stash(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`);
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, prefix, url) => {
    const href = safeUrl(url);
    if (href === '') return `${prefix}${url}`;
    return `${prefix}${stash(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${url}</a>`)}`;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, bold) => stash(`<strong>${bold}</strong>`));
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, prefix, italic) => `${prefix}${stash(`<em>${italic}</em>`)}`);
  // Restore placeholders without letting restored HTML be re-scanned.
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index) => placeholders[Number(index)] ?? '');
}

/**
 * Render Markdown into { text, html }. Deliberately small and predictable:
 * headings, lists, quotes, fenced code, horizontal rules, paragraphs and the
 * inline features above.
 *
 * @param {string} content - Markdown source.
 * @returns {{ text: string, html: string }}
 */
export function renderMarkdown(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const htmlBlocks = [];
  const textBlocks = [];
  let paragraph = [];
  let list = null; // { ordered: boolean, items: string[] }
  let quote = [];
  let codeFence = null; // { lang, lines: string[] }

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const raw = paragraph.join(' ');
    htmlBlocks.push(`<p style="margin:0 0 12px;">${renderInline(escapeHtml(raw))}</p>`);
    textBlocks.push(raw);
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    const tag = list.ordered ? 'ol' : 'ul';
    const style = 'margin:0 0 12px;padding-left:24px;';
    htmlBlocks.push(`<${tag} style="${style}">${list.items.map((item) => `<li style="margin:2px 0;">${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`);
    textBlocks.push(list.items.map((item, index) => `${list.ordered ? `${index + 1}.` : '-'} ${item}`).join('\n'));
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    htmlBlocks.push(`<blockquote style="margin:0 0 12px;padding:6px 14px;border-left:3px solid #d0d7de;color:#57606a;">${renderInline(escapeHtml(quote.join(' ')))}</blockquote>`);
    textBlocks.push(quote.map((line) => `> ${line}`).join('\n'));
    quote = [];
  };
  const flushCode = () => {
    if (codeFence === null) return;
    const code = codeFence.lines.join('\n');
    htmlBlocks.push(`<pre style="margin:0 0 12px;padding:12px 14px;background:#f6f8fa;border-radius:6px;overflow:auto;"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;">${escapeHtml(code)}</code></pre>`);
    textBlocks.push(code);
    codeFence = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushCode();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (codeFence !== null) {
      if (/^\s*```/.test(line)) flushCode();
      else codeFence.lines.push(rawLine);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushAll();
      codeFence = { lang: line.replace(/^\s*```/, '').trim(), lines: [] };
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = heading[1].length;
      const size = [26, 22, 19, 17, 16, 16][level - 1];
      htmlBlocks.push(`<h${level} style="margin:0 0 10px;font-size:${size}px;line-height:1.35;">${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      textBlocks.push(`${heading[2].trim()}`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushAll();
      htmlBlocks.push('<hr style="border:none;border-top:1px solid #d8dee4;margin:16px 0;">');
      textBlocks.push('—');
      continue;
    }
    const quoteLine = /^\s*>\s?(.*)$/.exec(line);
    if (quoteLine !== null) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1]);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (unordered !== null) {
      flushParagraph();
      flushQuote();
      if (list === null || list.ordered === true) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flushParagraph();
      flushQuote();
      if (list === null || list.ordered === false) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();
  return { text: textBlocks.join('\n\n').trim(), html: htmlBlocks.join('\n') };
}

/** Turn bare http(s) URLs into links inside already-escaped plain text. */
function linkifyPlain(escaped) {
  return escaped.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, prefix, url) => {
    const href = safeUrl(url);
    if (href === '') return `${prefix}${url}`;
    return `${prefix}<a href="${escapeHtml(href)}" rel="noopener noreferrer">${url}</a>`;
  });
}

/** Render plain text into paragraphs (single newlines become <br>, no Markdown). */
export function renderPlain(content) {
  const text = String(content ?? '').replace(/\r\n?/g, '\n').trim();
  const paragraphs = text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== '');
  const html = paragraphs
    .map((block) => `<p style="margin:0 0 12px;line-height:1.75;">${block.split('\n').map((line) => linkifyPlain(escapeHtml(line))).join('<br>')}</p>`)
    .join('\n');
  return { text, html };
}

/**
 * Wrap a body fragment into a minimal, email-safe HTML document.
 *
 * @param {string} html - body fragment.
 * @param {{ cid?: string, alt?: string }} [inlineImage] - optional legacy avatar.
 * @returns {string} complete HTML document.
 */
function wrapDocument(html, inlineImage) {
  const footer = inlineImage !== undefined && typeof inlineImage.cid === 'string' && inlineImage.cid !== ''
    ? `<p style="margin:24px 0 0;text-align:right;"><img src="cid:${inlineImage.cid}" width="44" height="44" alt="${String(inlineImage.alt ?? '').replace(/[&<>"']/g, '')}" style="display:inline-block;width:44px;height:44px;border-radius:50%;"></p>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:680px;margin:0 auto;padding:28px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.75;color:#24292f;word-break:break-word;">
${html}${footer}
</div>
</body>
</html>`;
}

/** Strip Markdown/HTML markers for a short fallback subject or preview. */
export function plainSummary(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*_`~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose both alternatives for one author-formatted letter.
 *
 * @param {object} options - composition input.
 * @param {string} options.content - author-written body.
 * @param {'markdown'|'text'|'html'} [options.format] - authoring format.
 * @param {{ cid?: string, alt?: string }} [options.inlineImage] - optional legacy letterhead avatar.
 * @returns {{ format: string, text: string, html: string }}
 */
export function composeLetter(options = {}) {
  const format = FORMATS.includes(options.format) ? options.format : DEFAULT_FORMAT;
  const content = String(options.content ?? '').slice(0, MAX_CONTENT_CHARS);
  const inlineImage = options.inlineImage;
  if (format === 'html') {
    const safe = sanitizeHtml(content, { allowRemoteImages: false });
    const text = htmlToText(safe).trim() || plainSummary(safe);
    return { format, text, html: wrapDocument(safe) };
  }
  if (format === 'text') {
    const rendered = renderPlain(content);
    return { format, text: rendered.text, html: wrapDocument(rendered.html, inlineImage) };
  }
  const rendered = renderMarkdown(content);
  return { format, text: rendered.text, html: wrapDocument(rendered.html, inlineImage) };
}

/** Best plain-text snippet for notification/search/derived subjects. */
export function letterSnippet(content, format, maxChars = 200) {
  const letter = composeLetter({ content, format });
  const text = letter.text.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
