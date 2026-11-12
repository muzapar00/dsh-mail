import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLetter, deriveSubject, escapeHtml, chineseDate } from '../../lib/letter.js';

const base = {
  subject: '[DeepSeek Harness] 项目进展',
  body: '第一段内容。\n\n- 条目一\n- 条目二',
  fromName: '大肥鱼deepseek',
  from: 'figaro1@qq.com',
  signature: '大肥鱼deepseek',
  salutation: '穆再排尔·穆合塔尔：',
  greeting: '见信好！',
  subjectPrefix: '[DeepSeek Harness] ',
  avatarSrc: 'cid:avatar@local',
  creditUrl: 'https://example.com/credit',
  date: '二〇二六年十一月十二日',
};

test('formatLetter keeps the established Chinese letter layout in text', () => {
  const { text, html } = formatLetter(base);
  const lines = text.split('\n');
  assert.equal(lines[0], '穆再排尔·穆合塔尔：');
  assert.match(lines[1], /^　　见信好！$/);
  assert.ok(text.includes('此致'));
  assert.ok(text.includes('敬礼！'));
  assert.ok(text.includes('大肥鱼deepseek'));
  assert.ok(text.includes('二〇二六年十一月十二日'));
  assert.ok(text.includes('· 条目一'));
  assert.ok(text.includes('<figaro1@qq.com>'));
  assert.match(html, /cid:avatar@local/);
  assert.match(html, /项目进展/);
  assert.match(html, /此致/);
});

test('formatLetter escapes untrusted body content for HTML', () => {
  const { html, text } = formatLetter({
    ...base,
    body: '<script>alert(1)</script> & 「引用」\n\nhttps://example.com/path?a=1&b=2',
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp; 「引用」'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(text.includes('<script>'));
});

test('formatLetter supports empty salutation/greeting and plain letterhead', () => {
  const { text, html } = formatLetter({ ...base, salutation: '', greeting: '', letterhead: false, quote: null });
  assert.ok(!text.startsWith('穆再排尔'));
  assert.ok(!text.includes('见信好'));
  assert.ok(!html.includes('background:#e4ecf8'));
});

test('formatLetter appends a quoted reply in both alternatives', () => {
  const { text, html } = formatLetter({ ...base, quote: { from: 'Alice <alice@example.com>', date: '2026-11-01 10:00', text: '原邮件内容 <b>粗体</b>' } });
  assert.ok(text.includes('---------- 原邮件 ----------'));
  assert.ok(text.includes('原邮件内容 <b>粗体</b>'));
  assert.ok(html.includes('原邮件内容 &lt;b&gt;粗体&lt;/b&gt;'));
  assert.ok(html.includes('Alice &lt;alice@example.com&gt;'));
});

test('deriveSubject falls back and truncates', () => {
  assert.equal(deriveSubject('', '大肥鱼deepseek'), '一封来自大肥鱼deepseek的信');
  assert.equal(deriveSubject('你好。'), '你好');
  const truncated = deriveSubject('这是一个非常非常非常非常非常非常非常非常长的主题句子啊。');
  assert.ok(truncated.endsWith('…'));
  assert.equal([...truncated].length, 27);
});

test('escapeHtml prevents tag injection', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`'"&<>`), '&#39;&quot;&amp;&lt;&gt;');
});

test('chineseDate renders Chinese numerals', () => {
  assert.match(chineseDate(new Date('2026-11-02T00:00:00Z'), 'UTC'), /^二〇二六年十一月[一二]日$/);
});
