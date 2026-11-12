/**
 * dsh-mailprobe — host-API 调研探针（**仅用于 /tmp 隔离测试 profile，禁止进生产**）。
 *
 * 它把自己挂在 DSH 宿主里，用 HTTP 端点暴露"这个宿主到底给了插件什么"：
 *   1. ctx.webServer.register 的自建路由是否经过宿主鉴权（对照实验 A）；
 *   2. ctx.connection.fetch.register 的 /api 精确路由是否强制浏览器鉴权（实验 B）；
 *   3. ctx.connection.requestRejection / admit 对裸 HTTP 请求的判定（实验 C）；
 *   4. ctx.tools.register / ctx.systemPrompt.section 的注销-重注册与重名冲突（实验 D）；
 *   5. ctx.get('agents') 的真实 API 面 + 往会话注入消息（实验 E）；
 *   6. ctx.setInterval / ctx.effect / logger / skills / sessions / sessionTitle 可用性（诊断）。
 *
 * 设计约束：不 import 任何 @deepseek-ai/*（验证 SPEC §10 的零依赖约束），只用 node: 内置模块。
 *
 * 端点（都在宿主 HTTP 端口上）：
 *   GET  /mailprobe/diag                 全量能力诊断 JSON（无需鉴权，便于 curl）
 *   GET  /mailprobe/plain                实验 A/C：webServer 自建路由 + requestRejection/admit
 *   POST /mailprobe/plain                同上，带请求体回显（实验 A：body 读取/上限）
 *   GET  /mailprobe/throw                实验 A：handler 抛异常时宿主返回什么
 *   GET  /api/mailprobe                  实验 B：connection.fetch 精确路由（**需宿主登录 cookie**）
 *   POST /api/mailprobe                  同上，body 回显 + 自定义头回显
 *   POST /mailprobe/tool?on=1|0          实验 D：工具热注册/注销；on=dup 触发重名冲突
 *   POST /mailprobe/prompt?on=1|0        实验 D：系统提示词 section 热注册/注销；on=dup 触发重名
 *   POST /mailprobe/session             实验 E：{op:'create'|'inject'|'followup'|'list'|'dispose'|'controller-list'|'prompt'|'eventlog'}
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

export const name = 'mailprobe';

/** 只声明硬依赖；connection / agents / sessionController 等用 ctx.get 可选探测。 */
export const inject = ['webServer', 'tools', 'systemPrompt'];

const DIAG_PATH = '/mailprobe/diag';
const PLAIN_PATH = '/mailprobe/plain';
const THROW_PATH = '/mailprobe/throw';
const SESSION_PATH = '/mailprobe/session';
const TOOL_PATH = '/mailprobe/tool';
const PROMPT_PATH = '/mailprobe/prompt';
/** connection.fetch 精确路由必须落在 /api 下（endpointFromPath 约束）。 */
const API_PATH = '/api/mailprobe';
/** 探针自己的请求体上限，模拟插件 1MB 预算。 */
const BODY_LIMIT = 1024 * 1024;
/** 探针用的 systemPrompt section 名（与正式插件错开）。 */
const SECTION_NAME = 'plugin:mailprobe';
const SECTION_ORDER = 10060;
const TOOL_NAME = 'mail_probe_status';

/** 进程内探针状态；测试进程重启即清零。 */
const state = {
  contractChecks: {},
  toolDispose: undefined,
  promptDispose: undefined,
  agentEvents: [],
  handles: new Map(),
  lastSessionId: undefined,
  deliveries: [],
};

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** 取服务但不抛（服务未 ACTIVE / 不存在都返回 undefined）。 */
function svc(ctx, serviceName) {
  try {
    return ctx.get(serviceName);
  } catch {
    return undefined;
  }
}

/** 服务方法面快照。 */
function surface(value, methods) {
  if (value === undefined || value === null) return { available: false };
  const out = { available: true };
  for (const method of methods) out[method] = typeof value[method];
  return out;
}

