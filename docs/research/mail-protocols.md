# 邮件协议兼容性调研（mail-protocols）

> 项目：dsh-mailbox（DSH 邮箱插件，零依赖邮件协议引擎）
> 主笔：mail-engine 队友 · 日期：2026-11-12 · 环境：Linux / Node v24.22.2 / OpenSSL 3.5.5
> 对应代码：`lib/mail/smtp.js`、`lib/mail/imap.js`、`lib/mail/mime.js`、`lib/mail/html.js`、`lib/mail/redact.js`
> 本文结论以**本机实测 + 官方文档**为准；未实测的一律标注「未验证/推断」。

---

## 1. 结论摘要（TL;DR）

| 结论 | 状态 |
|---|---|
| QQ 邮箱 SMTP 发信（`smtp.qq.com:465`，implicit TLS + AUTH LOGIN + 16 位授权码） | ✅ **真实可用**：自发自收成功，服务器返回 `OK: queued as.`，收件箱确认收到（UID 6） |
| QQ 邮箱 SMTP STARTTLS（`smtp.qq.com:587`） | ✅ **真实可用**：EHLO→STARTTLS→EHLO→AUTH LOGIN 全流程通过（未发信，仅认证+QUIT） |
| QQ 邮箱 IMAP（`imap.qq.com:993`） | ✅ **已开启且可用**：LOGIN → EXAMINE INBOX 只读成功，`EXISTS 4`、`UIDVALIDITY 1789339700`、`UIDNEXT 6` |
| QQ 邮箱 IMAP STARTTLS（`imap.qq.com:143`） | ❌ **不可用**：143 端口 greeting/CAPABILITY **不提供 STARTTLS**，只能用 993 implicit TLS（实测见 §6.4） |
| 163 / 126 / yeah.net IMAP | ⚠️ 未实测（无凭据）；**必须**在 LOGIN 后发送 IMAP `ID` 命令，否则 SELECT 会失败 —— 已实现并假服务器覆盖 |
| Gmail | ⚠️ 未实测；必须「两步验证 + 应用专用密码」，基础密码认证已不可用；引擎支持 AUTH LOGIN/PLAIN 因此应用专用密码方案可行 |
| Outlook / Microsoft 365 | ⚠️ **基础认证已被微软禁用**，需要 OAuth2/XOAUTH2；本引擎未实现 OAuth2 → 当前版本对 Outlook 个人/企业邮箱基本不可用（已知限制，见 §5.4） |
| iCloud | ⚠️ 未实测；必须 Apple ID 开启双重认证 + **App 专用密码**，SMTP 587/STARTTLS、IMAP 993 |
| MIME/字符集 | ✅ UTF-8 / GB18030 / GBK / GB2312 / ISO-8859-1 / 其他 TextDecoder 字符集、RFC 2047、base64、QP、嵌套 multipart、RFC 2231 文件名均已单测覆盖 |
| HTML 消毒 | ✅ XSS payload 集 49 例全部消除（script/iframe/svg/on*/协议混淆/style 表达式/外链图片等），见 `test/mail/html.test.js` |

---

## 2. 本引擎的协议边界（对照服务商现实）

`lib/mail/smtp.js` / `lib/mail/imap.js` 有意只实现 dsh-mailbox 需要的子集：

