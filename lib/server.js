/**
 * dsh-mailbox internal HTTP channel: the browser half of the plugin talks to
 * the host half through one same-origin JSON endpoint. This is NOT a web UI and
 * NOT a separate server — the route is registered on the existing DSH web
 * server and only accepts same-origin requests carrying a private header.
 *
 * Security controls implemented here:
 *  - same-origin enforcement (Sec-Fetch-Site / Origin vs Host)
 *  - POST requires `x-dsh-mailbox: 1` + `application/json` (blocks cross-site
 *    form posts and simple cross-origin requests)
 *  - allow-listed actions and methods only
 *  - bounded request bodies (1 MB) and a global request rate limit
 *  - `no-store` responses, sanitized error messages, no secrets in errors
 *
 * @module dsh-mailbox/lib/server
 */

/**
 * Single endpoint path. Registered on the host's authenticated Fetch routing
 * (`ctx.connection.fetch.register`, under `/api/`) so every request already
 * carries the host session cookie/authorization; the old raw webServer route is
 * kept only as a same-origin fallback for compositions without `connection`.
 */
export const API_PATH = '/api/mailbox';
/** CSRF fence header; a cross-site form cannot set it and a cross-origin fetch preflights. */
export const API_HEADER = 'x-dsh-mailbox';
/** Upper bound for one ordinary request body (configuration and compose payloads). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Larger bound for `mail.send` (base64 attachments); decoded attachment bytes are capped separately. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Per-action request body budget. */
export function bodyLimitFor(action) {
  return action === 'mail.send' ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
}
/** Read-only actions available over GET. */
export const READ_ACTIONS = new Set([
  'state',
  'messages',
  'message',
  'friends',
  'presets',
  'sessions',
  'diagnostics',
  'health',
]);
/** Mutating actions available over POST. */
export const WRITE_ACTIONS = new Set([
  'config.save',
  'config.reset',
  'test.smtp',
  'test.imap',
  'friends.add',
  'friends.remove',
  'friends.update',
  'friends.approve',
  'friends.reject',
  'message.read',
  'message.delete',
  'sync.now',
  'notify.test',
  'mail.send',
  'data.clear',
]);

/** Stable public error codes. */
export const ERROR_CODES = {
  BAD_REQUEST: 'bad-request',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  INPUT_INVALID: 'input-invalid',
  NOT_CONFIGURED: 'not-configured',
  SMTP_FAILED: 'smtp-failed',
  IMAP_FAILED: 'imap-failed',
  RATE_LIMITED: 'rate-limited',
  INTERNAL: 'internal',
};

/** Build one public error; `message` must already be safe to show. */
export function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.expose = true;
  return error;
}

/** Map a public error code to its HTTP status. */
export function statusForCode(code) {
  switch (code) {
    case ERROR_CODES.FORBIDDEN: return 403;
    case ERROR_CODES.NOT_FOUND: return 404;
    case ERROR_CODES.INPUT_INVALID:
    case ERROR_CODES.BAD_REQUEST:
    case ERROR_CODES.NOT_CONFIGURED: return 400;
    case ERROR_CODES.RATE_LIMITED: return 429;
    case ERROR_CODES.SMTP_FAILED:
    case ERROR_CODES.IMAP_FAILED: return 502;
    default: return 500;
  }
}

/** Send a JSON response with security headers. */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/** Read a bounded UTF-8 request body (drains oversized bodies so the 413 can be sent). */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(apiError(ERROR_CODES.BAD_REQUEST, '请求体超过 1 MB 上限'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => reject(error));
  });
}

/**
 * Same-origin fence. Rejects cross-site navigation/fetch and any request whose
 * Origin belongs to a different host.
 *
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} whether the request may proceed.
 */
export function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  const fetchMode = req.headers['sec-fetch-mode'];
  // Browsers send sec-fetch-mode for fetch/XHR; navigation requests have no
  // purpose hitting this JSON endpoint, so reject document loads outright.
  if (fetchMode === 'navigate') return false;
  return true;
}

