import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiHandler, isSameOrigin, apiError, API_HEADER } from '../../lib/server.js';

function makeReq({ method = 'GET', url = '/dsh-mailbox/api', headers = {}, body = null } = {}) {
  const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  const req = Object.assign(stream, {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
  });
  return req;
}

class FakeRes {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = '';
    this.writableEnded = false;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  }

  end(chunk) {
    if (chunk !== undefined) this.body += String(chunk);
    this.writableEnded = true;
  }
}

async function call(handler, req) {
  const res = new FakeRes();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
}

const sameOriginHeaders = { origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

function makeServices() {
  const calls = [];
  return {
    calls,
    dispatch: async (action, params) => {
      calls.push({ action, params });
      if (params.fail === 'exposed') throw apiError('imap-failed', 'IMAP 连接失败：认证被拒绝');
      if (params.fail === 'internal') throw new Error('internal detail that must not leak');
      if (action === 'state') return { state: { enabled: true } };
      return { accepted: true, action };
    },
  };
}

test('isSameOrigin rejects cross-site, cross-origin and navigation requests', () => {
  assert.equal(isSameOrigin({ headers: { host: 'h', 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(isSameOrigin({ headers: { host: 'h', 'sec-fetch-site': 'same-site' } }), false);
  assert.equal(isSameOrigin({ headers: { host: 'h', origin: 'http://evil.test' } }), false);
  assert.equal(isSameOrigin({ headers: { host: 'h', 'sec-fetch-mode': 'navigate' } }), false);
  assert.equal(isSameOrigin({ headers: { host: 'h', 'sec-fetch-site': 'same-origin', origin: 'http://h' } }), true);
  assert.equal(isSameOrigin({ headers: { host: 'h' } }), true);
});

test('GET read actions are served and mutating actions are refused', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const read = await call(handler, makeReq({ url: '/dsh-mailbox/api?action=state', headers: sameOriginHeaders }));
  assert.equal(read.status, 200);
  assert.equal(read.json.ok, true);
  assert.deepEqual(read.json.state, { enabled: true });
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.headers['x-content-type-options'], 'nosniff');

  const mutating = await call(handler, makeReq({ url: '/dsh-mailbox/api?action=config.save', headers: sameOriginHeaders }));
  assert.equal(mutating.status, 400);
  assert.equal(mutating.json.ok, false);
});

test('cross-site requests are rejected before dispatch', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const result = await call(handler, makeReq({ url: '/dsh-mailbox/api?action=state', headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(result.status, 403);
  assert.equal(result.json.error.code, 'forbidden');
  assert.equal(services.calls.length, 0);
});

test('POST requires the CSRF fence header and JSON content type', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const noHeader = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'config.save', enabled: false }),
  }));
  assert.equal(noHeader.status, 403);

  const wrongType = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'text/plain' },
    body: '{}',
  }));
  assert.equal(wrongType.status, 415);

  const badAction = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'not.allowed' }),
  }));
  assert.equal(badAction.status, 400);
  assert.equal(services.calls.length, 0);
});

test('POST dispatches allow-listed actions with parameters', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const result = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'config.save', patch: { enabled: false } }),
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(services.calls, [{ action: 'config.save', params: { patch: { enabled: false } } }]);
});

test('service errors are mapped to stable codes without leaking internals', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services, log: () => {} });
  const exposed = await call(handler, makeReq({
    method: 'GET',
    url: '/dsh-mailbox/api?action=message&id=x&fail=exposed',
    headers: sameOriginHeaders,
  }));
  assert.equal(exposed.status, 502);
  assert.equal(exposed.json.error.code, 'imap-failed');
  assert.match(exposed.json.error.message, /IMAP 连接失败/);

  const internal = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sync.now', fail: 'internal' }),
  }));
  assert.equal(internal.status, 500);
  assert.equal(internal.json.error.code, 'internal');
  assert.ok(!internal.json.error.message.includes('internal detail'));
});

test('ordinary actions reject bodies over 1 MB; mail.send accepts upload-sized bodies', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const big = 'x'.repeat(1024 * 1024 + 10);
  const ordinary = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'config.save', patch: { extraNote: big } }),
  }));
  assert.equal(ordinary.status, 413);
  assert.equal(services.calls.length, 0);

  // Attachment payloads may exceed 1 MB for mail.send (decoded size is capped in the service).
  const upload = await call(handler, makeReq({
    method: 'POST',
    headers: { ...sameOriginHeaders, [API_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'mail.send', content: 'hi', attachments: [{ filename: 'a.pdf', base64: big }] }),
  }));
  assert.equal(upload.status, 200);
});

test('unsupported methods are rejected with 405', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services });
  const result = await call(handler, makeReq({ method: 'PUT', headers: sameOriginHeaders }));
  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, 'GET, POST');
});

test('global request budget returns 429 after the limit', async () => {
  const services = makeServices();
  const handler = createApiHandler({ services, rateLimitPerMinute: 10 });
  let last = null;
  for (let i = 0; i < 12; i += 1) {
    last = await call(handler, makeReq({ url: '/dsh-mailbox/api?action=state', headers: sameOriginHeaders }));
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'rate-limited');
});
