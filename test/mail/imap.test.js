/**
 * IMAP client tests: protocol against a local fake IMAP server.
 * No external network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMessage, encodeWords } from '../../lib/mail/mime.js';
import {
  ImapClient,
  openImap,
  ImapError,
  formatUidSet,
  parseInternalDate,
} from '../../lib/mail/imap.js';
import { startFakeImap } from './helpers.js';

const USER = 'receiver@example.com';
const PASS = 'secret-auth-code';

/** Build one RFC 5322 fixture message. */
function fixtureMessage({ uid, subject, text = 'hello body', flags = [] }) {
  const raw = Buffer.from([
    'From: "Sender" <sender@example.com>',
    'To: receiver@example.com',
    'Subject: ' + encodeWords(subject),
    'Message-ID: <msg-' + uid + '@example.com>',
    'Date: Wed, 12 Nov 2026 10:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n'), 'utf8');
  return { uid, raw, flags, internalDate: '12-Nov-2026 10:00:00 +0800' };
}

function imapErrorKind(kind) {
  return (error) => error instanceof ImapError && error.kind === kind;
}

const BASE = {
  host: '127.0.0.1',
  security: 'none',
  user: USER,
  pass: PASS,
  timeoutMs: 2000,
};

/* ------------------------------------------------------------------------- */

describe('imap: connection and authentication', () => {
  it('connects, logs in, reads capabilities and sends ID automatically', async () => {
    const server = await startFakeImap({
      auth: { user: USER, pass: PASS },
      messages: [fixtureMessage({ uid: 1, subject: 'one' })],
    });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port });
      assert.equal(client.authenticated, true);
      assert.ok(client.capabilities.includes('IMAP4rev1'));
      assert.equal(client.capabilities.includes('ID'), true);
      assert.equal(server.logins, 1);
      assert.equal(server.ids.length, 1);
      assert.match(server.ids[0], /^ID \(/);
      // LOGIN must use quoted strings and never appear in logs.
      assert.ok(server.commands.some((command) => command.startsWith('A') && / LOGIN /.test(command)));
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('quotes credentials and masks them in errors', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS } });
    try {
      await assert.rejects(
        openImap({ ...BASE, port: server.port, pass: 'wrong-pass' }),
        (error) => {
          assert.ok(error instanceof ImapError);
          assert.equal(error.kind, 'auth');
          assert.doesNotMatch(error.message, /wrong-pass/);
          assert.doesNotMatch(error.stack, /wrong-pass/);
          assert.doesNotMatch(error.message, new RegExp(Buffer.from('wrong-pass').toString('base64').replace(/[+/=]/g, '\\$&')));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it('supports servers where ID is required before SELECT (163-style)', async () => {
    const server = await startFakeImap({
      auth: { user: USER, pass: PASS },
      requireId: true,
      messages: [fixtureMessage({ uid: 1, subject: 'one' })],
    });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port });
      assert.equal(server.ids.length, 1);
      const state = await client.select('INBOX');
      assert.equal(state.exists, 1);
      assert.equal(server.ids.length, 1);
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('logs in with non-ASCII credentials through IMAP literals', async () => {
    const nonAsciiUser = '收件人@example.com';
    const nonAsciiPass = '密码-授权码';
    const server = await startFakeImap({ auth: { user: nonAsciiUser, pass: nonAsciiPass } });
    let client;
    try {
      client = await openImap({
        ...BASE,
        port: server.port,
        user: nonAsciiUser,
        pass: nonAsciiPass,
        sendId: false,
      });
      assert.equal(client.authenticated, true);
      assert.equal(server.logins, 1);
      assert.ok(server.commands.some((command) => / LOGIN \{\d+\}$/.test(command)));
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('skips the ID command when sendId is false', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS }, messages: [] });
    let client;
    try {
      client = await new ImapClient({ ...BASE, port: server.port, sendId: false }).open();
      assert.equal(server.ids.length, 0);
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('tolerates servers that reject the ID command', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS }, idSupported: false });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port, sendId: true });
      assert.equal(client.authenticated, true);
      assert.equal(server.ids.length, 1);
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('times out when the server never greets', async () => {
    const server = await startFakeImap({ hangAt: 'greeting' });
    try {
      await assert.rejects(
        openImap({ ...BASE, port: server.port, timeoutMs: 250 }),
        imapErrorKind('timeout'),
      );
    } finally {
      await server.close();
    }
  });

  it('honours AbortSignal cancellation', async () => {
    const server = await startFakeImap({ hangAt: 'greeting' });
    const controller = new AbortController();
    try {
      const pending = openImap({ ...BASE, port: server.port, signal: controller.signal, timeoutMs: 5000 });
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(pending, imapErrorKind('aborted'));
    } finally {
      await server.close();
    }
  });

  it('refuses security:"none" for non-loopback hosts', () => {
    assert.throws(() => new ImapClient({ ...BASE, host: 'imap.example.com', security: 'none' }), imapErrorKind('config'));
  });
});