| 能力 | 支持情况 |
|---|---|
| SMTP 传输 | implicit TLS（465）、STARTTLS（587/25）、`none`（仅 loopback 测试服务器） |
| SMTP 认证 | AUTH LOGIN（QQ 实测）、AUTH PLAIN（假服务器实测）；**不支持 OAuth2/XOAUTH2** |
| SMTP 发信 | 多收件人（逐 RCPT，部分拒绝仍成功）、multipart/alternative、multipart/related（内嵌 CID 图片/头像）、multipart/mixed（附件）、In-Reply-To/References、自定义头、RFC 2047 主题/显示名、RFC 5322 Date/Message-ID、超时/取消/错误脱敏 |
| IMAP 传输 | implicit TLS（993）、STARTTLS（143，服务器须广告）、`none`（仅 loopback 测试） |
| IMAP 认证 | LOGIN（引号字符串；非 ASCII 凭据走 IMAP literal）、登录后可选 `ID` 命令（163/126/yeah 必需） |
| IMAP 读信 | CAPABILITY、SELECT/EXAMINE（UIDVALIDITY/UIDNEXT/EXISTS/FLAGS）、UID SEARCH、UID FETCH（UID/FLAGS/INTERNALDATE/RFC822.SIZE/BODY.PEEK[] 或 BODY.PEEK[HEADER]）、UID STORE ±FLAGS、LOGOUT |
| IMAP 未实现 | APPEND（发信走 SMTP）、IDLE（SPEC 用轮询）、MOVE/COPY、SORT/THREAD、UTF8=ACCEPT、COMPRESS、OAuth2、附件单独下载（BODY.PEEK[] 一次取全文，超限丢弃并标记 truncated） |
| 字符集 | 接收端用 `TextDecoder`（Node 全 ICU）：UTF-8、GB18030、GBK、GB2312、Big5、ISO-8859-1、windows-125x、Shift_JIS、EUC-JP/KR、ISO-2022-JP 等；发送端统一 UTF-8 |
| 安全 | TLS 证书默认严格校验（`rejectUnauthorized:true`）；`security:'none'` 只允许 loopback；授权码在错误/日志里替换为 `[REDACTED]`（含 base64/percent 变体） |

> UI 预设建议见 §8，可直接作为 `lib/config.js` 的 `PRESETS` 数据来源（config.js 由 Lead 维护）。

---

## 3. 服务商参数表

### 3.1 推荐预设（SMTP + IMAP）

| 服务商 | SMTP host | SMTP 端口/加密 | IMAP host | IMAP 端口/加密 | 认证方式 | 凭据类型 |
|---|---|---|---|---|---|---|
| QQ 邮箱 | `smtp.qq.com` | 465 `tls`（实测）或 587 `starttls`（实测） | `imap.qq.com` | 993 `tls`（实测；143 无 STARTTLS，勿用） | AUTH LOGIN（服务器也广告 PLAIN/XOAUTH2） | **16 位授权码**（不是 QQ 密码） |
| 163 邮箱 | `smtp.163.com` | 465 `tls` / 25 `starttls`（推断） | `imap.163.com` | 993 `tls` | AUTH LOGIN/PLAIN + 登录后 `ID` | **客户端授权码** |
| 126 邮箱 | `smtp.126.com` | 465 `tls` | `imap.126.com` | 993 `tls` | 同上，需 `ID` | 客户端授权码 |
| yeah.net | `smtp.yeah.net` | 465 `tls` | `imap.yeah.net` | 993 `tls` | 同上，需 `ID` | 客户端授权码 |
| Gmail | `smtp.gmail.com` | 465 `tls` 或 587 `starttls` | `imap.gmail.com` | 993 `tls` 或 143 `starttls` | AUTH LOGIN/PLAIN | **应用专用密码（16 位，需开两步验证）** |
| Outlook.com | `smtp-mail.outlook.com`（旧）/ `smtp.office365.com`（M365） | 587 `starttls` | `outlook.office365.com`（M365）/ `imap-mail.outlook.com`（旧） | 993 `tls` | **要求 OAuth2（XOAUTH2）** → 本引擎不支持 | 现代认证，无应用专用密码（个人版） |
| iCloud Mail | `smtp.mail.me.com` | 587 `starttls` | `imap.mail.me.com` | 993 `tls` | AUTH PLAIN/LOGIN | **App 专用密码（需双重认证）**，用户名是完整 Apple ID |
| 自定义 | 用户填写 | `tls` / `starttls` / `none`（仅本机） | 用户填写 | `tls` / `starttls` / `none`（仅本机） | AUTH LOGIN/PLAIN | 用户自备 |

POP3（本插件不需要，供参考）：QQ `pop.qq.com:995`、163 `pop.163.com:995`、Gmail `pop.gmail.com:995`、iCloud `pop.mail.me.com:995`。

### 3.2 QQ 实测的服务器能力（本机，2026-11-12）

SMTP `smtp.qq.com:465` EHLO 广告的能力：

```
PIPELINING
SIZE 73400320
AUTH LOGIN PLAIN XOAUTH XOAUTH2
AUTH=LOGIN
MAILCOMPRESS
SMTPUTF8
8BITMIME
```

