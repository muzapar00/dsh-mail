/**
 * dsh-mailbox configuration model: defaults, provider presets, validation,
 * deep merge, UI masking, and auth-code resolution.
 *
 * Zero dependencies, pure ESM. The runtime config lives in
 * `<dataDir>/config.json` and is seeded from this model; the Cordis layer only
 * supplies `dataDir` and an optional first-boot seed.
 *
 * @module dsh-mailbox/lib/config
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** E.164-ish mailbox address: one @ with something on both sides. */
export const EMAIL_RE = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;

/** Supported config shapes. */
export const FRIEND_POLICIES = ['auto', 'ask', 'manual'];
export const STRANGER_POLICIES = ['notify', 'quarantine', 'ignore'];
export const NOTIFY_TARGETS = ['dedicated', 'latest', 'all'];
export const SECURITY_MODES = ['tls', 'starttls', 'none'];
export const PROMPT_LANGUAGES = ['zh', 'en', 'both'];

/**
 * Provider presets. Each preset carries the connection defaults, a short
 * trust note, and the authorization-code guide the UI renders.
 *
 * Links are official provider help pages; the mail-protocols research file
 * owns the long-form details.
 */
export const PRESETS = {
  qq: {
    id: 'qq',
    label: { zh: 'QQ 邮箱', en: 'QQ Mail' },
    smtp: { host: 'smtp.qq.com', port: 465, security: 'tls' },
    imap: { host: 'imap.qq.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: 'QQ 邮箱需要用「授权码」而不是 QQ 密码登录第三方客户端。',
        steps: [
          '登录 QQ 邮箱网页版（mail.qq.com），进入「设置」→「账号与安全」→「安全设置」。',
          '找到「IMAP/SMTP 服务」，按提示开启（可能需要 QQ 安全中心验证）。',
          '开启后点击「生成授权码」，按提示验证后会得到一串 16 位授权码。',
          '把授权码填入下方「授权码」输入框（只显示一次，注意保存）。',
        ],
        links: [
          { label: 'QQ 邮箱帮助：如何开启 IMAP/SMTP 服务', url: 'https://service.mail.qq.com/detail/0/75' },
        ],
        note: 'QQ 邮箱的收信（IMAP）需要单独开启，若只开了 SMTP 则只能发不能收。',
      },
      en: {
        summary: 'QQ Mail requires an app authorization code instead of your QQ password.',
        steps: [
          'Open QQ Mail on the web and go to Settings → Account → Security.',
          'Enable the IMAP/SMTP service (QQ security verification may be required).',
          'Generate an authorization code; it is a 16-character string shown once.',
          'Paste the authorization code into the field below.',
        ],
        links: [
          { label: 'QQ Mail help: enable IMAP/SMTP', url: 'https://service.mail.qq.com/detail/0/75' },
        ],
        note: 'Receiving (IMAP) must be enabled separately from sending (SMTP).',
      },
    },
  },
  '163': {
    id: '163',
    label: { zh: '网易 163 邮箱', en: 'NetEase 163 Mail' },
    smtp: { host: 'smtp.163.com', port: 465, security: 'tls' },
    imap: { host: 'imap.163.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: '163 邮箱需要开启 IMAP/SMTP 服务并使用「授权密码」。',
        steps: [
          '登录 163 邮箱网页版，进入「设置」→「POP3/SMTP/IMAP」。',
          '开启「IMAP/SMTP 服务」，按提示完成手机验证。',
          '在「授权密码管理」中新增授权密码，得到一串授权码。',
          '把授权码填入下方输入框（163 首次 IMAP 登录会自动发送 IMAP ID 标识，插件已内置）。',
        ],
        links: [
          { label: '163 邮箱帮助中心', url: 'https://help.mail.163.com/' },
          { label: '如何开启 IMAP/SMTP 服务', url: 'https://help.mail.163.com/faqDetail.do?code=2' },
        ],
        note: '163 对第三方客户端有安全限制，IMAP 登录需要先发送 ID 命令，插件会自动处理。',
      },
      en: {
        summary: '163 Mail requires enabling IMAP/SMTP and using an app-specific password.',
        steps: [
          'Sign in to 163 Mail on the web and open Settings → POP3/SMTP/IMAP.',
          'Enable the IMAP/SMTP service and complete phone verification.',
          'Create an authorization password and copy it.',
          'Paste the authorization password below (the plugin sends the required IMAP ID automatically).',
        ],
        links: [{ label: '163 Mail help center', url: 'https://help.mail.163.com/' }],
        note: '163 restricts third-party clients; the plugin sends the IMAP ID command automatically.',
      },
    },
  },
  '126': {
    id: '126',
    label: { zh: '网易 126 邮箱', en: 'NetEase 126 Mail' },
    smtp: { host: 'smtp.126.com', port: 465, security: 'tls' },
    imap: { host: 'imap.126.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: '126 邮箱的授权方式与 163 相同，需要授权密码。',
        steps: [
          '登录 126 邮箱网页版，进入「设置」→「POP3/SMTP/IMAP」。',
          '开启「IMAP/SMTP 服务」并完成手机验证。',
          '新增「授权密码」，复制到下方输入框。',
        ],
        links: [{ label: '126 邮箱帮助中心', url: 'https://help.mail.163.com/' }],
        note: 'IMAP 登录需要 ID 命令，插件会自动处理。',
      },
      en: {
        summary: '126 Mail uses the same authorization-password flow as 163.',
        steps: [
          'Sign in to 126 Mail on the web and open Settings → POP3/SMTP/IMAP.',
          'Enable IMAP/SMTP and complete phone verification.',
          'Create an authorization password and paste it below.',
        ],
        links: [{ label: '126 Mail help center', url: 'https://help.mail.163.com/' }],
        note: 'The plugin sends the IMAP ID command automatically.',
      },
    },
  },
  gmail: {
    id: 'gmail',
    label: { zh: 'Gmail', en: 'Gmail' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: 'Gmail 需要先开启两步验证，再用「应用专用密码」登录。',
        steps: [
          '在 Google 账号安全设置中开启两步验证（2-Step Verification）。',
          '进入「应用专用密码」页面，创建一个用于「邮件」的密码（16 位）。',
          '把应用专用密码填入下方输入框（不是 Google 账号密码）。',
          'Gmail 网页端无需额外开启 IMAP（默认已开启，可到「转发和 POP/IMAP」确认）。',
        ],
        links: [
          { label: 'Google：创建应用专用密码', url: 'https://support.google.com/accounts/answer/185833' },
          { label: 'Gmail：IMAP 设置说明', url: 'https://support.google.com/mail/answer/7126229' },
        ],
        note: '若账号启用了高级保护，需要管理员或安全密钥才能创建应用专用密码。',
      },
      en: {
        summary: 'Gmail requires 2-Step Verification and an app password.',
        steps: [
          'Turn on 2-Step Verification in your Google Account security settings.',
          'Create an app password for Mail (16 characters).',
          'Paste the app password below (not your Google account password).',
          'IMAP is enabled by default in Gmail; check Forwarding and POP/IMAP if unsure.',
        ],
        links: [
          { label: 'Google: create an app password', url: 'https://support.google.com/accounts/answer/185833' },
          { label: 'Gmail: IMAP settings', url: 'https://support.google.com/mail/answer/7126229' },
        ],
      },
    },
  },
  outlook: {
    id: 'outlook',
    label: { zh: 'Outlook / Microsoft 365', en: 'Outlook / Microsoft 365' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: 'Outlook 正在淘汰基础认证；新账号建议使用 Outlook 官方应用，或确认租户仍允许基础认证。',
        steps: [
          '确认账号/租户允许 SMTP/IMAP 基础认证（很多 Microsoft 365 租户已禁用）。',
          '若开启了两步验证，需要创建「应用密码」（微软账号安全设置 → 安全选项）。',
          '把应用密码填入下方输入框；若登录失败，请改用支持 OAuth2 的客户端。',
        ],
        links: [
          { label: 'Microsoft：应用密码与两步验证', url: 'https://support.microsoft.com/account-billing/using-app-passwords-with-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944' },
          { label: 'Microsoft：Outlook.com 的 POP、IMAP 和 SMTP 设置', url: 'https://support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040' },
        ],
        note: 'Outlook/Office 365 对新式认证（OAuth2）的要求越来越严格，基础认证可能被拒绝；插件本版仅支持授权码/应用密码方式。',
      },
      en: {
        summary: 'Outlook is deprecating basic auth; verify your tenant still allows SMTP/IMAP with an app password.',
        steps: [
          'Confirm SMTP/IMAP basic authentication is allowed for the account or tenant.',
          'If 2-step verification is on, create an app password in Microsoft account security options.',
          'Paste the app password below; if login fails, use an OAuth2-capable client.',
        ],
        links: [
          { label: 'Microsoft: app passwords', url: 'https://support.microsoft.com/account-billing/using-app-passwords-with-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944' },
          { label: 'Microsoft: POP/IMAP/SMTP settings', url: 'https://support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040' },
        ],
      },
    },
  },
  icloud: {
    id: 'icloud',
    label: { zh: 'iCloud 邮箱', en: 'iCloud Mail' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: 'iCloud 邮箱需要使用「App 专用密码」。',
        steps: [
          '登录 appleid.apple.com，进入「登录与安全」→「App 专用密码」。',
          '生成一个 App 专用密码并复制。',
          '把 App 专用密码填入下方输入框。',
        ],
        links: [
          { label: 'Apple：使用 App 专用密码', url: 'https://support.apple.com/zh-cn/102654' },
          { label: 'Apple：iCloud 邮件服务器设置', url: 'https://support.apple.com/zh-cn/guide/icloud/mm6b1a7e3b/icloud' },
        ],
        note: '',
      },
      en: {
        summary: 'iCloud Mail requires an app-specific password.',
        steps: [
          'Sign in at appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
          'Generate an app-specific password and copy it.',
          'Paste the app-specific password below.',
        ],
        links: [{ label: 'Apple: app-specific passwords', url: 'https://support.apple.com/en-us/102654' }],
        note: '',
      },
    },
  },
  custom: {
    id: 'custom',
    label: { zh: '自定义 SMTP / IMAP', en: 'Custom SMTP / IMAP' },
    smtp: { host: '', port: 465, security: 'tls' },
    imap: { host: '', port: 993, security: 'tls' },
    guide: {
      zh: {
        summary: '填写邮件服务商提供的服务器地址、端口与加密方式，并使用授权码或应用密码。',
        steps: [
          '在邮箱服务商的帮助文档里找到「IMAP/SMTP 服务器地址与端口」。',
          '开启 IMAP/SMTP 服务并生成授权码或应用密码。',
          '常见组合：465/993 用 SSL/TLS；587/143 用 STARTTLS。',
        ],
        links: [],
        note: '',
      },
      en: {
        summary: 'Enter the server addresses, ports and security mode from your provider, then use an authorization code.',
        steps: [
          'Find the IMAP/SMTP server addresses and ports in your provider help.',
          'Enable IMAP/SMTP and generate an authorization code or app password.',
          'Common pairs: 465/993 use SSL/TLS; 587/143 use STARTTLS.',
        ],
        links: [],
        note: '',
      },
    },
  },
};

