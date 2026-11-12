/**
 * dsh-mailbox persistence: one data directory owned by the plugin, atomic JSON
 * writes, strict permissions, secret isolation and corrupt-file recovery.
 *
 * Layout (all files 0600, directory 0700 where the platform allows it):
 *   config.json        non-secret runtime configuration
 *   secrets.json       authorization codes only (never returned by the API)
 *   friends.json       friend whitelist, pending requests and AI-add audit log
 *   state.json         IMAP sync state (uidValidity / lastUid / lastSyncAt)
 *   index.json         message index rows (newest first)
 *   messages/<id>.json message bodies (plain text + sanitized HTML only)
 *   notifications.json queued AI notifications that could not be delivered yet
 *
 * @module dsh-mailbox/lib/store
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Data files that hold no secrets. */
const DATA_FILES = {
  config: 'config.json',
  friends: 'friends.json',
  state: 'state.json',
  index: 'index.json',
  notifications: 'notifications.json',
};
/** Secret file; separate so it can be excluded from backups/diagnostics. */
const SECRETS_FILE = 'secrets.json';
/** Directory for message bodies. */
const MESSAGES_DIR = 'messages';

/** Reject file names that could escape the data directory. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Default empty document shapes. */
function emptyFriends() {
  return {
    version: 1,
    policyDefaultAutoReply: false,
    friends: [],
    pending: [],
    aiAddLog: [],
  };
}

function emptyState() {
  return {
    version: 1,
    uidValidity: null,
    lastUid: 0,
    lastSyncAt: null,
    lastError: null,
    lastSuccessAt: null,
  };
}

function emptyIndex() {
  return { version: 1, messages: [] };
}

function emptyNotifications() {
  return { version: 1, queue: [] };
}

/**
 * Normalize a stored message body record.
 *
 * @param {object} raw - candidate record.
 * @returns {object|null} normalized body, or null when unusable.
 */
function normalizeMessageBody(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return null;
  if (typeof raw.text !== 'string') return null;
  return raw;
}

/** Local ISO timestamp used for file/record ordering. */
function nowIso() {
  return new Date().toISOString();
}

/** Deterministic message identity for an incoming IMAP message. */
export function incomingMessageId(messageId, uid, date) {
  const seed = `${messageId ?? ''}\n${uid ?? ''}\n${date ?? ''}`;
  return `in-${createHash('sha1').update(seed).digest('hex').slice(0, 20)}`;
}

/** Random identity for an outgoing message. */
export function outgoingMessageId() {
  return `out-${randomUUID()}`;
}

/**
 * Plugin data store. One instance per host process; writes are serialized per
 * file so concurrent sync/tool/UI operations cannot interleave.
 */
