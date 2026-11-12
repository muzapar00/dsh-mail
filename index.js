/**
 * dsh-mailbox — Cordis bundle entry (host half).
 *
 * Responsibilities:
 *  - own the data directory and runtime configuration (`lib/config`, `lib/store`,
 *    `lib/service`);
 *  - register the nine model tools (`lib/tools`) and the system-prompt section
 *    (`lib/prompt`) while the plugin master switch is on;
 *  - serve the browser half through the host's **authenticated** Fetch routing
 *    (`/api/mailbox`), falling back to a same-origin raw webServer route;
 *  - poll IMAP (`lib/sync`), import untrusted mail and inject one batched
 *    "you have new mail" notice into live conversations (`lib/notify`).
 *
 * Zero third-party imports: only `node:*` builtins and Cordis services obtained
 * through `ctx`. That keeps the bundle installable in any DSH profile.
 *
 * @module dsh-mailbox
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './lib/config.js';
import { createNotifier } from './lib/notify.js';
import { composeSystemPrompt, SECTION_NAME, SECTION_ORDER } from './lib/prompt.js';
import { createApiHandler, createFetchHandler, API_PATH } from './lib/server.js';
import { createMailboxService } from './lib/service.js';
import { createStore } from './lib/store.js';
import { createSyncService } from './lib/sync.js';
import { registerMailboxTools } from './lib/tools.js';
import { parseMessage } from './lib/mail/mime.js';
import { sanitizeHtml } from './lib/mail/html.js';
import { sendMail, verifySmtp } from './lib/mail/smtp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Fallback version when package.json cannot be read. */
const FALLBACK_VERSION = '0.1.0';
/** Plugin id; also used for the prompt section name and the model message source. */
export const name = 'mailbox';
/** Hard dependency: tools registration. Everything else is optional via ctx.get. */
export const inject = ['tools'];

/** Small validation-only Cordis config (runtime config lives in dataDir/config.json). */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mailbox',
    /**
     * @param {unknown} raw - configured row value.
     * @returns {{ value: object } | { issues: Array<{ message: string, path?: string[] }> }}
     */
    validate(raw) {
      const config = raw === undefined || raw === null ? {} : raw;
      if (typeof config !== 'object' || Array.isArray(config)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      const issues = [];
      const value = {};
      if (config.dataDir !== undefined) {
        if (typeof config.dataDir !== 'string' || config.dataDir.trim() === '') issues.push({ message: 'must be a non-empty path string', path: ['dataDir'] });
        else value.dataDir = config.dataDir.trim();
      }
      if (config.version !== undefined && config.version !== 1) issues.push({ message: 'unsupported config version', path: ['version'] });
      return issues.length > 0 ? { issues } : { value };
    },
  },
};

/**
 * Resolve a logger. DSH's default composition has no console logger exporter,
 * so plugin readiness and warnings are also printed to the process console —
 * otherwise operators cannot confirm the plugin loaded at all.
 */
function loggerFor(ctx) {
  const services = [];
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger('dsh-mailbox');
      if (logger !== undefined && logger !== null) services.push(logger);
    }
  } catch {
    // No logger service; console remains.
  }
  const emit = (level, line) => {
    for (const service of services) {
      try {
        service[level]?.(line);
      } catch {
        // A broken logger must never break the plugin.
      }
    }
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    const text = String(line).startsWith('[dsh-mailbox]') ? String(line) : `[dsh-mailbox] ${line}`;
    write(text);
  };
  return {
    info: (line) => emit('info', line),
    warn: (line) => emit('warn', line),
    error: (line) => emit('error', line),
  };
}

/** Build one line for diagnostics without throwing. */
function describe(error) {
  return String(error?.message ?? error).slice(0, 300);
}

/**
 * Host adapter: enumerate live conversations and deliver one plugin notice.
 *
 * Delivery is deliberately limited to live agents with `followup`, which starts
 * a real turn. `sessionController.prompt` is NOT used by default because its
 * durable source is attributed to the user (security: a plugin notice must never
 * look like a user instruction); when no live agent accepts the notice, it is
 * queued on disk and retried later.
 */