/**
 * Create the route handler bound to the plugin services.
 *
 * The services object is the plugin host half built by `index.js`; every method
 * receives already-validated parameters and must return JSON-serializable data
 * or throw an `apiError`. Secrets never leave this boundary.
 *
 * @param {object} options - wiring.
 * @param {object} options.services - dispatch target (see index.js createServices).
 * @param {() => boolean} [options.isEnabled] - plugin master switch state.
 * @param {number} [options.rateLimitPerMinute] - global request budget.
 * @param {(line: string) => void} [options.log] - diagnostic logger.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(options) {
  const { services } = options;
  const isEnabled = options.isEnabled ?? (() => true);
  const log = options.log ?? (() => {});
  const limitPerMinute = Number.isInteger(options.rateLimitPerMinute) ? Math.max(10, options.rateLimitPerMinute) : 300;
  const windowMs = 60 * 1000;
  let windowStart = Date.now();
  let windowCount = 0;

  /** Global request budget; the UI is the only caller. */
  function admitRequest() {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= limitPerMinute;
  }

  /** Dispatch one action with parameters. */
  async function dispatch(action, params) {
    if (typeof action !== 'string' || action === '') {
      throw apiError(ERROR_CODES.BAD_REQUEST, '缺少 action 参数');
    }
    if (typeof services.dispatch !== 'function') throw apiError(ERROR_CODES.INTERNAL, '插件服务未就绪');
    return services.dispatch(action, params, { enabled: isEnabled() });
  }

  /** Map an internal error to a safe public payload. */
  function publicError(error) {
    const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.INTERNAL;
    const exposed = error?.expose === true;
    if (!exposed) log(`[dsh-mailbox] api error: ${error?.stack ?? error}`);
    const message = exposed ? String(error.message) : '插件内部错误，详情见宿主日志';
    return { code, message };
  }

  return async function handle(req, res) {
    try {
      if (typeof options.authorize === 'function') {
        const rejection = options.authorize(req);
        if (rejection !== null && rejection !== undefined) {
          sendJson(res, rejection.status ?? 401, { ok: false, error: { code: rejection.code ?? ERROR_CODES.FORBIDDEN, message: rejection.message ?? '未授权' } });
          return;
        }
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: '跨源请求被拒绝' } });
        return;
      }
      if (!admitRequest()) {
        sendJson(res, 429, { ok: false, error: { code: ERROR_CODES.RATE_LIMITED, message: '请求过于频繁，请稍后再试' } });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET') {
        const action = url.searchParams.get('action') ?? 'state';
        if (!READ_ACTIONS.has(action)) {
          sendJson(res, 400, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: `不支持的操作：${action}` } });
          return;
        }
        const params = Object.fromEntries(url.searchParams.entries());
        delete params.action;
        const data = await dispatch(action, params);
        sendJson(res, 200, { ok: true, ...data });
        return;
      }

      if (req.method === 'POST') {
        const header = req.headers[API_HEADER];
        if (header !== '1') {
          sendJson(res, 403, { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: '缺少请求校验头' } });
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\b/i.test(contentType)) {
          sendJson(res, 415, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '只接受 application/json' } });
          return;
        }
        let raw;
        try {
          raw = await readBody(req, MAX_UPLOAD_BYTES);
        } catch (error) {
          sendJson(res, 413, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: error.message } });
          return;
        }
        let body;
        try {
          body = raw === '' ? {} : JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体不是合法 JSON' } });
          return;
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体必须是对象' } });
          return;
        }
        const { action, ...params } = body;
        if (typeof action !== 'string' || !WRITE_ACTIONS.has(action)) {
          sendJson(res, 400, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: `不支持的操作：${String(action)}` } });
          return;
        }
        if (Buffer.byteLength(raw, 'utf8') > bodyLimitFor(action)) {
          sendJson(res, 413, { ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体超过该操作的大小上限' } });
          return;
        }
        const data = await dispatch(action, params);
        sendJson(res, 200, { ok: true, ...data });
        return;
      }

      res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '只支持 GET / POST' } }));
    } catch (error) {
      try {
        const payload = publicError(error);
        sendJson(res, statusForCode(payload.code), { ok: false, error: payload });
      } catch {
        // The socket may already be gone; nothing else to do.
      }
    }
  };
}

