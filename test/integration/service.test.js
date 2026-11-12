import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../lib/store.js';
import { createMailboxService } from '../../lib/service.js';
import { apiError } from '../../lib/server.js';

/** Fake mail engine recording sends and accepting tests. */
function fakeMail() {
  const sent = [];
  return {
    sent,
    async sendMail(options) {
      sent.push(options);
      return { messageId: `<fake-${sent.length}@example.com>` };
    },
    async verifySmtp() {
      return { ok: true };
    },
    async openImap() {
      return {
        async select() {
          return { uidValidity: 7, exists: 3, uidNext: 10 };
        },
        async logout() {},
      };
    },
    sanitizeHtml(html) {
      return String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
    },
    parseMessage() {
      throw new Error('not used in these tests');
    },
  };
}

/** Fake host adapter: session list + delivery capture. */
function fakeHost() {
  const delivered = [];
  return {
    delivered,
    async listSessions() {
      return [
        { sessionId: 'session-old', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 'session-new', title: 'new', updatedAt: '2026-02-01T00:00:00.000Z' },
        { sessionId: 'child', title: 'child', updatedAt: '2026-03-01T00:00:00.000Z', isSubagent: true },
      ];
    },
    async deliver(sessionId, text, meta) {
      delivered.push({ sessionId, text, meta });
      return true;
    },
  };
}

async function freshService(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mailbox-service-'));
  const store = await createStore(dir, { onWarning: () => {} });
  if (seed !== undefined) await store.saveSeed(seed);
  const mail = fakeMail();
  const host = fakeHost();
  const applied = [];
  const service = createMailboxService({
    store,
    host,
    mail,
    getVersion: () => '0.1.0-test',
    onConfigApplied: async (config) => applied.push(config.enabled),
    loadAvatar: async () => ({ cid: 'avatar@test', filename: 'avatar.png', contentType: 'image/png', base64: 'AAAA' }),
    log: () => {},
  });
  await service.init();
  return { dir, store, mail, host, service, applied };
}

const goodSeed = {
  config: {
    enabled: true,
    mailbox: { address: 'figaro1@qq.com', displayName: '大肥鱼deepseek', signature: '大肥鱼deepseek', salutation: '穆再排尔·穆合塔尔：', greeting: '见信好！', subjectPrefix: '[DeepSeek Harness] ' },
    owner: { address: 'mzpr00@163.com' },
    smtp: { host: 'smtp.qq.com', port: 465, security: 'tls', user: 'figaro1@qq.com' },
    imap: { enabled: true, host: 'imap.qq.com', port: 993, security: 'tls', user: 'figaro1@qq.com', pollIntervalSeconds: 120 },
    notify: { enabled: true, target: 'latest', strangerMail: 'notify', batchSeconds: 0 },
  },
  secrets: { smtp: { authCode: 'SECRET-SMTP' }, imap: { authCode: 'SECRET-IMAP' } },
};

test('init migrates seed credentials into secrets and never persists them in config.json', async () => {
  const { dir, service } = await freshService(goodSeed);
  const config = service.getConfig();
  assert.equal(config.owner.address, 'mzpr00@163.com');
  assert.equal(config.mailbox.address, 'figaro1@qq.com');
  assert.equal(service.getSecrets().smtp.authCode, 'SECRET-SMTP');
  const configText = await readFile(join(dir, 'config.json'), 'utf8');
  assert.ok(!configText.includes('SECRET-SMTP'));
  assert.ok(!configText.includes('SECRET-IMAP'));
  const masked = await service.maskedConfig();
  assert.ok(!JSON.stringify(masked).includes('SECRET-SMTP'));
  assert.equal(masked.secrets.smtp.configured, true);
});

test('state surfaces counts and masked config without secrets', async () => {
  const { service, host } = await freshService(goodSeed);
  const state = await service.state();
  assert.equal(state.enabled, true);
  assert.equal(state.counts.unread, 0);
  assert.equal(state.connections.smtp.configured, true);
  assert.ok(Array.isArray(state.presets));
  assert.ok(!JSON.stringify(state).includes('SECRET-SMTP'));
  assert.ok(!JSON.stringify(state).includes('SECRET-IMAP'));
  const sessions = await service.sessions();
  assert.equal(sessions.sessions.length, 3);
  assert.ok(host.delivered.length === 0);
});