IMAP `imap.qq.com:993` 登录后 CAPABILITY（节选）：

```
IMAP4rev1 XLIST MOVE IDLE XAPPLEPUSHSERVICE SASL-IR AUTH=PLAIN AUTH=LOGIN
AUTH=XOAUTH2 NAMESPACE CHILDREN ID UIDPLUS ...
```

IMAP `imap.qq.com:143` 的 greeting/CAPABILITY（说明无 STARTTLS）：

```
* OK [CAPABILITY IMAP4 IMAP4rev1 ID AUTH=PLAIN AUTH=LOGIN AUTH=XOAUTH2 NAMESPACE] QQMail XMIMAP4Server ready
```

> 结论：QQ 的 993 与 143 都广告 `ID` 能力，本引擎在 `sendId:'auto'` 下会发送 ID（QQ 接受，返回 OK）。QQ 143 **不广告 STARTTLS**，因此 `security:'starttls'` 在 143 上会得到明确错误「server does not advertise STARTTLS」——UI 预设应把 QQ IMAP 固定为 993/tls。

---

## 4. 授权码 / 应用专用密码获取步骤

> 通用原则：第三方客户端必须用**授权码/应用专用密码**，不能用邮箱登录密码；凭据只保存在 `$DSH_HOME/mailbox/secrets.json`（600 权限），本插件 UI 与 API 永不回显明文。

### 4.1 QQ 邮箱（实测成功路径）

