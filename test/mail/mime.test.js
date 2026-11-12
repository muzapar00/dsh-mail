/**
 * MIME / RFC 5322 / RFC 2047 parser tests.
 * All fixtures are local strings/buffers; no network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseMessage,
  parseHeaders,
  parseContentType,
  parseAddressList,
  decodeWords,
  encodeWords,
  decodeQuotedPrintable,
  decodeCharset,
  decodeHtmlEntities,
  htmlToText,
  makeSnippet,
  parseDateHeader,
  normalizeMessageId,
  messageIdKey,
  MimeError,
} from '../../lib/mail/mime.js';

/** Join fixture lines with CRLF. */
function raw(lines) {
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

const SIMPLE_MESSAGE = [
  'Return-Path: <alice@example.com>',
  'From: =?UTF-8?B?5aSn6IKl6bG8?= <alice@example.com>',
  'To: "Doe, John" <john@example.com>, bob@example.com',
  'Cc: carol@example.com',
  'Subject: =?UTF-8?B?5L2g5aW977yMd29ybGQ=?=',
  'Date: Wed, 12 Nov 2026 10:00:00 +0800',
  'Message-ID: <abc123@example.com>',
  'In-Reply-To: <parent@example.com>',
  'References: <root@example.com> <parent@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('你好，world'),
];

const GB18030_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文 in GB18030/GBK

function multipartFixture(parts, subtype = 'mixed', params = '') {
  const boundary = 'BOUNDARY-xyz-123';
  const lines = [
    'From: sender@example.com',
    'To: receiver@example.com',
    'Subject: multipart test',
    'MIME-Version: 1.0',
    `Content-Type: multipart/${subtype}; boundary="${boundary}"${params}`,
    '',
  ];
  for (const part of parts) {
    lines.push(`--${boundary}`, ...part);
  }
  lines.push(`--${boundary}--`, '');
  return lines;
}

/* ------------------------------------------------------------------------- */

describe('parseMessage: simple headers and bodies', () => {
  it('parses RFC 2047 subject/display-name, addresses, date, message ids', () => {
    const message = parseMessage(raw(SIMPLE_MESSAGE));
    assert.equal(message.subject, '你好，world');
    assert.equal(message.from[0].address, 'alice@example.com');
    assert.equal(message.from[0].name, '大肥鱼');
    assert.deepEqual(message.to.map((entry) => entry.address), ['john@example.com', 'bob@example.com']);
    assert.equal(message.to[0].name, 'Doe, John');
    assert.deepEqual(message.cc.map((entry) => entry.address), ['carol@example.com']);
    assert.equal(message.dateIso, '2026-11-12T02:00:00.000Z');
    assert.equal(message.messageId, '<abc123@example.com>');
    assert.deepEqual(message.inReplyTo, ['<parent@example.com>']);
    assert.deepEqual(message.references, ['<root@example.com>', '<parent@example.com>']);
    assert.equal(message.text, '你好，world');
    assert.equal(message.hasText, true);
    assert.equal(message.hasHtml, false);
    assert.equal(message.truncated, false);
    assert.equal(message.suspicious, false);
  });

  it('decodes GB18030 8bit bodies declared via charset=gb18030', () => {
    const message = parseMessage(Buffer.concat([
      Buffer.from('From: a@example.com\r\nSubject: gb test\r\nContent-Type: text/plain; charset=gb18030\r\n\r\n', 'latin1'),
      GB18030_BYTES,
    ]));
    assert.equal(message.text, '中文');
  });

  it('accepts charset=gbk and charset=GB2312 aliases', () => {
    for (const charset of ['gbk', 'GB2312', 'GB18030']) {
      const message = parseMessage(Buffer.concat([
        Buffer.from(`From: a@example.com\r\nContent-Type: text/plain; charset=${charset}\r\n\r\n`, 'latin1'),
        GB18030_BYTES,
      ]));
      assert.equal(message.text, '中文');
    }
  });

  it('decodes ISO-8859-1 quoted-printable bodies', () => {
    const message = parseMessage(raw(multipartFixture([
      ['Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=E9 = ok'],
    ], 'alternative')));
    assert.equal(message.text, 'Café = ok');
  });

  it('decodes base64 and quoted-printable transfer encodings', () => {
    assert.equal(decodeQuotedPrintable('a=3Db=0D=0A').toString('latin1'), 'a=b\r\n');
    assert.equal(decodeQuotedPrintable('soft=\r\nbreak').toString('latin1'), 'softbreak');
    assert.equal(decodeQuotedPrintable('stray=zz').toString('latin1'), 'stray=zz');
  });
});

describe('parseMessage: multipart structures', () => {
  it('parses multipart/alternative selecting plain text and HTML', () => {
    const message = parseMessage(raw(multipartFixture([
      ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64('纯文本正文')],
      ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64('<p>HTML 正文</p>')],
    ], 'alternative')));
    assert.equal(message.text, '纯文本正文');
    assert.equal(message.html, '<p>HTML 正文</p>');
    assert.equal(message.contentType, 'multipart/alternative');
    assert.equal(message.attachments.length, 0);
  });

  it('derives plain text from HTML-only messages', () => {
    const message = parseMessage(raw(multipartFixture([
      ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', '<p>Hello</p><p>World &amp; friends</p>'],
    ], 'alternative')));
    assert.equal(message.html, '<p>Hello</p><p>World &amp; friends</p>');
    assert.equal(message.text, 'Hello\nWorld & friends');
    assert.equal(message.hasText, true);
  });

  it('parses nested mixed(related(alternative + cid image) + attachment)', () => {
    const innerAlternative = [
      'Content-Type: multipart/alternative; boundary="ALT"',
      '',
      '--ALT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain',
      '--ALT',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html <img src="cid:logo@x"></p>',
      '--ALT--',
    ];
    const related = [
      'Content-Type: multipart/related; boundary="REL"; type="multipart/alternative"',
      '',
      '--REL',
      ...innerAlternative.map((line) => (line === '' ? line : line)),
      '--REL',
      'Content-Type: image/png; name="logo.png"',
      'Content-ID: <logo@x>',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      b64('PNGDATA'),
      '--REL--',
    ];
    const message = parseMessage(raw(multipartFixture([
      related,
      ['Content-Type: application/pdf; name="报告.pdf"',
        "Content-Disposition: attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
        'Content-Transfer-Encoding: base64', '', b64('PDFDATA')],
    ], 'mixed')));
    assert.equal(message.text, 'plain');
    assert.match(message.html, /<img src="cid:logo@x">/);
    assert.equal(message.attachments.length, 2);
    const inline = message.attachments.find((item) => item.inline);
    assert.equal(inline.contentType, 'image/png');
    assert.equal(inline.cid, 'logo@x');
    assert.equal(inline.size, 7);
    assert.equal(inline.filename, 'logo.png');
    const pdf = message.attachments.find((item) => !item.inline);
    assert.equal(pdf.filename, '报告.pdf');
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.disposition, 'attachment');
  });

  it('parses base64 attachment with RFC 2047 filename fallback', () => {
    const message = parseMessage(raw(multipartFixture([
      ['Content-Type: text/plain; charset=utf-8', '', 'body'],
      ['Content-Type: application/octet-stream; name="=?UTF-8?B?5paH5Lu2LnppcA==?="',
        'Content-Disposition: attachment; filename="=?UTF-8?B?5paH5Lu2LnppcA==?="',
        'Content-Transfer-Encoding: base64', '', b64('ZIPDATA')],
    ])));
    assert.equal(message.text, 'body');
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, '文件.zip');
    assert.equal(message.attachments[0].disposition, 'attachment');
  });

  it('handles broken multipart without throwing', () => {
    const message = parseMessage(raw([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary="missing"',
      '',
      'no delimiters here at all',
    ]));
    assert.equal(message.text, 'no delimiters here at all');
  });
});

