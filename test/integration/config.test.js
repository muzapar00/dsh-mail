import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  defaultConfig,
  normalizeConfig,
  validateConfig,
  deepMerge,
  maskConfig,
  normalizeAddress,
  sameAddress,
  uniqueAddresses,
  presetForUi,
  PRESET_IDS,
  defaultDataDir,
  connectionStatus,
} from '../../lib/config.js';

test('defaultConfig is a fresh deep copy and keeps known-good letter defaults', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert.notEqual(a, b);
  a.mailbox.signature = 'changed';
  assert.equal(b.mailbox.displayName, '费加罗');
  assert.equal(b.mailbox.signature, '费加罗');
  assert.equal(b.mailbox.greeting, '');
  assert.equal(b.mailbox.letterhead, false);
  assert.equal(b.notify.target, 'dedicated');
  assert.equal(b.friends.policy, 'auto');
  assert.equal(b.enabled, true);
});

test('deepMerge merges objects and replaces arrays/scalars', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], text: 'x' };
  const merged = deepMerge(base, { a: { c: 9 }, list: [3], text: 'y' });
  assert.deepEqual(merged, { a: { b: 1, c: 9 }, list: [3], text: 'y' });
  assert.deepEqual(base.list, [1, 2]);
});

test('normalizeConfig fills defaults and clamps invalid values with issues', () => {
  const { value, issues } = normalizeConfig({
    owner: { address: 'mzpr00@163.com' },
    smtp: { user: 'figaro1@qq.com', host: 'smtp.qq.com', port: 'not-a-port' },
    imap: { pollIntervalSeconds: 3, fetchLimit: 500 },
    notify: { target: 'bogus target!', batchSeconds: 9999 },
    prompt: { language: 'fr' },
    unknownKey: true,
  });
  assert.equal(value.owner.address, 'mzpr00@163.com');
  assert.equal(value.smtp.port, 465);
  assert.equal(value.imap.pollIntervalSeconds, 120);
  assert.equal(value.imap.fetchLimit, 20);
  assert.equal(value.notify.target, 'dedicated');
  assert.equal(value.prompt.language, 'zh');
  assert.ok(issues.some((issue) => issue.path === 'smtp.port'));
  assert.ok(issues.some((issue) => issue.path === 'notify.target'));
});

test('normalizeConfig enforces address shapes and security mode constraints', () => {
  const { flags } = (() => {
    const normalized = normalizeConfig({ smtp: { security: 'none', host: 'smtp.example.com' }, imap: { security: 'none', host: 'imap.example.com' } });
    return { flags: normalized };
  })();
  assert.equal(flags.value.smtp.security, 'tls');
  assert.equal(flags.value.imap.security, 'tls');
  assert.ok(flags.issues.some((issue) => issue.path === 'smtp.security'));

  const bad = normalizeConfig({ owner: { address: 'not-an-address' } });
  assert.ok(bad.issues.some((issue) => issue.path === 'owner.address'));
});

test('validateConfig throws one aggregated error', () => {
  assert.throws(() => validateConfig({ owner: { address: '' } }), /owner\.address/);
});

test('maskConfig never exposes authorization codes', () => {
  const config = validateConfig({
    owner: { address: 'mzpr00@163.com' },
    smtp: { host: 'smtp.qq.com', user: 'figaro1@qq.com', authCode: 'SECRET-SMTP' },
    imap: { host: 'imap.qq.com', user: 'figaro1@qq.com', authCode: 'SECRET-IMAP' },
  });
  const masked = maskConfig(config);
  assert.equal(masked.smtp.authCode, '');
  assert.equal(masked.imap.authCode, '');
  assert.equal(masked.secrets.smtp.configured, true);
  assert.equal(masked.secrets.imap.configured, true);
  assert.ok(!JSON.stringify(masked).includes('SECRET-SMTP'));
  assert.ok(!JSON.stringify(masked).includes('SECRET-IMAP'));
});

test('address helpers normalize and compare', () => {
  assert.equal(normalizeAddress(' <Figaro1@QQ.com> '), 'Figaro1@qq.com');
  assert.equal(normalizeAddress('bad'), '');
  assert.equal(sameAddress('a@b.com', 'A@B.COM'), true);
  assert.deepEqual(uniqueAddresses(['a@b.com', 'A@b.com', 'c@d.com', 'bad']), ['a@b.com', 'c@d.com']);
});

test('presets expose provider presets and localized auth guides', () => {
  const zh = presetForUi('zh');
  assert.equal(zh.length, PRESET_IDS.length);
  const qq = zh.find((preset) => preset.id === 'qq');
  assert.equal(qq.smtp.host, 'smtp.qq.com');
  assert.equal(qq.imap.host, 'imap.qq.com');
  assert.ok(qq.guide.steps.length >= 3);
  assert.ok(qq.guide.links.length >= 1);
  assert.ok(qq.guide.links.every((link) => link.url.startsWith('https://')));
  const en = presetForUi('en').find((preset) => preset.id === 'qq');
  assert.match(en.guide.summary, /authorization code/i);
});

test('defaultDataDir honors DSH_HOME', () => {
  // Compare with join() so the expectation uses the platform separator (Windows).
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/dsh-home' }), join('/tmp/dsh-home', 'mailbox'));
});

test('connectionStatus reports configured flags without secrets', () => {
  const config = validateConfig({
    owner: { address: 'mzpr00@163.com' },
    smtp: { host: 'smtp.qq.com', user: 'figaro1@qq.com', authCode: 'x' },
    imap: { host: 'imap.qq.com', user: 'figaro1@qq.com' },
  });
  const status = connectionStatus(config);
  assert.equal(status.smtp.configured, true);
  assert.equal(status.imap.configured, false);
  assert.ok(!JSON.stringify(status).includes('"x"'));
});
