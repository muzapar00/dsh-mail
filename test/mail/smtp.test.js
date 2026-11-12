/**
 * SMTP client tests: message building + live protocol against local fake servers.
 * No external network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import net from 'node:net';
import { parseMessage } from '../../lib/mail/mime.js';
import {
  sendMail,
  verifySmtp,
  buildMessage,
  SmtpError,
  formatRfc5322Date,
  formatPhrase,
  normalizeRecipient,
  normalizeMessageIds,
  parseCapabilities,
  advertisedAuthMethods,
} from '../../lib/mail/smtp.js';
import { startFakeSmtp, delay } from './helpers.js';

const BASE = {
  host: '127.0.0.1',
  security: 'none',
  user: 'sender@example.com',
  pass: 'secret',
  from: 'sender@example.com',
  fromName: '大肥鱼deepseek',
  to: 'receiver@example.com',
  subject: '测试主题 hello',
  text: '你好，这是一封测试信。',
  html: '<p>你好，这是一封测试信。</p>',
};

/** Predicate for SmtpError with a given kind. */
function smtpErrorKind(kind) {
  return (error) => error instanceof SmtpError && error.kind === kind;
}

/** Grab a port that is closed right now (connection refused test). */
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/* ------------------------------------------------------------------------- */

describe('smtp: buildMessage (pure)', () => {
  it('builds a multipart/alternative message with encoded headers', () => {
    const { raw, messageId, envelope } = buildMessage(BASE);
    assert.match(messageId, /^<[0-9a-f-]{36}@example\.com>$/);
    assert.deepEqual(envelope, { from: 'sender@example.com', to: ['receiver@example.com'] });
    assert.match(raw, /^From: =\?UTF-8\?B\?[^?]+\?= <sender@example\.com>\r\n/);
    assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
    assert.match(raw, /Content-Type: multipart\/alternative; boundary="alt-/);
    assert.match(raw, /MIME-Version: 1\.0/);
    assert.match(raw, /Message-ID: <[^>]+>/);
    const parsed = parseMessage(raw);
    assert.equal(parsed.subject, BASE.subject);
    assert.equal(parsed.from[0].name, BASE.fromName);
    assert.equal(parsed.text, BASE.text);
    assert.equal(parsed.html, BASE.html);
  });

  it('emits RFC 5322 Date headers', () => {
    const date = new Date('2026-11-12T02:00:00Z');
    const formatted = formatRfc5322Date(date);
    assert.match(formatted, /^[A-Z][a-z]{2}, 12 Nov 2026 \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    assert.ok(Number.isFinite(Date.parse(formatted)));
  });

  it('supports threads (In-Reply-To / References) and custom headers', () => {
    const { raw } = buildMessage({
      ...BASE,
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', 'parent@example.com'],
      headers: { 'X-Mailer': 'dsh-mailbox-test' },
    });
    assert.match(raw, /In-Reply-To: <parent@example\.com>/);
    assert.match(raw, /References: <root@example\.com> <parent@example\.com>/);
    assert.match(raw, /X-Mailer: dsh-mailbox-test/);
    const parsed = parseMessage(raw);
    assert.deepEqual(parsed.inReplyTo, ['<parent@example.com>']);
    assert.deepEqual(parsed.references, ['<root@example.com>', '<parent@example.com>']);
  });

  it('wraps inline avatar in multipart/related with Content-ID', () => {
    const { raw } = buildMessage({
      ...BASE,
      html: '<p>hi <img src="cid:avatar-x"></p>',
      avatar: { cid: 'avatar-x', filename: 'avatar.png', contentType: 'image/png', base64: 'iVBORw0KGgo=' },
    });
    assert.match(raw, /Content-Type: multipart\/related; boundary="rel-.*"; type="multipart\/alternative"/);
    assert.match(raw, /Content-ID: <avatar-x>/);
    assert.match(raw, /Content-Disposition: inline; filename="avatar\.png"/);
    const parsed = parseMessage(raw);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].cid, 'avatar-x');
    assert.equal(parsed.attachments[0].inline, true);
  });

  it('wraps attachments in multipart/mixed', () => {
    const { raw } = buildMessage({
      ...BASE,
      attachments: [{ filename: 'report.txt', contentType: 'text/plain', content: Buffer.from('hello') }],
    });
    assert.match(raw, /Content-Type: multipart\/mixed; boundary="mix-/);
    const parsed = parseMessage(raw);
    assert.equal(parsed.text, BASE.text);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, 'report.txt');
    assert.equal(parsed.attachments[0].size, 5);
  });

  it('rejects header injection and invalid recipients', () => {
    assert.throws(() => buildMessage({ ...BASE, to: 'victim@example.com>\r\nBcc: evil@example.com' }), smtpErrorKind('config'));
    assert.throws(() => buildMessage({ ...BASE, to: 'not-an-address' }), smtpErrorKind('config'));
    assert.throws(() => buildMessage({ ...BASE, to: [] }), smtpErrorKind('config'));
    assert.throws(() => buildMessage({ ...BASE, headers: { 'Bad Header': 'x' } }), smtpErrorKind('config'));
    assert.throws(() => buildMessage({ ...BASE, headers: { Subject: 'override' } }), smtpErrorKind('config'));
  });

  it('sanitizes CR/LF in subject instead of injecting headers', () => {
    const { raw } = buildMessage({ ...BASE, subject: 'line1\r\nline2' });
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    const subjectLines = headerBlock.split('\r\n').filter((line) => line.toLowerCase().startsWith('subject:'));
    assert.equal(subjectLines.length, 1);
    assert.match(subjectLines[0], /line1 line2/);
    // No injected header line may start the CRLF-split line2.
    assert.doesNotMatch(headerBlock, /(^|\r\n)line2/);
  });

  it('derive plain text from HTML-only input', () => {
    const { raw } = buildMessage({ ...BASE, text: '', html: '<p>Hello <b>World</b></p>' });
    const parsed = parseMessage(raw);
    assert.equal(parsed.text, 'Hello World');
  });

  it('exposes helpers', () => {
    assert.equal(formatPhrase('plain name'), 'plain name');
    assert.equal(formatPhrase('Doe, John'), '"Doe, John"');
    assert.deepEqual(normalizeRecipient({ name: 'A', address: 'a@example.com' }), { name: 'A', address: 'a@example.com' });
    assert.deepEqual(normalizeMessageIds(['a@b', '<c@d>']), ['<a@b>', '<c@d>']);
    const capabilities = parseCapabilities('fake.host\nAUTH LOGIN PLAIN\nSIZE 1000\nSTARTTLS');
    assert.equal(capabilities.AUTH, 'LOGIN PLAIN');
    assert.deepEqual(advertisedAuthMethods(capabilities).sort(), ['LOGIN', 'PLAIN']);
  });
});

