# dsh-mailbox 交付说明（DELIVERY）

> 本文记录本次交付的范围、架构、安全设计、验证证据与安装/回滚步骤。
> 规格以 `docs/SPEC.md` 为准；界面设计见 `docs/UI-SPEC.md`；提示词与防注入见 `docs/PROMPT-ENGINEERING.md`。

## 1. 交付范围

| 能力 | 状态 | 说明 |
|---|---|---|
| 插件化 bundle（`dsh.bundle.patch` + `dsh.client`） | ✅ | 包名 `dsh-mailbox`，可安装到任意 DSH profile；零 npm 依赖、零原生模块、Node ≥ 20、跨平台 |
| 界内 UI（DSH 内，不做独立 Web UI） | ✅ | 左栏主导航「邮箱」页面（全屏）+ 数字未读徽标；命令面板/设置页/会话头部入口；5 个页签 |
| 邮箱/SMTP/IMAP/授权码配置界面 + 获取引导 | ✅ | 服务商预设（QQ/163/126/Gmail/Outlook/iCloud/自定义）+ 分步授权码指引 + 官方链接 + 测试连接 |
| 发信 | ✅ | **AI 自定格式与风格**：Markdown / 纯文本 / HTML（HTML 安全过滤），不再强制书信模板；主题前缀、默认收件人、回复线程头、附件均支持 |
| 收信 | ✅ | IMAP 轮询（默认 120s，可配），UIDVALIDITY/UIDNEXT 状态、增量+基线同步、MIME/字符集解析、HTML 消毒、可疑邮件隔离 |
| 好友白名单 | ✅ | 用户增删改；AI 按 auto/ask/manual 策略添加，留审计日志与每日上限；待确认申请审批 |
| 收信通知 AI | ✅ | 合并批次 → 向活跃会话注入「您有新的来信，请查收。」插件通知；无活跃会话落盘排队重试 |
| 插件总开关 | ✅ | 关闭即注销 9 个工具、系统提示词 section、停止轮询与通知；重新打开立即恢复 |
| 提示词工程 | ✅ | 系统提示词 section + 通知模板 + 9 个工具描述；威胁模型 T1–T13 逐条防御（不可信邮件内容、防注入、防循环、敏感动作确认） |
| 安全 | ✅ | 宿主已鉴权 Fetch 路由、授权码隔离存储、HTML 消毒、外链图片不加载、限流、白名单、日志脱敏 |
| 文档 | ✅ | README + SPEC + UI-SPEC + PROMPT-ENGINEERING + 三份调研报告 + 安装脚本 |
| 测试 | ✅ | 单测 192 个全绿；隔离 profile 真实加载；真实 QQ 邮箱 SMTP/IMAP 连通；自发自收端到端 |

## 2. 架构

