# dsh-mailbox 客户端 UI 规范（UI-SPEC v1）

> 对应 SPEC §9（高级 UI / DSH 入口 / 总开关）与 §0（安全第一）。
> 实现：`lib/client.js`（手写单文件客户端 bundle，运行在 DSH Web GUI 内）；调研依据：`docs/research/client-ui.md`。
> 形态：**不是独立 Web UI**，不新增页面/端口/服务器；是 DSH 的一个客户端插件页面 + 若干原生入口，视觉与交互和 DSH 一体。

---

## 1. 设计原则

1. **DSH 一体**：复用 DSH 主题令牌（`--dsw-*` / `--dsh-*`）与 `@deepseek-ai/dsh-client-ui-primitives` 组件；亮/暗自动跟随宿主；色调克制、信息密度高、线性图标 + 1px/0.5px 发丝线。
2. **安全第一**（高于好看）：邮件 HTML 只在 `sandbox=""` 的 iframe 里渲染（srcdoc = 宿主已消毒 HTML）或纯文本；客户端零未消毒 innerHTML；授权码不回显、不落 localStorage、不进 URL/日志；危险操作二次确认。
3. **高级 ≠ 花哨**：用层次（bg-base → bg-layer-1 → 浮层）、发丝线、8px 网格、四档字号、克制动效（120–180ms）营造质感；不做渐变大字、不做装饰性插画堆砌。
4. **任何状态都有出口**：加载 → 骨架屏；空 → 插画式空状态 + CTA；错误 → 可读原因 + 重试；停用 → 明确说明 + 重新启用；未配置 → 引导去设置。
5. **键盘与读屏可用**：Tab 顺序符合视觉顺序，Esc 关面板/弹层，Enter 触发主操作，所有图标按钮有 `aria-label`，焦点环用统一 `--dsw-focus-ring-color`。

---

## 2. 信息架构（IA）

```
DSH Web GUI
├── 左侧主导航（sidebar.panellist，order 30，图标 + 数字未读徽标）──「邮箱」
│   └── 全屏页面 main[key='mailbox']  ← 主界面
│       ├── 页头：标题「邮箱」+ 连接状态灯 + 操作（刷新/同步/写信）
│       ├── 邮箱导航（左列，宽 ≥ 1024px）：收件箱 / 已发送 / 隔离 / 好友 / 设置 / 诊断
│       ├── 邮件列表（中列）：搜索、未读筛选、排序、骨架/空/错误、行（未读圆点/星标/好友标记/时间）
│       ├── 阅读面板（右列）：工具栏（回复/标记未读/加好友/删除）、元信息、安全正文、附件、外链清单
│       ├── 写信面板（右侧滑出）：收件人/主题/正文/发送（回复模式预填 to/subject/replyToId）
│       ├── 好友页 / 设置页 / 诊断页（替换列表+阅读列）
│       ├── 停用遮罩：总开关关闭时全页只读 + 顶部停用横幅 + 「重新启用」
│       └── Toast 栈（右下角）+ 危险操作确认 Modal
├── 会话头部常驻入口（conversation.session.header.utilities，order 10）
│   └── 28×28 图标按钮「邮箱」，点击打开邮箱页面；有未读时右上角红点
├── 命令面板：`/mailbox` → 「打开邮箱」
└── 设置 → 插件 → 「邮箱」页（settings.section, id='mailbox', order 40）
    └── 复用 SettingsView（配置表单 + 总开关 + 测试连接 + 授权码引导）
```

页面内视图（`view` 状态）：`inbox | sent | quarantine | friends | settings | diagnostics`。
阅读态（`selectedId`）与写信态（`composer`）是页面内的叠加层，不新增路由。

**入口徽标规则**（三处一致）：
- 左栏图标徽标：未读总数（`counts.unread`），`>99` 显示 `99+`，0 不显示；
- 页面内：收件箱导航项未读数、列表行未读圆点、页头「N 封未读」；
- 会话头部按钮：未读 >0 时右上角 8px 红点（不显示数字，空间小）。
- 徽标数据只来自 `state.counts`，仅供展示。

---

## 3. 线框