describe('parseHeaders / content types / addresses', () => {
  it('unfolds folded headers and preserves insertion order', () => {
    const parsed = parseHeaders('Subject: hello\r\n world\r\nX-Test: 1\r\nReceived: a\r\nReceived: b');
    assert.deepEqual(parsed.list, [
      { name: 'Subject', value: 'hello world' },
      { name: 'X-Test', value: '1' },
      { name: 'Received', value: 'a' },
      { name: 'Received', value: 'b' },
    ]);
    assert.deepEqual(parsed.map.get('received'), ['a', 'b']);
  });

  it('parses parameterized content types, quoted params and RFC 2231', () => {
    const parsed = parseContentType('multipart/related; boundary="a;b"; type="multipart/alternative"');
    assert.equal(parsed.type, 'multipart');
    assert.equal(parsed.subtype, 'related');
    assert.equal(parsed.params.boundary, 'a;b');
    assert.equal(parsed.params.type, 'multipart/alternative');
    const extended = parseContentType("text/plain; charset=utf-8; name*=UTF-8''%E6%8A%A5%E5%91%8A.txt");
    assert.equal(extended.params.name, '报告.txt');
    const continuation = parseContentType("application/octet-stream; name*0*=UTF-8''%E6%8A; name*1*=%A5%E5%91%8A; name*2=.pdf");
    assert.equal(continuation.params.name, '报告.pdf');
  });

  it('parses address lists: quoted commas, comments, groups, bare addresses', () => {
    assert.deepEqual(parseAddressList('"Doe, John" <john@example.com>'), [{ name: 'Doe, John', address: 'john@example.com' }]);
    assert.deepEqual(parseAddressList('a@example.com (Alice)'), [{ name: 'Alice', address: 'a@example.com' }]);
    assert.deepEqual(parseAddressList('Team: a@example.com, b@example.com;'), [
      { name: '', address: 'a@example.com' },
      { name: '', address: 'b@example.com' },
    ]);
    assert.deepEqual(parseAddressList('=?UTF-8?B?5byg5LiJ?= <zhang@example.com>'), [{ name: '张三', address: 'zhang@example.com' }]);
    assert.deepEqual(parseAddressList(''), []);
  });
});