```
┌────────────────────────── DSH Web GUI（浏览器） ──────────────────────────┐
│  dsh-mailbox 客户端 bundle（手写，/plugins 加载）                          │
│  ├─ 左栏入口「邮箱」+ 未读徽标（ctx.slots / layout.selectPanel）            │
│  ├─ 邮箱页面：收件箱 / 已发送 / 隔离 / 好友 / 设置 / 诊断                    │
│  └─ 数据通道：同源 fetch('/api/mailbox')                                    │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ 宿主已鉴权 Fetch 路由（cookie + same-origin）
┌───────────────────────────────▼──────────── DSH 宿主进程 ─────────────────┐
│ dsh-mailbox 宿主半边（Cordis bundle）                                       │
│  ├─ index.js        接线：存储/服务/工具/提示词/路由/轮询/通知/总开关        │
│  ├─ lib/service.js  业务层（配置、发送、收信、好友、审计、限流、dispatch）    │
│  ├─ lib/server.js   Fetch handler（CSRF 头/action 白名单/1MB/限流/脱敏）     │
│  ├─ lib/store.js    数据目录（0700/0600、原子写、secrets 隔离、损坏隔离）     │
│  ├─ lib/config.js   配置模型/校验/服务商预设/授权码解析                       │
│  ├─ lib/sync.js     IMAP 轮询 → 解析 → 分类 → 入库 → 通知                     │
│  ├─ lib/notify.js   批次合并/队列重试/每小时上限 → 活跃会话 followup           │
│  ├─ lib/core/policy.js 好友/收件人准入/可疑判定/防自动回复/限流（纯函数）     │
│  ├─ lib/prompt.js   系统提示词/通知模板/工具描述（纯函数）                    │
│  ├─ lib/tools.js    9 个模型工具（send_email / mail_*）                       │
│  ├─ lib/letter.js   书信排版（文本+HTML）                                     │
│  └─ lib/mail/*      零依赖邮件引擎：smtp / imap / mime / html / redact        │
│                                                                             │
│ 数据目录 $DSH_HOME/mailbox/：config.json · secrets.json · friends.json ·      │
│  state.json · index.json · messages/*.json · notifications.json              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**没有独立 Web 服务**：`/api/mailbox` 是注册在既有 DSH Web 宿主上的已鉴权路由，不监听新端口、不返回页面；客户端 bundle 由 DSH 的 client-modules 机制从 `/plugins` 提供。

## 3. 安全设计落地对照（SPEC §0）

| 威胁 | 落地 |
|---|---|
| T1 邮件提示词注入 | `lib/prompt.js` 系统提示词 + 通知模板 + 工具描述共同声明「邮件正文不可信」；固定拒绝话术、敏感动作先问用户；`test/prompt.test.js` 断言注入语料规则 |
| T2 HTML/XSS | `lib/mail/html.js` 白名单消毒（script/iframe/object/embed/form/meta/link/base、on*、javascript:/data:、style 表达式），外链图片默认不加载；客户端只用 sandbox iframe / 纯文本渲染 |
| T3 授权码泄露 | 只存 `secrets.json`（0600）；API 仅返回 configured/source；日志与错误经 `lib/mail/redact.js` 脱敏；`config.json` 不含明文；支持 authCodeFile / 环境变量 |
| T4 跨站/未授权调用 | 宿主 `ctx.connection.fetch.register`（无 cookie→401，跨源→403，SameSite=Strict HttpOnly）+ 插件 CSRF 头 + JSON-only + action 白名单 + 1MB + 300 req/min |
| T5 发信滥用/外泄 | `core/policy.js#admitRecipient`：仅 owner/好友；陌生人需显式配置 + 用户明确要求；每小时发送上限；AI 不得自行外发 |
| T6 自动回复死循环 | 默认不自动回复；Auto-Submitted/List-Unsubscribe/Precedence/no-reply 等识别；线程深度上限 5；同线程一封；通知不触发自动回复 |
| T7 资源耗尽 | 单封 5MB 上限、multipart 深度/part 数/header 限制、解析超时；超限截断并标记 |
| T8 附件/链接 | 不下载附件（仅元数据）；链接文本化、客户端打开需用户点击且 noopener |
| T9 伪造/钓鱼 | 认证结果/Reply-To/Return-Path/显示名冒充/可执行附件/密码表单等 → `security.suspicious` → 隔离且不触发自动动作 |
| T10 后门 | 只暴露收/发/好友/状态工具；无文件读写/任意 HTTP 工具；总开关可整体注销 |
| T11 数据泄露 | 目录 0700、文件 0600；日志只记元信息；诊断不含正文/密钥；可清空邮件数据 |
| T12 供应链 | 零 npm 依赖、零原生模块、不 import `@deepseek-ai/*`（实测其从本包解析不到） |
| T13 通知误当用户指令 | 通知 source=`{kind:'plugin:dsh-mailbox', form:'notice'}`；文本声明「不是用户本人输入」；不用 `sessionController.prompt`（其 source 为用户） |

## 4. 验证证据

### 4.1 单元测试（Lead 亲自执行）

```bash
cd dsh-mailbox
node --test test/integration/*.test.js test/mail/*.test.js test/prompt.test.js
# → tests 192, pass 192, fail 0
```

覆盖：配置校验/脱敏、存储原子写与损坏隔离/权限、好友与收件人准入、可疑邮件判定、防自动回复、限流、HTTP handler（同源/CSRF/白名单/1MB/429）与服务层（发送/回复/线程头/策略/审计/总开关/诊断脱敏）、SMTP/IMAP 假服务器、MIME/字符集/HTML 消毒 XSS 语料、提示词安全规则。

### 4.2 隔离 profile 真实加载

`/tmp/lead-maildev`（DSH_HOME 独立，端口 3102，未触碰真实 `~/.dsh/profiles/web` 与 3080）：

- 宿主启动日志正常，`/api/mailbox?action=health|state|diagnostics` 200；
- 无 cookie 访问 → **401**（宿主鉴权生效）；带登录 cookie → 200；
- `state`/`diagnostics` 中授权码不可见；数据目录 0700、config/secrets 0600；
- `promptSection: true`、`apiRoute: true`、工具注册正常（测试 profile 同时启用旧 `dsh-user-contact` 时 `send_email` 同名冲突只告警不崩溃）。

