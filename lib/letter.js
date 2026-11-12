/**
 * Outgoing letter composition: a plain-text alternative and a frameless HTML
 * page that follows Chinese letter-writing conventions (salutation flush left,
 * greeting and body indented two characters, 此致 / 敬礼, right-aligned
 * signature and date). Keep this format byte-compatible with the previous
 * `dsh-user-contact` letters users already receive.
 *
 * @module dsh-mailbox/lib/letter
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Turn absolute URLs inside already-escaped text into links. */
export function linkify(escaped) {
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => `<a href="${url}" rel="noopener noreferrer" style="color:#2f6bb0;text-decoration:underline;word-break:break-all;">${url}</a>`,
  );
}

/** Render one Chinese number from 1 to 31 (month and day). */
function chineseNumber(value) {
  if (value < 10) return DIGITS[value];
  if (value === 10) return '十';
  if (value < 20) return `十${DIGITS[value - 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${DIGITS[tens]}十${ones === 0 ? '' : DIGITS[ones]}`;
}

/**
 * Format a date in Chinese numerals, as written at the end of a Chinese letter:
 * 二〇二六年十一月二日.
 *
 * @param {Date} [now] - the instant to render; defaults to the current time.
 * @param {string} [timeZone] - IANA zone; defaults to the machine's zone.
 * @returns {string} the Chinese date.
 */
export function chineseDate(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const year = String(get('year')).split('').map((digit) => DIGITS[Number(digit)]).join('');
  return `${year}年${chineseNumber(get('month'))}月${chineseNumber(get('day'))}日`;
}

/** Split the model text into letter paragraphs; bullet lines become · items. */
export function toParagraphs(body) {
  return String(body ?? '')
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .flatMap((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
        return lines.map((line) => ({ bullet: true, lines: [line.replace(/^[-*]\s+/, '')] }));
      }
      return [{ bullet: false, lines }];
    });
}

/**
 * Build both message bodies for one outgoing letter.
 *
 * @param {object} options - message and branding fields.
 * @param {string} options.subject - full subject (used for the hidden title only).
 * @param {string} options.body - plain-text letter body written by the agent.
 * @param {string} options.fromName - display name used in metadata.
 * @param {string} options.from - sender address.
 * @param {string} options.signature - signature written at the end of the letter.
 * @param {string} [options.salutation] - salutation such as `兄弟：`; may be empty.
 * @param {string} [options.greeting] - greeting such as `见信好！`; may be empty.
 * @param {string} [options.subjectPrefix] - prefix stripped from the hidden title.
 * @param {string} [options.avatarSrc] - `cid:` reference or an absolute image URL.
 * @param {string} [options.creditUrl] - attribution link for the artwork.
 * @param {string} [options.date] - preformatted Chinese letter date.
 * @param {boolean} [options.letterhead] - render the letterhead HTML template.
 * @param {{ from: string, date: string, text: string }|null} [options.quote] - quoted reply.
 * @returns {{ text: string, html: string }} message bodies.
 */