describe('RFC 2047 encoded words', () => {
  it('decodes B and Q encodings, including adjacent words', () => {
    assert.equal(decodeWords('=?UTF-8?B?5L2g5aW9?='), '你好');
    assert.equal(decodeWords('=?utf-8?q?=E4=BD=A0=E5=A5=BD?='), '你好');
    assert.equal(decodeWords('=?UTF-8?B?5L2g?= =?UTF-8?B?5aW9?='), '你好');
    assert.equal(decodeWords('prefix =?UTF-8?B?5L2g?= suffix'), 'prefix 你 suffix');
    assert.equal(decodeWords('plain ascii'), 'plain ascii');
  });

  it('decodes encoded words in a legacy GBK charset', () => {
    const encoded = `=?gb2312?B?${GB18030_BYTES.toString('base64')}?=`;
    assert.equal(decodeWords(encoded), '中文');
  });

  it('encodes non-ASCII values as RFC 2047 UTF-8 B words', () => {
    assert.equal(encodeWords('plain'), 'plain');
    const encoded = encodeWords('大肥鱼');
    assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.equal(decodeWords(encoded), '大肥鱼');
    const long = encodeWords('很长的中文主题'.repeat(20));
    assert.ok(long.includes('\r\n '));
    assert.equal(decodeWords(long), '很长的中文主题'.repeat(20));
  });
});

describe('auto-reply and security signals', () => {
  function messageWith(headers) {
    return parseMessage(raw([...headers, 'From: attacker@evil.example', 'Subject: hi', '', 'body']));
  }

  it('detects Auto-Submitted / Precedence / List-Unsubscribe / no-reply senders', () => {
    const auto = parseMessage(raw([
      'From: noreply@service.example',
      'Auto-Submitted: auto-replied',
      'Precedence: bulk',
      'List-Unsubscribe: <https://example.com/u>',
      'Subject: out of office',
      '',
      'I am away',
    ]));
    assert.equal(auto.autoReply.isAutoReply, true);
    assert.equal(auto.autoReply.noReplyAddress, true);
    assert.equal(auto.autoReply.autoSubmitted, 'auto-replied');
    assert.equal(auto.autoReply.precedence, 'bulk');
    assert.equal(auto.autoReply.listUnsubscribe, true);
    assert.equal(auto.security.suspicious, true);
    assert.ok(auto.security.reasons.some((reason) => /auto-generated/.test(reason)));
  });

  it('flags failed Authentication-Results and Reply-To mismatch', () => {
    const message = messageWith([
      'From: Friend <friend@example.com>',
      'Reply-To: attacker@evil.example',
      'Authentication-Results: mx.example; spf=fail smtp.mailfrom=evil.example; dkim=pass; dmarc=fail',
      'Return-Path: <bounce@other.example>',
      'Received: from mx1',
      'Received: from mx2',
    ]);
    assert.equal(message.security.suspicious, true);
    assert.deepEqual(message.security.authenticationFailed.sort(), ['dmarc', 'spf']);
    assert.equal(message.security.authentication.dkim, 'pass');
    assert.equal(message.security.replyToMismatch, true);
    assert.equal(message.security.returnPathMismatch, true);
    assert.equal(message.security.receivedCount, 2);
    assert.ok(message.security.reasons.some((reason) => /Reply-To/.test(reason)));
  });

  it('does not flag a normal friend message as suspicious', () => {
    const message = parseMessage(raw([
      'From: Friend <friend@example.com>',
      'To: me@example.com',
      'Subject: lunch?',
      '',
      'see you at noon',
    ]));
    assert.equal(message.security.suspicious, false);
    assert.deepEqual(message.security.reasons, []);
  });
});