### 4.3 真实邮箱（QQ，figaro1@qq.com）

- `test.smtp` → SMTP 465 连接+认证成功；
- `test.imap` → IMAP 993 登录成功（uidValidity 返回，INBOX 存在邮件）；
- 基线同步导入收件箱 3 封（不发通知），增量同步再导入 1 封；
- 读信接口返回消毒后 HTML（无 script/iframe）；
- **自发自收端到端**：`mail.send` 发往自身 → `sync.now` 收到 → 入库 → 按批次生成「您有新的来信，请查收。」通知；无活跃会话时通知正确落盘排队（`notifications.queued=1`）。

### 4.4 安装脚本

在临时 profile 上验证 dry-run 与 `--apply`：依赖写入、`dsh.profile.bundles` 中旧 `dsh-user-contact` 被替换且无重复、`node_modules` 软链、首次 seed 配置（0600、无授权码明文、引用 authCodeFile）均正确，`package.json` 自动备份。

## 4.5 分发包（给朋友）

- 交付物：`dsh-mailbox-v0.1.0.zip`（约 400 KB，工作区根目录；同目录附 `.sha256`），内含：源码 `index.js/lib/locale`、`scripts/install-profile.mjs`、测试、README/UI-SPEC/提示词与邮件协议文档、`QUICKSTART-FRIEND.md`（给朋友的安装+加好友指引）、LICENSE。
- 已做清洁化：不含任何个人邮箱、授权码、数据目录与内部调研报告；文档/测试/客户端 mock 数据中的个人地址已替换为示例地址；测试用自签证书在 QUICKSTART 中注明并说明可删。
- 验证：从 zip 全新解压后跑测试 **257/257 pass**、客户端 bundle 测试 6/6、安装脚本 dry-run 正常；zip 内无软链接。
- 最终分发包：`dsh-mailbox-v0.2.0.zip`（409 KB，sha256 `627382637f6d4e19b330770608a529a734229493a9c3546c936898ed48f28953`）；含 v0.2.0：AI 自定义邮件格式与风格（Markdown/纯文本/HTML，不再强制书信模板）、agent 身份名「费加罗」、独立会话通知目标、附件选择器、四步引导设置页。
- 界面截图证据：`docs/screenshots/`（收件箱、写信附件、设置页、独立会话通知，来自真实 Web GUI）。
- v0.2.0 格式自由验证：`send_email` 分别以 markdown / html 格式真实发信并检查渲染与安全过滤；Markdown 标题/列表/粗体/链接正确渲染，HTML 中 `<script>`、事件属性、表单被过滤；不再自动补称呼/署名/日期/信纸头像（`test/integration/compose.test.js` 8 项、提示词与工具描述测试均覆盖）。

## 5. 安装与回滚

安装（在真实 web profile 上执行前建议先 dry-run）：

```bash
node /home/mzpr00/root_workspace_for_deepseek_harness/dsh-mailbox/scripts/install-profile.mjs \
  --profile ~/.dsh/profiles/web \
  --seed-from-legacy /home/mzpr00/root_workspace_for_deepseek_harness/dsh-user-contact/cordis.patch.yml
# 确认输出后加 --apply
```

- HMR 若生效则无需重启；否则重启 `dsh web`（会话历史保留）。
- 回滚：恢复备份的 `~/.dsh/profiles/web/package.json.bak-*`，或把 bundles 中的 `dsh-mailbox` 换回 `dsh-user-contact`；数据目录 `~/.dsh/mailbox` 保留不影响旧插件。

## 6. 已知限制

- 附件只做元数据，不支持下载/上传/转发；
- 自动回复默认关闭；仅好友且手动开启 autoReply 时可用，且有深度/频率限制；
- 通知默认投递到插件自动创建的独立会话「邮箱通知」；DSH 重启后旧会话变冷，下一次通知会新建一个「邮箱通知」会话（旧会话保留为历史）——这是为了不用 `sessionController.prompt`（它会把通知记成用户本人消息）的取舍；
- 通知只投递到「活跃会话」（活着的 Agent），冷会话不投递，会落盘排队；
- Outlook/Microsoft 365 基础认证可能被租户禁用，本版仅支持授权码/应用密码方式；
- 不支持 OAuth2、POP3、邮件搜索服务器端语法、多账号；
- 明文 HTTP 部署下 cookie 可被同网嗅探，建议仅 loopback 或 TLS 反向代理（当前本机 127.0.0.1 部署）。