export class MailboxStore {
  /**
   * @param {string} dataDir - absolute data directory.
   * @param {{ onWarning?: (message: string) => void }} [options] - diagnostics hook.
   */
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.onWarning = options.onWarning ?? (() => {});
    /** @type {Map<string, Promise<unknown>>} */
    this.writeQueues = new Map();
    this.ready = false;
  }

  get files() {
    return {
      config: join(this.dataDir, DATA_FILES.config),
      secrets: join(this.dataDir, SECRETS_FILE),
      friends: join(this.dataDir, DATA_FILES.friends),
      state: join(this.dataDir, DATA_FILES.state),
      index: join(this.dataDir, DATA_FILES.index),
      notifications: join(this.dataDir, DATA_FILES.notifications),
      messages: join(this.dataDir, MESSAGES_DIR),
    };
  }

  /** Create the data directory tree and tighten permissions. */
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.files.messages, { recursive: true, mode: 0o700 });
    await this.#chmod(this.dataDir, 0o700);
    this.ready = true;
  }

  // ---------------------------------------------------------------- JSON I/O

  /** Best-effort permission change (Windows may not support POSIX modes). */
  async #chmod(path, mode) {
    try {
      await chmod(path, mode);
    } catch {
      // Unsupported on some platforms/filesystems; not fatal.
    }
  }

  /** Read and parse a JSON file; corrupt files are quarantined, not fatal. */
  async #readJson(path, fallback) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      const backup = `${path}.corrupt-${Date.now()}`;
      try {
        await rename(path, backup);
      } catch {
        // Ignore: the parse failure still yields the fallback.
      }
      this.onWarning(`corrupt file quarantined: ${backup} (${error.message})`);
      return fallback;
    }
  }

  /** Atomic JSON write: temp file in the same directory, fsync-free rename. */
  async #writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await this.#chmod(temporary, 0o600);
    await rename(temporary, path);
    await this.#chmod(path, 0o600);
  }

  /** Serialize writes to one file to avoid lost updates. */
  #enqueue(key, task) {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.writeQueues.set(key, next.catch(() => {}));
    return next;
  }

  // -------------------------------------------------------------- config

  /** @returns {Promise<object|null>} stored config, or null when absent. */
  async loadConfig() {
    const raw = await this.#readJson(this.files.config, null);
    return typeof raw === 'object' && raw !== null ? raw : null;
  }

  /** Persist the non-secret configuration. */
  saveConfig(config) {
    return this.#enqueue('config', () => this.#writeJson(this.files.config, config));
  }

  /** @returns {Promise<object|null>} stored first-boot seed, or null. */
  async loadSeed() {
    return this.#readJson(join(this.dataDir, 'seed.json'), null);
  }

  /** Persist a first-boot seed (only the installer writes it). */
  saveSeed(seed) {
    return this.#enqueue('seed', () => this.#writeJson(join(this.dataDir, 'seed.json'), seed));
  }

  // -------------------------------------------------------------- secrets

  /** @returns {Promise<{ smtp: { authCode: string }, imap: { authCode: string }, version: number }>} */
  async loadSecrets() {
    const raw = await this.#readJson(this.files.secrets, null);
    const shaped = { version: 1, smtp: { authCode: '' }, imap: { authCode: '' } };
    if (typeof raw === 'object' && raw !== null) {
      if (typeof raw.smtp?.authCode === 'string') shaped.smtp.authCode = raw.smtp.authCode;
      if (typeof raw.imap?.authCode === 'string') shaped.imap.authCode = raw.imap.authCode;
      if (typeof raw.version === 'number') shaped.version = raw.version;
    }
    return shaped;
  }

  /** Persist authorization codes into the separate 0600 secrets file. */
  saveSecrets(secrets) {
    const shaped = {
      version: 1,
      smtp: { authCode: typeof secrets?.smtp?.authCode === 'string' ? secrets.smtp.authCode : '' },
      imap: { authCode: typeof secrets?.imap?.authCode === 'string' ? secrets.imap.authCode : '' },
    };
    return this.#enqueue('secrets', () => this.#writeJson(this.files.secrets, shaped));
  }

  // -------------------------------------------------------------- friends

  /** @returns {Promise<object>} friend whitelist document. */
  async loadFriends() {
    const raw = await this.#readJson(this.files.friends, null);
    const base = emptyFriends();
    if (typeof raw !== 'object' || raw === null) return base;
    if (Array.isArray(raw.friends)) {
      base.friends = raw.friends.filter((item) => typeof item === 'object' && item !== null && typeof item.address === 'string');
    }
    if (Array.isArray(raw.pending)) base.pending = raw.pending.filter((item) => typeof item === 'object' && item !== null && typeof item.address === 'string');
    if (Array.isArray(raw.aiAddLog)) base.aiAddLog = raw.aiAddLog.filter((item) => typeof item === 'object' && item !== null);
    if (typeof raw.policyDefaultAutoReply === 'boolean') base.policyDefaultAutoReply = raw.policyDefaultAutoReply;
    if (typeof raw.version === 'number') base.version = raw.version;
    return base;
  }

  /** Persist the friend whitelist document. */
  saveFriends(friends) {
    return this.#enqueue('friends', () => this.#writeJson(this.files.friends, friends));
  }

  // ---------------------------------------------------------------- state

  /** @returns {Promise<object>} IMAP sync state. */
  async loadState() {
    const raw = await this.#readJson(this.files.state, null);
    const base = emptyState();
    if (typeof raw !== 'object' || raw === null) return base;
    for (const key of ['uidValidity', 'lastUid', 'lastSyncAt', 'lastError', 'lastSuccessAt']) {
      if (raw[key] !== undefined) base[key] = raw[key];
    }
    if (typeof raw.version === 'number') base.version = raw.version;
    return base;
  }

  /** Persist the IMAP sync state. */
  saveState(state) {
    return this.#enqueue('state', () => this.#writeJson(this.files.state, state));
  }

  // ---------------------------------------------------------------- index

  /** @returns {Promise<{ version: number, messages: object[] }>} message index. */
  async loadIndex() {
    const raw = await this.#readJson(this.files.index, null);
    const base = emptyIndex();
    if (typeof raw === 'object' && raw !== null && Array.isArray(raw.messages)) {
      base.messages = raw.messages.filter((item) => typeof item === 'object' && item !== null && typeof item.id === 'string' && SAFE_ID.test(item.id));
      if (typeof raw.version === 'number') base.version = raw.version;
    }
    return base;
  }

  /** Persist the message index. */
  saveIndex(index) {
    return this.#enqueue('index', () => this.#writeJson(this.files.index, index));
  }

  // -------------------------------------------------------------- messages

  /** Read one stored message body. */
  async readMessage(id) {
    if (!SAFE_ID.test(id)) throw new Error(`invalid message id: ${id}`);
    const raw = await this.#readJson(join(this.files.messages, `${id}.json`), null);
    const body = normalizeMessageBody(raw);
    if (body === null) return null;
    if (body.id !== id) return null;
    return body;
  }

  /** Write one message body atomically. */
  async writeMessage(message) {
    const body = normalizeMessageBody(message);
    if (body === null) throw new Error('refusing to store a message without id and text');
    return this.#enqueue(`message:${body.id}`, () => this.#writeJson(join(this.files.messages, `${body.id}.json`), body));
  }

  /** Remove one message body (missing files are fine). */
  async deleteMessage(id) {
    if (!SAFE_ID.test(id)) return;
    await this.#enqueue(`message:${id}`, async () => {
      try {
        await unlink(join(this.files.messages, `${id}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    });
  }

  /**
   * Append an index row (updates an existing row with the same id), trim to the
   * configured maximum, and remove evicted message bodies.
   *
   * @param {object} row - index row; must carry a safe id.
   * @param {{ maxMessages?: number }} [options] - retention.
   * @returns {Promise<{ index: object, evicted: string[] }>}
   */
  async appendIndex(row, options = {}) {
    if (typeof row?.id !== 'string' || !SAFE_ID.test(row.id)) throw new Error('index row needs a safe id');
    const maxMessages = Number.isInteger(options.maxMessages) ? Math.max(1, options.maxMessages) : 500;
    return this.#enqueue('index', async () => {
      const index = await this.loadIndex();
      const rest = index.messages.filter((item) => item.id !== row.id);
      const messages = [row, ...rest].sort((left, right) => String(right.date ?? '').localeCompare(String(left.date ?? '')));
      const kept = messages.slice(0, maxMessages);
      const evicted = messages.slice(maxMessages).map((item) => item.id);
      index.messages = kept;
      await this.#writeJson(this.files.index, index);
      return { index, evicted };
    });
  }

  /**
   * Patch one index row in place (read flag, friend flag, ...).
   *
   * @param {string} id - message id.
   * @param {object} patch - shallow fields to merge.
   * @returns {Promise<object|null>} the updated row, or null when absent.
   */
  updateIndexRow(id, patch) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) return Promise.resolve(null);
    return this.#enqueue('index', async () => {
      const index = await this.loadIndex();
      const row = index.messages.find((item) => item.id === id);
      if (row === undefined) return null;
      Object.assign(row, patch);
      await this.#writeJson(this.files.index, index);
      return row;
    });
  }

  /** Remove one index row without touching other rows. */
  removeIndexRow(id) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) return Promise.resolve(null);
    return this.#enqueue('index', async () => {
      const index = await this.loadIndex();
      const before = index.messages.length;
      index.messages = index.messages.filter((item) => item.id !== id);
      if (index.messages.length !== before) await this.#writeJson(this.files.index, index);
      return index.messages;
    });
  }

  // --------------------------------------------------------- notifications

  /** @returns {Promise<{ version: number, queue: object[] }>} queued notifications. */
  async loadNotifications() {
    const raw = await this.#readJson(this.files.notifications, null);
    const base = emptyNotifications();
    if (typeof raw === 'object' && raw !== null && Array.isArray(raw.queue)) {
      base.queue = raw.queue.filter((item) => typeof item === 'object' && item !== null);
      if (typeof raw.version === 'number') base.version = raw.version;
    }
    return base;
  }

  /** Persist the notification queue. */
  saveNotifications(list) {
    return this.#enqueue('notifications', () => this.#writeJson(this.files.notifications, list));
  }

  // --------------------------------------------------------------- helpers

  /**
   * Delete every stored file (keeps the directory). Used by the UI "清空数据"
   * action after a second confirmation.
   */
  /**
   * Clear stored mailbox data. Configuration, secrets and (by default) the
   * friend whitelist are kept: deleting them would be a destructive account
   * reset, which the UI exposes separately.
   *
   * @param {{ includeConfig?: boolean, includeFriends?: boolean, includeState?: boolean }} [options]
   */
  async clearData(options = {}) {
    // Read the index first: deleting it first would orphan message bodies.
    const index = await this.loadIndex();
    for (const row of index.messages) await this.deleteMessage(row.id);
    await this.saveIndex(emptyIndex());
    await this.saveNotifications(emptyNotifications());
    if (options.includeState !== false) await this.saveState(emptyState());
    if (options.includeFriends === true) await this.saveFriends(emptyFriends());
    if (options.includeConfig === true) {
      const removable = [this.files.config, this.files.secrets];
      for (const file of removable) {
        try {
          await unlink(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  /** Data-directory health summary for diagnostics (no secrets, no bodies). */
  async diagnostics() {
    return {
      dataDir: this.dataDir,
      files: Object.fromEntries(Object.entries(this.files).map(([key, path]) => [key, path])),
      messages: (await this.loadIndex()).messages.length,
      friends: (await this.loadFriends()).friends.length,
      pending: (await this.loadFriends()).pending.length,
      queuedNotifications: (await this.loadNotifications()).queue.length,
      now: nowIso(),
    };
  }
}

/** Create and initialize a store. */
export async function createStore(dataDir, options) {
  const store = new MailboxStore(dataDir, options);
  await store.init();
  return store;
}
