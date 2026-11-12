import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySender,
  admitRecipient,
  detectAutoSubmission,
  suspiciousSignals,
  admitAutoReply,
  RateLimiter,
  normalizeSubject,
  buildSubject,
  threadRoot,
  replyDepth,
  snippet,
  prepareRecipients,
} from '../../lib/core/policy.js';
import { validateConfig } from '../../lib/config.js';

const config = validateConfig({
  owner: { address: 'owner@example.com' },
  smtp: { host: 'smtp.example.com', user: 'bot@example.com', allowStrangerRecipients: false },
  imap: { host: 'imap.example.com', user: 'bot@example.com' },
  friends: { policy: 'auto', defaultAutoReply: false },
});
const configAllowStrangers = validateConfig({
  owner: { address: 'owner@example.com' },
  smtp: { host: 'smtp.example.com', user: 'bot@example.com', allowStrangerRecipients: true },
  imap: { host: 'imap.example.com', user: 'bot@example.com' },
});
const friendsDoc = {
  friends: [
    { address: 'Alice@Example.com', name: 'Alice', autoReply: true },
    { address: 'bob@example.com', name: 'Bob', autoReply: false },
  ],
  pending: [],
};

test('classifySender matches whitelist by address, not display name', () => {
  assert.equal(classifySender('alice@example.com', friendsDoc).kind, 'friend');
  assert.equal(classifySender('ALICE@EXAMPLE.COM', friendsDoc).kind, 'friend');
  assert.equal(classifySender('mallory@example.com', friendsDoc).kind, 'stranger');
});

test('admitRecipient allows owner and friends, gates strangers', () => {
  assert.deepEqual(admitRecipient(config.owner.address, config, friendsDoc), { ok: true, kind: 'owner', reason: '' });
  assert.deepEqual(admitRecipient('bob@example.com', config, friendsDoc), { ok: true, kind: 'friend', reason: '' });
  const denied = admitRecipient('stranger@evil.test', config, friendsDoc);
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, 'stranger');
  assert.match(denied.reason, /白名单/);
  // An explicit user request still cannot reach a stranger when the switch is off.
  assert.equal(admitRecipient('stranger@evil.test', config, friendsDoc, { actor: 'model', explicitUserRequest: true }).ok, false);
  // The human UI may reach a stranger only when the switch is on.
  assert.equal(admitRecipient('stranger@evil.test', configAllowStrangers, friendsDoc, { actor: 'user' }).ok, true);
  // The model also requires the explicit user request.
  assert.equal(admitRecipient('stranger@evil.test', configAllowStrangers, friendsDoc, { actor: 'model' }).ok, false);
  assert.equal(admitRecipient('stranger@evil.test', configAllowStrangers, friendsDoc, { actor: 'model', explicitUserRequest: true }).ok, true);
});

test('detectAutoSubmission recognizes the standard auto-mail headers', () => {
  assert.equal(detectAutoSubmission({}).automatic, false);
  assert.equal(detectAutoSubmission({ 'auto-submitted': 'no' }).automatic, false);
  assert.equal(detectAutoSubmission({ 'auto-submitted': 'auto-replied' }).automatic, true);
  assert.equal(detectAutoSubmission({ precedence: 'bulk' }).automatic, true);
  assert.equal(detectAutoSubmission({ 'list-unsubscribe': '<mailto:u@example.com>' }).automatic, true);
  assert.equal(detectAutoSubmission({ 'x-auto-response-suppress': 'All' }).automatic, true);
  assert.equal(detectAutoSubmission({ from: 'no-reply@service.example.com' }).automatic, true);
  assert.equal(detectAutoSubmission({ subject: '自动回复：我在休假' }).automatic, true);
});

