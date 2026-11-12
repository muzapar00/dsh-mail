/**
 * Local fake SMTP / IMAP servers for `node --test test/mail/`.
 *
 * Everything runs on ephemeral loopback ports with self-signed TLS fixtures
 * (fixtures/cert.pem + key.pem, generated once for the test suite). No external
 * network, no real mailboxes, no credentials involved.
 *
 * @module dsh-mailbox/test/mail/helpers
 */

import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TLS_KEY = readFileSync(path.join(HERE, 'fixtures/key.pem'));
export const TLS_CERT = readFileSync(path.join(HERE, 'fixtures/cert.pem'));

/** Create a TLS SecureContext for the self-signed test certificate. */
export function testSecureContext() {
  return tls.createSecureContext({ key: TLS_KEY, cert: TLS_CERT });
}

async function listenOn(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function decodeBase64(value) {
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------------- *
 * Fake SMTP submission server
 * ------------------------------------------------------------------------- */

/**
 * Start a fake SMTP server.
 *
 * @param {object} [options]
 * @param {string} [options.greeting='220 fake.smtp ESMTP ready']
 * @param {string[]} [options.capabilities=['AUTH LOGIN PLAIN','SIZE 10485760','8BITMIME']]
 * @param {{user: string, pass: string}} [options.auth] - expected credentials (null disables the check).
 * @param {boolean} [options.authFail=false] - reject all AUTH attempts with 535.
 * @param {boolean} [options.starttls=false] - advertise and accept STARTTLS.
 * @param {boolean} [options.implicitTls=false] - TLS from the first byte (port 465 style).
 * @param {string[]} [options.rejectRecipients=[]]
 * @param {'greeting'|'ehlo'|'auth'|'data'|null} [options.hangAt=null]
 * @returns {Promise<object>}
 */
export async function startFakeSmtp(options = {}) {
  const config = {
    greeting: '220 fake.smtp ESMTP ready',
    capabilities: ['AUTH LOGIN PLAIN', 'SIZE 10485760', '8BITMIME'],
    auth: { user: 'sender@example.com', pass: 'secret' },
    authFail: false,
    starttls: false,
    implicitTls: false,
    rejectRecipients: [],
    hangAt: null,
    ...options,
  };
  const secureContext = testSecureContext();
  const sockets = new Set();
  const state = {
    messages: [],
    commands: [],
    connections: 0,
    authAttempts: [],
  };

  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };

  const attach = (socket, { secure, sendGreeting = true }) => {
    const context = { inData: false, data: [], authState: null, secure, envelope: {} };
    let buffer = '';
    const send = (line) => socket.write(`${line}\r\n`);

    const handle = (line) => {
      state.commands.push(line);
      if (context.inData) {
        if (line === '.') {
          context.inData = false;
          state.messages.push({
            raw: context.data.join('\r\n'),
            envelope: { ...context.envelope },
            secure: context.secure,
          });
          context.data = [];
          if (config.hangAt === 'data') return; // never acknowledge: client times out
          send('250 2.0.0 OK queued as FAKE0001');
          return;
        }
        context.data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) {
        if (config.hangAt === 'ehlo') return;
        const capabilities = [...config.capabilities];
        if (config.starttls && !context.secure
          && !capabilities.some((item) => item.toUpperCase() === 'STARTTLS')) {
          capabilities.push('STARTTLS');
        }
        if (capabilities.length === 0) {
          send('250 fake.smtp');
          return;
        }
        const lines = ['250-fake.smtp'];
        capabilities.forEach((capability, index) => {
          const last = index === capabilities.length - 1;
          lines.push(`250${last ? ' ' : '-'}${capability}`);
        });
        socket.write(`${lines.join('\r\n')}\r\n`);
        return;
      }
      if (upper.startsWith('HELO')) {
        send('250 fake.smtp');
        return;
      }
      if (upper === 'STARTTLS') {
        if (!config.starttls || context.secure) {
          send('502 5.5.1 STARTTLS not available');
          return;
        }
        send('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
        track(secureSocket);
        attach(secureSocket, { secure: true, sendGreeting: false });
        return;
      }
      if (upper === 'AUTH LOGIN') {
        if (config.authFail) {
          send('535 5.7.8 Authentication failed');
          return;
        }
        if (config.hangAt === 'auth') return;
        context.authState = 'user';
        send('334 VXNlcm5hbWU6');
        return;
      }
      if (context.authState === 'user') {
        context.authUser = decodeBase64(line);
        context.authState = 'pass';
        send('334 UGFzc3dvcmQ6');
        return;
      }
      if (context.authState === 'pass') {
        const password = decodeBase64(line);
        state.authAttempts.push({ user: context.authUser, password });
        context.authState = null;
        if (config.auth !== null && config.auth !== undefined
          && context.authUser === config.auth.user && password === config.auth.pass) {
          send('235 2.7.0 Authentication successful');
        } else {
          send('535 5.7.8 Authentication failed');
        }
        return;
      }
      if (upper.startsWith('AUTH PLAIN')) {
        const token = line.slice('AUTH PLAIN'.length).trim();
        const parts = Buffer.from(token, 'base64').toString('utf8').split('\u0000');
        const user = parts.length >= 3 ? parts[1] : '';
        const password = parts.length >= 3 ? parts[2] : '';
        state.authAttempts.push({ user, password });
        if (!config.authFail && config.auth !== null && config.auth !== undefined
          && user === config.auth.user && password === config.auth.pass) {
          send('235 2.7.0 Authentication successful');
        } else {
          send('535 5.7.8 Authentication failed');
        }
        return;
      }
      if (upper.startsWith('MAIL FROM')) {
        const match = /<([^>]*)>/.exec(line);
        context.envelope.from = match === null ? '' : match[1];
        send('250 2.1.0 Ok');
        return;
      }
      if (upper.startsWith('RCPT TO')) {
        const match = /<([^>]*)>/.exec(line);
        const address = match === null ? '' : match[1];
        if (config.rejectRecipients.includes(address)) {
          send('550 5.1.1 No such user');
          return;
        }
        context.envelope.to = [...(context.envelope.to ?? []), address];
        send('250 2.1.5 Ok');
        return;
      }
      if (upper === 'DATA') {
        context.inData = true;
        send('354 End data with <CR><LF>.<CR><LF>');
        return;
      }
      if (upper === 'QUIT') {
        send('221 2.0.0 Bye');
        socket.end();
        return;
      }
      if (upper === 'RSET' || upper === 'NOOP') {
        send('250 2.0.0 Ok');
        return;
      }
      send('500 5.5.1 Unknown command');
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });
    if (!context.secure) state.connections += 1;
    if (sendGreeting && config.hangAt !== 'greeting') send(config.greeting);
  };

  const server = config.implicitTls
    ? tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
      track(socket);
      attach(socket, { secure: true });
    })
    : net.createServer((socket) => {
      track(socket);
      attach(socket, { secure: false });
    });
  const port = await listenOn(server);

  return {
    port,
    get messages() {
      return state.messages;
    },
    get commands() {
      return state.commands;
    },
    get connections() {
      return state.connections;
    },
    get authAttempts() {
      return state.authAttempts;
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/* ------------------------------------------------------------------------- *
 * Fake IMAP server
 * ------------------------------------------------------------------------- */

/** Parse the quoted/literal-ish arguments of an IMAP command (best effort). */
function parseImapArgs(text) {
  const args = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && text[i] === ' ') i += 1;
    if (i >= text.length) break;
    if (text[i] === '"') {
      let value = '';
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      args.push(value);
      continue;
    }
    if (text[i] === '(') {
      let depth = 0;
      let value = '';
      while (i < text.length) {
        if (text[i] === '(') depth += 1;
        if (text[i] === ')') depth -= 1;
        value += text[i];
        i += 1;
        if (depth === 0) break;
      }
      args.push(value);
      continue;
    }
    let value = '';
    while (i < text.length && text[i] !== ' ') {
      value += text[i];
      i += 1;
    }
    args.push(value);
  }
  return args;
}