### 3.1 宽屏（≥1200px）：三列

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 邮箱                                           ● 已连接 IMAP   [刷新][写信] │  ← 页头 28px 上边距
├──────────────┬──────────────────────────────────┬─────────────────────────┤
│ ▣ 收件箱  12 │ [搜索邮件…            ] [未读]   │  回复  标未读  加好友 删除│
│ ▤ 已发送      ├──────────────────────────────────┤  Re: 项目周报            │
│ ⛨ 隔离     2  │ ● 张三 <z***@qq.com>     10:24   │  张三 <zhangsan@qq.com>  │
│ ♧ 好友     8  │   项目周报                        │  2026-11-12 10:24        │
│ ⚙ 设置       │   附件已更新，请查收…             ├─────────────────────────┤
│ ⚕ 诊断       ├──────────────────────────────────┤  ┌───────────────────┐  │
│              │ ○ 李四 <l***@163.com>    昨天     │  │ sandbox iframe     │  │
│ ──────────   │   周末聚餐                        │  │ （宿主消毒 HTML）  │  │
│ 状态灯卡片    │   周六老地方…                     │  └───────────────────┘  │
│              │ ○ news@example.com       11-10    │  附件：报告.pdf (240KB)  │
│              │   产品更新                        │  外链：example.com/…  ↗  │
└──────────────┴──────────────────────────────────┴─────────────────────────┘
```

### 3.2 中屏（768–1199px）：两列（导航收成页头下的胶囊行）

```
┌────────────────────────────────────────────────────────────┐
│ 邮箱                                      ● 已连接  [刷新][写信]│
│ [收件箱 12] [已发送] [隔离 2] [好友 8] [设置] [诊断]          │
├──────────────────────────────┬─────────────────────────────┤
│ 列表（全宽）                  │ 阅读面板（覆盖/滑入）        │
└──────────────────────────────┴─────────────────────────────┘
```

### 3.3 窄屏（<768px）：单列 + 列表↔阅读切换

```
┌────────────────────────────┐
│ ‹ 邮箱            [刷新][写信]│
│ [搜索…] [未读 ▾]           │
├────────────────────────────┤
│ ● 张三 · 项目周报     10:24 │
│ ○ 李四 · 周末聚餐    昨天   │
│ …                          │
└────────────────────────────┘
  点击行 → 全屏阅读视图（顶部 ‹ 返回列表）