/** 写一个 JSON 响应（node:http）。 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * 读取有上限的请求体，返回 { text } 或 { tooLarge, size }。
 *
 * 超限时**不要**立刻 req.destroy()：那会连响应也一起掐掉，客户端只看到空响应 /
 * ECONNRESET，而不是干净的 413。这里改为停止收集并 resume() 排空剩余字节。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        resolve({ tooLarge: true, size });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString('utf8'), size });
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 解析 Cookie 头。 */
function cookieNames(header) {
  if (typeof header !== 'string' || header === '') return [];
  return header.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean);
}

/** 对裸 node:http 请求跑 connection 的信任/鉴权判定，返回可 JSON 化的结果。 */
function connectionJudgement(ctx, req) {
  const connection = svc(ctx, 'connection');
  const out = { connectionAvailable: connection !== undefined };
  if (connection === undefined) return out;
  try {
    out.requestRejection = connection.requestRejection(req) ?? null;
  } catch (error) {
    out.requestRejection = 'threw: ' + String(error?.message ?? error);
  }
  try {
    const admission = connection.admit(req);
    if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
      out.admit = { rejection: admission.rejection };
    } else if (admission !== null && typeof admission === 'object' && 'peer' in admission) {
      out.admit = {
        peerId: admission.peer?.id,
        principal: admission.peer?.principal,
        interactions: admission.peer?.interactions,
      };
    } else {
      out.admit = 'unexpected: ' + JSON.stringify(admission);
    }
  } catch (error) {
    out.admit = 'threw: ' + String(error?.message ?? error);
  }
  return out;
}

/** 请求摘要，避免把 cookie 值本身回显出去。 */
function requestSummary(req) {
  return {
    method: req.method,
    url: req.url,
    host: req.headers.host ?? null,
    origin: req.headers.origin ?? null,
    secFetchSite: req.headers['sec-fetch-site'] ?? null,
    secFetchMode: req.headers['sec-fetch-mode'] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    cookieHeaderPresent: typeof req.headers.cookie === 'string',
    cookieNames: cookieNames(req.headers.cookie),
    customHeader: req.headers['x-dsh-mailbox'] ?? null,
    contentType: req.headers['content-type'] ?? null,
    contentLength: req.headers['content-length'] ?? null,
  };
}

/** 构造一条"插件通知型" user 消息：唯一 id + producer-owned source kind + notice form。 */
function pluginMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:dsh-mailbox',
      form: 'notice',
      summary: summary.slice(0, 120),
    },
  };
}

/* ────────────────────────────── 插件入口 ────────────────────────────── */

/**
 * 插件入口。`config` 仅用于标记探针（真插件不走这条路径）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主插件上下文（运行时对象，不 import 类型）。
 * @param {object} [config] - 探针配置（保留，未使用）。
 */