test('saveConfig merges a patch, validates, and stores new secrets separately', async () => {
  const { dir, service, applied } = await freshService(goodSeed);
  const result = await service.saveConfig({
    patch: { notify: { target: 'all' }, prompt: { language: 'en' } },
    secrets: { smtpAuthCode: 'NEW-SMTP-CODE' },
  });
  assert.equal(result.saved, true);
  assert.equal(service.getConfig().notify.target, 'all');
  assert.equal(service.getConfig().prompt.language, 'en');
  assert.equal(service.getSecrets().smtp.authCode, 'NEW-SMTP-CODE');
  assert.deepEqual(applied, [true]);
  const configText = await readFile(join(dir, 'config.json'), 'utf8');
  assert.ok(!configText.includes('NEW-SMTP-CODE'));
  const secretsText = await readFile(join(dir, 'secrets.json'), 'utf8');
  assert.ok(secretsText.includes('NEW-SMTP-CODE'));
});

test('saveConfig rejects invalid patches with field issues', async () => {
  const { service } = await freshService(goodSeed);
  await assert.rejects(
    () => service.saveConfig({ patch: { smtp: { port: 999999 }, owner: { address: 'bad' } } }),
    (error) => error.code === 'input-invalid' && Array.isArray(error.issues) && error.issues.length >= 2,
  );
});

test('sendMail renders author-formatted markdown, admits only owner/friends, and stores a sent row', async () => {
  const { service, mail } = await freshService(goodSeed);
  const receipt = await service.sendMail({ content: '第一段。\n\n- 要点一', actor: 'model' });
  assert.equal(receipt.to, 'mzpr00@163.com');
  assert.match(receipt.subject, /\[DeepSeek Harness\]/);
  assert.equal(mail.sent.length, 1);
  const wire = mail.sent[0];
  assert.equal(wire.to, 'mzpr00@163.com');
  assert.equal(wire.from, 'figaro1@qq.com');
  assert.match(wire.text, /第一段/);
  assert.match(wire.text, /要点一/);
  assert.match(wire.html, /<ul style=/);
  assert.match(wire.html, /<li style=/);
  assert.ok(!wire.text.includes('此致'), 'the plugin must not add a letter template');
  assert.equal(wire.text.includes('大肥鱼deepseek'), false);
  assert.equal(wire.pass, 'SECRET-SMTP');
  assert.ok(receipt.messageId.startsWith('<fake-') && receipt.messageId.endsWith('@example.com>'));

  const list = await service.listMessages({ folder: 'sent' });
  assert.equal(list.total, 1);
  assert.equal(list.messages[0].folder, 'sent');
  const body = await service.getMessage({ id: list.messages[0].id });
  assert.match(body.message.text, /第一段/);
  assert.equal(body.message.format, 'markdown');
});

test('sendMail carries attachments, records metadata, and rejects dangerous files', async () => {
  const { service, mail } = await freshService(goodSeed);
  const receipt = await service.sendMail({
    content: '正文见附件。',
    actor: 'model',
    attachments: [
      { filename: '报告.pdf', contentType: 'application/pdf', content: Buffer.from('pdf-bytes') },
      { filename: '照片.png', content: Buffer.from('png-bytes') },
    ],
  });
  assert.equal(receipt.attachments.length, 2);
  assert.equal(mail.sent.length, 1);
  const wire = mail.sent[0];
  assert.equal(wire.attachments.length, 2);
  assert.equal(wire.attachments[0].filename, '报告.pdf');
  assert.equal(wire.attachments[0].contentType, 'application/pdf');
  assert.equal(wire.attachments[0].content.toString('utf8'), 'pdf-bytes');
  assert.equal(wire.attachments[1].contentType, 'image/png');

  const listed = await service.listMessages({ folder: 'sent' });
  assert.equal(listed.messages[0].hasAttachments, true);
  const stored = await service.getMessage({ id: listed.messages[0].id });
  assert.deepEqual(stored.message.attachments, [
    { filename: '报告.pdf', contentType: 'application/pdf', size: 9 },
    { filename: '照片.png', contentType: 'image/png', size: 9 },
  ]);

  await assert.rejects(
    () => service.sendMail({ content: 'x', actor: 'model', attachments: [{ filename: 'setup.exe', content: Buffer.from('MZ') }] }),
    (error) => error.code === 'input-invalid',
  );
  await assert.rejects(
    () => service.sendMail({ content: 'x', actor: 'model', attachments: [{ filename: 'id_rsa', content: Buffer.from('key') }] }),
    (error) => error.code === 'input-invalid',
  );
  await assert.rejects(
    () => service.sendMail({ content: 'x', actor: 'model', attachments: [{ filename: 'big.zip', content: Buffer.alloc(9 * 1024 * 1024) }] }),
    (error) => error.code === 'input-invalid',
  );
});