test('suspiciousSignals flags phishing-ish mail and dangerous attachments', () => {
  const clean = suspiciousSignals({ headers: {}, from: { name: 'Alice', address: 'alice@example.com' }, replyTo: [], attachments: [], links: [] }, friendsDoc);
  assert.equal(clean.suspicious, false);

  const failedAuth = suspiciousSignals(
    { headers: { 'authentication-results': 'spf=fail dkim=fail dmarc=fail' }, from: { address: 'x@y.test' } },
    friendsDoc,
  );
  assert.equal(failedAuth.suspicious, true);
  assert.ok(failedAuth.reasons.some((reason) => /SPF/.test(reason)));

  const replyToMismatch = suspiciousSignals(
    { headers: {}, from: { address: 'ceo@company.test' }, replyTo: [{ address: 'attacker@evil.test' }] },
    friendsDoc,
  );
  assert.equal(replyToMismatch.suspicious, true);

  const spoof = suspiciousSignals(
    { headers: {}, from: { name: 'Alice', address: 'mallory@evil.test' } },
    friendsDoc,
  );
  assert.equal(spoof.suspicious, true);
  assert.ok(spoof.reasons.some((reason) => /冒充好友/.test(reason)));

  const attachment = suspiciousSignals(
    { headers: {}, from: { address: 'a@b.test' }, attachments: [{ filename: 'invoice.pdf.exe' }] },
    friendsDoc,
  );
  assert.equal(attachment.suspicious, true);

  const punycode = suspiciousSignals({ headers: {}, from: { address: 'x@xn--pple-43d.test' } }, friendsDoc);
  assert.equal(punycode.suspicious, true);

  const form = suspiciousSignals({ headers: {}, from: { address: 'a@b.test' }, html: '<form action="https://evil.test"><input type="password"></form>' }, friendsDoc);
  assert.equal(form.suspicious, true);
});

test('admitAutoReply stays closed unless the friend opted in and mail is human', () => {
  const normal = { from: { address: 'alice@example.com' }, headers: {}, references: [], subject: '你好' };
  assert.deepEqual(admitAutoReply(normal, config, friendsDoc), { ok: true, reason: '' });

  const bob = { from: { address: 'bob@example.com' }, headers: {}, references: [], subject: '你好' };
  assert.equal(admitAutoReply(bob, config, friendsDoc).ok, false);

  const auto = { from: { address: 'alice@example.com' }, headers: { 'auto-submitted': 'auto-generated' }, references: [], subject: 'x' };
  assert.equal(admitAutoReply(auto, config, friendsDoc).ok, false);

  const deep = { from: { address: 'alice@example.com' }, headers: {}, references: ['<a>', '<b>', '<c>', '<d>', '<e>'], subject: 'x' };
  assert.equal(admitAutoReply(deep, config, friendsDoc).ok, false);

  const noDefault = admitAutoReply({ from: { address: 'stranger@example.com' }, headers: {}, references: [] }, config, friendsDoc);
  assert.equal(noDefault.ok, false);
});

test('standalone rate limiter enforces a fixed window', () => {
  let now = 1000;
  const limiter = new RateLimiter({ max: 2, windowMs: 1000, name: 'test' });
  assert.equal(limiter.take(now).ok, true);
  assert.equal(limiter.take(now + 10).ok, true);
  const blocked = limiter.take(now + 20);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.take(now + 1500).ok, true);
});

test('subject, thread and snippet helpers', () => {
  const normalized = normalizeSubject('[DeepSeek Harness] Re: Re: 项目进度', '[DeepSeek Harness] ');
  assert.equal(normalized.base, '项目进度');
  assert.equal(normalized.isReply, true);
  assert.equal(buildSubject('项目进度', { prefix: '[DeepSeek Harness] ', reply: true }), '[DeepSeek Harness] Re: 项目进度');
  assert.equal(buildSubject('[DeepSeek Harness] 项目进度', { prefix: '[DeepSeek Harness] ' }), '[DeepSeek Harness] 项目进度');
  assert.equal(threadRoot('<b@x>', ['<a@x>', '<b@x>']), 'a@x');
  assert.equal(threadRoot('<a@x>', []), 'a@x');
  assert.equal(replyDepth(['<a>', '<b>']), 2);
  assert.equal(snippet('第一行\n第二行', 100), '第一行 第二行');
  assert.ok(snippet('字'.repeat(100), 20).endsWith('…'));
  assert.deepEqual(prepareRecipients(['a@b.com', 'A@B.com', 'bad', 'c@d.com']), ['a@b.com', 'c@d.com']);
});