官方帮助：[如何开启 POP3/SMTP/IMAP 服务并获取授权码？](https://help.mail.qq.com/detail/0/1087)

1. 网页登录 QQ 邮箱（https://mail.qq.com）。
2. 顶部「设置」→「账号与安全」。
3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV 服务」，打开 **IMAP/SMTP 服务** 开关（QQ 默认关闭第三方客户端服务）。
4. 按页面提示用绑定手机发送指定短信 → 点「我已发送」完成验证。
5. 页面弹出 **16 位授权码**，复制保存（关闭后只能重置，不再显示）。
6. 在 DSH 邮箱设置里：服务商选 QQ，用户填完整邮箱地址，授权码粘贴这 16 位。
7. 可选：「设备管理 → 授权码管理」里查看/停用/重置；泄露后立即重置。

### 4.2 163 / 126 / yeah.net（网易）

官方帮助中心：https://help.mail.163.com/ （账号与安全 / 客户端协议分类）

1. 网页登录 163 邮箱 → 顶部「设置」→「POP3/SMTP/IMAP」。
2. 开启「IMAP/SMTP 服务」，按提示完成手机短信验证。
3. 设置/查看「客户端授权码」（可新建，形如 16 位字母数字），保存。
4. DSH 邮箱设置：用户填完整邮箱地址，授权码粘贴该客户端授权码。
5. **坑**：网易 IMAP 要求登录后先发 `ID` 命令（见 §5.2）；本引擎默认对 163/126/yeah.net 与所有广告 `ID` 能力的服务器自动发送，无需用户配置。

### 4.3 Gmail

- 应用专用密码（官方）：[Sign in with app passwords](https://support.google.com/mail/answer/185833)
- IMAP/SMTP 配置（官方）：[Check Gmail through other email platforms](https://support.google.com/mail/answer/7126229)

1. Google 账号开启「两步验证」（2-Step Verification）——不开两步验证就没有应用专用密码入口。
2. 打开 https://myaccount.google.com/apppasswords ，创建应用专用密码（16 位，显示为 4 组）。
3. DSH 邮箱设置：用户填完整 Gmail 地址，授权码填这 16 位（去掉空格）。
4. **坑**：Google 已彻底移除「允许不够安全的应用（less secure apps）」；网页登录密码在第三方客户端必然失败；SMTP/IMAP 服务器可能限速；新账号/异常登录会临时锁定 IMAP。

### 4.4 Outlook / Microsoft 365（当前版本受限）

- 服务器设置（官方）：[POP, IMAP, and SMTP settings for Outlook.com](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040)
- 基础认证弃用（官方）：[Deprecation of Basic authentication in Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)

**关键限制**：微软自 2022-10-01 起在 Exchange Online 停用基础认证，Outlook.com 个人邮箱也已切换到现代认证；AUTH LOGIN/PLAIN（用密码或应用专用密码）会被拒绝（典型错误 `5.7.139 Authentication unsuccessful, basic authentication is disabled`）。
本引擎未实现 OAuth2/XOAUTH2，因此：

- **当前版本不支持** Outlook.com / Microsoft 365 邮箱（UI 预设应显式标注并建议使用 Gmail/QQ/iCloud 或自建 SMTP）。
- 若未来要支持：需要 OAuth2 授权码流程 + 存 refresh token + SMTP `AUTH XOAUTH2` / IMAP `AUTHENTICATE XOAUTH2`，属于独立子任务。
- 企业租户若管理员仍允许（或启用 SMTP AUTH + 应用密码），理论上可用 AUTH LOGIN；这是例外，不作为默认预期。

### 4.5 iCloud Mail

- 服务器设置（官方，中文）：[适用于其他电子邮件客户端 App 的 iCloud 邮件服务器设置](https://support.apple.com/zh-cn/102525)
- App 专用密码（官方）：[使用 App 专用密码](https://support.apple.com/zh-cn/102654)

1. Apple ID 开启双重认证。
2. 打开 https://appleid.apple.com →「登录与安全」→「App 专用密码」→ 生成（形如 `xxxx-xxxx-xxxx-xxxx`）。
3. iCloud 设置里确认「邮件」已开启（iCloud+ / 自定域名邮箱也可）。
4. DSH 邮箱设置：用户名填完整 Apple ID 邮箱，授权码粘贴 App 专用密码。
5. 参数：SMTP `smtp.mail.me.com:587` + STARTTLS；IMAP `imap.mail.me.com:993` + TLS。
6. **坑**：用 Apple ID 主密码会认证失败；某些网络环境需要允许 587 出站；iCloud 对发信频率/附件大小限制较严。

### 4.6 自定义服务商

- SMTP：host / port / `tls`(465) 或 `starttls`(587/25) / 用户名 / 密码或授权码。
- IMAP：host / port / `tls`(993) 或 `starttls`(143) / 同上。
- `security:'none'` 仅允许本机回环地址（本地假服务器测试用），防止明文凭据外发。
- 自签证书：生产不允许；测试代码才可通过 `tlsOptions:{rejectUnauthorized:false}` 关闭校验（DSH 的 UI 不暴露该选项）。

---

## 5. 已知坑清单（按踩坑概率排序）

### 5.1 QQ

1. **默认关闭第三方客户端协议**：不开 IMAP/SMTP 服务，登录直接返回 `LOGIN failed` / `AUTHENTICATE failed`。必须在网页版开启（见 §4.1）。
2. **必须用 16 位授权码**，用 QQ 密码会认证失败。授权码关闭弹窗后不可再查看，只能重置。
3. **IMAP 143 无 STARTTLS**：QQ 官方文档虽列 143，但实测（2026-11-12）greeting 与 CAPABILITY 都没有 STARTTLS。请固定 993/tls；本引擎对 `security:'starttls'`+143 会给出明确「server does not advertise STARTTLS」错误而不是静默降级。
4. SMTP 587 STARTTLS 实测可用；465 implicit TLS 是首选（少一次握手往返）。
5. QQ 对发信内容/频率有反垃圾限制：短时间大量发信、正文含大量链接、首次登录的新设备可能被临时限制（返回 `550`/`451` 类错误）。dsh-mailbox 侧有「每任务最多一封」的策略，不要重试风暴。
6. 服务端 `SIZE 73400320`（约 70 MB）为收信容量参考；本地引擎默认单封上限 5 MB（解析）/ 20 MB（发送），远小于服务端上限，够用且防资源耗尽。
7. QQ IMAP 广告 `ID` 能力；本引擎自动发送 `ID`（QQ 返回 OK），不影响兼容。

### 5.2 163 / 126 / yeah.net

1. **登录后必须发 IMAP `ID` 命令**，否则网易服务器会拒绝 SELECT（常见 `NO [ALERT] Unsafe Login` / `SELECT Unsafe Login. Please contact ...`）。本引擎在 `sendId:'auto'` 时对 163/126/yeah.net 域名或广告 `ID` 能力的服务器自动发送：
   `ID ("name" "dsh-mailbox" "version" "0.1" "vendor" "dsh-mailbox")`，失败不致命（服务器不支持的会 BAD/NO，被忽略）。
2. 必须开启「客户端授权码」并用授权码登录，不能用登录密码。
3. 邮件文件夹名（已发送/垃圾邮件）是 modified UTF-7，本插件只轮询 `INBOX`，不受影响。
4. 163 对第三方客户端有限速/风控，轮询间隔不要低于 60s（SPEC 默认 120s）。

### 5.3 Gmail

1. 必须开两步验证才能创建应用专用密码；「less secure apps」已下线。
2. 应用专用密码 16 位（页面显示带空格，粘贴时去掉空格）。本引擎对授权码按原样 base64 发送，空格会造成认证失败，UI 应在保存时 trim。
3. 新账号 / 异常地理位置登录可能触发临时锁定（`LOGIN failed`），需在网页确认后重试。
4. Google 会限制并发 IMAP 连接数与单次 FETCH 大小；轮询 + fetchLimit 是安全做法。

### 5.4 Outlook / Microsoft 365

1. 基础认证已禁用，AUTH LOGIN/PLAIN 不可用（见 §4.4）。当前版本不支持；UI 需显式提示，避免用户反复试错。
2. 若企业租户启用 SMTP AUTH 并允许应用密码，可尝试手动配置，但微软对个人 Outlook.com 已关闭该路径。

### 5.5 iCloud

1. 必须「双重认证 + App 专用密码」，Apple ID 主密码失败。
2. SMTP 587 必须 STARTTLS（本引擎支持）。
3. 部分网络对 587 出站有限制；若失败先换网络或用 993/465 验证。

### 5.6 通用协议坑（引擎已处理）

1. **RFC 2047 编码字**：主题/发件人名/附件名里的 `=?UTF-8?B?...?=`，且相邻编码字之间的空白必须丢弃；GBK/GB2312 编码字要按 gb18030 解码（超集）。已单测。
2. **MIME 嵌套**：`multipart/mixed → multipart/related → multipart/alternative`、边界字符串含引号/分号、RFC 2231 `filename*=UTF-8''...`、`filename*0*` 续行。已单测。
3. **QP 软换行**、base64 换行/非法字符、缺 charset 的 8bit 中文。已处理（缺 charset 时回退 UTF-8）。
4. **头部折行**：长 Subject/To 折行展开；恶意超长 header 会被截断并标记 `truncated`。
5. **RFC 2231 / RFC 2047 文件名**：统一解码为可读文件名。
6. **UIDVALIDITY 变化**：服务端重建邮箱会导致 UID 失效，同步层必须比对 `uidValidity` 并重置 `lastUid`（SPEC §7 / `lib/sync.js`；引擎在 `select()` 返回）。
7. **BODY.PEEK[]**：读信必须用 PEEK 版本，否则会把未读强制置为已读；本引擎固定 PEEK。
8. **IMAP literal**：FETCH 的正文是 literal，按行读协议会错位；本引擎实现 literal-aware reader，测试覆盖正文含 `\r\n)`、二进制字节的情况。
9. **点填充（dot-stuffing）**：SMTP DATA 中行首 `.` 需双写；本引擎发送时统一处理。
10. **证书**：email 服务商证书均受公共 CA 签发；引擎默认严格校验，测试用自签证书时才关闭。

---

## 6. 真实连通实测记录（QQ 邮箱，2026-11-12，Asia/Shanghai）

> 凭据：`/home/mzpr00/.dsh/secrets/figaro1-qq-smtp.txt`（16 字符授权码，**值不打印、不落盘、不进日志**）。
> 纪律：只向 figaro1@qq.com 自己发信（共 1 封）；IMAP 一律只读（EXAMINE），不标已读、不改任何设置；未使用 3080 端口或 `~/.dsh` 数据目录做实验。

### 6.1 SMTP 发信（implicit TLS 465 + AUTH LOGIN）✅

| 项 | 值 |
|---|---|
| 服务器 | `smtp.qq.com:465`，`security:'tls'` |
| 认证 | `AUTH LOGIN`（服务器广告 LOGIN/PLAIN/XOAUTH/XOAUTH2，引擎 auto 选 LOGIN） |
| 结果 | `accepted: ["figaro1@qq.com"]`，`rejected: []`，服务器响应 `OK: queued as.` |
| Message-ID | `<81317913-cdc4-47c5-bb90-efaa5e442d23@qq.com>` |
| 耗时 | 1093 ms（连接+认证+投递+QUIT） |
| 内容 | multipart/alternative（中文纯文本 + HTML），主题含 RFC 2047 编码 |

### 6.2 SMTP STARTTLS（587）✅（仅认证，未发信）

| 项 | 值 |
|---|---|
| 服务器 | `smtp.qq.com:587`，`security:'starttls'` |
| 流程 | EHLO（含 STARTTLS）→ STARTTLS 220 → TLS 握手（公共 CA 校验通过）→ EHLO → AUTH LOGIN → QUIT |
| 结果 | `ok:true`，`authMethod:'LOGIN'`，耗时约 0.5–0.6 s |
| 说明 | 用的是 `verifySmtp()`，**没有提交任何邮件**（MAP 未发生） |

### 6.3 IMAP 只读（implicit TLS 993）✅

| 项 | 值 |
|---|---|
| 服务器 | `imap.qq.com:993`，`security:'tls'` |
| 认证 | LOGIN（授权码）+ 自动 `ID`（服务器广告 ID 能力） |
| 方式 | `EXAMINE INBOX`（只读，不改变 flags） |
| 结果 | `EXISTS 4`、`RECENT 0`、`UIDVALIDITY 1789339700`、`UIDNEXT 6`、`readOnly:true` |
| 读取 | 只取最近 3 封的 `BODY.PEEK[HEADER]`（不取正文/附件、不标已读）；耗时约 0.8 s |
| 结论 | **QQ 邮箱 IMAP 服务已开启**（否则 LOGIN 或 SELECT 会失败） |

### 6.4 QQ IMAP 143 STARTTLS ❌（服务端不支持）

- greeting：`* OK [CAPABILITY IMAP4 IMAP4rev1 ID AUTH=PLAIN AUTH=LOGIN AUTH=XOAUTH2 NAMESPACE] QQMail XMIMAP4Server ready`
- 命令 `CAPABILITY` 返回：`IMAP4 IMAP4rev1 XLIST MOVE IDLE XAPPLEPUSHSERVICE SASL-IR AUTH=PLAIN AUTH=LOGIN AUTH=XOAUTH2 NAMESPACE CHILDREN ID UIDPLUS`
- 两处均**没有 STARTTLS**；引擎按契约直接抛 `ImapError{kind:'tls', message:'server does not advertise STARTTLS'}`，不静默降级明文。
- **结论：QQ IMAP 必须用 993 implicit TLS；UI/host 预设不要给 QQ 配置 143/STARTTLS。** 其他服务商（Gmail/iCloud）143 STARTTLS 未实测。

### 6.5 自发自收闭环确认 ✅

SMTP 投递后再用 IMAP 只读检查：收件箱从 `EXISTS 4 / UIDNEXT 6` 变为 `EXISTS 5 / UIDNEXT 7`，最新邮件 UID 6 的主题为本次测试信主题（`[dsh-mailbox] 协议引擎真实连通测试 ...`），发件人 `figaro1@qq.com`。→ **SMTP 463+IMAP 993 端到端用同一授权码真实可通**。

---

## 7. 测试覆盖与未验证项

### 7.1 自动化测试（`node --test "test/mail/*.test.js"`，149 用例全绿）

| 文件 | 覆盖 |
|---|---|
| `test/mail/mime.test.js` (28) | 头部折行/RFC2047(B+Q+GBK)/地址列表(引号逗号/注释/组)/Date/Message-ID/References；UTF-8/GB18030/GBK/GB2312/ISO-8859-1；base64/QP/8bit；alternative/related(cid)/mixed 嵌套；RFC 2231 文件名；HTML→text；自动回复字段；Authentication-Results/Reply-To 不一致/无回复地址等可疑信号；5 MB/深度/part/header 上限与截断；畸形输入不崩 |
| `test/mail/html.test.js` (70) | 49 个 XSS payload（script/iframe/object/embed/form/meta/link/base/svg/math/on*/javascript:/vbscript:/data:/协议混淆/CSS expression/url()/position/@import/注释/srcdoc/plaintext/xmp…）；外链图片默认阻止与开关；cid 解析；style 白名单；标签平衡；长度截断；详细结果统计 |
| `test/mail/smtp.test.js` (26) | buildMessage（alternative/related/mixed/线程头/自定义头/注入防护/多收件人/大小上限）；假服务器上的成功发信、部分/全部收件人拒绝、认证失败（断言错误中不泄露密码及 base64 变体）、超时、AbortSignal、连接拒绝、`none` 非 loopback 拒绝、PLAIN 回退、verifySmtp；implicit TLS、STARTTLS（含二次 EHLO）、自签证书默认拒绝、未广告 STARTTLS |
| `test/mail/imap.test.js` (27) | 连接/登录/CAPABILITY/ID 自动发送、163 式「必须先 ID」、sendId:false、服务器拒绝 ID 仍可用；SELECT 状态解析、searchNew/uidSearch/UNSEEN、单封/批量/headersOnly/metadata-only FETCH、literal 含二进制与伪 IMAP 行、超大 literal 丢弃、UID STORE 标已读/取消、logout/close、认证失败脱敏、超时、AbortSignal、非 ASCII 凭据走 IMAP literal、implicit TLS、自签证书默认拒绝、STARTTLS；UidSet/INTERNALDATE 工具函数 |

> 本地假服务器：`test/mail/helpers.js`（loopback 随机端口 + 自签证书 fixtures，`net`/`tls`，零外部网络）。
> 说明：Node 24.22.2 下 `node --test test/mail/`（目录形式）会报 `Cannot find module .../test/mail`；请用 `node --test "test/mail/*.test.js"`（或裸 `node --test` 跑全项目）。已在交付消息中提醒 Lead 更新 package.json 的 `test:mail` script。

### 7.2 未验证项 / 残余风险

| 项 | 说明 | 风险 |
|---|---|---|
| Gmail / iCloud / 163 / 126 / Outlook 真实收发 | 无对应授权码，未实测；参数来自官方文档 | 中：首次用户可能遇到服务商侧风控/额外验证，需要 README/UI 引导排障 |
| Outlook 现代认证 | 引擎无 OAuth2，确定不可用 | 高（对 Outlook 用户）：需 UI 明确提示「暂不支持 Outlook」，或后续补 OAuth2 |
| IMAP STARTTLS（143）真实服务商 | 只在假服务器验证；QQ 143 不支持 | 低：Gmail/iCloud 若用 143 STARTTLS 理论可行但未实测；推荐直接用 993 |
| OAuth2 / XOAUTH2 | 未实现 | 中：未来 Gmail/Outlook 收紧后需要 |
| 附件投稿（发送） | buildMessage 支持 multipart/mixed 附件并单测，但 UI/模型工具 MVP 不暴露附件发送 | 低 |
| 中文文件夹 / 非 INBOX 轮询 | 只轮询 INBOX，文件夹名 modified UTF-7 未实现 | 低（MVP 契约如此） |
| 8bit/binary 正文 | 引擎按字节处理，但非 base64/QP 的二进制正文未做完整 round-trip | 低：邮件几乎都用 base64/QP |
| 大邮件 | 单封默认 5 MB 解析上限、IMAP literal 默认 10 MB 丢弃阈值 | 中低：超大邮件内容会截断（标记 truncated/suspicious），AI 侧只见截断文本 |

---

## 8. 给 dsh-mailbox 配置预设 / UI 引导的建议（供 Lead 参考）

`lib/config.js` 的 `PRESETS` 可按下面取值（host/port/security + 引导链接）：

```js
qq:      { smtp: { host:'smtp.qq.com',  port:465, security:'tls' },
           imap: { host:'imap.qq.com',  port:993, security:'tls' },
           authHint: 'QQ 邮箱设置 → 账号与安全 → 开启 IMAP/SMTP 服务，按短信验证获取 16 位授权码；不要用 QQ 密码。',
           helpUrl: 'https://help.mail.qq.com/detail/0/1087' }
net163:  { smtp: { host:'smtp.163.com', port:465, security:'tls' },
           imap: { host:'imap.163.com', port:993, security:'tls' },
           authHint: '163 邮箱设置 → POP3/SMTP/IMAP → 开启服务并获取「客户端授权码」；本插件会自动发送 IMAP ID 命令。',
           helpUrl: 'https://help.mail.163.com/' }
net126:  { /* 同上，host 换 126 */ }
gmail:   { smtp: { host:'smtp.gmail.com', port:465, security:'tls' },
           imap: { host:'imap.gmail.com', port:993, security:'tls' },
           authHint: '先开启 Google 两步验证，再到 myaccount.google.com/apppasswords 创建 16 位应用专用密码（不是 Google 登录密码）。',
           helpUrl: 'https://support.google.com/mail/answer/185833' }
outlook: { smtp: { host:'smtp-mail.outlook.com', port:587, security:'starttls' },
           imap: { host:'outlook.office365.com', port:993, security:'tls' },
           authHint: '⚠️ Outlook/Microsoft 365 已禁用基础认证，当前版本暂不支持（需要 OAuth2）。',
           helpUrl: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040',
           unsupported: true }
icloud:  { smtp: { host:'smtp.mail.me.com', port:587, security:'starttls' },
           imap: { host:'imap.mail.me.com', port:993, security:'tls' },
           authHint: 'Apple ID 开启双重认证 → appleid.apple.com 生成 App 专用密码；用户名填完整 Apple ID。',
           helpUrl: 'https://support.apple.com/zh-cn/102525' }
custom:  { ... }
```

UI 注意事项：

- Gmail 引导里写明「先去空格」；QQ/163 引导里写明「不是网页登录密码」。
- Outlook 预设建议标灰/显示警告，保存时提示「当前版本暂不支持，请用其他邮箱或自建 SMTP」。
- 测试连接按钮：SMTP 用 `verifySmtp()`（不发信）、IMAP 建议用 `examine('INBOX')`（只读，不改变用户邮箱状态）。
- 错误展示：`verifySmtp`/`openImap` 抛出的错误已带 `kind`（auth/connection/timeout/tls/config），UI 可按 kind 给中文排障文案；错误消息中授权码已由 `lib/mail/redact.js` 脱敏。

---

## 9. 安全注意事项（本次实测遵守）

1. 授权码只从 `~/.dsh/secrets/figaro1-qq-smtp.txt` 读取，进程内不打印、不写日志、不写仓库；引擎所有错误经 `redactSecrets()` 处理（含 raw、base64、percent-encode、JSON 变体）。
2. 真实测试只给 figaro1@qq.com 自己发 1 封；没有向任何第三方地址发信，没有修改邮箱设置，没有删除/标记任何邮件。
3. IMAP 全程 `EXAMINE`（只读）+ `BODY.PEEK[HEADER]`（不读正文、不置已读）。
4. TLS 全部走公共 CA 严格校验；未在真实连接中关闭证书校验。
5. 测试与实验脚本均放在 `/tmp`，不落在项目目录；不占用 Web 端口 3080。

---

## 10. 参考链接汇总

- QQ 邮箱：授权码获取官方帮助 https://help.mail.qq.com/detail/0/1087 · 帮助中心 https://service.mail.qq.com/
- 网易 163/126/yeah：帮助中心 https://help.mail.163.com/
- Gmail：应用专用密码 https://support.google.com/mail/answer/185833 · IMAP/SMTP 配置 https://support.google.com/mail/answer/7126229
- Outlook：POP/IMAP/SMTP 设置 https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040 · 基础认证弃用 https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online
- iCloud：服务器设置 https://support.apple.com/zh-cn/102525 · App 专用密码 https://support.apple.com/zh-cn/102654
- 协议规范：RFC 5321 (SMTP)、RFC 5322 (Internet Message Format)、RFC 2045/2046/2047 (MIME)、RFC 3501 (IMAP4rev1)、RFC 2971 (IMAP ID)、RFC 2231 (参数续行/字符集)