/* ------------------------------------------------------------------------- */

describe('smtp: sendMail against a fake server', () => {
  it('sends a message successfully with AUTH LOGIN', async () => {
    const server = await startFakeSmtp();
    try {
      const result = await sendMail({ ...BASE, port: server.port });
      assert.equal(result.accepted.length, 1);
      assert.equal(result.rejected.length, 0);
      assert.equal(result.server.authMethod, 'LOGIN');
      assert.equal(result.messageId, parseMessage(server.messages[0].raw).messageId);
      assert.equal(server.messages.length, 1);
      const captured = parseMessage(server.messages[0].raw);
      assert.equal(captured.subject, BASE.subject);
      assert.equal(captured.text, BASE.text);
      assert.equal(captured.html, BASE.html);
      assert.equal(captured.from[0].address, 'sender@example.com');
      assert.equal(captured.to[0].address, 'receiver@example.com');
      assert.equal(server.messages[0].envelope.from, 'sender@example.com');
      assert.deepEqual(server.messages[0].envelope.to, ['receiver@example.com']);
      // Credentials are only ever sent through AUTH (never in the message body).
      assert.doesNotMatch(server.messages[0].raw, /secret/);
      assert.equal(server.authAttempts[0].password, 'secret');
    } finally {
      await server.close();
    }
  });

  it('tracks accepted and rejected recipients', async () => {
    const server = await startFakeSmtp({ rejectRecipients: ['bad@example.com'] });
    try {
      const result = await sendMail({
        ...BASE,
        port: server.port,
        to: ['good@example.com', 'bad@example.com'],
      });
      assert.deepEqual(result.accepted, ['good@example.com']);
      assert.equal(result.rejected[0].address, 'bad@example.com');
      assert.equal(result.rejected[0].code, 550);
    } finally {
      await server.close();
    }
  });

  it('throws a recipient error when every recipient is rejected', async () => {
    const server = await startFakeSmtp({ rejectRecipients: ['bad@example.com'] });
    try {
      await assert.rejects(
        sendMail({ ...BASE, port: server.port, to: 'bad@example.com' }),
        smtpErrorKind('recipient'),
      );
    } finally {
      await server.close();
    }
  });

  it('reports authentication failure without leaking the password', async () => {
    const server = await startFakeSmtp({ authFail: true });
    const password = 'P@ssw0rd-secret';
    try {
      await assert.rejects(
        sendMail({ ...BASE, port: server.port, pass: password }),
        (error) => {
          assert.ok(error instanceof SmtpError);
          assert.equal(error.kind, 'auth');
          assert.doesNotMatch(error.message, /P@ssw0rd-secret/);
          assert.doesNotMatch(error.message, new RegExp(Buffer.from(password).toString('base64').replace(/[+/=]/g, '\\$&')));
          assert.match(error.message, /authentication failed/i);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it('times out when the server never greets', async () => {
    const server = await startFakeSmtp({ hangAt: 'greeting' });
    try {
      await assert.rejects(
        sendMail({ ...BASE, port: server.port, timeoutMs: 250 }),
        smtpErrorKind('timeout'),
      );
    } finally {
      await server.close();
    }
  });

  it('honours AbortSignal cancellation', async () => {
    const server = await startFakeSmtp({ hangAt: 'greeting' });
    const controller = new AbortController();
    try {
      const pending = sendMail({ ...BASE, port: server.port, signal: controller.signal, timeoutMs: 5000 });
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(pending, smtpErrorKind('aborted'));
    } finally {
      await server.close();
    }
  });

  it('fails cleanly when the connection is refused', async () => {
    const port = await unusedPort();
    await assert.rejects(
      sendMail({ ...BASE, port, timeoutMs: 1000 }),
      smtpErrorKind('connection'),
    );
  });

  it('refuses security:"none" for non-loopback hosts', async () => {
    await assert.rejects(
      sendMail({ ...BASE, host: 'smtp.example.com', security: 'none', port: 465 }),
      smtpErrorKind('config'),
    );
  });

  it('falls back to AUTH PLAIN when LOGIN is not advertised', async () => {
    const server = await startFakeSmtp({ capabilities: ['AUTH PLAIN', 'SIZE 1024'] });
    try {
      const result = await sendMail({ ...BASE, port: server.port });
      assert.equal(result.server.authMethod, 'PLAIN');
      assert.equal(server.authAttempts[0].user, 'sender@example.com');
      assert.equal(server.messages.length, 1);
    } finally {
      await server.close();
    }
  });

  it('verifySmtp authenticates without sending a message', async () => {
    const server = await startFakeSmtp();
    try {
      const result = await verifySmtp({ ...BASE, port: server.port });
      assert.equal(result.ok, true);
      assert.equal(result.authMethod, 'LOGIN');
      assert.equal(server.messages.length, 0);
      assert.equal(server.authAttempts.length, 1);
    } finally {
      await server.close();
    }
  });

  it('verifySmtp surfaces auth failures', async () => {
    const server = await startFakeSmtp({ authFail: true });
    try {
      await assert.rejects(verifySmtp({ ...BASE, port: server.port }), smtpErrorKind('auth'));
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------------- */

describe('smtp: TLS modes', () => {
  it('sends over implicit TLS when certificate verification is disabled for the test', async () => {
    const server = await startFakeSmtp({ implicitTls: true });
    try {
      const result = await sendMail({
        ...BASE,
        security: 'tls',
        port: server.port,
        tlsOptions: { rejectUnauthorized: false },
      });
      assert.equal(result.accepted.length, 1);
      assert.equal(server.messages[0].secure, true);
    } finally {
      await server.close();
    }
  });

  it('rejects a self-signed certificate by default (strict verification)', async () => {
    const server = await startFakeSmtp({ implicitTls: true });
    try {
      await assert.rejects(
        sendMail({ ...BASE, security: 'tls', port: server.port }),
        (error) => error instanceof SmtpError && error.kind === 'tls',
      );
    } finally {
      await server.close();
    }
  });

  it('upgrades with STARTTLS and re-authenticates', async () => {
    const server = await startFakeSmtp({ starttls: true });
    try {
      const result = await sendMail({
        ...BASE,
        port: server.port,
        security: 'starttls',
        tlsOptions: { rejectUnauthorized: false },
      });
      assert.equal(result.accepted.length, 1);
      assert.equal(server.messages[0].secure, true);
      assert.equal(result.server.authMethod, 'LOGIN');
      // EHLO must be sent twice: before and after the TLS upgrade.
      assert.equal(server.commands.filter((command) => command.startsWith('EHLO')).length, 2);
    } finally {
      await server.close();
    }
  });

  it('fails STARTTLS when the certificate is untrusted by default', async () => {
    const server = await startFakeSmtp({ starttls: true });
    try {
      await assert.rejects(
        sendMail({ ...BASE, port: server.port, security: 'starttls' }),
        (error) => error instanceof SmtpError && error.kind === 'tls',
      );
    } finally {
      await server.close();
    }
  });

  it('fails when security:"starttls" is requested but not advertised', async () => {
    const server = await startFakeSmtp();
    try {
      await assert.rejects(
        sendMail({ ...BASE, port: server.port, security: 'starttls', tlsOptions: { rejectUnauthorized: false } }),
        (error) => error instanceof SmtpError && error.kind === 'tls',
      );
    } finally {
      await server.close();
    }
  });
});

describe('smtp: message size guard', () => {
  it('refuses messages above maxMessageBytes', () => {
    assert.throws(
      () => buildMessage({ ...BASE, text: 'x'.repeat(1000), maxMessageBytes: 100 }),
      smtpErrorKind('config'),
    );
  });
});