/** Preset ids in display order. */
export const PRESET_IDS = ['qq', '163', '126', 'gmail', 'outlook', 'icloud', 'custom'];

/** Effective defaults for one fresh deployment (owner and mailbox are unset). */
export function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    mailbox: {
      address: '',
      displayName: '费加罗',
      // Signature is legacy metadata (the AI now decides its own closing); kept
      // so older configs still render and the prompt can mention the identity.
      signature: '费加罗',
      salutation: '',
      greeting: '',
      subjectPrefix: '[DeepSeek Harness] ',
      letterhead: false,
      avatarFile: '',
    },
    owner: { address: '', name: '' },
    smtp: {
      preset: 'qq',
      host: 'smtp.qq.com',
      port: 465,
      security: 'tls',
      user: '',
      authCode: '',
      authCodeFile: '',
      allowStrangerRecipients: false,
    },
    imap: {
      enabled: true,
      preset: 'qq',
      host: 'imap.qq.com',
      port: 993,
      security: 'tls',
      user: '',
      authCode: '',
      authCodeFile: '',
      mailbox: 'INBOX',
      pollIntervalSeconds: 120,
      markSeen: true,
      fetchLimit: 20,
    },
    friends: { policy: 'auto', defaultAutoReply: false },
    notify: {
      enabled: true,
      target: 'dedicated',
      dedicatedSessionId: '',
      strangerMail: 'notify',
      batchSeconds: 30,
      maxPreviewChars: 200,
    },
    prompt: {
      language: 'zh',
      extraNote: '',
      includeFriendListInSystemPrompt: true,
      maxFriendListInPrompt: 30,
    },
    security: {
      allowRemoteImages: false,
      maxSendsPerHour: 20,
      maxFriendAddsPerDay: 3,
      maxMessageBytes: 5242880,
      quarantineSuspicious: true,
      maxMessagesRetained: 500,
      maxAttachments: 5,
      maxAttachmentBytes: 10485760,
      attachmentDirs: [],
    },
    ui: { locale: 'zh' },
  };
}