export function apply(ctx, config = {}) {
  const probeStart = Date.now();
  mkdirSync('/tmp/dsh-maildev/workspace', { recursive: true });

  /** 诊断日志走宿主 logger；没有 logger 时退 console。 */
  function log(line) {
    try {
      ctx.logger('mailprobe').info(line);
    } catch {
      // eslint-disable-next-line no-console
      console.log('[mailprobe] ' + line);
    }
  }

  log('probe plugin applying (pid ' + process.pid + ')');

  /* ── 实验 D：工具注册 ───────────────────────────────────────────── */

  function registerProbeTool() {
    if (state.toolDispose !== undefined) return { already: true };
    try {
      const dispose = ctx.tools.register({
        name: TOOL_NAME,
        description: 'Mailbox probe status tool: returns the probe process pid and uptime. Test-only.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { pid: { type: 'number' }, uptimeMs: { type: 'number' } },
            required: ['pid', 'uptimeMs'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: 'mailprobe pid=' + value.pid }],
        },
        async execute() {
          return { pid: process.pid, uptimeMs: Date.now() - probeStart };
        },
      });
      state.toolDispose = dispose;
      return { registered: true };
    } catch (error) {
      return { registered: false, error: String(error?.message ?? error) };
    }
  }

  function unregisterProbeTool() {
    if (typeof state.toolDispose !== 'function') return { wasRegistered: false };
    try {
      state.toolDispose();
    } catch (error) {
      return { wasRegistered: true, error: String(error?.message ?? error) };
    }
    state.toolDispose = undefined;
    return { wasRegistered: true, unregistered: true };
  }

  function duplicateToolTest() {
    registerProbeTool();
    try {
      ctx.tools.register({
        name: TOOL_NAME,
        description: 'duplicate registration probe',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output: { schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, render: () => [{ type: 'text', text: 'dup' }] },
        async execute() {
          return {};
        },
      });
      return { duplicateThrew: false };
    } catch (error) {
      return { duplicateThrew: true, error: String(error?.message ?? error) };
    }
  }

  /* ── 实验 D：系统提示词 section ─────────────────────────────────── */

  function registerProbePrompt() {
    if (state.promptDispose !== undefined) return { already: true };
    try {
      const dispose = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        // 函数形态：每次 assemble 时求值 → 配置变化无需 dispose→重注册。
        text: () => 'MAILPROBE_SECTION one="宿主插件 API 探针" dynamic=' + Date.now(),
      });
      state.promptDispose = dispose;
      return { registered: true };
    } catch (error) {
      return { registered: false, error: String(error?.message ?? error) };
    }
  }

  function unregisterProbePrompt() {
    if (typeof state.promptDispose !== 'function') return { wasRegistered: false };
    try {
      state.promptDispose();
    } catch (error) {
      return { wasRegistered: true, error: String(error?.message ?? error) };
    }
    state.promptDispose = undefined;
    return { wasRegistered: true, unregistered: true };
  }

  function duplicatePromptTest() {
    registerProbePrompt();
    try {
      ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: 'dup' });
      return { duplicateThrew: false };
    } catch (error) {
      return { duplicateThrew: true, error: String(error?.message ?? error) };
    }
  }

  /**
   * 真正跑一次 ctx.systemPrompt.assemble()（返回 Promise<PromptAssembly>），
   * 验证 section 文本进入装配结果（renderPrompt 是包级导出函数，不在服务上）。
   */
  async function assembleProbe() {
    try {
      if (typeof ctx.systemPrompt?.assemble !== 'function') return { assembled: false, error: 'assemble not a function' };
      const assembly = await ctx.systemPrompt.assemble({});
      const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
      const probeSection = sections.find((section) => section?.name === SECTION_NAME);
      return {
        assembled: true,
        sectionCount: sections.length,
        sectionNames: sections.map((section) => section?.name),
        probeSectionText: typeof probeSection?.text === 'string' ? probeSection.text.slice(0, 160) : null,
        toolSchemaCount: Array.isArray(assembly?.tools) ? assembly.tools.length : null,
      };
    } catch (error) {
      return { assembled: false, error: String(error?.message ?? error) };
    }
  }

  /* ── 实验 A/C：webServer 自建路由（不经宿主鉴权） ───────────────── */

  async function handlePlain(req, res) {
    const judgement = connectionJudgement(ctx, req);
    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, BODY_LIMIT);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: 'body exceeds ' + BODY_LIMIT + ' bytes' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        route: 'ctx.webServer.register',
        request: requestSummary(req),
        judgement,
        bodyBytes: body.size,
        bodyText: body.text.slice(0, 200),
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      route: 'ctx.webServer.register',
      reachedWithoutHostAuth: true,
      request: requestSummary(req),
      judgement,
    });
  }

  function handleThrow() {
    throw new Error('mailprobe: intentional handler throw');
  }

  /* ── 实验 B：connection.fetch 精确路由（宿主鉴权 + Host/Origin 围栏） ── */

  async function handleAuthenticatedApi(request) {
    const url = new URL(request.url);
    let bodyText;
    if (request.method === 'POST') {
      try {
        bodyText = await request.text();
      } catch (error) {
        return Response.json({ ok: false, error: 'body read failed: ' + String(error?.message ?? error) }, { status: 400 });
      }
      if (Buffer.byteLength(bodyText, 'utf8') > BODY_LIMIT) {
        return Response.json({ ok: false, error: 'body too large' }, { status: 413 });
      }
    }
    return Response.json({
      ok: true,
      route: 'ctx.connection.fetch.register',
      hostAuth: 'passed (only owner Peers reach this handler; no cookie rejected upstream with 401)',
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      headers: {
        origin: request.headers.get('origin'),
        referer: request.headers.get('referer'),
        contentType: request.headers.get('content-type'),
        customHeader: request.headers.get('x-dsh-mailbox'),
        cookiePresent: request.headers.get('cookie') !== null,
      },
      bodyText: typeof bodyText === 'string' ? bodyText.slice(0, 500) : null,
      bodyBytes: typeof bodyText === 'string' ? Buffer.byteLength(bodyText, 'utf8') : 0,
    });
  }

  /* ── 实验 E：agents / sessionController 会话探测 ─────────────────── */

  function agentIdOf(agent) {
    return agent?.session?.id ?? agent?.id ?? null;
  }

  async function sessionOp(body) {
    const agents = svc(ctx, 'agents');
    const controller = svc(ctx, 'sessionController');
    const op = typeof body?.op === 'string' ? body.op : 'surface';
    const base = {
      op,
      agents: surface(agents, ['list', 'roots', 'get', 'create', 'resume', 'register', 'withInitiator']),
      sessionController: surface(controller, ['list', 'prompt', 'resolveAgent', 'create']),
    };

    if (op === 'surface') return base;

    if (op === 'controller-list' && typeof controller?.list === 'function') {
      try {
        const result = await controller.list({}, AbortSignal.timeout(5000));
        return { ...base, items: (result?.items ?? []).map((item) => ({ ...item })) };
      } catch (error) {
        return { ...base, error: String(error?.message ?? error) };
      }
    }

    if (op === 'create') {
      if (agents === undefined) return { ...base, error: 'agents service missing' };
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : randomUUID();
      try {
        const handle = await agents.create({ sessionId, meta: { cwd: '/tmp/dsh-maildev/workspace' } });
        state.handles.set(sessionId, handle);
        state.lastSessionId = sessionId;
        return {
          ...base,
          created: true,
          sessionId,
          status: handle.agent.status,
          sessionSeq: handle.agent.session?.seq,
          header: handle.agent.session?.header,
          inbox: {
            nextTurn: handle.agent.inbox?.nextTurn?.length,
            nextStep: handle.agent.inbox?.nextStep?.length,
          },
        };
      } catch (error) {
        return { ...base, created: false, error: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6) };
      }
    }

    const targetId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : state.lastSessionId;
    const agent = targetId !== undefined ? agents?.get?.(targetId) : undefined;

    if (op === 'list') {
      return {
        ...base,
        agents: undefined,
        roots: (agents?.roots?.() ?? []).map((item) => ({ id: agentIdOf(item), status: item.status, seq: item.session?.seq })),
        all: (agents?.list?.() ?? []).map((item) => ({ id: agentIdOf(item), status: item.status, seq: item.session?.seq })),
      };
    }

    if (op === 'title') {
      const titleService = svc(ctx, 'sessionTitle');
      return {
        ...base,
        titleService: surface(titleService, ['get', 'rename', 'refresh']),
        title: titleService?.get?.(agent.session) ?? null,
      };
    }

    if (agent === undefined) return { ...base, sessionId: targetId ?? null, error: 'live agent not found for session; create first' };

    /** 避免探针触发真实模型请求：把模型选到不存在的 provider，让 step 准备快速失败。 */
    function forceOfflineModel() {
      try {
        agent.model?.select?.({ provider: 'mailprobe-offline', model: 'offline' });
        return { selected: true, current: agent.model?.current?.() ?? null };
      } catch (error) {
        return { selected: false, error: String(error?.message ?? error) };
      }
    }

    /** settle 之后读一次事件尾部，证明"这一轮到底起没起"。 */
    function eventsTail(limit = 12) {
      try {
        const events = agent.session.snapshotEvents();
        return events.slice(-limit).map((event) => ({ seq: event.seq, type: event.type, data: summariseEvent(event) }));
      } catch (error) {
        return 'eventlog failed: ' + String(error?.message ?? error);
      }
    }

    if (op === 'inject' || op === 'followup') {
      const text = typeof body?.text === 'string' && body.text !== '' ? body.text : '您有新的来信，请查收。（探针通知）';
      const summary = typeof body?.summary === 'string' && body.summary !== '' ? body.summary : 'mailprobe notice';
      const message = pluginMessage(text, summary);
      const before = { seq: agent.session?.seq, status: agent.status, nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length };
      const model = op === 'followup' && body?.offlineModel !== false ? forceOfflineModel() : undefined;
      if (op === 'inject') agent.inject(message);
      else agent.followup(message);
      const receivedAt = Date.now();
      if (op === 'followup') {
        const settleMs = Number.isFinite(Number(body?.settleMs)) ? Number(body.settleMs) : 1500;
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      return {
        ...base,
        op,
        sessionId: targetId,
        message,
        model,
        before,
        after: { seq: agent.session?.seq, status: agent.status, nextStep: agent.inbox?.nextStep?.length, nextTurn: agent.inbox?.nextTurn?.length },
        wallMs: Date.now() - receivedAt,
        eventsTail: eventsTail(),
        agentEvents: state.agentEvents.filter((entry) => entry.id === targetId).slice(-20),
      };
    }

    if (op === 'prompt' && typeof controller?.prompt === 'function') {
      const model = body?.offlineModel === false ? undefined : forceOfflineModel();
      try {
        const value = await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId: targetId,
            mode: 'queue',
            content: [{ type: 'text', text: typeof body?.text === 'string' ? body.text : 'controller prompt probe' }],
          },
          AbortSignal.timeout(8000),
        );
        await new Promise((resolve) => setTimeout(resolve, Number(body?.settleMs) || 1500));
        return { ...base, promptAccepted: true, value, model, afterSeq: agent.session?.seq, eventsTail: eventsTail(), agentEvents: state.agentEvents.filter((entry) => entry.id === targetId).slice(-20) };
      } catch (error) {
        return { ...base, promptAccepted: false, model, error: String(error?.message ?? error), eventsTail: eventsTail() };
      }
    }

    if (op === 'dispose') {
      const handle = state.handles.get(targetId);
      if (handle === undefined) return { ...base, error: 'no handle for this session' };
      state.handles.delete(targetId);
      try {
        await handle.dispose();
        return { ...base, disposed: true, sessionId: targetId };
      } catch (error) {
        return { ...base, disposed: false, error: String(error?.message ?? error) };
      }
    }

    if (op === 'eventlog') {
      try {
        // snapshotEvents 已标 deprecated（新生产代码禁用），探针里只读用。
        const events = agent.session.snapshotEvents();
        return {
          ...base,
          seq: agent.session.seq,
          events: events.map((event) => ({ seq: event.seq, type: event.type, data: summariseEvent(event) })),
        };
      } catch (error) {
        return { ...base, error: String(error?.message ?? error) };
      }
    }

    return { ...base, error: 'unknown op: ' + String(op) };
  }

  /** 事件数据的紧凑摘要，避免把整段 message 打回来。 */
  function summariseEvent(event) {
    const data = event?.data;
    if (event.type === 'user/message') {
      return {
        id: data?.id,
        source: data?.source,
        text: Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('').slice(0, 120) : null,
      };
    }
    if (event.type === 'agent/inbox/spliced') {
      return { target: data?.target, inserted: (data?.inserted ?? []).map((m) => ({ id: m?.id, source: m?.source })) };
    }
    if (event.type === 'turn/end') return { turn: data?.turn, reason: data?.reason };
    if (event.type === 'turn/start') return { turn: data?.turn };
    if (event.type === 'step/start') return { turn: data?.turn, step: data?.step };
    if (event.type === 'assistant/attempt') return { attempt: data?.attemptId, failure: data?.failure?.kind };
    return null;
  }

  /* ── 路由注册 ───────────────────────────────────────────────────── */

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PLAIN_PATH, handler: handlePlain }), 'mailprobe: ' + PLAIN_PATH);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: THROW_PATH, handler: handleThrow }), 'mailprobe: ' + THROW_PATH);

  // 契约探测：同一 exact path 重复注册必须抛错（webServer 文档如此说，这里实测）。
  try {
    const disposeDuplicate = ctx.webServer.register({ kind: 'exact', path: PLAIN_PATH, handler: handlePlain });
    state.contractChecks.duplicateWebRoute = { threw: false };
    Promise.resolve(disposeDuplicate()).catch(() => {});
  } catch (error) {
    state.contractChecks.duplicateWebRoute = { threw: true, error: String(error?.message ?? error) };
  }

  // connection 服务在 Web 载体里才有（Electron 壳自带 transport）；用 ctx.inject 等它就绪。
  let authenticatedRouteDispose;
  const disposeAuthenticatedRoute = () => {
    if (typeof authenticatedRouteDispose === 'function') {
      const dispose = authenticatedRouteDispose;
      authenticatedRouteDispose = undefined;
      Promise.resolve(dispose()).catch(() => {});
    }
  };
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      // ctx.inject 的回调在服务可用时执行，作用域随插件卸载回收。
      const connection = connectionCtx.get('connection');
      const dispose = connection.fetch.register({
        path: API_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: handleAuthenticatedApi,
      });
      authenticatedRouteDispose = dispose;
      log('authenticated fetch route registered at ' + API_PATH);
      // 契约探测：connection.fetch.register 的 path 必须落在 /api/ 下。
      try {
        const disposeBad = connection.fetch.register({
          path: '/mailprobe/not-api',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => Promise.resolve(new Response('bad route registered')),
        });
        state.contractChecks.badFetchPath = { threw: false };
        Promise.resolve(disposeBad()).catch(() => {});
      } catch (error) {
        state.contractChecks.badFetchPath = { threw: true, error: String(error?.message ?? error) };
      }
      // 契约探测：同 path 重复注册必须抛错。
      try {
        const disposeDuplicate = connection.fetch.register({
          path: API_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => Promise.resolve(new Response('dup')),
        });
        state.contractChecks.duplicateFetchPath = { threw: false };
        Promise.resolve(disposeDuplicate()).catch(() => {});
      } catch (error) {
        state.contractChecks.duplicateFetchPath = { threw: true, error: String(error?.message ?? error) };
      }
      return () => disposeAuthenticatedRoute();
    });
  } catch (error) {
    log('connection.fetch registration deferred: ' + String(error?.message ?? error));
  }

  /** 启动即注册工具与 prompt section（模拟插件 enabled 状态）。 */
  const initialTool = registerProbeTool();
  const initialPrompt = registerProbePrompt();
  if (!initialTool.registered) log('tool registration failed: ' + JSON.stringify(initialTool));
  if (!initialPrompt.registered) log('prompt registration failed: ' + JSON.stringify(initialPrompt));

  // 观察 agent 事件：证明事件订阅可用，也是 inject/followup 的实证。
  try {
    ctx.on('agent/status', (payload) => {
      state.agentEvents.push({ at: Date.now(), kind: 'agent/status', id: agentIdOf(payload?.agent), status: payload?.status });
    });
    ctx.on('agent/inbox/inserted', (payload) => {
      state.deliveries.push(payload?.message);
      state.agentEvents.push({ at: Date.now(), kind: 'agent/inbox/inserted', id: agentIdOf(payload?.agent), messageId: payload?.message?.id });
    });
    ctx.on('agent/inbox/claimed', (payload) => {
      state.agentEvents.push({ at: Date.now(), kind: 'agent/inbox/claimed', id: agentIdOf(payload?.agent), messageId: payload?.message?.id, turn: payload?.turn });
    });
    ctx.on('agent/inbox/discarded', (payload) => {
      state.agentEvents.push({ at: Date.now(), kind: 'agent/inbox/discarded', id: agentIdOf(payload?.agent), messageId: payload?.message?.id });
    });
  } catch (error) {
    log('agent event subscription failed: ' + String(error?.message ?? error));
  }

  /* ── 诊断端点 ──────────────────────────────────────────────────── */

  function handleDiag(_req, res) {
    try {
      sendJson(res, 200, collectDiagnostics());
    } catch (error) {
      // 诊断端点自己绝不 400：把失败阶段原样带回来。
      sendJson(res, 200, {
        ok: false,
        error: String(error?.message ?? error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 12),
      });
    }
  }

  /** 收集诊断数据；任何单项失败都降级成字符串而不是抛。 */
  function collectDiagnostics() {
    const agents = svc(ctx, 'agents');
    const controller = svc(ctx, 'sessionController');
    const connection = svc(ctx, 'connection');
    const timerService = svc(ctx, 'timer');
    const timer = {
      service: surface(timerService, ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval']),
      direct: accessProbe('ctx.setInterval', () => ctx.setInterval),
      viaGet: accessProbe('ctx.get("timer").interval', () => svc(ctx, 'timer')?.interval),
    };
    const access = {};
    for (const serviceName of ['webServer', 'tools', 'systemPrompt', 'skills', 'agents', 'sessionController', 'connection', 'sessions', 'sessionTitle', 'credentials', 'timer', 'remoteAccess', 'llm', 'workspace', 'sessionPersistence']) {
      access[serviceName] = {
        direct: accessProbe('ctx.' + serviceName, () => ctx[serviceName]),
        viaGet: accessProbe('ctx.get("' + serviceName + '")', () => ctx.get(serviceName)),
      };
    }
    let toolNames = [];
    try {
      toolNames = (ctx.tools.definitions?.() ?? []).map((definition) => definition.name);
    } catch (error) {
      toolNames = ['error: ' + String(error?.message ?? error)];
    }
    const skills = svc(ctx, 'skills');
    const sessions = svc(ctx, 'sessions');
    const sessionTitle = svc(ctx, 'sessionTitle');
    return {
      ok: true,
      plugin: 'dsh-mailprobe',
      pid: process.pid,
      node: process.version,
      uptimeMs: Date.now() - probeStart,
      config,
      host: {
        host: ctx.webServer?.host,
        port: ctx.webServer?.port,
        protocol: ctx.webServer?.protocol,
        origin: safeCall(() => ctx.webServer?.getOrigin?.()),
      },
      context: {
        get: typeof ctx.get,
        inject: typeof ctx.inject,
        effect: typeof ctx.effect,
        on: typeof ctx.on,
        waterfall: typeof ctx.waterfall,
        logger: typeof ctx.logger,
        namedLogger: (() => {
          try {
            return typeof ctx.logger('mailprobe').info;
          } catch {
            return 'error';
          }
        })(),
      },
      timer,
      access,
      services: {
        webServer: surface(ctx.webServer, ['register', 'registerUpgrade', 'registerFallback', 'readResource', 'tapIndex', 'getOrigin']),
        tools: surface(ctx.tools, ['register', 'guard', 'restrict', 'definitions', 'schemas', 'get', 'execute', 'resolve']),
        systemPrompt: surface(ctx.systemPrompt, ['section', 'context', 'variable', 'tools', 'assemble', 'renderPrompt', 'getSectionOrder']),
        skills: surface(skills, ['register', 'registerProvider', 'list', 'load']),
        agents: surface(agents, ['list', 'roots', 'get', 'create', 'resume', 'register', 'withInitiator', 'withoutInitiator', 'currentInitiator']),
        sessionController: surface(controller, ['list', 'prompt', 'resolveAgent', 'create', 'rename', 'fork']),
        connection: surface(connection, ['requestRejection', 'admit', 'createPeer', 'admitConnection', 'authorizeIndex', 'authenticatedUrl', 'browserPeer']),
        connectionFetch: surface(connection?.fetch, ['register']),
        connectionRpc: surface(connection?.rpc, ['handle', 'intercept']),
        sessions: surface(sessions, ['get', 'list', 'create', 'fork', 'flush', 'registerMessageProjection']),
        sessionTitle: surface(sessionTitle, ['get', 'rename', 'refresh']),
        credentials: surface(svc(ctx, 'credentials'), ['read', 'has', 'write', 'delete']),
        llm: surface(svc(ctx, 'llm'), ['resolveModelInfo']),
        attachments: surface(svc(ctx, 'attachments'), ['admitPromptContent']),
        workspace: surface(svc(ctx, 'workspace'), ['attach']),
        sessionPersistence: surface(svc(ctx, 'sessionPersistence'), ['list', 'stat', 'read']),
        remoteAccess: surface(svc(ctx, 'remoteAccess'), ['allows', 'decide']),
      },
      probeState: {
        contractChecks: state.contractChecks,
        toolRegistered: typeof state.toolDispose === 'function',
        promptRegistered: typeof state.promptDispose === 'function',
        authenticatedRouteRegistered: typeof authenticatedRouteDispose === 'function',
        agentEvents: state.agentEvents.slice(-30),
        deliveries: state.deliveries.length,
        knownSessions: [...state.handles.keys()],
      },
      registeredToolNames: toolNames,
    };
  }

  /**
   * 探测一次"能否读取"：Cordis 的服务读取受 inject 声明约束 ——
   * 未在插件 inject 里声明的服务，直接 ctx.<name> 会抛
   * "cannot get property \"<name>\" without inject"；ctx.get(name) 是否放行也一并测。
   */
  function accessProbe(label, read) {
    try {
      const value = read();
      return { ok: true, type: value === undefined ? 'undefined' : typeof value };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 安全调用，异常转成字符串。 */
  function safeCall(fn) {
    try {
      return fn();
    } catch (error) {
      return 'threw: ' + String(error?.message ?? error);
    }
  }

  async function handleToolToggle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const on = url.searchParams.get('on') ?? '1';
    if (on === 'dup') {
      sendJson(res, 200, { ok: true, ...duplicateToolTest(), registered: typeof state.toolDispose === 'function' });
      return;
    }
    if (on === '0') {
      sendJson(res, 200, { ok: true, ...unregisterProbeTool(), registered: false });
      return;
    }
    sendJson(res, 200, { ok: true, ...registerProbeTool(), registered: typeof state.toolDispose === 'function' });
  }

  async function handlePromptToggle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const on = url.searchParams.get('on') ?? '1';
    if (on === 'dup') {
      sendJson(res, 200, { ok: true, ...duplicatePromptTest(), registered: typeof state.promptDispose === 'function' });
      return;
    }
    if (on === '0') {
      sendJson(res, 200, { ok: true, ...unregisterProbePrompt(), registered: false, assemble: await assembleProbe() });
      return;
    }
    const result = registerProbePrompt();
    sendJson(res, 200, { ok: true, ...result, registered: typeof state.promptDispose === 'function', assemble: await assembleProbe() });
  }

  async function handleSession(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' });
      return;
    }
    const parsed = await readBody(req, BODY_LIMIT);
    if (parsed.tooLarge) {
      sendJson(res, 413, { ok: false, error: 'body too large' });
      return;
    }
    let body;
    try {
      body = parsed.text === '' ? {} : JSON.parse(parsed.text);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'not JSON: ' + String(error?.message ?? error) });
      return;
    }
    try {
      const result = await sessionOp(body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 8) });
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DIAG_PATH, handler: handleDiag }), 'mailprobe: ' + DIAG_PATH);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TOOL_PATH, handler: handleToolToggle }), 'mailprobe: ' + TOOL_PATH);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PROMPT_PATH, handler: handlePromptToggle }), 'mailprobe: ' + PROMPT_PATH);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SESSION_PATH, handler: handleSession }), 'mailprobe: ' + SESSION_PATH);

  /** 插件卸载时的清理（ctx.effect 注册的顺序逆序执行）。 */
  ctx.effect(() => () => {
    unregisterProbeTool();
    unregisterProbePrompt();
    disposeAuthenticatedRoute();
    for (const handle of state.handles.values()) {
      Promise.resolve(handle.dispose?.()).catch(() => {});
    }
    state.handles.clear();
    log('probe plugin unloading: tools/prompt/route disposed');
  });

  log('probe plugin applied: routes ' + [DIAG_PATH, PLAIN_PATH, THROW_PATH, TOOL_PATH, PROMPT_PATH, SESSION_PATH].join(', '));
}
