import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, incomingMessageId, outgoingMessageId } from '../../lib/store.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mailbox-store-'));
  return { dir, store: await createStore(dir) };
}

function messageBody(id, overrides = {}) {
  return {
    id,
    direction: 'in',
    messageId: `<${id}@example.com>`,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ name: '', address: 'bot@example.com' }],
    subject: '测试邮件',
    date: new Date().toISOString(),
    text: '正文内容',
    html: '<p>正文内容</p>',
    snippet: '正文内容',
    attachments: [],
    ...overrides,
  };
}

test('store initializes the data directory with files and tight modes', async () => {
  const { dir, store } = await freshStore();
  const info = await stat(dir);
  assert.ok((info.mode & 0o777) === 0o700);
  const index = await store.loadIndex();
  assert.deepEqual(index.messages, []);
  const friends = await store.loadFriends();
  assert.deepEqual(friends.friends, []);
  const secrets = await store.loadSecrets();
  assert.equal(secrets.smtp.authCode, '');
});

test('config and secrets round-trip in separate files with 0600 permissions', async () => {
  const { dir, store } = await freshStore();
  await store.saveConfig({ enabled: true, mailbox: { address: 'bot@example.com' } });
  await store.saveSecrets({ smtp: { authCode: 'SECRET' }, imap: { authCode: 'SECRET2' } });
  assert.deepEqual((await store.loadConfig()).mailbox.address, 'bot@example.com');
  assert.equal((await store.loadSecrets()).smtp.authCode, 'SECRET');
  const configText = await readFile(join(dir, 'config.json'), 'utf8');
  assert.ok(!configText.includes('SECRET'));
  for (const file of ['config.json', 'secrets.json']) {
    const info = await stat(join(dir, file));
    assert.equal(info.mode & 0o777, 0o600, `${file} must be 0600`);
  }
});

test('messages round-trip and reject unsafe ids', async () => {
  const { store } = await freshStore();
  const id = incomingMessageId('<a@b.c>', 7, '2026-01-01');
  await store.writeMessage(messageBody(id));
  const loaded = await store.readMessage(id);
  assert.equal(loaded.subject, '测试邮件');
  await assert.rejects(() => store.writeMessage({ id: '../evil', text: 'x' }), /safe id|refusing/);
  await assert.rejects(() => store.readMessage('../evil'), /invalid message id/);
  await store.deleteMessage(id);
  assert.equal(await store.readMessage(id), null);
});

test('appendIndex updates, sorts newest-first, trims and reports evictions', async () => {
  const { store } = await freshStore();
  const ids = [];
  for (let day = 1; day <= 4; day += 1) {
    const id = `in-msg-000${day}`;
    ids.push(id);
    await store.writeMessage(messageBody(id));
    await store.appendIndex({
      id,
      folder: 'inbox',
      direction: 'in',
      messageId: `<${id}@example.com>`,
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      subject: `第 ${day} 封`,
      date: `2026-01-0${day}T00:00:00.000Z`,
      snippet: '正文内容',
      unread: true,
    }, { maxMessages: 3 });
  }
  const index = await store.loadIndex();
  assert.deepEqual(index.messages.map((row) => row.id), ['in-msg-0004', 'in-msg-0003', 'in-msg-0002']);
  const updated = await store.appendIndex({ ...index.messages[0], unread: false }, { maxMessages: 3 });
  assert.equal(updated.index.messages.find((row) => row.id === 'in-msg-0004').unread, false);
  assert.equal(updated.index.messages.length, 3);
});

test('corrupt JSON is quarantined and defaults are returned', async () => {
  const { dir, store } = await freshStore();
  await writeFile(join(dir, 'friends.json'), '{ this is not json');
  const warnings = [];
  const withWarn = await createStore(dir, { onWarning: (message) => warnings.push(message) });
  const friends = await withWarn.loadFriends();
  assert.deepEqual(friends.friends, []);
  assert.equal(warnings.length, 1);
  const files = await readdir(dir);
  assert.ok(files.some((name) => name.startsWith('friends.json.corrupt-')));
});

test('notifications queue and friends document round-trip', async () => {
  const { store } = await freshStore();
  await store.saveFriends({
    version: 1,
    friends: [{ address: 'alice@example.com', name: 'Alice', addedBy: 'user', addedAt: '2026-01-01T00:00:00.000Z' }],
    pending: [{ address: 'bob@example.com', requestedAt: '2026-01-02T00:00:00.000Z' }],
    aiAddLog: [],
  });
  const friends = await store.loadFriends();
  assert.equal(friends.friends.length, 1);
  assert.equal(friends.pending.length, 1);

  await store.saveNotifications({ version: 1, queue: [{ id: 'n1', createdAt: 'x', text: '您有新的来信' }] });
  const notifications = await store.loadNotifications();
  assert.equal(notifications.queue.length, 1);
  assert.match(notifications.queue[0].text, /新的来信/);
});

test('clearData removes stored content and keeps the store usable', async () => {
  const { dir, store } = await freshStore();
  const id = outgoingMessageId();
  await store.writeMessage(messageBody(id, { direction: 'out' }));
  await store.appendIndex({ id, folder: 'sent', direction: 'out', date: '2026-01-01T00:00:00.000Z', subject: 'x' });
  await store.saveSecrets({ smtp: { authCode: 'SECRET' } });
  await store.clearData();
  assert.equal(await store.readMessage(id), null);
  assert.deepEqual((await store.loadIndex()).messages, []);
  // Credentials survive a data wipe: clearing mail must not log the account out.
  assert.equal((await store.loadSecrets()).smtp.authCode, 'SECRET');
  assert.ok(dir.length > 0);
});