test('sendMail honours the author-chosen format and optional legacy letterhead', async () => {
  const { service, mail } = await freshService(goodSeed);
  const markdown = await service.sendMail({ content: '# 标题\n\n**重点** 与 [链接](https://example.com)', actor: 'model' });
  assert.equal(markdown.format, 'markdown');
  assert.match(mail.sent.at(-1).html, /<h1 style=/);
  assert.match(mail.sent.at(-1).html, /<strong>重点<\/strong>/);

  const plain = await service.sendMail({ content: '第一行\n第二行', actor: 'model', format: 'text' });
  assert.equal(plain.format, 'text');
  assert.ok(!mail.sent.at(-1).html.includes('<h1'));
  assert.match(mail.sent.at(-1).html, /<br>/);

  const html = await service.sendMail({ content: '<p>你好</p><script>alert(1)</script>', actor: 'model', format: 'html' });
  assert.equal(html.format, 'html');
  assert.ok(!mail.sent.at(-1).html.includes('<script'));
  assert.match(mail.sent.at(-1).text, /你好/);

  // Legacy stationery avatar stays strictly opt-in.
  await service.saveConfig({ patch: { mailbox: { letterhead: true } } });
  await service.sendMail({ content: '带信纸头像的正文', actor: 'model' });
  const withAvatar = mail.sent.at(-1);
  assert.ok(withAvatar.avatar !== undefined, 'letterhead=true must attach the inline avatar');
  assert.match(withAvatar.html, /cid:/);
});

test('sendMail refuses strangers and rate limits once the hourly budget is spent', async () => {
  const { service, mail } = await freshService(goodSeed);
  await assert.rejects(
    () => service.sendMail({ to: 'stranger@evil.test', content: 'hi', actor: 'model' }),
    (error) => error.code === 'forbidden',
  );
  // Budget is 20/hour by default in the seed; lower it through config.save.
  await service.saveConfig({ patch: { security: { maxSendsPerHour: 1 } } });
  await service.sendMail({ content: '第一封', actor: 'model' });
  await assert.rejects(
    () => service.sendMail({ content: '第二封', actor: 'model' }),
    (error) => error.code === 'rate-limited',
  );
  assert.equal(mail.sent.length, 1);
});

test('replyMail sets thread headers, quotes the parent, and refuses auto mail', async () => {
  const { service, store, mail } = await freshService(goodSeed);
  await service.addFriend({ address: 'alice@example.com', name: 'Alice', actor: 'user' });
  const parentId = 'in-abcdef0123456789abcd';
  await store.writeMessage({
    id: parentId,
    direction: 'in',
    messageId: '<parent@example.com>',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'figaro1@qq.com' }],
    subject: '[DeepSeek Harness] 项目进度',
    date: '2026-11-01T10:00:00.000Z',
    text: '上一封信的正文。',
    html: '<p>上一封信的正文。</p>',
    snippet: '上一封信的正文。',
    attachments: [],
    headers: { messageId: '<parent@example.com>', references: ['<root@example.com>'] },
    friend: true,
    automatic: false,
  });
  await store.appendIndex({ id: parentId, folder: 'inbox', direction: 'in', fromAddress: 'alice@example.com', fromName: 'Alice', subject: '[DeepSeek Harness] 项目进度', date: '2026-11-01T10:00:00.000Z', unread: true, friend: true, messageId: '<parent@example.com>' });

  const receipt = await service.replyMail({ id: parentId, content: '收到，稍后处理。' });
  assert.equal(receipt.to, 'alice@example.com');
  assert.match(receipt.subject, /^\[DeepSeek Harness\] Re: 项目进度/);
  const wire = mail.sent[0];
  assert.equal(wire.inReplyTo, '<parent@example.com>');
  assert.deepEqual(wire.references, ['<root@example.com>', '<parent@example.com>']);
  assert.match(wire.text, /收到，稍后处理。/);
  assert.ok(!wire.text.includes('原邮件'), 'the plugin must not quote the parent automatically');

  const autoId = 'in-11111111111111111111';
  await store.writeMessage({
    id: autoId,
    direction: 'in',
    messageId: '<auto@example.com>',
    from: { address: 'alice@example.com' },
    subject: '自动回复',
    date: '2026-11-01T10:00:00.000Z',
    text: '我在休假',
    html: '',
    snippet: '我在休假',
    attachments: [],
    headers: {},
    automatic: true,
  });
  await store.appendIndex({ id: autoId, folder: 'inbox', direction: 'in', fromAddress: 'alice@example.com', subject: '自动回复', date: '2026-11-01T10:00:00.000Z', automatic: true });
  await assert.rejects(
    () => service.replyMail({ id: autoId, content: '回复自动邮件' }),
    (error) => error.code === 'forbidden',
  );
});

