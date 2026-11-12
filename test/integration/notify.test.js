import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../lib/store.js';
import { createNotifier } from '../../lib/notify.js';
import { validateConfig } from '../../lib/config.js';
import { buildMessage } from '../../lib/mail/smtp.js';

function makeConfig(patch = {}) {
  return validateConfig({
    owner: { address: 'owner@example.com' },
    smtp: { host: 'smtp.example.com', user: 'bot@example.com' },
    imap: { host: 'imap.example.com', user: 'bot@example.com' },
    notify: { enabled: true, target: 'dedicated', batchSeconds: 0, ...patch },
  });
}

function makeHost(overrides = {}) {
  const delivered = [];
  const created = [];
  let sessions = overrides.sessions ?? [
    { sessionId: 'session-old-1234', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
    { sessionId: 'session-new-1234', title: 'new', updatedAt: '2026-02-01T00:00:00.000Z' },
    { sessionId: 'session-child-12', title: 'child', updatedAt: '2026-03-01T00:00:00.000Z', isSubagent: true },
  ];
  return {
    delivered,
    created,
    setSessions(next) {
      sessions = next;
    },
    async listSessions() {
      return sessions;
    },
    async isLive(sessionId) {
      if (overrides.live === false) return false;
      return sessionId === 'session-mailbox-9999' || sessions.some((row) => row.sessionId === sessionId);
    },
    async createSession() {
      if (overrides.createSession === false) return '';
      created.push('session-mailbox-9999');
      return 'session-mailbox-9999';
    },
    async deliver(sessionId, text, meta) {
      delivered.push({ sessionId, text, meta });
      return overrides.deliver === false ? false : true;
    },
  };
}

async function freshNotifier({ config, host }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mailbox-notify-'));
  const store = await createStore(dir);
  const applied = [];
  const notifier = createNotifier({
    store,
    getConfig: () => config,
    getFriends: async () => ({ friends: [], pending: [] }),
    host,
    onDedicatedSession: async (sessionId) => applied.push(sessionId),
    log: () => {},
  });
  return { store, notifier, applied };
}

function row(id, overrides = {}) {
  return {
    id,
    fromName: 'Alice',
    fromAddress: 'alice@example.com',
    subject: '测试来信',
    date: '2026-11-12T10:00:00.000Z',
    snippet: '这是一封测试信的摘要。',
    friend: false,
    suspicious: false,
    notify: true,
    folder: 'inbox',
    ...overrides,
  };
}

test('dedicated target creates one mailbox conversation and never touches the latest chat', async () => {
  const host = makeHost();
  const { notifier, applied } = await freshNotifier({ config: makeConfig(), host });
  const result = await notifier.flushRows([row('in-1')], { kind: 'new-mail' });
  assert.equal(result.delivered, true);
  assert.equal(host.created.length, 1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0], 'session-mailbox-9999');
  assert.equal(host.delivered.length, 1);
  assert.equal(host.delivered[0].sessionId, 'session-mailbox-9999');
  assert.match(host.delivered[0].text, /您有新的来信，请查收。/);
  assert.ok(!host.delivered[0].text.includes('<script') && !host.delivered[0].text.includes('<div'));
});

test('dedicated target reuses a stored live mailbox session', async () => {
  const host = makeHost();
  const config = makeConfig({ dedicatedSessionId: 'session-mailbox-9999' });
  const { notifier, applied } = await freshNotifier({ config, host });
  const result = await notifier.flushRows([row('in-2')], { kind: 'new-mail' });
  assert.equal(result.delivered, true);
  assert.equal(host.created.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(host.delivered[0].sessionId, 'session-mailbox-9999');
});

test('dedicated target queues when session creation is unavailable', async () => {
  const host = makeHost({ createSession: false, deliver: false });
  const config = makeConfig({ dedicatedSessionId: '' });
  const { notifier, store } = await freshNotifier({ config, host });
  const result = await notifier.flushRows([row('in-3')], { kind: 'new-mail' });
  assert.equal(result.delivered, false);
  const queued = await store.loadNotifications();
  assert.equal(queued.queue.length, 1);
  assert.match(queued.queue[0].text, /您有新的来信/);
});

test('latest and all targets keep their documented semantics', async () => {
  const host = makeHost();
  const latest = await freshNotifier({ config: makeConfig({ target: 'latest' }), host });
  await latest.notifier.flushRows([row('in-4')], { kind: 'new-mail' });
  assert.equal(host.delivered.at(-1).sessionId, 'session-new-1234');
  assert.equal(host.created.length, 0);

  const all = await freshNotifier({ config: makeConfig({ target: 'all' }), host });
  await all.notifier.flushRows([row('in-5')], { kind: 'new-mail' });
  assert.deepEqual(host.delivered.slice(-2).map((item) => item.sessionId), ['session-old-1234', 'session-new-1234']);
});

test('batching collapses a burst into one notification and skips non-notify mail', async () => {
  const host = makeHost();
  const config = makeConfig({ target: 'dedicated', batchSeconds: 0 });
  const { notifier } = await freshNotifier({ config, host });
  const queued = notifier.enqueue([row('in-6'), row('in-7'), row('in-8', { notify: false })]);
  assert.equal(queued.queued, 2);
  await notifier.flush();
  assert.equal(host.delivered.length, 1);
  assert.match(host.delivered[0].text, /共 2 封新信/);
});

test('smtp buildMessage accepts text attachment content types with parameters', () => {
  const built = buildMessage({
    from: 'bot@example.com',
    to: 'owner@example.com',
    subject: '附件测试',
    text: '正文',
    html: '<p>正文</p>',
    attachments: [{ filename: 'report.txt', contentType: 'text/plain; charset=utf-8', content: Buffer.from('hello') }],
  });
  assert.match(built.raw, /Content-Type: text\/plain; charset=utf-8/i);
  assert.match(built.raw, /Content-Disposition: attachment; filename="report.txt"/i);
});