function parseUidSet(set) {
  const uids = new Set();
  for (const piece of String(set).split(',')) {
    if (piece === '') continue;
    const range = /^(\d+):(\d+)$/.exec(piece);
    if (range !== null) {
      const from = Math.min(Number(range[1]), Number(range[2]));
      const to = Math.max(Number(range[1]), Number(range[2]));
      for (let uid = from; uid <= to && uid - from < 5000; uid += 1) uids.add(uid);
    } else if (/^\d+$/.test(piece)) {
      uids.add(Number(piece));
    }
  }
  return uids;
}

/**
 * Start a fake IMAP server.
 *
 * @param {object} [options]
 * @param {string} [options.greeting]
 * @param {string[]} [options.capabilities]
 * @param {{user: string, pass: string}} [options.auth]
 * @param {Array<{uid: number, raw: string|Buffer, flags?: string[], internalDate?: string}>} [options.messages]
 * @param {boolean} [options.starttls=false]
 * @param {boolean} [options.implicitTls=false]
 * @param {boolean} [options.idSupported=true]
 * @param {boolean} [options.requireId=false] - SELECT fails until ID has been sent (163 behaviour).
 * @param {'greeting'|'select'|'fetch'|null} [options.hangAt=null]
 * @returns {Promise<object>}
 */
