#!/usr/bin/env node
/**
 * 给隔离测试 profile（DSH_HOME=/tmp/clientui-home）造一份「有邮件」的数据目录，
 * 让真实 UI 可以验证列表/阅读/好友页，而不只看到空状态。
 *
 * 只写测试 HOME 下的 mailbox 数据文件（绝不碰 ~/.dsh）；邮件正文是安全检查过的
 * 简单 HTML（真机收信时由宿主消毒，这里模拟"已消毒"形态）。
 *
 * 用法：node probes/client/seed-test-data.mjs [mailboxDataDir]
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

const dataDir = process.argv[2] ?? '/tmp/clientui-home/mailbox'
const now = Date.now()
const ago = (ms) => new Date(now - ms).toISOString()
const hash = (seed) => {
  let h = 2166136261
  for (const char of seed) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0').repeat(3).slice(0, 20)
}

const templates = [
  {
    from: { name: '林晓', address: 'linxiao@example.com' },
    subject: '项目周报：v0.2 进行中',
    ageMs: 42 * 60 * 1000,
    unread: true,
    friend: true,
    text: '这周的进展：IMAP 收信已经跑通，MIME 解析的 GB18030 分支补了单测。下周计划做通知合并的边界测试。周五前需要你确认一下测试 profile 的端口。',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0 0 12px">这周的进展：IMAP 收信已经跑通，MIME 解析的 GB18030 分支补了单测。</p><p style="margin:0 0 12px">下周计划做通知合并的边界测试。周五前需要你确认一下测试 profile 的端口。</p><p style="margin:16px 0 0"><a href="https://github.com/deepseek-ai/deepseek-harness">https://github.com/deepseek-ai/deepseek-harness</a></p></div>',
    attachments: [{ filename: '周报-2026-11-12.pdf', contentType: 'application/pdf', size: 245760 }],
  },
  {
    from: { name: '仓库通知', address: 'noreply@github.com' },
    subject: '[deepseek-harness] PR #482 merged',
    ageMs: 3 * 60 * 60 * 1000,
    unread: true,
    friend: true,
    automatic: true,
    text: 'Pull request #482 "fix: slot registry priority" was merged. Review the changes at the pull request page.',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0 0 12px">Pull request #482 "fix: slot registry priority" was merged.</p><p style="margin:0">Review the changes at the pull request page.</p></div>',
  },
  {
    from: { name: '陈默', address: 'chenmo@example.org' },
    subject: '周末聚餐',
    ageMs: 26 * 60 * 60 * 1000,
    unread: true,
    friend: true,
    text: '周六晚上老地方，六点半。能来的回个话，我订位置。',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0">周六晚上老地方，六点半。能来的回个话，我订位置。</p></div>',
  },
  {
    from: { name: '周雨', address: 'zhouyu@example.com' },
    subject: '关于协议里那条引用',
    ageMs: 52 * 60 * 60 * 1000,
    unread: false,
    friend: true,
    text: 'In-Reply-To / References 的链路我们只保留最近 10 层，超过 5 层就不自动回复，这个规则写进提示词了吗？',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0">In-Reply-To / References 的链路我们只保留最近 10 层，超过 5 层就不自动回复，这个规则写进提示词了吗？</p></div>',
  },
  {
    from: { name: '未知发件人', address: 'promo@unknown-mailer.biz' },
    subject: '限时优惠：点击领取',
    ageMs: 76 * 60 * 60 * 1000,
    unread: false,
    friend: false,
    suspicious: true,
    text: '尊敬的用户，您的账户存在异常，请点击下方链接输入密码验证身份。',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0 0 12px">尊敬的用户，您的账户存在异常，请点击下方链接输入密码验证身份。</p><p style="margin:0;color:#b42318">（这是一封模拟的可疑邮件：链接不会在客户端自动打开。）</p></div>',
  },
  {
    from: { name: '某营销平台', address: 'news@bulk-sender.example' },
    subject: '本周精选：你可能错过的 10 个工具',
    ageMs: 2 * 24 * 60 * 60 * 1000,
    unread: true,
    friend: false,
    automatic: true,
    folder: 'quarantine',
    text: '这是一封群发营销邮件，已按陌生人策略放入隔离区。',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px"><p style="margin:0">这是一封群发营销邮件，已按陌生人策略放入隔离区。</p></div>',
  },
]

const sentTemplates = [
  {
    from: { name: '费加罗', address: 'figaro1@qq.com' },
    to: [{ name: '林晓', address: 'linxiao@example.com' }],
    subject: '[DeepSeek Harness] Re: 项目周报：v0.2 进行中',
    ageMs: 20 * 60 * 60 * 1000,
    text: '收到，端口用 3102。',
  },
  {
    from: { name: '费加罗', address: 'figaro1@qq.com' },
    to: [{ name: '穆再排尔·穆合塔尔', address: 'mzpr00@163.com' }],
    subject: '[DeepSeek Harness] 插件安装完成报告',
    ageMs: 2 * 24 * 60 * 60 * 1000,
    text: '安装完成，测试 profile 已验证。',
  },
]

const indexRows = []
const bodies = []
const makeBody = (template, index) => {
  const date = ago(template.ageMs)
  const folder = template.folder ?? (template.to !== undefined ? 'sent' : 'inbox')
  const direction = template.to === undefined ? 'in' : 'out'
  const id = (direction === 'in' ? 'in-' : 'out-') + hash(`${index}-${template.subject}`)
  const messageId = '<' + id + '@example.com>'
  const body = {
    id,
    direction,
    messageId,
    from: template.from,
    to: template.to ?? [{ name: '费加罗', address: 'figaro1@qq.com' }],
    cc: [],
    replyTo: [],
    subject: template.subject,
    date,
    receivedAt: date,
    text: template.text,
    html: direction === 'in' ? template.html ?? '' : '',
    snippet: template.text.slice(0, 120),
    attachments: template.attachments ?? [],
    headers: { messageId, inReplyTo: '', references: [] },
    friend: template.friend === true,
    suspicious: template.suspicious === true,
    suspiciousReasons: template.suspicious === true ? ['spf-fail', 'suspicious-content'] : [],
    automatic: template.automatic === true,
    unread: direction === 'in' ? template.unread === true : false,
    threadId: messageId,
    size: template.text.length,
    folder,
  }
  bodies.push(body)
  indexRows.push({
    id,
    folder,
    direction,
    messageId,
    fromAddress: template.from.address,
    fromName: template.from.name,
    toAddresses: body.to.map((item) => item.address),
    subject: template.subject,
    date,
    snippet: body.snippet,
    unread: body.unread,
    friend: body.friend,
    suspicious: body.suspicious,
    suspiciousReasons: body.suspiciousReasons,
    automatic: body.automatic,
    hasAttachments: body.attachments.length > 0,
    threadId: body.threadId,
    notify: body.friend === true || (template.suspicious !== true && folder !== 'quarantine'),
    size: body.size,
    attachments: body.attachments,
  })
}
templates.forEach((template, index) => makeBody(template, index))
sentTemplates.forEach((template, index) => makeBody(template, 100 + index))
indexRows.sort((left, right) => String(right.date).localeCompare(String(left.date)))

const friendsDoc = {
  version: 1,
  policyDefaultAutoReply: false,
  friends: [
    { address: 'linxiao@example.com', name: '林晓', note: '同组前端', reason: '', addedBy: 'user', addedAt: ago(40 * 24 * 60 * 60 * 1000), autoReply: false },
    { address: 'chenmo@example.org', name: '陈默', note: '老同学', reason: '', addedBy: 'user', addedAt: ago(35 * 24 * 60 * 60 * 1000), autoReply: false },
    { address: 'zhouyu@example.com', name: '周雨', note: '协议评审', reason: '来意明确的协议讨论', addedBy: 'ai', addedAt: ago(10 * 24 * 60 * 60 * 1000), autoReply: false },
    { address: 'wangjian@example.com', name: '王简', note: '', reason: '文档 review', addedBy: 'user-approved-ai', addedAt: ago(6 * 24 * 60 * 60 * 1000), autoReply: false },
  ],
  pending: [
    { address: 'zhouyu@example.com', name: '周雨', note: '协议评审', reason: '来信讨论 MIME 解析，来意明确', requestedBy: 'ai', requestedAt: ago(2 * 24 * 60 * 60 * 1000) },
  ],
  aiAddLog: [{ address: 'zhouyu@example.com', at: ago(10 * 24 * 60 * 60 * 1000), reason: '来意明确的协议讨论', action: 'added' }],
}

const config = {
  version: 1,
  enabled: true,
  mailbox: {
    address: 'figaro1@qq.com',
    displayName: '费加罗',
    signature: '费加罗',
    salutation: '穆再排尔·穆合塔尔：',
    greeting: '见信好！',
    subjectPrefix: '[DeepSeek Harness] ',
    letterhead: true,
    avatarFile: '',
  },
  owner: { address: 'mzpr00@163.com', name: '' },
  smtp: { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '', allowStrangerRecipients: false },
  imap: { enabled: false, preset: 'qq', host: 'imap.qq.com', port: 993, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '', mailbox: 'INBOX', pollIntervalSeconds: 120, markSeen: true, fetchLimit: 20 },
  friends: { policy: 'auto', defaultAutoReply: false },
  notify: { enabled: true, target: 'dedicated', strangerMail: 'notify', batchSeconds: 30, maxPreviewChars: 200, dedicatedSessionId: '' },
  prompt: { language: 'zh', extraNote: '', includeFriendListInSystemPrompt: true, maxFriendListInPrompt: 30 },
  security: { allowRemoteImages: false, maxSendsPerHour: 20, maxFriendAddsPerDay: 3, maxMessageBytes: 5242880, quarantineSuspicious: true, maxMessagesRetained: 500 },
  ui: { locale: 'zh' },
}

await mkdir(join(dataDir, 'messages'), { recursive: true })
await writeFile(join(dataDir, 'index.json'), JSON.stringify({ version: 1, messages: indexRows }, null, 2))
await writeFile(join(dataDir, 'friends.json'), JSON.stringify(friendsDoc, null, 2))
await writeFile(join(dataDir, 'config.json'), JSON.stringify(config, null, 2))
await writeFile(join(dataDir, 'secrets.json'), JSON.stringify({ version: 1, smtp: { authCode: 'dummy-test-code-not-real' }, imap: { authCode: 'dummy-test-code-not-real' } }, null, 2))
for (const body of bodies) await writeFile(join(dataDir, 'messages', body.id + '.json'), JSON.stringify(body, null, 2))
for (const file of ['index.json', 'friends.json', 'config.json', 'secrets.json']) {
  try { await chmod(join(dataDir, file), 0o600) } catch {}
}
console.log(`seeded ${bodies.length} messages + ${friendsDoc.friends.length} friends into ${dataDir}`)