/** True for plain JSON objects (not arrays, not null). */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge plain objects; arrays and scalars replace the base value. */
export function deepMerge(base, patch) {
  if (!isRecord(patch)) return clone(base);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

/** Structured clone for JSON-shaped values. */
export function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Trim a value when it is a string; otherwise the fallback. */
function text(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** Positive integer within bounds, or the fallback. */
function integer(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/** Coerce a boolean flag; anything non-boolean falls back. */
function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalize an address: trim and lowercase the domain only (local part stays
 * byte-identical because SMTP treats it literally).
 *
 * @param {unknown} value - raw address text.
 * @returns {string} normalized address, or '' when not address-shaped.
 */
export function normalizeAddress(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/^<|>$/g, '');
  if (!EMAIL_RE.test(trimmed)) return '';
  const at = trimmed.lastIndexOf('@');
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

/** Case-insensitive address comparison. */
export function sameAddress(a, b) {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  return left !== '' && right !== '' && left.toLowerCase() === right.toLowerCase();
}

/** A list of addresses with duplicates removed (case-insensitive). */
export function uniqueAddresses(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const address = normalizeAddress(value);
    if (address === '') continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/** Resolve `$DSH_HOME` (or `~/.dsh`) without importing the harness. */
export function defaultDataDir(env = process.env) {
  const home = text(env.DSH_HOME, '') || join(homedir(), '.dsh');
  return join(home, 'mailbox');
}

/**
 * Validate a raw config object. Lenient: unknown keys are dropped, invalid
 * values fall back to defaults and are reported as issues.
 *
 * @param {unknown} raw - the candidate config.
 * @returns {{ value: object, issues: Array<{ path: string, message: string }>, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  const merged = isRecord(raw) ? deepMerge(base, raw) : base;
  const issues = [];
  const warnings = [];
  const value = defaultConfig();

  const report = (path, message, level = 'issue') => {
    if (level === 'issue') issues.push({ path, message });
    else warnings.push(`${path}: ${message}`);
  };

  // enabled
  if (typeof merged.enabled !== 'boolean') report('enabled', 'must be a boolean');
  else value.enabled = merged.enabled;

  // mailbox
  const mailbox = merged.mailbox;
  value.mailbox.address = normalizeAddress(mailbox.address);
  if (mailbox.address !== '' && value.mailbox.address === '') report('mailbox.address', 'is not an email address');
  value.mailbox.displayName = text(mailbox.displayName, base.mailbox.displayName);
  value.mailbox.signature = text(mailbox.signature, base.mailbox.signature) || base.mailbox.signature;
  value.mailbox.salutation = text(mailbox.salutation, '');
  value.mailbox.greeting = text(mailbox.greeting, base.mailbox.greeting);
  value.mailbox.subjectPrefix = text(mailbox.subjectPrefix, base.mailbox.subjectPrefix);
  if (value.mailbox.subjectPrefix !== '' && !value.mailbox.subjectPrefix.endsWith(' ')) value.mailbox.subjectPrefix += ' ';
  value.mailbox.letterhead = flag(mailbox.letterhead, true);
  value.mailbox.avatarFile = text(mailbox.avatarFile, '');

  // owner
  const owner = merged.owner;
  value.owner.address = normalizeAddress(owner.address);
  if (owner.address !== '' && value.owner.address === '') report('owner.address', 'is not an email address');
  else if (owner.address === '') report('owner.address', 'a non-empty email address is required');
  value.owner.name = text(owner.name, '');

  // smtp
  const smtp = merged.smtp;
  value.smtp.preset = PRESET_IDS.includes(smtp.preset) ? smtp.preset : 'custom';
  value.smtp.host = text(smtp.host, '');
  if (value.smtp.host === '') report('smtp.host', 'a host is required');
  value.smtp.port = integer(smtp.port, base.smtp.port, 1, 65535);
  if (value.smtp.port !== smtp.port) report('smtp.port', 'must be an integer between 1 and 65535');
  value.smtp.security = SECURITY_MODES.includes(smtp.security) ? smtp.security : 'tls';
  if (value.smtp.security !== smtp.security) report('smtp.security', `must be one of ${SECURITY_MODES.join(', ')}`);
  value.smtp.user = text(smtp.user, '');
  if (value.smtp.user === '') report('smtp.user', 'a login mailbox address is required');
  else if (normalizeAddress(value.smtp.user) === '') report('smtp.user', 'is not an email address');
  value.smtp.authCode = text(smtp.authCode, '');
  value.smtp.authCodeFile = text(smtp.authCodeFile, '');
  value.smtp.allowStrangerRecipients = flag(smtp.allowStrangerRecipients, false);
  if (value.smtp.security === 'none' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(value.smtp.host)) {
    report('smtp.security', 'plaintext SMTP is only allowed for localhost');
    value.smtp.security = 'tls';
  }

  // imap
  const imap = merged.imap;
  value.imap.enabled = flag(imap.enabled, true);
  value.imap.preset = PRESET_IDS.includes(imap.preset) ? imap.preset : 'custom';
  value.imap.host = text(imap.host, '');
  if (value.imap.host === '') report('imap.host', 'a host is required');
  value.imap.port = integer(imap.port, base.imap.port, 1, 65535);
  if (value.imap.port !== imap.port) report('imap.port', 'must be an integer between 1 and 65535');
  value.imap.security = SECURITY_MODES.includes(imap.security) ? imap.security : 'tls';
  if (value.imap.security !== imap.security) report('imap.security', `must be one of ${SECURITY_MODES.join(', ')}`);
  value.imap.user = text(imap.user, '') || value.smtp.user;
  if (value.imap.user === '') report('imap.user', 'a login mailbox address is required');
  else if (normalizeAddress(value.imap.user) === '') report('imap.user', 'is not an email address');
  value.imap.authCode = text(imap.authCode, '');
  value.imap.authCodeFile = text(imap.authCodeFile, '');
  value.imap.mailbox = text(imap.mailbox, 'INBOX') || 'INBOX';
  const interval = integer(imap.pollIntervalSeconds, base.imap.pollIntervalSeconds, 30, 3600);
  if (interval !== imap.pollIntervalSeconds) report('imap.pollIntervalSeconds', 'must be an integer between 30 and 3600');
  value.imap.pollIntervalSeconds = interval;
  value.imap.markSeen = flag(imap.markSeen, true);
  const limit = integer(imap.fetchLimit, base.imap.fetchLimit, 1, 100);
  if (limit !== imap.fetchLimit) report('imap.fetchLimit', 'must be an integer between 1 and 100');
  value.imap.fetchLimit = limit;
  if (value.imap.security === 'none' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(value.imap.host)) {
    report('imap.security', 'plaintext IMAP is only allowed for localhost');
    value.imap.security = 'tls';
  }

  // friends
  const friends = merged.friends;
  value.friends.policy = FRIEND_POLICIES.includes(friends.policy) ? friends.policy : 'auto';
  if (value.friends.policy !== friends.policy) report('friends.policy', `must be one of ${FRIEND_POLICIES.join(', ')}`);
  value.friends.defaultAutoReply = flag(friends.defaultAutoReply, false);

  // notify
  const notify = merged.notify;
  value.notify.enabled = flag(notify.enabled, true);
  const target = typeof notify.target === 'string' ? notify.target.trim() : '';
  if (NOTIFY_TARGETS.includes(target) || /^[A-Za-z0-9_-]{8,}$/.test(target)) value.notify.target = target;
  else {
    report('notify.target', 'must be "dedicated", "latest", "all", or a session id');
    value.notify.target = 'dedicated';
  }
  value.notify.dedicatedSessionId = text(notify.dedicatedSessionId, '');
  if (value.notify.dedicatedSessionId !== '' && !/^[A-Za-z0-9_-]{8,}$/.test(value.notify.dedicatedSessionId)) {
    report('notify.dedicatedSessionId', 'must be a session id');
    value.notify.dedicatedSessionId = '';
  }
  value.notify.strangerMail = STRANGER_POLICIES.includes(notify.strangerMail) ? notify.strangerMail : 'notify';
  if (!STRANGER_POLICIES.includes(notify.strangerMail)) report('notify.strangerMail', `must be one of ${STRANGER_POLICIES.join(', ')}`);
  const batch = integer(notify.batchSeconds, base.notify.batchSeconds, 0, 600);
  if (batch !== notify.batchSeconds) report('notify.batchSeconds', 'must be an integer between 0 and 600');
  value.notify.batchSeconds = batch;
  const preview = integer(notify.maxPreviewChars, base.notify.maxPreviewChars, 40, 2000);
  if (preview !== notify.maxPreviewChars) report('notify.maxPreviewChars', 'must be an integer between 40 and 2000');
  value.notify.maxPreviewChars = preview;

  // prompt
  const prompt = merged.prompt;
  value.prompt.language = PROMPT_LANGUAGES.includes(prompt.language) ? prompt.language : 'zh';
  if (!PROMPT_LANGUAGES.includes(prompt.language)) report('prompt.language', `must be one of ${PROMPT_LANGUAGES.join(', ')}`);
  value.prompt.extraNote = text(prompt.extraNote, '');
  value.prompt.includeFriendListInSystemPrompt = flag(prompt.includeFriendListInSystemPrompt, true);
  const maxFriends = integer(prompt.maxFriendListInPrompt, base.prompt.maxFriendListInPrompt, 0, 200);
  if (maxFriends !== prompt.maxFriendListInPrompt) report('prompt.maxFriendListInPrompt', 'must be an integer between 0 and 200');
  value.prompt.maxFriendListInPrompt = maxFriends;

  // security
  const security = merged.security;
  value.security.allowRemoteImages = flag(security.allowRemoteImages, false);
  const sends = integer(security.maxSendsPerHour, base.security.maxSendsPerHour, 1, 200);
  if (sends !== security.maxSendsPerHour) report('security.maxSendsPerHour', 'must be an integer between 1 and 200');
  value.security.maxSendsPerHour = sends;
  const adds = integer(security.maxFriendAddsPerDay, base.security.maxFriendAddsPerDay, 0, 100);
  if (adds !== security.maxFriendAddsPerDay) report('security.maxFriendAddsPerDay', 'must be an integer between 0 and 100');
  value.security.maxFriendAddsPerDay = adds;
  const maxBytes = integer(security.maxMessageBytes, base.security.maxMessageBytes, 64 * 1024, 50 * 1024 * 1024);
  if (maxBytes !== security.maxMessageBytes) report('security.maxMessageBytes', 'must be an integer between 64 KB and 50 MB');
  value.security.maxMessageBytes = maxBytes;
  value.security.quarantineSuspicious = flag(security.quarantineSuspicious, true);
  const retained = integer(security.maxMessagesRetained, base.security.maxMessagesRetained, 20, 5000);
  if (retained !== security.maxMessagesRetained) report('security.maxMessagesRetained', 'must be an integer between 20 and 5000');
  value.security.maxMessagesRetained = retained;
  const maxAttachments = integer(security.maxAttachments, base.security.maxAttachments, 1, 10);
  if (maxAttachments !== security.maxAttachments) report('security.maxAttachments', 'must be an integer between 1 and 10');
  value.security.maxAttachments = maxAttachments;
  const maxAttachmentBytes = integer(security.maxAttachmentBytes, base.security.maxAttachmentBytes, 1024 * 1024, 20 * 1024 * 1024);
  if (maxAttachmentBytes !== security.maxAttachmentBytes) report('security.maxAttachmentBytes', 'must be an integer between 1 MB and 20 MB');
  value.security.maxAttachmentBytes = maxAttachmentBytes;
  const dirs = Array.isArray(security.attachmentDirs) ? security.attachmentDirs.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  value.security.attachmentDirs = dirs.map((item) => item.trim());
  if (!Array.isArray(security.attachmentDirs) && security.attachmentDirs !== undefined) report('security.attachmentDirs', 'must be an array of directory paths');

  // ui
  value.ui.locale = merged.ui && merged.ui.locale === 'en' ? 'en' : 'zh';

  for (const key of Object.keys(merged)) {
    if (!(key in base)) warnings.push(`unknown config key "${key}" dropped`);
  }

  return { value, issues, warnings };
}

/** Validate a config and throw one aggregated error when invalid. */
export function validateConfig(raw) {
  const normalized = normalizeConfig(raw);
  if (normalized.issues.length > 0) {
    const error = new Error(`invalid mailbox config: ${normalized.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    error.code = 'config-invalid';
    error.issues = normalized.issues;
    throw error;
  }
  return normalized.value;
}

/**
 * Read the authorization code for one protocol section.
 * Order: explicit value → private file → environment variables.
 *
 * @param {{ authCode?: string, authCodeFile?: string }} section - smtp or imap.
 * @param {string[]} envNames - environment fallbacks, first hit wins.
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @returns {Promise<{ value: string, source: 'config'|'file'|'env'|'' }>}
 */
export async function resolveAuthCode(section, envNames = [], env = process.env) {
  if (typeof section.authCode === 'string' && section.authCode.trim() !== '') {
    return { value: section.authCode.trim(), source: 'config' };
  }
  if (typeof section.authCodeFile === 'string' && section.authCodeFile.trim() !== '') {
    try {
      const value = (await readFile(section.authCodeFile.trim(), 'utf8')).trim();
      if (value !== '') return { value, source: 'file' };
    } catch (error) {
      throw new Error(`cannot read authCodeFile "${section.authCodeFile}": ${error.message}`);
    }
  }
  for (const name of envNames) {
    const value = (env[name] ?? '').trim();
    if (value !== '') return { value, source: 'env' };
  }
  return { value: '', source: '' };
}

/** SMTP authorization code, with the documented environment fallbacks. */
export function resolveSmtpAuthCode(config, env = process.env) {
  return resolveAuthCode(config.smtp, ['DSH_SMTP_AUTH_CODE', 'SMTP_AUTH_CODE'], env);
}

/** IMAP authorization code, falling back to the SMTP one when unset. */
export async function resolveImapAuthCode(config, env = process.env) {
  const imap = await resolveAuthCode(config.imap, ['DSH_IMAP_AUTH_CODE', 'IMAP_AUTH_CODE'], env).catch(() => ({ value: '', source: '' }));
  if (imap.value !== '') return imap;
  return resolveSmtpAuthCode(config, env);
}

/** Whether sending / receiving is fully configured (without reading secrets). */
export function connectionStatus(config) {
  const smtpConfigured = config.smtp.host !== '' && config.smtp.user !== '' && (config.smtp.authCode !== '' || config.smtp.authCodeFile !== '');
  const imapConfigured = config.imap.enabled && config.imap.host !== '' && config.imap.user !== '' && (config.imap.authCode !== '' || config.imap.authCodeFile !== '');
  return {
    smtp: { host: config.smtp.host, port: config.smtp.port, security: config.smtp.security, user: config.smtp.user, configured: smtpConfigured },
    imap: { host: config.imap.host, port: config.imap.port, security: config.imap.security, user: config.imap.user, configured: imapConfigured, enabled: config.imap.enabled },
  };
}

/**
 * Strip secrets for the browser. Replaces authorization codes with flags while
 * keeping everything else identical, so the UI never receives a secret.
 *
 * @param {object} config - normalized config.
 * @param {{ smtp: { source: string, configured: boolean }, imap: { source: string, configured: boolean } }} [secretStatus]
 * @returns {object} a UI-safe copy.
 */
export function maskConfig(config, secretStatus = {}) {
  const safe = clone(config);
  const smtpConfigured = secretStatus.smtp?.configured ?? (config.smtp.authCode !== '' || config.smtp.authCodeFile !== '');
  const imapConfigured = secretStatus.imap?.configured ?? (config.imap.authCode !== '' || config.imap.authCodeFile !== '');
  safe.smtp.authCode = '';
  safe.smtp.authCodeFile = secretStatus.smtp?.source === 'file' ? config.smtp.authCodeFile : '';
  safe.imap.authCode = '';
  safe.imap.authCodeFile = secretStatus.imap?.source === 'file' ? config.imap.authCodeFile : '';
  safe.secrets = {
    smtp: { configured: smtpConfigured, source: secretStatus.smtp?.source ?? (config.smtp.authCode !== '' ? 'config' : config.smtp.authCodeFile !== '' ? 'file' : '') },
    imap: { configured: imapConfigured, source: secretStatus.imap?.source ?? (config.imap.authCode !== '' ? 'config' : config.imap.authCodeFile !== '' ? 'file' : '') },
  };
  return safe;
}

/** Provider preset payload for the UI, resolved to one language. */
export function presetForUi(locale = 'zh') {
  return PRESET_IDS.map((id) => {
    const preset = PRESETS[id];
    const guide = preset.guide[locale] ?? preset.guide.zh;
    return {
      id: preset.id,
      label: preset.label[locale] ?? preset.label.zh,
      smtp: preset.smtp,
      imap: preset.imap,
      guide,
    };
  });
}