```

### 3.4 写信面板（右侧滑出，宽 480–560px；窄屏全屏）

```
┌──────────────────────────────────────┐
│ 写信 · 回复「项目周报」          [×] │
│ 收件人 [zhangsan@qq.com        ]  ← 好友/owner 可发；陌生人提示规则
│ 主题   [Re: 项目周报           ]     │
│ 正文                                │
│ ┌────────────────────────────────┐  │
│ │ （Markdown / 纯文本，可带附件）  │  │
│ └────────────────────────────────┘  │
│ 正文格式随你：Markdown / 纯文本；宿主渲染并安全过滤，不自动补称呼/署名/日期 │
│                        [取消] [发送 ✈] │
└──────────────────────────────────────┘
```

### 3.5 设置页（v1.1 重构：分组 tab + 快速开始，降低认知负担）

```
┌────────────────────────────────────────────────────────────────┐
│ 邮箱设置                                                       │
│ ┌── 插件总开关（compact）──────────────────────────── [ ●—] ─┐ │
│ │ 收信轮询、AI 收信通知与全部邮件工具：已启用                  │ │
│ └───────────────────────────────────────────────────────────┘ │
│ [快速开始]  [连接配置]  [通知与好友]  [高级设置]   ← 分组 tab │
│ ┌── 四步开始使用 ─────────────────────────────── 3 / 4 ────┐ │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  ← 进度条                            │ │
│ │ ① 填写邮箱账号                         ✓ 已完成           │ │
│ │ ② 选择服务商并填写授权码               ✓ 已完成  [查看]   │ │
│ │ ③ 测试连接（SMTP / IMAP）              [去测试]           │ │
│ │ ④ 保存设置                             [保存]             │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌── 邮箱账号 ──────────────────────────────────────────────┐ │
│ │ 本机发信邮箱 / 发件人显示名 / 用户收信邮箱 / 用户称呼      │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌── 安全提示 ──────────────────────────────────────────────┐ │
│ │ 授权码只保存在宿主本地（600），API 不回显；[诊断]          │ │
│ └───────────────────────────────────────────────────────────┘ │
├── 连接配置 tab ────────────────────────────────────────────────┤
│ ┌── 服务商预设（可点卡片，自动填 host/port/TLS）───────────┐ │
│ │ [QQ邮箱] [163] [126] [Gmail] [Outlook] [iCloud] [自定义]   │ │
│ │  ▸ 如何获取授权码（按当前服务商：摘要/分步/官方链接/注意）  │ │
│ └───────────────────────────────────────────────────────────┘ │
│ SMTP 卡片：登录账号 / 授权码（已配置不回显 + 来源 Tag）/ 服务器+端口+TLS / [测试 SMTP] 结果 │
│ IMAP 卡片：启用收信 / 账号 / 授权码 / 服务器+端口+TLS / 文件夹 / 轮询间隔 / [测试 IMAP] │
├── 通知与好友 tab ──────────────────────────────────────────────┤
│ 收信通知：启用 / 目标（独立会话·推荐 / 最近活跃 / 全部 / 指定）/ 陌生人策略 / 合并窗口 | 预览字数 │
│   目标说明行（dedicated：首次自动建「邮箱通知」会话，不打扰当前聊天；已建则显示目标会话 id） │
│   [通知测试]  →  ✓ 已投递到独立会话「邮箱通知」（8ea5f9ee）                                  │
│ 好友策略：三张可选卡片（AI 自行添加 / 需你确认 / 仅你手动）+ 默认自动回复开关               │
├── 高级设置 tab ────────────────────────────────────────────────┤
│ ▸ 信件外观与账号（显示名用于发件人；称呼/署名/日期由 AI 在正文里自行决定） ← 折叠 │
│ ▸ 提示词（语言/好友列表注入/上限/追加说明）      ← 折叠                     │
│ ▸ 安全与限额（发信频率/AI加好友/隔离/保留量/远程图片） ← 折叠               │
│ ▸ 界面与数据（界面语言 / 本机数据目录只读）       ← 折叠                     │
├── 固定保存栏（sticky）────────────────────────────────────────┤
│ 有未保存的修改                            [重置为默认] [保存设置] │
└────────────────────────────────────────────────────────────────┘
```

**设计意图**：默认只展示「一步一步怎么配」；连接细节在第二个 tab；通知/好友策略语义用卡片说明；低频字段折叠进「高级设置」。任何时刻底部有保存栏与「有未保存的修改」提示。

---

## 4. 设计令牌（映射到 DSH 原生变量）

> 颜色一律用 `var(--dsw-*)`，亮/暗由宿主切换；不要写死 hex（下面的 hex 只是说明语义，代码里用变量）。

### 4.1 颜色

| 用途 | 令牌 | 说明 |
|---|---|---|
| 页面底 | `--dsw-alias-bg-base` | 主列背景 |
| 卡片/面板 | `--dsw-alias-bg-layer-1` | 列表、设置卡、阅读面板底 |
| 次级卡片/悬浮 | `--dsw-alias-bg-layer-2` | hover 行、编辑框底 |
| 骨架 | `--dsw-alias-bg-skeleton` | 列表/正文骨架 |
| 标题文字 | `--dsw-alias-label-primary` | 20/28 标题、列表主题 |
| 正文 | `--dsw-alias-label-primary` | 13/20 |
| 次要 | `--dsw-alias-label-secondary` | 发件人、时间、说明 |
| 辅助/占位 | `--dsw-alias-label-tertiary` / `--dsw-alias-label-caption` | 空状态、辅助 |
| 分隔线 | `--dsw-alias-border-l3`（0.5px）/ `-l2` | 列表行、卡片边 |
| 交互 hover | `--dsw-alias-interactive-bg-hover` | 行 hover |
| 交互 pressed | `--dsw-alias-interactive-bg-active` | 按下 |
| 主操作 | `--dsw-alias-button-primary-fill` / `-primary-hover` | 发送、保存 |
| 危险 | `--dsw-alias-state-error-primary` | 删除、未读圆点、停用红点 |
| 成功 | `--dsw-alias-state-success-primary` | 连接成功状态灯 |
| 警告 | `--dsw-alias-state-warn-primary` | 可疑邮件、隔离提示 |
| 进行中 | `--dsw-alias-state-business-primary` | 同步中、连接中 |
| 品牌/选中 | `--dsw-alias-state-business-tertiary` + `--dsw-alias-interactive-bg-hover-accent` | 选中导航项底 |
| 遮罩 | `--dsw-alias-bg-mask-1/2` | Modal 遮罩、停用遮罩 |
| Toast | `--dsw-alias-toast-bg` / `--dsw-alias-toast-label` | primitives Toast 自带 |

### 4.2 字体

| 层级 | 规格 | 令牌/说明 |
|---|---|---|
| 页面标题 | 20px / 28px / 500 | h1「邮箱」、设置页标题 |
| 区块标题 | 14px / 22px / 500 | 设置卡标题、列表栏标题 |
| 正文/列表 | 13px / 20px / 400 | 主题、发件人、正文摘要 |
| 次要/元信息 | 12px / 18px / 400 | 时间、附件大小 |
| 微标签 | 10–11px / 16px / 500 | 未读数字、Tag、徽标 |
| 等宽 | `var(--dsh-font-family-code)` | 诊断数据、错误详情 |

字体族：正文继承宿主 `--dsw-font-family`（用户可在设置里改），不指定具体字体。

### 4.3 间距 / 圆角 / 阴影 / 动效

- 间距 4px 网格：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48；页面左右 inset：`clamp(24px, 4vw, 48px)`（与官方页一致）；窄屏 20px。
- 圆角：控件 8px（`--dsw-radius-sm` 附近）、卡片 12px（`--dsw-radius-lg`）、弹层 16px（`--dsw-radius-xl`）、胶囊 999px。**统一变量**，不混用。
- 阴影：卡片不投影（发丝线）；浮层用 `--dsw-elevation-panel`/`--dsw-shadow-lv2`；Modal 用 `--dsw-elevation-prominent`。
- 动效：面板滑入 160ms `cubic-bezier(.2,.8,.2,1)`；hover 底色 120ms；列表项出现/骨架切换 150ms；`prefers-reduced-motion: reduce` 下全部 0ms。
- 焦点：`:focus-visible` 用 `outline:2px solid var(--dsw-focus-ring-color); outline-offset:2px`（或直接使用 primitives 组件的内建焦点）；不要去掉 outline 而不给替代。

---

## 5. 组件清单与状态矩阵

### 5.1 组件

| 组件 | 说明 | 用到的 primitives |
|---|---|---|
| `MailboxPage` | 页面壳：页头 + 导航 + 内容区 + 停用遮罩 + toast 容器 | `Button`, `Tooltip`, `SegmentedControl`, `StateDot` |
| `FolderNav` | 邮箱导航项（图标 + 名称 + 未读数字 + 选中态） | — 自绘（`dsh-mailbox-` 前缀） |
| `MailList` | 搜索、未读筛选、刷新、列表行、分页/加载更多 | `Input`(icon=search), `SegmentedControl`, `Button`, `Tag` |
| `MailRow` | 单行：未读圆点、发件人、主题、摘要、时间、标记 chips（好友/可疑/附件） | `Tag`, `Tooltip` |
| `MailReader` | 阅读面板：工具栏、元信息、iframe 正文、附件、外链、回复 | `Button`, `Modal`, `Tooltip`, `Tag` |
| `Composer` | 写信滑出面板：to/subject/content、格式说明、发送 | `Button`, `Input`, `Tooltip` |
| `FriendsView` | 策略卡、待确认申请、好友卡（chips、autoReply、删除）、添加表单 | `Button`, `Switch`, `Input`, `Modal`, `Tag` |
| `SettingsView` | 总开关、SMTP/IMAP、授权码引导、测试连接、通知/好友/提示词/安全 | `Button`, `Switch`, `Input`, `DisclosureRow`, `Tooltip`, `Tag` |
| `DiagnosticsView` | 版本/数据目录/连接/工具/存储统计、同步/通知测试、清空数据 | `Button`, `Tag`, `StateDot`, `JsonBlock`? 自绘 `<pre>` |
| `MasterSwitchCard` | 大开关 + 状态说明 + 关闭后果说明 | `Switch`, `Tag` |
| `ConfirmDialog` | 危险操作二次确认（删除邮件/好友/清空数据/关闭插件） | `Modal`, `Button` |
| `ToastStack` | 右下角 toast 栈，自动消失 | `Toast` |
| `Skeleton` | 列表骨架 × 6 / 正文骨架 | 自绘（`--dsw-alias-bg-skeleton`） |
| `EmptyState` | 图标插画 + 标题 + 说明 + CTA | 自绘 + `Button` |
| `StatusPill` | 连接状态灯 + 文案（已连接/未配置/连接失败/停用） | `StateDot`, `Tooltip` |
| `PanelIcon` / `HeaderAction` | 入口：左栏图标 + 数字徽标 / 会话头部 28px 按钮 | `Tooltip` |
| `MailboxSettingsSection` | 设置页 wrapper（复用 `SettingsView`） | — |

图标：自带 SVG（24 viewBox、`stroke=1.5`、`currentColor`）——mail / inbox / sent / shield(隔离) / users(好友) / settings / stethoscope(诊断) / compose / refresh / search / reply / trash / check / close / chevron / external / key / plug / spinner / warning。DSH primitives 里没有 mail 图标，其余交互图标可复用官方 `Icon*OutlineRegular`。

### 5.2 状态矩阵

| 区域 | 加载中 | 空 | 错误 | 停用 |
|---|---|---|---|---|
| 页面整体 | 页头 + 导航骨架；列表/阅读骨架 | — | 顶部错误条（可读原因 + 重试） | 全页遮罩 + 停用卡（说明哪些能力停用 + 重新启用） |
| 邮件列表 | 6 行骨架 | 插画 + 「收件箱是空的」+ 去设置/刷新 CTA | 图标 + 原因 + 重试按钮 | 列表只读灰化 |
| 阅读面板 | 正文骨架 | 「选择一封邮件」轻提示（宽屏右列常显） | 无法加载正文 + 重试 | 「插件已停用」说明 |
| 好友 | 卡片骨架 | 「还没有好友」+ 手动添加表单聚焦 | 加载失败 + 重试 | 只读 |
| 设置 | 表单骨架 | — | 字段级错误/保存失败 toast | 开关置灰 + 说明（除总开关可点） |
| 诊断 | 骨架 | — | 显示错误详情（脱敏） | 只读 |
| 同步 | 旋转图标 + 「同步中…」 | — | 红色状态灯 + 原因 + 「重试」 | 不显示同步按钮 |

**空状态文案要给出下一步**，不是只有一句「暂无数据」。

---

## 6. 交互细节

### 6.1 导航与列表
- 点击文件夹：切换视图并拉取列表；选中态用 `--dsw-alias-interactive-bg-hover-accent` + 左侧 2px 品牌色指示条（或底色）。
- 搜索：输入 250ms 防抖，走 `messages?search=`；清空按钮；无结果空状态显示搜索词。
- 未读筛选：分段控件「全部 / 未读」；与搜索组合。
- 刷新：按钮 hover tooltip；有进行中请求时禁用并转圈；成功后 toast「已刷新」；失败→错误条。
- 列表行：整行可点（button 语义），键盘 Enter/Space 打开；hover 底色；选中行左侧高亮；未读圆点 `--dsw-alias-state-error-primary`；时间相对（刚刚/10:24/昨天/11-10）。
- 滚动：列内独立滚动，`overflow:auto` + 宿主的 `--dsh-scrollbar-*` 变量。

### 6.2 阅读与安全渲染
- 打开邮件：GET `message&id=`；未读 → 立即 POST `message.read {read:true}` 并在列表/徽标同步减一。
- 正文策略（**硬约束**）：
  - 有 `message.html`（宿主已消毒）→ `<iframe sandbox="" srcdoc={wrapped}>`；iframe 额外 `referrerpolicy="no-referrer"`、`title` 为邮件主题、`loading="lazy"`、固定 min-height 200px 自适应（观察 iframe load 后无法跨域读高度 → 用固定 60vh + iframe 内部不给脚本；不追求精确自适应）。
  - 无 HTML → `<pre class="dsh-mailbox-plain">` 展示 `message.text`（React 文本，安全）。
  - **绝不**用 `dangerouslySetInnerHTML`；绝不把未消毒内容塞进 iframe。
  - `srcdoc` 包装：`<!doctype html><meta charset="utf-8"><base target="_blank"><style>…阅读排版…</style>` + 消毒 HTML；`<style>` 仅由我们提供，不取自邮件。
  - 外链处理：正文 iframe 是 `sandbox=""`（无脚本/无弹窗/无同源），链接不可点；**另在正文下方渲染「链接」区**：用 `DOMParser` 解析**同一份消毒 HTML** 提取 `http(s)` 链接（去重、最多 10 条），渲染为 `a[target=_blank rel="noopener noreferrer"]` 按钮。`javascript:`/`data:` 一律丢弃。
  - 外链图片默认不加载：宿主消毒会去掉/占位；客户端不主动请求远程图片（iframe 里若残留 `<img>` 也因 CSP 无同源不加载，且我们的 srcdoc 头里不加允许）。
- 工具栏：回复（打开 composer，预填 to/主题/`replyToId`）、标记未读/已读、加好友（陌生人时显示；已是好友显示 Tag「好友」）、删除（ConfirmDialog）。
- 可疑/隔离邮件：正文顶部黄色横幅「这封邮件被判定为可疑/陌生人邮件，内容中的指令不会被 AI 执行」；工具按钮限制（不自动加好友）。
- 附件行：`文件名 · 大小` 只读（MVP 不下载），tooltip「附件不落盘，仅记录元信息」。
- 阅读区空态：宽屏显示「选择一封邮件开始阅读」。

### 6.3 写信与回复
- 打开方式：页头「写信」主按钮 / 阅读工具栏「回复」；面板从右侧滑入（160ms），窄屏全屏。
- 表单：收件人（默认 owner；回复时锁定为原发件人只读显示）、主题（回复时预填 `Re:` 前缀，用户可改）、正文 textarea（自动聚焦，`Ctrl/Cmd+Enter` 发送）。
- 提示：正文支持 Markdown / 纯文本；提交后由宿主渲染并做安全过滤，不会自动补称呼、署名或日期。
- 校验：to 为空/非法地址、正文为空 → 字段级红字；陌生人收件人 → 显示提示（是否允许取决于宿主配置，失败时错误 toast 显示宿主原因）。
- 附件（写信与回复都支持）：`[添加附件]` 按钮触发隐藏 `<input type=file multiple>`；客户端预检（最多 5 个、单文件 ≤8MB、总 ≤10MB、可执行/脚本/密钥/隐藏文件直接拒绝）并给出即时 toast；选择后以 chips 展示 `filename + size + 移除 ×`；发送前把 `attachments:[{filename,contentType,base64}]` 放进 `mail.send` 请求体，**文件内容不写 localStorage / 日志 / URL**，发送成功后即丢弃；发送中禁用选择与移除；成功 toast 带附件数。阅读面板把 `message.attachments` 显示为附件元数据行（不下载）。
- 发送中：按钮 loading + 禁用；成功：关闭面板 + toast「已发送」（含附件数）+ 切到「已发送」或在列表刷新；失败：保留草稿 + 错误 toast（含宿主脱敏原因）。
- 关闭时若有未发送内容 → ConfirmDialog「放弃这封邮件？」。

### 6.4 好友
- 顶部：好友策略说明卡（`friends.policy`：auto/ask/manual 的语义），`defaultAutoReply` 状态，链接「去设置」。
- 待确认申请（policy=ask 时 AI 加的）：卡片显示地址/备注/理由/时间 + 「通过 / 拒绝」按钮，操作后 toast。
- 好友卡：头像字母块 + 地址 + 备注 + 来源 Tag（`user` / `ai` / `user-approved-ai`）+ 添加时间 + `autoReply` 开关（PATCH `friends.update`）+ 删除（二次确认）。
- 添加表单：地址（必填，格式校验）+ 备注 + 「添加好友」；成功 toast + 列表刷新；已存在/待确认给宿主返回的状态文案。
- 危险操作（删除/拒绝/清空）二次确认。

### 6.5 设置与总开关（v1.1）

- **总开关置顶**：compact 卡片 + `Switch` + 状态 Tag（已启用/已停用）+ 能力说明。关闭时 ConfirmDialog 说明后果（停轮询/通知、注销工具与提示词、数据保留），确认后 `config.save {patch:{enabled:false}}`，页面立即进入停用态（横幅 + 遮罩 + 重新启用按钮）。
- **分组 tab**：快速开始 / 连接配置 / 通知与好友 / 高级设置。切换不丢表单状态（同一 controller）。
- **快速开始**：四步进度（① 账号 ② 服务商+授权码 ③ 测试连接 ④ 保存），每步带状态（✓ / 序号）与 CTA；左侧显示 `N / 4` 与进度条，用户一眼知道下一步做什么。
- **服务商预设**：可点卡片（QQ/163/126/Gmail/Outlook/iCloud/自定义），选中后自动填 SMTP+IMAP 的 host/port/security；下方按当前服务商展示「如何获取授权码」：摘要 + 分步说明 + 官方帮助链接（`target=_blank rel="noopener noreferrer"`）+ 注意事项；授权码未配置时默认展开。
- **授权码**：`type=password`、`autocomplete=new-password`，占位「已配置（不回显）」，已配置显示来源 Tag（env/file/config）；输入非空才提交 `secrets.smtpAuthCode`；提供「清除已保存的授权码」。
- **测试连接**：`[测试 SMTP] [测试 IMAP]` 用当前**未保存**表单值（host/port/security/user + 输入中的授权码）调用 `test.*`（不落盘）；行内显示测试中/成功（含耗时）/失败（宿主脱敏原因）。
- **通知**：启用开关；目标四选一（独立会话·推荐 / 最近活跃 / 全部 / 指定会话），每项有说明；`dedicated` 显示「目标会话：邮箱通知（id8）」或「首次有新信自动创建」；`[通知测试]` 不带 sessionId 调用 `notify.test`，返回后把 `delivered/sessionId` 就地展示（成功/失败文案 + id 前 8 位）。
- **好友策略**：三张可选卡片（auto/ask/manual，含说明与选中态），默认自动回复开关。
- **高级设置**：折叠分组（信件外观与账号 / 提示词 / 安全限额 / 界面与数据），默认收起，减少视觉噪音。
- **保存栏**：sticky 底部，显示「有未保存的修改 / 设置已是最新」+ 重置/保存；保存失败显示宿主脱敏原因；字段级错误映射到字段。
- **停用态**：除总开关与设置/诊断外禁用（fieldset disabled + 降低不透明度），顶部停用横幅 + 重新启用。

### 6.6 诊断
- 顶部：版本、插件启用状态、数据目录（可复制按钮 + 复制成功 toast）。
- 连接：SMTP/IMAP 配置/最近测试/最近同步时间/最近错误（脱敏文本）。
- 存储：消息数/索引数/数据目录大小（来自 `store.diagnostics`）。
- 操作：`sync.now`（立即收信）、`notify.test`（通知测试，可选目标会话）、`data.clear`（清空数据，强二次确认：输入「清空」或勾选确认）。
- 通知队列长度、待投递信息。
- 错误详情用 `<pre>` + `--dsh-font-family-code`，不包含任何密钥。

### 6.7 收信通知的目标（独立会话）

- 默认 `notify.target = 'dedicated'`：宿主自动创建一个标题为「邮箱通知」的独立会话，通知不进当前聊天；`state.config.notify.dedicatedSessionId` / `state.notifications.dedicatedSessionId` 保存该会话 id。
- UI：设置 → 通知与好友里可选「独立会话（推荐）」，并显示「目标会话：邮箱通知（<id 前 8 位>）」；未创建时显示「首次有新信时会自动创建」。
- `[通知测试]` 不带 sessionId 即可：宿主按目标解析（必要时创建独立会话），返回 `{delivered, sessionId}`；UI 就地显示「已投递到独立会话「邮箱通知」（id8）」或失败原因。
- 其它目标：`latest`（最近活跃）、`all`（全部活跃）、指定 sessionId；说明文案随目标切换。

### 6.8 键盘与动效
- `Tab`：页头 → 导航 → 列表 → 阅读；`Esc`：先关 Modal，再关写信面板，最后返回列表（窄屏）；`Enter/Space`：行打开；`Ctrl/Cmd+Enter`：发送。
- 面板滑入/滑出、hover 底色、未读圆点出现、toast 进出、骨架 shimmer（`prefers-reduced-motion` 关闭）。
- 不阻塞会话主线程：HTTP 请求异步，列表分页 limit 50，iframe lazy。

---

## 7. 响应式断点

| 断点 | 布局 |
|---|---|
| ≥1200px | 三列：导航 200px / 列表 360–420px / 阅读自适应；写信右侧滑出 520px |
| 1024–1199px | 导航收窄为图标+文字胶囊行（在页头下横向滚动）；列表 + 阅读两列 |
| 768–1023px | 列表 + 阅读两列（阅读可滑入覆盖）；页头操作收成图标 |
| <768px | 单列：列表 ↔ 阅读（滑入全屏 + 返回按钮）；导航为横向胶囊；写信全屏 |

实现用 CSS Grid + `@media (min-width: 768px/1024px/1200px)`；列宽用 `minmax()` 与 `clamp()`；不依赖 JS 测宽（除窄屏返回逻辑用 matchMedia）。

---

## 8. 可访问性（A11y）

- 语义：`<main>`, `<nav>`, `<section>`, `<h1>/<h2>`；列表用 `role="list"`/`role="listitem"` 或 `<ul><li>`；行用 `<button>`。
- 所有图标按钮 `aria-label`（来自 locale 字典），`Tooltip` 视觉提示 + `aria-label` 无障碍名一致。
- 状态：`aria-live="polite"` 的区域播报「已刷新 / 已发送 / 同步完成」；错误用 `role="alert"`；未读数用 `aria-label="收件箱 12 封未读"`。
- 焦点管理：打开写信/Modal 时焦点移入第一个字段；关闭后焦点回到触发按钮；破坏性确认 Modal 默认焦点在「取消」。
- 对比度：正文/次要文字用 DSH 原生 label 令牌，满足 AA；红色仅用于错误/危险，不只靠颜色传达（配文字/图标）。
- 动效遵循 `prefers-reduced-motion`。
- iframe 正文：`title` 用邮件主题；iframe 内容不可聚焦（sandbox 无同源、无脚本），屏幕阅读器主要读纯文本摘要（在 iframe 前提供「纯文本版本」折叠区，读屏友好）。

---

## 9. 安全 UI 约束（实现硬约束，评审逐条检查）

| # | 约束 | 实现要点 |
|---|---|---|
| S1 | 邮件 HTML 只进 `sandbox=""` iframe（srcdoc = 宿主已消毒内容） | iframe 属性 `sandbox=""` 不带任何 `allow-*`；不设 `src` 远程地址 |
| S2 | 客户端零未消毒 `innerHTML` | 全仓库 grep `innerHTML` 只允许 iframe 之外的 0 处；正文仅 React 文本 / srcdoc |
| S3 | 外链 `rel="noopener noreferrer"` + `target="_blank"` + 仅 http(s) | 链接白名单在客户端再过滤一次（`new URL` 校验协议） |
| S4 | 授权码不回显、不落 localStorage、不进日志/URL | 输入框 `type=password` + `autocomplete="new-password"`；只提交不保存；state 只显示 `configured/source` |
| S5 | 危险操作二次确认 | 删除邮件/好友、清空数据、关闭总开关 |
| S6 | 入口徽标/状态只读自身数据 | 只读 `/api/mailbox?action=state`；不读取宿主其它服务数据 |
| S7 | 不阻塞主线程 | 无同步 XHR、无死循环轮询；unread 轮询 60s，页面可见性变化时暂停 |
| S8 | 错误信息脱敏 | 直接展示宿主返回的 `error.message`（宿主已脱敏）；不 `console.log` 配置/密钥 |

---

## 10. 与宿主 API 的映射（实现契约）

接口路径以宿主实现为准：**`/api/mailbox`**（`ctx.connection.fetch.register` 的 `/api` 前缀下的绝对路径；`lib/server.js` 的 `API_PATH`）。客户端另做 `/dsh-mailbox/api` 兜底探测（仅当宿主早期版本/SPEC 路径），404 时自动回退。

| UI 行为 | 请求 |
|---|---|
| 首屏/徽标 | `GET /api/mailbox?action=state`（`enabled/config/connections/sync/notifications/counts/presets/tools`） |
| 列表 | `GET ?action=messages&folder=inbox|sent|quarantine&unreadOnly=false|true&limit=50&offset=0&search=` |
| 阅读 | `GET ?action=message&id=` → `{message:{html,text,from,to,subject,date,attachments,headers,…}, row}` |
| 已读 | `POST {action:'message.read', id, read}` |
| 删除 | `POST {action:'message.delete', id}` |
| 发信/回复（含附件） | `POST {action:'mail.send', to, subject, content, replyToId?, attachments?:[{filename,contentType?,base64}]}`（≤5 个、单文件 ≤8MB、总 ≤10MB） |
| 好友 | `GET ?action=friends` → `{policy,defaultAutoReply,friends,pending,aiAddLog}`；`friends.add/remove/update/approve/reject` |
| 预设&引导 | `GET ?action=presets` → `{locale,presets:[{id,label,smtp,imap,guide:{summary,steps,links,note}}]}` |
| 保存设置 | `POST {action:'config.save', patch:{…}, secrets:{smtpAuthCode?,imapAuthCode?}, clearSecrets?}` |
| 重置 | `POST {action:'config.reset'}` |
| 测试连接 | `POST {action:'test.smtp'|'test.imap', host?,port?,security?,user?,authCode?}` |
| 立即收信 | `POST {action:'sync.now'}` |
| 通知测试 | `POST {action:'notify.test', sessionId?}`；不带 sessionId 时按 `notify.target` 解析（dedicated 会创建「邮箱通知」会话），返回 `{delivered, sessionId}` |
| 会话列表 | `GET ?action=sessions` |
| 诊断 | `GET ?action=diagnostics` |
| 清空数据 | `POST {action:'data.clear'}`（二次确认） |

请求头：POST 必带 `content-type: application/json` + `x-dsh-mailbox: 1`；错误统一 `{ok:false,error:{code,message}}` → 展示 `message`，按 `code` 决定文案（`not-configured` 引导去设置、`forbidden` 停用态、`rate-limited` 提示稍后再试）。

---

## 11. 验收清单（交付前自查）

- [ ] 左栏「邮箱」入口 + 数字未读徽标（亮/暗均清晰）；点击打开全屏页面；`/mailbox` 命令可打开；设置页有「邮箱」。
- [ ] 收件箱/已发送/隔离/好友/设置/诊断六个视图均可切换；列表搜索/未读筛选可用；空/加载/错误/停用四态齐备。
- [ ] 阅读面板：iframe `sandbox=""` + 宿主消毒 HTML；无 innerHTML；外链过滤 + rel；附件行；回复/标未读/加好友/删除可用（删除二次确认）。
- [ ] 写信：预填、校验、发送中、成功 toast、失败保留草稿、关闭确认。
- [ ] 好友：待确认通过/拒绝、autoReply 开关、删除二次确认、添加校验。
- [ ] 设置：总开关置顶且关闭后全页停用态 + 可恢复；6 家预设 + 自定义；授权码已配置占位不回显；引导步骤与官方链接；测试 SMTP/IMAP 就地结果；字段级错误；保存/重置。
- [ ] 诊断：数据只读展示、同步/通知测试、清空数据强确认。
- [ ] 亮/暗主题跟随 DSH；窄屏单列；键盘可达、aria 完整；动效尊重 reduced-motion。
- [ ] 中英双语：跟随 DSH 语言切换即时生效。
- [ ] 静态 bundle 测试通过 + 真实 profile 加载 + 亮暗截图。

---

## 12. 验证记录（真实 DSH Web GUI，隔离 profile）

> 环境：`DSH_HOME=/tmp/clientui-home` + `dsh --profile web --port 3099`；真实插件安装于 profile（`dsh-mailbox` link + bundle）；Chrome headless + CDP 驱动（`probes/client/cdp-verify.mjs`）。
> 截图：`probes/client/screenshots/real-ui/`（25 张）；日志：`/tmp/verify.log`（本地临时）。

- 左栏入口「邮箱」渲染（数字未读徽标 2 / 3 与 `/api/mailbox?action=state` 的 `counts.unread` 一致），点击进入全屏页面；
- 收件箱/已发送/隔离/好友/设置/诊断全部可切换；真实 5 封收件 + 2 封已发送 + 1 封隔离渲染正确（好友/可疑/附件/自动邮件标签正确）；
- 设置页：4 个 tab、快速开始进度、服务商卡片与授权码引导、总开关、sticky 保存栏全部生效；授权码显示「已配置（不回显）+ 来源 Tag」；
- **通知目标 = independent（dedicated）**：设置里可选「独立会话（推荐）」；点「通知测试」得到
  `已投递到独立会话「邮箱通知」（8ea5f9ee）`，`/api/mailbox?action=sessions` 返回 `{title:"邮箱通知"}`，左栏出现「邮箱通知」会话；
- **附件**：写信面板用 CDP 塞入 `demo-report.pdf`(78B) 与 `notes.txt`(67B) → chips 显示 `demo-report.pdf · 78 B`、`notes.txt · 67 B`，可移除；`mail.send` payload 带 `attachments:[{filename,contentType,base64}]`；
- 阅读面板：iframe `sandbox=""`、`referrerpolicy=no-referrer`、`srcDoc` 非空；提取外链为 `a[target=_blank rel="noopener noreferrer"]`；
- 亮/暗主题、窄屏（420px）列表↔阅读切换正常；console errors = 0；
- 静态测试：`node test/client-bundle.test.js` → `pass 6 / fail 0`，exit 0，约 0.22s（无定时器泄漏，不依赖 process.exit）。