export async function startFakeImap(options = {}) {
  const config = {
    user: 'receiver@example.com',
    pass: 'secret',
    messages: [],
    starttls: false,
    implicitTls: false,
    idSupported: true,
    requireId: false,
    hangAt: null,
    uidValidity: 111,
    uidNext: null,
    ...options,
  };
  const baseCapabilities = config.capabilities
    ?? ['IMAP4rev1', 'AUTH=PLAIN', config.idSupported ? 'ID' : null].filter(Boolean);
  const capabilitiesFor = (secure) => {
    if (config.starttls && !secure) {
      return baseCapabilities.some((item) => item.toUpperCase() === 'STARTTLS')
        ? baseCapabilities
        : [...baseCapabilities, 'STARTTLS'];
    }
    return baseCapabilities;
  };
  const greetingFor = (secure) => config.greeting
    ?? `* OK [CAPABILITY ${capabilitiesFor(secure).join(' ')}] fake.imap ready`;
  const secureContext = testSecureContext();
  const sockets = new Set();
  const state = {
    commands: [],
    ids: [],
    fetches: [],
    stores: [],
    logins: 0,
    messages: config.messages.map((message) => ({
      uid: message.uid,
      raw: Buffer.isBuffer(message.raw) ? message.raw : Buffer.from(String(message.raw), 'utf8'),
      flags: message.flags ?? [],
      internalDate: message.internalDate ?? '12-Nov-2026 10:00:00 +0800',
      seq: 0,
    })),
  };
  state.messages.forEach((message, index) => {
    message.seq = index + 1;
  });

  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };

  const attach = (socket, { secure, sendGreeting = true }) => {
    const context = { secure, authenticated: false, idSent: false };
    let buffer = '';
    const send = (line) => socket.write(`${line}\r\n`);
    const sendBuffer = (data) => socket.write(data);

    const handle = (line) => {
      state.commands.push(line);
      // Non-ASCII LOGIN: client uses IMAP literals; literal payloads are NOT
      // normal command lines, so they are handled before generic tag parsing.
      if (context.literalStage === 'user') {
        const literalUser = /^(.*) \{(\d+)\}$/.exec(line);
        if (literalUser === null) {
          context.literalStage = null;
          send(`${context.literalTag ?? '*'} BAD malformed literal LOGIN`);
          return;
        }
        context.literalUser = Buffer.from(literalUser[1], 'latin1').toString('utf8');
        context.literalStage = 'pass';
        send('+ Ready for literal data');
        return;
      }
      if (context.literalStage === 'pass') {
        const password = Buffer.from(line, 'latin1').toString('utf8');
        context.literalStage = null;
        if (context.literalUser === config.auth.user && password === config.auth.pass) {
          context.authenticated = true;
          state.logins += 1;
          send(`${context.literalTag} OK LOGIN completed`);
        } else {
          send(`${context.literalTag} NO [AUTHENTICATIONFAILED] Authentication failed`);
        }
        return;
      }
      const match = /^(A\d+|\S+) (.*)$/.exec(line);
      if (match === null) {
        send('* BAD malformed command');
        return;
      }
      const [, tag, command] = match;
      const upper = command.toUpperCase();
      const literalLogin = /^(A\d+) LOGIN \{(\d+)\}$/.exec(line);
      if (literalLogin !== null) {
        context.literalTag = literalLogin[1];
        context.literalStage = 'user';
        send('+ Ready for literal data');
        return;
      }
      if (upper.startsWith('CAPABILITY')) {
        send(`* CAPABILITY ${capabilitiesFor(context.secure).join(' ')}`);
        send(`${tag} OK CAPABILITY completed`);
        return;
      }
      if (upper.startsWith('LOGIN')) {
        const args = parseImapArgs(command.slice(5).trim());
        if (args.length >= 2 && args[0] === config.auth.user && args[1] === config.auth.pass) {
          context.authenticated = true;
          state.logins += 1;
          send(`${tag} OK LOGIN completed`);
        } else {
          send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
        }
        return;
      }
      if (upper === 'STARTTLS') {
        if (!config.starttls || context.secure) {
          send(`${tag} BAD STARTTLS not available`);
          return;
        }
        send(`${tag} OK Begin TLS negotiation now`);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
        track(secureSocket);
        attach(secureSocket, { secure: true, sendGreeting: false });
        return;
      }
      if (!context.authenticated) {
        send(`${tag} NO Not authenticated`);
        return;
      }
      if (upper.startsWith('ID')) {
        state.ids.push(command);
        if (!config.idSupported) {
          send(`${tag} BAD ID not supported`);
          return;
        }
        context.idSent = true;
        send('* ID ("name" "fake-imap")');
        send(`${tag} OK ID completed`);
        return;
      }
      if (upper.startsWith('SELECT') || upper.startsWith('EXAMINE')) {
        if (config.hangAt === 'select') return;
        if (config.requireId && !context.idSent) {
          send(`${tag} NO [PRIVACYREQUIRED] IMAP ID command required`);
          return;
        }
        const readOnly = upper.startsWith('EXAMINE');
        send(`* ${state.messages.length} EXISTS`);
        send('* 0 RECENT');
        send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
        send(`* OK [UIDVALIDITY ${config.uidValidity}] UIDs valid`);
        const uidNext = config.uidNext ?? Math.max(0, ...state.messages.map((message) => message.uid)) + 1;
        send(`* OK [UIDNEXT ${uidNext}] Predicted next UID`);
        send('* OK [UNSEEN 1] First unseen');
        send('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted)] Limited');
        send(`${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
        return;
      }
      if (upper.startsWith('UID SEARCH')) {
        const criteria = command.slice('UID SEARCH'.length).trim();
        let uids = state.messages.map((message) => message.uid);
        const uidRange = /^UID (\d+):\*$/i.exec(criteria);
        if (criteria.toUpperCase() === 'UNSEEN') {
          uids = state.messages.filter((message) => !message.flags.includes('\\Seen')).map((message) => message.uid);
        } else if (uidRange !== null) {
          const from = Number(uidRange[1]);
          uids = uids.filter((uid) => uid >= from);
        } else if (criteria.toUpperCase() !== 'ALL') {
          send(`${tag} BAD unsupported search criteria`);
          return;
        }
        uids.sort((a, b) => a - b);
        send(uids.length === 0 ? '* SEARCH' : `* SEARCH ${uids.join(' ')}`);
        send(`${tag} OK SEARCH completed`);
        return;
      }
      if (upper.startsWith('UID FETCH')) {
        const rest = command.slice('UID FETCH'.length).trim();
        const setMatch = /^([\d,:]+)\s+(.*)$/.exec(rest);
        if (setMatch === null) {
          send(`${tag} BAD malformed FETCH`);
          return;
        }
        const wanted = parseUidSet(setMatch[1]);
        const items = setMatch[2].toUpperCase();
        state.fetches.push({ uids: [...wanted].sort((a, b) => a - b), items });
        if (config.hangAt === 'fetch') return;
        const headersOnly = items.includes('BODY.PEEK[HEADER]') || items.includes('BODY[HEADER]');
        const wantBody = headersOnly || items.includes('BODY.PEEK[]') || items.includes('BODY[]');
        for (const message of state.messages) {
          if (!wanted.has(message.uid)) continue;
          const raw = message.raw;
          const separator = raw.indexOf('\r\n\r\n');
          const headerLength = separator === -1 ? raw.length : separator + 4;
          const payload = headersOnly ? raw.subarray(0, headerLength) : raw;
          let head = `* ${message.seq} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}) INTERNALDATE "${message.internalDate}" RFC822.SIZE ${raw.length}`;
          if (wantBody) {
            head += ` BODY[] {${payload.length}}\r\n`;
            sendBuffer(Buffer.from(head, 'latin1'));
            sendBuffer(payload);
            sendBuffer(Buffer.from(')\r\n', 'latin1'));
          } else {
            head += ')\r\n';
            sendBuffer(Buffer.from(head, 'latin1'));
          }
        }
        send(`${tag} OK FETCH completed`);
        return;
      }
      if (upper.startsWith('UID STORE')) {
        const rest = command.slice('UID STORE'.length).trim();
        const storeMatch = /^([\d,:]+)\s+([+-]?FLAGS)\s+\((.*)\)$/i.exec(rest);
        if (storeMatch === null) {
          send(`${tag} BAD malformed STORE`);
          return;
        }
        const wanted = parseUidSet(storeMatch[1]);
        const mode = storeMatch[2].toUpperCase();
        const flags = storeMatch[3].split(/\s+/).filter(Boolean);
        state.stores.push({ uids: [...wanted], mode, flags });
        for (const message of state.messages) {
          if (!wanted.has(message.uid)) continue;
          if (mode === '+FLAGS') message.flags = [...new Set([...message.flags, ...flags])];
          else if (mode === '-FLAGS') message.flags = message.flags.filter((flag) => !flags.includes(flag));
          else message.flags = [...flags];
          send(`* ${message.seq} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}))`);
        }
        send(`${tag} OK STORE completed`);
        return;
      }
      if (upper === 'NOOP' || upper === 'CHECK') {
        send(`${tag} OK completed`);
        return;
      }
      if (upper === 'LOGOUT') {
        send('* BYE fake.imap logging out');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
        return;
      }
      send(`${tag} BAD unknown command: ${command.slice(0, 40)}`);
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });
    if (sendGreeting && config.hangAt !== 'greeting') send(greetingFor(context.secure));
  };

  const server = config.implicitTls
    ? tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
      track(socket);
      attach(socket, { secure: true });
    })
    : net.createServer((socket) => {
      track(socket);
      attach(socket, { secure: false });
    });
  const port = await listenOn(server);

  return {
    port,
    get commands() {
      return state.commands;
    },
    get ids() {
      return state.ids;
    },
    get fetches() {
      return state.fetches;
    },
    get stores() {
      return state.stores;
    },
    get logins() {
      return state.logins;
    },
    get messages() {
      return state.messages;
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** Wait a short time (used to assert non-completion / let abort fire). */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