/* ------------------------------------------------------------------------- */

describe('imap: select / search / fetch', () => {
  async function withClient(options, run) {
    const server = await startFakeImap({
      auth: { user: USER, pass: PASS },
      uidValidity: 4242,
      ...options,
    });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port, ...(options.clientOptions ?? {}) });
      return await run(client, server);
    } finally {
      await client?.logout();
      await server.close();
    }
  }

  it('parses SELECT response state (UIDVALIDITY / UIDNEXT / EXISTS / FLAGS)', async () => {
    await withClient(
      {
        uidValidity: 4242,
        messages: [fixtureMessage({ uid: 10, subject: 'a' }), fixtureMessage({ uid: 11, subject: 'b' })],
      },
      async (client) => {
        const state = await client.select('INBOX');
        assert.equal(state.mailbox, 'INBOX');
        assert.equal(state.exists, 2);
        assert.equal(state.uidValidity, 4242);
        assert.equal(state.uidNext, 12);
        assert.equal(state.readOnly, false);
        assert.ok(state.flags.includes('\\Seen'));
        assert.equal(client.uidValidity, 4242);
        assert.equal(client.uidNext, 12);
        const examined = await client.examine('INBOX');
        assert.equal(examined.readOnly, true);
      },
    );
  });

  it('searches for new UIDs with searchNew and supports raw criteria', async () => {
    const messages = [10, 11, 12].map((uid, index) => fixtureMessage({ uid, subject: `s${index}`, flags: index === 0 ? ['\\Seen'] : [] }));
    await withClient({ messages }, async (client, server) => {
      await client.select('INBOX');
      assert.deepEqual(await client.searchNew(0), [10, 11, 12]);
      assert.deepEqual(await client.searchNew(10), [11, 12]);
      assert.deepEqual(await client.searchNew(12), []);
      assert.deepEqual(await client.uidSearch('ALL'), [10, 11, 12]);
      assert.deepEqual(await client.searchUnseen(), [11, 12]);
      assert.ok(server.commands.some((command) => command.includes('UID SEARCH UID 11:*')));
    });
  });

  it('fetches a single message with UID/FLAGS/INTERNALDATE/BODY[]', async () => {
    const message = fixtureMessage({ uid: 11, subject: '你好 hello', flags: ['\\Seen'] });
    await withClient({ messages: [message] }, async (client, server) => {
      await client.select('INBOX');
      const [fetched] = await client.fetchByUid([11]);
      assert.equal(fetched.uid, 11);
      assert.equal(fetched.seq, 1);
      assert.deepEqual(fetched.flags, ['\\Seen']);
      assert.equal(fetched.internalDate.toISOString(), '2026-11-12T02:00:00.000Z');
      assert.equal(fetched.size, message.raw.length);
      assert.equal(fetched.truncated, false);
      assert.ok(Buffer.isBuffer(fetched.raw));
      assert.ok(fetched.raw.equals(message.raw));
      const parsed = parseMessage(fetched.raw);
      assert.equal(parsed.subject, '你好 hello');
      assert.equal(parsed.text, 'hello body');
      // BODY.PEEK[] must be used (never BODY[]) so reading does not mark seen.
      assert.ok(server.fetches[0].items.includes('BODY.PEEK[]'));
      assert.ok(!server.fetches[0].items.includes('BODY[]'));
    });
  });

  it('fetches headers only', async () => {
    const message = fixtureMessage({ uid: 5, subject: 'header only' });
    await withClient({ messages: [message] }, async (client, server) => {
      await client.select('INBOX');
      const [fetched] = await client.fetchByUid([5], { headersOnly: true });
      assert.ok(fetched.headersRaw !== null);
      assert.equal(fetched.raw, null);
      const parsed = parseMessage(fetched.headersRaw);
      assert.equal(parsed.subject, 'header only');
      assert.ok(server.fetches[0].items.includes('BODY.PEEK[HEADER]'));
    });
  });

  it('fetches metadata only with body:false', async () => {
    await withClient({ messages: [fixtureMessage({ uid: 7, subject: 'meta' })] }, async (client) => {
      await client.select('INBOX');
      const [fetched] = await client.fetchByUid([7], { body: false });
      assert.equal(fetched.raw, null);
      assert.equal(fetched.headersRaw, null);
      assert.equal(fetched.truncated, false);
      assert.ok(fetched.size > 0);
    });
  });

  it('batches UIDs into an IMAP set', async () => {
    const messages = [3, 4, 5, 9].map((uid) => fixtureMessage({ uid, subject: `m${uid}` }));
    await withClient({ messages }, async (client, server) => {
      await client.select('INBOX');
      const fetched = await client.fetchByUid([3, 4, 5, 9]);
      assert.deepEqual(fetched.map((item) => item.uid), [3, 4, 5, 9]);
      assert.ok(server.commands.some((command) => command.includes('UID FETCH 3:5,9 ')));
    });
  });

  it('fetchRecent returns the newest N messages ascending', async () => {
    const messages = [1, 2, 3, 4, 5].map((uid) => fixtureMessage({ uid, subject: `m${uid}` }));
    await withClient({ messages }, async (client) => {
      await client.select('INBOX');
      const recent = await client.fetchRecent(2);
      assert.deepEqual(recent.map((item) => item.uid), [4, 5]);
      assert.ok(parseMessage(recent[1].raw).subject === 'm5');
    });
  });

  it('drains oversized literals instead of buffering them', async () => {
    const message = fixtureMessage({ uid: 1, subject: 'big', text: 'x'.repeat(500) });
    await withClient({ messages: [message], clientOptions: { maxLiteralBytes: 50 } }, async (client) => {
      await client.select('INBOX');
      const [fetched] = await client.fetchByUid([1]);
      assert.equal(fetched.raw, null);
      assert.equal(fetched.truncated, true);
      assert.equal(fetched.size, message.raw.length);
      // The connection still works after draining the literal.
      assert.deepEqual(await client.searchNew(0), [1]);
    });
  });

  it('parses literals that contain IMAP-looking lines and binary bytes', async () => {
    const binaryBody = Buffer.concat([
      Buffer.from('From: a@example.com\r\nSubject: binary\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n', 'latin1'),
      Buffer.from([0x00, 0x0d, 0x0a, 0x29, 0x20, 0x2a, 0xff, 0x7f]),
    ]);
    await withClient({ messages: [{ uid: 9, raw: binaryBody, flags: [] }] }, async (client) => {
      await client.select('INBOX');
      const [fetched] = await client.fetchByUid([9]);
      assert.ok(fetched.raw.equals(binaryBody));
      assert.equal(parseMessage(fetched.raw).subject, 'binary');
    });
  });

  it('marks messages as seen with UID STORE +FLAGS (\\Seen)', async () => {
    await withClient(
      { messages: [fixtureMessage({ uid: 10, subject: 'a' }), fixtureMessage({ uid: 11, subject: 'b' })] },
      async (client, server) => {
        await client.select('INBOX');
        const result = await client.markSeen([10, 11]);
        assert.equal(result.updated, 2);
        assert.deepEqual(server.stores[0], { uids: [10, 11], mode: '+FLAGS', flags: ['\\Seen'] });
        assert.ok(server.messages[0].flags.includes('\\Seen'));
        assert.ok(server.messages[1].flags.includes('\\Seen'));
        await client.markUnseen([10]);
        assert.deepEqual(server.stores[1], { uids: [10], mode: '-FLAGS', flags: ['\\Seen'] });
      },
    );
  });

  it('close() tears the connection down immediately', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS } });
    try {
      const client = await openImap({ ...BASE, port: server.port });
      client.close();
      assert.equal(client.closed, true);
      await assert.rejects(client.select('INBOX'), imapErrorKind('connection'));
    } finally {
      await server.close();
    }
  });

  it('logs out and refuses commands afterwards', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS } });
    try {
      const client = await openImap({ ...BASE, port: server.port });
      await client.logout();
      await assert.rejects(client.select('INBOX'), imapErrorKind('connection'));
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------------- */

describe('imap: TLS modes', () => {
  it('works with implicit TLS when verification is disabled for the test', async () => {
    const server = await startFakeImap({
      auth: { user: USER, pass: PASS },
      implicitTls: true,
      messages: [fixtureMessage({ uid: 1, subject: 'tls' })],
    });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port, security: 'tls', tlsOptions: { rejectUnauthorized: false } });
      const state = await client.select('INBOX');
      assert.equal(state.exists, 1);
      const [fetched] = await client.fetchByUid([1]);
      assert.equal(parseMessage(fetched.raw).subject, 'tls');
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('rejects self-signed certificates by default', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS }, implicitTls: true });
    try {
      await assert.rejects(
        openImap({ ...BASE, port: server.port, security: 'tls' }),
        imapErrorKind('tls'),
      );
    } finally {
      await server.close();
    }
  });

  it('upgrades with STARTTLS and re-fetches capabilities', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS }, starttls: true });
    let client;
    try {
      client = await openImap({ ...BASE, port: server.port, security: 'starttls', tlsOptions: { rejectUnauthorized: false } });
      assert.equal(client.authenticated, true);
      const state = await client.select('INBOX');
      assert.equal(state.exists, 0);
      const commandText = server.commands.join('\n');
      assert.match(commandText, / STARTTLS/);
      const starttlsIndex = server.commands.findIndex((command) => / STARTTLS$/.test(command));
      const capabilityAfterTls = server.commands.findIndex(
        (command, index) => index > starttlsIndex && / CAPABILITY$/.test(command),
      );
      assert.notEqual(capabilityAfterTls, -1);
    } finally {
      await client?.logout();
      await server.close();
    }
  });

  it('fails STARTTLS when the certificate is untrusted by default', async () => {
    const server = await startFakeImap({ auth: { user: USER, pass: PASS }, starttls: true });
    try {
      await assert.rejects(
        openImap({ ...BASE, port: server.port, security: 'starttls' }),
        imapErrorKind('tls'),
      );
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------------- */

describe('imap: helpers', () => {
  it('formats UID sets compactly', () => {
    assert.equal(formatUidSet([5]), '5');
    assert.equal(formatUidSet([1, 2, 3, 5, 7, 8]), '1:3,5,7:8');
    assert.equal(formatUidSet([3, 3, 2]), '2:3');
    assert.equal(formatUidSet([]), '');
  });

  it('parses INTERNALDATE values', () => {
    assert.equal(parseInternalDate('12-Nov-2026 10:00:00 +0800').toISOString(), '2026-11-12T02:00:00.000Z');
    assert.equal(parseInternalDate('01-Jan-2020 00:00:00 +0000').toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(parseInternalDate('not-a-date'), null);
    assert.equal(parseInternalDate(undefined), null);
  });
});
