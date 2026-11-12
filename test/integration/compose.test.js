import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLetter, renderMarkdown, renderPlain, FORMATS } from '../../lib/compose.js';

test('markdown rendering supports headings, lists, emphasis, links and code', () => {
  const letter = composeLetter({
    format: 'markdown',
    content: [
      '# 周报',
      '',
      '这是一段 **重点** 和 *斜体*，还有 `code` 与 [链接](https://example.com)。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```',
      'const a = 1;',
      '```',
    ].join('\n'),
  });
  assert.equal(letter.format, 'markdown');
  assert.match(letter.text, /周报/);
  assert.match(letter.text, /第一项/);
  assert.match(letter.text, /const a = 1;/);
  assert.match(letter.html, /<h1 style=/);
  assert.match(letter.html, /<strong>重点<\/strong>/);
  assert.match(letter.html, /<em>斜体<\/em>/);
  assert.match(letter.html, /<a href="https:\/\/example\.com\/?" rel="noopener noreferrer">/);
  assert.match(letter.html, /<ul style=/);
  assert.match(letter.html, /<pre style=/);
});

test('no salutation, signature, date or letterhead is fabricated', () => {
  const letter = composeLetter({ format: 'markdown', content: '就一句话。' });
  assert.equal(letter.text, '就一句话。');
  for (const phrase of ['此致', '敬礼', '大肥鱼deepseek', '费加罗', '二〇二六年']) {
    assert.ok(!letter.text.includes(phrase), `letter must not contain ${phrase}`);
    assert.ok(!letter.html.includes(phrase), `html must not contain ${phrase}`);
  }
});

test('remote images in markdown are not rendered (anti-tracking)', () => {
  const letter = composeLetter({ format: 'markdown', content: '看这个 ![图](https://tracker.example/pixel.gif)' });
  assert.ok(!letter.html.includes('<img'), 'markdown images must not become <img>');
});

test('unsafe URLs never become links', () => {
  const markdown = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!markdown.html.includes('<a '), 'javascript: URL must not become a link');
  const plain = renderPlain('data:text/html,<script>alert(1)</script>');
  assert.ok(!plain.html.includes('<script>'));
});

test('html format is sanitized and keeps a text alternative', () => {
  const letter = composeLetter({
    format: 'html',
    content: '<p>你好</p><script>alert(1)</script><a href="https://example.com" onclick="x()">链接</a><form><input type="password"></form>',
  });
  assert.equal(letter.format, 'html');
  assert.match(letter.text, /你好/);
  assert.match(letter.text, /链接/);
  assert.ok(!letter.html.includes('<script'), 'script must be removed');
  assert.ok(!letter.html.includes('onclick'), 'event handlers must be removed');
  assert.ok(!letter.html.includes('<form'), 'forms must be removed');
});

test('plain text format keeps line breaks and avoids markdown rendering', () => {
  const letter = composeLetter({ format: 'text', content: '第一行\n第二行\n\n新段落 *不是斜体*' });
  assert.equal(letter.format, 'text');
  assert.match(letter.text, /第一行\n第二行/);
  assert.match(letter.html, /<br>/);
  assert.equal(letter.html.includes('<em>'), false);
});

test('legacy letterhead avatar is opt-in and becomes a cid image', () => {
  const letter = composeLetter({ format: 'markdown', content: '正文', inlineImage: { cid: 'avatar@local', alt: '费加罗' } });
  assert.match(letter.html, /cid:avatar@local/);
  const plain = composeLetter({ format: 'text', content: '正文' });
  assert.equal(plain.html.includes('cid:'), false);
});

test('supported formats are exactly markdown/text/html', () => {
  assert.deepEqual(FORMATS, ['markdown', 'text', 'html']);
  const fallback = composeLetter({ format: 'bogus', content: '# 标题' });
  assert.equal(fallback.format, 'markdown');
});