function createHostAdapter(ctx, log) {
  const agents = () => {
    try {
      return ctx.get('agents');
    } catch {
      return undefined;
    }
  };
  const controller = () => {
    try {
      return ctx.get('sessionController');
    } catch {
      return undefined;
    }
  };

  /** Convert one SessionSummary row into the notifier target shape. */
  function targetFromSummary(row) {
    if (typeof row?.sessionId !== 'string' || row.sessionId === '') return null;
    const isSubagent = row.origin === 'subagent' || row.parentSessionId !== undefined;
    // SessionSummary.updatedAt is an epoch-millisecond number, not an ISO string.
    let updatedAt = '';
    if (typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)) updatedAt = new Date(row.updatedAt).toISOString();
    else if (typeof row.updatedAt === 'string' && row.updatedAt !== '') updatedAt = row.updatedAt;
    return {
      sessionId: row.sessionId,
      title: row.projections?.values?.title ?? row.title ?? '',
      updatedAt,
      running: row.running === true,
      blank: row.blank === true,
      agentAvailable: row.agentAvailable !== false,
      isSubagent,
    };
  }

  return {
    /** Whether a session currently has a live agent in this host process. */
    async isLive(sessionId) {
      try {
        const agent = agents()?.get?.(sessionId);
        return agent !== undefined && agent !== null;
      } catch {
        return false;
      }
    },

    /**
     * Create one fresh conversation for mailbox notifications and name it.
     * Returns the new session id, or '' when the composition cannot create one.
     */
    async createSession() {
      const service = controller();
      if (service === undefined || service === null || typeof service.create !== 'function') return '';
      let created;
      try {
        created = await service.create({});
      } catch (error) {
        log.warn?.(`[dsh-mailbox] cannot create dedicated session: ${describe(error)}`);
        return '';
      }
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
      if (sessionId === '') return '';
      try {
        const titles = ctx.get('sessionTitle');
        const agent = agents()?.get?.(sessionId);
        if (titles !== undefined && titles !== null && typeof titles.rename === 'function' && agent?.session !== undefined) {
          titles.rename(agent.session, '邮箱通知');
        }
      } catch {
        // Naming is cosmetic.
      }
      return sessionId;
    },

    /** @returns {Promise<Array<{sessionId:string,title:string,updatedAt:string,isSubagent:boolean}>>} */
    async listSessions() {
      const service = controller();
      if (service !== undefined && service !== null && typeof service.list === 'function') {
        try {
          const result = await service.list({}, AbortSignal.timeout(3000));
          const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
          const targets = items.map(targetFromSummary).filter((row) => row !== null);
          return targets.filter((row) => row.isSubagent !== true && row.blank !== true && row.agentAvailable !== false);
        } catch (error) {
          log.warn?.(`[dsh-mailbox] session list failed: ${describe(error)}`);
        }
      }
      const agentsService = agents();
      if (agentsService !== undefined && agentsService !== null && typeof agentsService.roots === 'function') {
        try {
          const roots = await agentsService.roots();
          return (Array.isArray(roots) ? roots : []).map((agent) => {
            const sessionId = agent?.sessionId ?? agent?.session?.id ?? agent?.id;
            if (typeof sessionId !== 'string' || sessionId === '') return null;
            return { sessionId, title: '', updatedAt: '', running: agent.status !== 'idle', isSubagent: false };
          }).filter((row) => row !== null);
        } catch (error) {
          log.warn?.(`[dsh-mailbox] agents.roots failed: ${describe(error)}`);
        }
      }
      return [];
    },

    /**
     * Deliver one plugin notice as a real user-role turn with a plugin source.
     *
     * @param {string} sessionId - target conversation.
     * @param {string} text - plain-text notice.
     * @param {{ kind?: string, ids?: string[] }} meta - notice metadata.
     * @returns {Promise<boolean>} whether a live agent accepted it.
     */
    async deliver(sessionId, text, meta) {
      const agentsService = agents();
      if (agentsService === undefined || agentsService === null || typeof agentsService.get !== 'function') return false;
      let agent;
      try {
        agent = agentsService.get(sessionId);
      } catch {
        agent = undefined;
      }
      if (agent === undefined || agent === null) return false;
      /** Durable message shape (Session V4 requires a unique id and producer-owned source kind). */
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin:dsh-mailbox',
          form: 'notice',
          summary: Array.isArray(meta?.ids) && meta.ids.length > 0 ? `${meta.ids.length} new mail` : 'dsh-mailbox notice',
        },
      };
      try {
        if (typeof agent.followup === 'function') {
          await agent.followup(message);
          return true;
        }
        if (typeof agent.inject === 'function') {
          // inject adds to the next model context but does not start a turn; that
          // still tells the agent about the mail and is safe regarding attribution.
          await agent.inject(message);
          return true;
        }
      } catch (error) {
        log.warn?.(`[dsh-mailbox] notify delivery failed: ${describe(error)}`);
      }
      return false;
    },
  };
}