export function formatLetter(options) {
  const {
    subject,
    body,
    fromName,
    from,
    signature,
    salutation = '',
    greeting = '见信好！',
    subjectPrefix = '',
    avatarSrc = '',
    creditUrl = '',
    date = chineseDate(),
    letterhead = true,
    quote = null,
  } = options;

  const heading = subjectPrefix !== '' && String(subject).startsWith(subjectPrefix)
    ? String(subject).slice(subjectPrefix.length).trim()
    : String(subject ?? '').trim();

  const paragraphs = toParagraphs(body);

  const textLines = [];
  if (salutation !== '') textLines.push(salutation);
  if (greeting !== '') textLines.push(`　　${greeting}`);
  for (const paragraph of paragraphs) {
    for (const line of paragraph.lines) {
      textLines.push(`　　${paragraph.bullet ? `· ${line}` : line}`);
    }
  }
  textLines.push('', '　　此致', '敬礼！', '', `　　　　　　　　　　　　${signature}`, `　　　　　　　　　　　　${date}`);
  textLines.push('', `（发件人：${fromName} <${from}>）`);
  if (quote !== null && quote.text !== '') {
    textLines.push('', '---------- 原邮件 ----------', `From: ${quote.from}`, `Date: ${quote.date}`, '', quote.text);
  }
  const text = textLines.join('\n');

  const bodyHtml = paragraphs
    .map((paragraph) => paragraph.lines
      .map((line) => {
        const prefix = paragraph.bullet ? '· ' : '';
        return `<p style="margin:0;font-size:16px;line-height:2;text-indent:2em;color:#22314a;">${prefix}${linkify(escapeHtml(line))}</p>`;
      })
      .join(''))
    .join('');

  const salutationHtml = salutation === '' ? '' : `<p style="margin:0 0 4px;font-size:17px;line-height:2;color:#1b2a44;">${escapeHtml(salutation)}</p>`;
  const greetingHtml = greeting === '' ? '' : `<p style="margin:0;font-size:16px;line-height:2;text-indent:2em;color:#22314a;">${escapeHtml(greeting)}</p>`;
  const quoteHtml = quote === null || quote.text === ''
    ? ''
    : `<div style="margin:28px 0 0;padding:14px 16px;background:#eef4fb;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;line-height:1.7;color:#5d7699;white-space:pre-wrap;">${escapeHtml(quote.from)} 写道（${escapeHtml(quote.date)}）：\n${escapeHtml(quote.text)}</div>`;

  const html = letterhead
    ? `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#e4ecf8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e4ecf8;">
<tr><td align="center" style="padding:30px 10px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#f9fcff;">
  <tr>
    <td style="padding:44px 48px 40px;">
      <div style="text-align:right;margin:0 0 22px;">
        <img src="${escapeHtml(avatarSrc)}" width="44" height="44" alt="${escapeHtml(fromName)}" style="display:inline-block;width:44px;height:44px;border-radius:50%;">
      </div>
      <div style="font-family:'Songti SC','Noto Serif SC','Source Han Serif SC','SimSun',Georgia,serif;color:#22314a;">
        ${salutationHtml}
        ${greetingHtml}
        ${bodyHtml}
        <p style="margin:12px 0 0;font-size:16px;line-height:2;text-indent:2em;color:#22314a;">此致</p>
        <p style="margin:0;font-size:16px;line-height:2;color:#22314a;">敬礼！</p>
        <p style="margin:34px 0 0;text-align:right;font-size:16px;line-height:2;color:#1b2a44;">${escapeHtml(signature)}</p>
        <p style="margin:0;text-align:right;font-size:14px;line-height:2;color:#5d7699;">${escapeHtml(date)}</p>
        ${quoteHtml}
      </div>
    </td>
  </tr>
</table>
<div style="max-width:600px;margin:14px auto 0;font-size:11px;line-height:1.7;color:#93a9c4;text-align:center;">
  信中形象：DeepSeek 鲸鱼娘（CC BY-NC-SA 4.0）·
  <a href="${escapeHtml(creditUrl)}" rel="noopener noreferrer" style="color:#8aa3c2;">素材来源</a>
</div>
</td></tr>
</table>
</body>
</html>`
    : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;">
<div style="font-family:'Songti SC','Noto Serif SC','Source Han Serif SC','SimSun',Georgia,serif;color:#22314a;">
${salutationHtml}${greetingHtml}${bodyHtml}
<p style="margin:12px 0 0;font-size:16px;line-height:2;text-indent:2em;">此致</p>
<p style="margin:0;font-size:16px;line-height:2;">敬礼！</p>
<p style="margin:28px 0 0;text-align:right;font-size:16px;line-height:2;">${escapeHtml(signature)}</p>
<p style="margin:0;text-align:right;font-size:14px;line-height:2;color:#5d7699;">${escapeHtml(date)}</p>
${quoteHtml}
</div></body></html>`;

  return { text, html };
}

/**
 * Derive a subject from the letter's first sentence when the caller omits one.
 *
 * @param {string} content - letter body.
 * @param {string} signature - configured signature for the fallback title.
 * @returns {string} a short subject line.
 */
export function deriveSubject(content, signature) {
  const firstLine = String(content ?? '').split('\n').find((line) => line.trim() !== '') ?? '';
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, '').replace(/[。！？!?；;，,、：:]+$/, '').trim();
  if (cleaned === '') return `一封来自${signature}的信`;
  const characters = [...cleaned];
  return characters.length > 26 ? `${characters.slice(0, 26).join('')}…` : cleaned;
}

/**
 * Format an RFC-style date for quotes (local time, human readable).
 *
 * @param {string|Date} value - instant.
 * @param {string} [locale] - BCP 47 locale, defaults to zh-CN.
 * @returns {string} formatted date.
 */
export function formatMailDate(value, locale = 'zh-CN') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