/** JSON response helper for the Fetch handler. */
function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

/** Read a bounded body from a Fetch Request. */
async function readFetchBody(request, limitBytes) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw apiError(ERROR_CODES.BAD_REQUEST, '请求体超过 1 MB 上限');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > limitBytes) {
    throw apiError(ERROR_CODES.BAD_REQUEST, '请求体超过 1 MB 上限');
  }
  return text;
}

/**
 * Create the authenticated Fetch handler used by `ctx.connection.fetch.register`.
 *
 * The host's Fetch routing already enforces the session cookie and same-origin
 * policy (cross-origin → 403, missing auth → 401); this handler adds the
 * plugin's own CSRF fence header, action allow-list, body limit and rate limit.
 *
 * @param {object} options - wiring (same service contract as createApiHandler).
 * @returns {(request: Request) => Promise<Response>}
 */
export function createFetchHandler(options) {
  const { services } = options;
  const isEnabled = options.isEnabled ?? (() => true);
  const log = options.log ?? (() => {});
  const limitPerMinute = Number.isInteger(options.rateLimitPerMinute) ? Math.max(10, options.rateLimitPerMinute) : 300;
  const windowMs = 60 * 1000;
  let windowStart = Date.now();
  let windowCount = 0;

  function admitRequest() {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= limitPerMinute;
  }

  async function dispatch(action, params) {
    if (typeof services.dispatch !== 'function') throw apiError(ERROR_CODES.INTERNAL, '插件服务未就绪');
    return services.dispatch(action, params, { enabled: isEnabled() });
  }

  /** Map an internal error to a safe public payload. */
  function publicError(error) {
    const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.INTERNAL;
    if (error?.expose !== true) log(`[dsh-mailbox] api error: ${error?.stack ?? error}`);
    return { code, message: error?.expose === true ? String(error.message) : '插件内部错误，详情见宿主日志' };
  }

  return async function handleFetch(request) {
    try {
      if (!(request.method === 'GET' || request.method === 'HEAD' || request.method === 'POST')) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '只支持 GET / HEAD / POST' } }, 405, { allow: 'GET, HEAD, POST' });
      }
      if (!admitRequest()) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.RATE_LIMITED, message: '请求过于频繁，请稍后再试' } }, 429);
      }
      const url = new URL(request.url);
      const isHead = request.method === 'HEAD';

      if (request.method === 'GET' || isHead) {
        const action = url.searchParams.get('action') ?? 'state';
        if (!READ_ACTIONS.has(action)) {
          return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: `不支持的操作：${action}` } }, 400);
        }
        const params = Object.fromEntries(url.searchParams.entries());
        delete params.action;
        const data = await dispatch(action, params);
        const response = jsonResponse({ ok: true, ...data });
        return isHead ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }

      // POST
      if (request.headers.get(API_HEADER) !== '1') {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: '缺少请求校验头' } }, 403);
      }
      const contentType = request.headers.get('content-type') ?? '';
      if (!/^application\/json\b/i.test(contentType)) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '只接受 application/json' } }, 415);
      }
      let raw;
      try {
        raw = await readFetchBody(request, MAX_UPLOAD_BYTES);
      } catch (error) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: error.message } }, 413);
      }
      let body;
      try {
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体不是合法 JSON' } }, 400);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体必须是对象' } }, 400);
      }
      const { action, ...params } = body;
      if (typeof action !== 'string' || !WRITE_ACTIONS.has(action)) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: `不支持的操作：${String(action)}` } }, 400);
      }
      if (Buffer.byteLength(raw, 'utf8') > bodyLimitFor(action)) {
        return jsonResponse({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体超过该操作的大小上限' } }, 413);
      }
      const data = await dispatch(action, params);
      return jsonResponse({ ok: true, ...data });
    } catch (error) {
      const payload = publicError(error);
      return jsonResponse({ ok: false, error: payload }, statusForCode(payload.code));
    }
  };
}