/**
 * Cordis plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ dataDir?: string }} config - validated Cordis row config.
 * @returns {Promise<() => Promise<void>>} disposer.
 */
export async function apply(ctx, config) {
  const log = loggerFor(ctx);
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir.trim() !== '' ? config.dataDir.trim() : defaultDataDir();
  let version = FALLBACK_VERSION;
  try {
    version = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8')).version ?? FALLBACK_VERSION;
  } catch {
    // Keep the fallback version.
  }
  const store = await createStore(dataDir, { onWarning: (message) => log.warn?.(`[dsh-mailbox] ${message}`) });
  const host = createHostAdapter(ctx, log);

  /** In-memory friends document used by the system prompt function. */
  let friendsCache = { friends: [], pending: [] };
  let refreshingFriends = Promise.resolve();
  const refreshFriends = async () => {
    const doc = await store.loadFriends();
    friendsCache = doc;
    return doc;
  };
  await refreshFriends().catch(() => {});

  /** Load the inline avatar used by outgoing letters. */
  async function loadAvatarPart() {
    const config = service.getConfig();
    const file = config.mailbox?.avatarFile !== '' ? config.mailbox.avatarFile : join(HERE, 'avatar.png');
    try {
      const bytes = await readFile(file);
      const lower = file.toLowerCase();
      const contentType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
      return { cid: 'dafeiyu@dsh.local', filename: 'dafeiyu-deepseek.png', contentType, base64: bytes.toString('base64') };
    } catch (error) {
      log.warn?.(`[dsh-mailbox] avatar unavailable: ${describe(error)}`);
      return undefined;
    }
  }

  /** Lazy IMAP engine: keeps the plugin loadable while mail/imap.js is absent. */
  let openImap;
  let imapLoadError = '';
  try {
    const module = await import('./lib/mail/imap.js');
    openImap = module.openImap ?? (typeof module.ImapClient === 'function' ? (options) => new module.ImapClient(options) : undefined);
    if (typeof openImap !== 'function') imapLoadError = 'mail/imap.js 未导出 openImap / ImapClient';
  } catch (error) {
    imapLoadError = describe(error);
    log.warn?.(`[dsh-mailbox] IMAP engine unavailable: ${imapLoadError}`);
  }

  const mailAdapter = {
    sendMail,
    verifySmtp,
    openImap: openImap ?? (async () => {
      throw new Error(`IMAP 引擎不可用：${imapLoadError || '未加载'}`);
    }),
    parseMessage,
    sanitizeHtml,
  };

  let notifier;
  let sync;
  const service = createMailboxService({
    store,
    host,
    mail: mailAdapter,
    getVersion: () => version,
    getSync: () => sync,
    getNotifier: () => notifier,
    getRegisteredTools: () => (toolsRegistration === null ? [] : [...toolsRegistration.registered]),
    getStatusExtras: () => ({ promptSection: sectionDispose !== null, apiRoute: routeDispose !== null }),
    loadAvatar: loadAvatarPart,
    onConfigApplied: async () => {
      await refreshFriends();
      setEnabled(service.getConfig().enabled === true);
    },
    onFriendsChanged: async () => {
      await refreshFriends();
    },
    log: (line) => log.info?.(line),
  });
  await service.init();

  notifier = createNotifier({
    store,
    getConfig: () => service.getConfig(),
    getFriends: () => refreshFriends().catch(() => friendsCache),
    host,
    onDedicatedSession: (sessionId) => service.setDedicatedSession(sessionId),
    log: (line) => log.info?.(line),
  });

  sync = createSyncService({
    store,
    getConfig: () => service.getConfig(),
    getSecrets: async () => ({ smtp: { authCode: (await service.resolveSecret('smtp')).value }, imap: { authCode: (await service.resolveSecret('imap')).value } }),
    getFriends: async () => store.loadFriends(),
    openImap: mailAdapter.openImap,
    parseMessage,
    sanitizeHtml,
    onNewMail: (rows) => {
      notifier.enqueue(rows);
    },
    log: (line) => log.info?.(line),
  });

  // ---------------------------------------------------------------- prompt section
  let sectionDispose = null;
  const systemPrompt = (() => {
    try {
      return ctx.get('systemPrompt');
    } catch {
      return undefined;
    }
  })();
  function registerSection() {
    if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') return;
    if (sectionDispose !== null) return;
    // A text function is re-evaluated on every assemble, so config/friend
    // changes (and the master switch) are reflected without re-registration.
    sectionDispose = systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => composeSystemPrompt(service.getConfig(), friendsCache),
    });
  }
  function disposeSection() {
    if (sectionDispose === null) return;
    try {
      sectionDispose();
    } catch {
      // Best effort.
    }
    sectionDispose = null;
  }

  // ------------------------------------------------------------------- tools
  let toolsRegistration = null;
  function registerTools() {
    if (toolsRegistration !== null) return;
    toolsRegistration = registerMailboxTools(ctx, service, service.getConfig(), { dataDir: store.dataDir });
  }
  function disposeTools() {
    if (toolsRegistration === null) return;
    toolsRegistration.dispose();
    toolsRegistration = null;
  }

  // ------------------------------------------------------------------ timers
  let syncTimer = null;
  let retryTimer = null;
  function stopTimers() {
    if (syncTimer !== null) clearInterval(syncTimer);
    if (retryTimer !== null) clearInterval(retryTimer);
    syncTimer = null;
    retryTimer = null;
  }
  function startTimers() {
    stopTimers();
    const config = service.getConfig();
    if (config.imap.enabled !== true) return;
    const intervalMs = Math.max(30, config.imap.pollIntervalSeconds) * 1000;
    syncTimer = setInterval(() => {
      if (!sync.shouldPoll() || sync.isRunning()) return;
      sync.sync({ reason: 'poll' }).catch((error) => log.warn?.(`[dsh-mailbox] poll failed: ${describe(error)}`));
    }, intervalMs);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
    retryTimer = setInterval(() => {
      notifier.tick().catch((error) => log.warn?.(`[dsh-mailbox] notification retry failed: ${describe(error)}`));
    }, 60 * 1000);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    // First sync shortly after boot (never during the plugin apply itself).
    const initial = setTimeout(() => {
      if (service.getConfig().enabled === true && sync.shouldPoll() && !sync.isRunning()) {
        sync.sync({ reason: 'startup' }).catch((error) => log.warn?.(`[dsh-mailbox] initial sync failed: ${describe(error)}`));
      }
    }, 5000);
    if (typeof initial.unref === 'function') initial.unref();
  }

  // ------------------------------------------------------------ master switch
  function setEnabled(enabled) {
    if (enabled) {
      registerSection();
      registerTools();
      startTimers();
    } else {
      disposeTools();
      disposeSection();
      stopTimers();
    }
  }

  // ---------------------------------------------------------------- HTTP route
  let routeDispose = null;
  const isEnabled = () => service.getConfig().enabled === true;
  const fetchServices = { dispatch: service.dispatch };
  const connection = (() => {
    try {
      return ctx.get('connection');
    } catch {
      return undefined;
    }
  })();
  if (connection !== undefined && connection !== null && connection.fetch !== undefined && typeof connection.fetch.register === 'function') {
    const handleFetch = createFetchHandler({ services: fetchServices, isEnabled, log: (line) => log.warn?.(line) });
    routeDispose = connection.fetch.register({ path: API_PATH, methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch: handleFetch });
  } else {
    const webServer = (() => {
      try {
        return ctx.get('webServer');
      } catch {
        return undefined;
      }
    })();
    if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
      const handleApi = createApiHandler({
        services: fetchServices,
        isEnabled,
        log: (line) => log.warn?.(line),
        authorize: (req) => {
          try {
            const reject = ctx.get('connection')?.requestRejection?.(req);
            if (reject !== null && reject !== undefined) return { status: 401, code: 'forbidden', message: '未授权' };
          } catch {
            // ignore; fall through to same-origin checks
          }
          return null;
        },
      });
      routeDispose = webServer.register({ kind: 'exact', path: API_PATH, handler: handleApi });
    }
  }

  // Start from the stored state.
  setEnabled(service.getConfig().enabled === true);
  log.info?.(`[dsh-mailbox] ready: dataDir=${dataDir} enabled=${service.getConfig().enabled === true} api=${routeDispose === null ? 'none' : API_PATH}`);

  // -------------------------------------------------------------------- dispose
  return async function dispose() {
    stopTimers();
    try {
      notifier?.dispose();
    } catch {
      // best effort
    }
    try {
      sync?.dispose();
    } catch {
      // best effort
    }
    disposeTools();
    disposeSection();
    try {
      if (typeof routeDispose === 'function') routeDispose();
      else routeDispose?.();
    } catch {
      // best effort
    }
    await refreshingFriends.catch(() => {});
  };
}