describe('resource limits (SPEC §0 T7)', () => {
  it('truncates oversized messages and flags them instead of throwing', () => {
    const big = parseMessage(raw([
      'From: big@example.com',
      'Subject: big',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'x'.repeat(2000),
    ]), { maxBytes: 200 });
    assert.equal(big.truncated, true);
    assert.equal(big.suspicious, true);
    assert.ok(big.text.length < 2000);
  });

  it('can throw a structured MimeError in strict mode', () => {
    assert.throws(
      () => parseMessage(Buffer.alloc(300, 0x41), { maxBytes: 100, strict: true }),
      (error) => error instanceof MimeError && error.code === 'too-large',
    );
  });

  it('caps multipart recursion depth', () => {
    let entity = ['Content-Type: text/plain', '', 'deep'];
    for (let depth = 0; depth < 30; depth += 1) {
      const boundary = `B${depth}`;
      entity = [`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...entity, `--${boundary}--`];
    }
    const message = parseMessage(raw(['From: deep@example.com', 'Content-Type: multipart/mixed; boundary="TOP"', '', '--TOP', ...entity, '--TOP--']), { maxDepth: 3 });
    assert.equal(message.truncated, true);
    assert.equal(message.text, null);
  });

  it('caps header length and header count', () => {
    const longValue = 'v'.repeat(200);
    const message = parseMessage(raw([
      'From: a@example.com',
      `X-Long: ${longValue}`,
      'Subject: ok',
      '',
      'body',
    ]), { maxHeaderLineBytes: 50 });
    assert.equal(message.truncated, true);
    assert.equal(message.headers['x-long'].length, 50);
    assert.equal(message.subject, 'ok');
  });

  it('never throws on malformed input', () => {
    for (const input of ['', 'not a mail at all', '\r\n\r\n', 'From:\r\nSubject:\r\n\r\n', ':::bad:::']) {
      assert.doesNotThrow(() => parseMessage(input));
    }
    assert.doesNotThrow(() => parseMessage(''));
    assert.throws(() => parseMessage(42), MimeError);
  });
});

describe('helpers', () => {
  it('decodes HTML entities and converts HTML to text', () => {
    assert.equal(decodeHtmlEntities('&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39; &#x4e2d; &nbsp;'), '<a> & "b" \'c\' 中 \u00a0');
    assert.equal(htmlToText('<div>Hello<br>World</div><ul><li>one</li><li>two</li></ul><script>alert(1)</script>'), 'Hello\nWorld\n\n• one\n\n• two');
    assert.equal(htmlToText('<p>&nbsp;Caf&eacute;</p>'), 'Café');
  });

  it('builds one-line snippets with an ellipsis', () => {
    assert.equal(makeSnippet('  hello \n\n world  '), 'hello world');
    const long = makeSnippet('a'.repeat(200), 20);
    assert.equal(long.length, 21);
    assert.ok(long.endsWith('…'));
    assert.equal(makeSnippet('short', 10), 'short');
  });

  it('parses dates and message ids defensively', () => {
    assert.equal(parseDateHeader('Wed, 12 Nov 2026 10:00:00 +0800').toISOString(), '2026-11-12T02:00:00.000Z');
    assert.equal(parseDateHeader('not a date'), null);
    assert.equal(parseDateHeader(''), null);
    assert.equal(normalizeMessageId('<a@b>'), 'a@b');
    assert.equal(messageIdKey('<A@B>'), 'a@b');
  });

  it('falls back to utf-8 for unknown charsets instead of throwing', () => {
    const decoded = decodeCharset(Buffer.from('你好', 'utf8'), 'x-unknown-charset');
    assert.equal(decoded, '你好');
  });
});
