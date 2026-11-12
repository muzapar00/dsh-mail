import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  normalizeAttachment,
  normalizeAttachments,
  sanitizeFilename,
  guessContentType,
  isBlockedAttachment,
  isSecretLikeName,
} from '../../lib/core/attachments.js';
import { loadToolAttachments } from '../../lib/tools.js';
import { validateConfig } from '../../lib/config.js';

function bytes(text) {
  return Buffer.from(text, 'utf8');
}

test('sanitizeFilename keeps the last segment and strips control characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\me\\报告.pdf'), '报告.pdf');
  assert.equal(sanitizeFilename('a\u202eb.txt'), 'ab.txt');
  assert.equal(sanitizeFilename(''), '');
  assert.equal(sanitizeFilename('..'), '');
  assert.ok([...sanitizeFilename('x'.repeat(300))].length <= 120);
});

test('content type guessing and executable/secret detection', () => {
  assert.equal(guessContentType('报告.pdf'), 'application/pdf');
  assert.equal(guessContentType('photo.JPG'), 'image/jpeg');
  assert.equal(guessContentType('unknown.bin'), 'application/octet-stream');
  assert.equal(isBlockedAttachment('setup.exe'), true);
  assert.equal(isBlockedAttachment('script.PS1'), true);
  assert.equal(isBlockedAttachment('notes.md'), false);
  assert.equal(isSecretLikeName('id_rsa'), true);
  assert.equal(isSecretLikeName('/x/secrets.json'), true);
  assert.equal(isSecretLikeName('auth-code.txt'), true);
  assert.equal(isSecretLikeName('report.pdf'), false);
});

test('normalizeAttachment validates content, size, type and name', () => {
  const good = normalizeAttachment({ filename: '报告.pdf', content: bytes('hello') });
  assert.equal(good.ok, true);
  assert.equal(good.attachment.filename, '报告.pdf');
  assert.equal(good.attachment.contentType, 'application/pdf');
  assert.equal(good.attachment.size, 5);

  assert.equal(normalizeAttachment({ filename: 'x.exe', content: bytes('x') }).ok, false);
  assert.equal(normalizeAttachment({ filename: 'id_rsa', content: bytes('x') }).ok, false);
  assert.equal(normalizeAttachment({ filename: 'x.txt', content: Buffer.alloc(0) }).ok, false);
  assert.equal(normalizeAttachment({ filename: 'x.txt', content: Buffer.alloc(MAX_FILE_BYTES + 1) }).ok, false);
  assert.equal(normalizeAttachment({ filename: '../x.txt', content: bytes('x') }).attachment.filename, 'x.txt');
  assert.equal(normalizeAttachment({ filename: '', content: bytes('x') }).ok, false);
});

test('normalizeAttachments enforces count and total-size caps', () => {
  const one = { filename: 'a.txt', content: bytes('a') };
  assert.equal(normalizeAttachments([one]).ok, true);
  assert.equal(normalizeAttachments(new Array(MAX_ATTACHMENTS + 1).fill(one)).ok, false);
  const chunk = bytes('x'.repeat(1024 * 1024));
  const big = new Array(Math.floor(MAX_TOTAL_BYTES / chunk.length) + 1).fill(null).map((_, index) => ({
    filename: `f${index}.bin`,
    content: chunk,
  }));
  assert.equal(normalizeAttachments(big).ok, false);
  assert.equal(normalizeAttachments(undefined).attachments.length, 0);
});

test('loadToolAttachments confines model paths to the session workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mailbox-attach-'));
  const dataDir = join(root, 'mailbox-data');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(workspace, '.hidden'), { recursive: true });
  await writeFile(join(workspace, '报告.pdf'), 'pdf-bytes');
  await writeFile(join(workspace, 'notes.txt'), 'notes');
  await writeFile(join(workspace, '.env'), 'SECRET=1');
  await writeFile(join(workspace, 'run.exe'), 'MZ');
  await writeFile(join(workspace, 'id_rsa'), 'key');
  await writeFile(join(root, 'outside.txt'), 'outside');
  await writeFile(join(dataDir, 'secrets.json'), '{"authCode":"x"}');
  const config = validateConfig({
    owner: { address: 'owner@example.com' },
    smtp: { host: 'smtp.example.com', user: 'bot@example.com' },
    imap: { host: 'imap.example.com', user: 'bot@example.com' },
  });
  const exec = { agent: { session: { header: { cwd: workspace } } } };

  const loaded = await loadToolAttachments(['报告.pdf', join(workspace, 'notes.txt')], exec, config, dataDir);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].filename, '报告.pdf');
  assert.equal(loaded[1].content.toString('utf8'), 'notes');

  await assert.rejects(() => loadToolAttachments(['../outside.txt'], exec, config, dataDir), /只允许/);
  await assert.rejects(() => loadToolAttachments(['.env'], exec, config, dataDir), /隐藏文件/);
  await assert.rejects(() => loadToolAttachments(['.hidden/x.txt'], exec, config, dataDir), /隐藏文件/);
  await assert.rejects(() => loadToolAttachments(['run.exe'], exec, config, dataDir), /可执行/);
  await assert.rejects(() => loadToolAttachments(['id_rsa'], exec, config, dataDir), /密钥/);
  await assert.rejects(() => loadToolAttachments([join(dataDir, 'secrets.json')], exec, config, dataDir), /工作区|允许目录|邮箱数据/);
  await assert.rejects(() => loadToolAttachments(new Array(9).fill('notes.txt'), exec, config, dataDir), /最多/);
  // Without a caller workspace, paths are refused outright.
  await assert.rejects(() => loadToolAttachments(['notes.txt'], {}, config, dataDir), /工作区/);
});