test('friend whitelist honours policy auto/ask/manual and audits AI additions', async () => {
  const { service } = await freshService(goodSeed);
  // user add
  const userAdd = await service.addFriend({ address: 'friend1@example.com', name: 'Friend 1', actor: 'user' });
  assert.equal(userAdd.status, 'added');
  // duplicate
  assert.equal((await service.addFriend({ address: 'FRIEND1@example.com', actor: 'user' })).status, 'already');
  // owner/self addresses are skipped
  assert.equal((await service.addFriend({ address: 'mzpr00@163.com', actor: 'user' })).status, 'skipped');
  // auto policy: AI adds directly
  const aiAdd = await service.addFriend({ address: 'friend2@example.com', actor: 'ai', reason: '真实来信' });
  assert.equal(aiAdd.status, 'added');
  let doc = await service.listFriends();
  assert.equal(doc.friends.length, 2);
  assert.equal(doc.aiAddLog.length, 1);
  // ask policy: pending request
  await service.saveConfig({ patch: { friends: { policy: 'ask' } } });
  const pending = await service.addFriend({ address: 'friend3@example.com', actor: 'ai', reason: '可能认识' });
  assert.equal(pending.status, 'pending');
  doc = await service.listFriends();
  assert.equal(doc.pending.length, 1);
  // manual policy: AI refused
  await service.saveConfig({ patch: { friends: { policy: 'manual' } } });
  await assert.rejects(
    () => service.addFriend({ address: 'friend4@example.com', actor: 'ai' }),
    (error) => error.code === 'forbidden',
  );
  // approve the pending request
  const approved = await service.approveFriend({ address: 'friend3@example.com' });
  assert.equal(approved.approved, true);
  doc = await service.listFriends();
  assert.equal(doc.friends.length, 3);
  assert.equal(doc.pending.length, 0);
});

test('dispatch gates operations behind the master switch but keeps config editable', async () => {
  const { service } = await freshService(goodSeed);
  const off = await service.dispatch('config.save', { patch: { enabled: false } });
  assert.equal(off.config.enabled, false);
  await assert.rejects(
    () => service.dispatch('mail.send', { to: 'mzpr00@163.com', content: 'hi' }, { enabled: false }),
    (error) => error.code === 'forbidden',
  );
  const state = await service.dispatch('state', {}, { enabled: false });
  assert.equal(state.enabled, false);
  const health = await service.dispatch('health', {}, { enabled: false });
  assert.equal(health.ok, true);
});

test('test.smtp / test.imap accept transient form overrides', async () => {
  const { service } = await freshService(goodSeed);
  const smtp = await service.testSmtp({ host: 'smtp.example.com', user: 'bot@example.com', authCode: 'FORM-CODE' });
  assert.equal(smtp.ok, true);
  assert.equal(smtp.host, 'smtp.example.com');
  const imap = await service.testImap({});
  assert.equal(imap.ok, true);
  assert.equal(imap.uidValidity, 7);
});

test('markRead / deleteMessage / clearData behave', async () => {
  const { service, store } = await freshService(goodSeed);
  await service.sendMail({ content: '正文', actor: 'model' });
  const list = await service.listMessages({ folder: 'sent' });
  const id = list.messages[0].id;
  const read = await service.markRead({ id, read: true });
  assert.equal(read.read, true);
  await service.deleteMessage({ id });
  assert.equal((await service.listMessages({ folder: 'sent' })).total, 0);
  await service.clearData({});
  const after = await service.state();
  assert.equal(after.counts.sent, 0);
  assert.equal((await store.loadIndex()).messages.length, 0);
});

test('diagnostics never include credentials', async () => {
  const { service } = await freshService(goodSeed);
  const diagnostics = await service.diagnostics();
  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes('SECRET-SMTP'));
  assert.ok(!serialized.includes('SECRET-IMAP'));
  assert.equal(diagnostics.version, '0.1.0-test');
  assert.ok(Array.isArray(diagnostics.tools) && diagnostics.tools.includes('send_email'));
});
