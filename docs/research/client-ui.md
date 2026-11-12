# client-ui 调研报告：DSH 浏览器端插件形态、入口扩展点与设计系统

> 状态：**已验证**（2026-11-12）。验证环境：隔离 profile `DSH_HOME=/tmp/clientui-home`，`dsh --profile web --port 3099`，真实 Chrome headless（CDP）加载并截图。
> 探针代码：`probes/client/probe/`（可独立安装的最小客户端插件）；驱动脚本：`probes/client/cdp-check.mjs`；截图证据：`probes/client/screenshots/`。
> 本报告结论直接支撑 `docs/UI-SPEC.md` 与 `lib/client.js` 的实现。

## 0. 结论先行（TL;DR）

1. **形态约束成立**：dsh-mailbox 不需要独立 Web UI。客户端半边是一个手写单文件 CJS-factory bundle（`lib/client.js`），由宿主加载到 DSH Web GUI 进程内，和「插件 / 自动化任务」页面同级。**数据通道仍是宿主半边的同源 `/dsh-mailbox/api`**，不是独立服务。
2. **左侧主导航页面方案已验证可行**：`ctx.slots.inject('main')` + `ctx.slots.register({ name:'main', key:'mailbox' })` 注册页面；`ctx.slots.register({ name:'sidebar.panellist', id:'mailbox', order, label })` 注册左栏行。实测左栏出现「邮箱探针」行，点击后全屏页面渲染正常（见截图）。
3. **入口组合已定**（SPEC §9.1 全部满足，且都是 DSH 原生形态）：
   - 主入口：左侧主导航「邮箱」页面（数字未读徽标画在图标上，实测可见）；
   - 命令面板：`ctx.commandUi.register({ kind:'action' })`「打开邮箱」；
   - 设置页：`ctx.slots.register({ name:'settings.section', id:'mailbox' })`，出现在「设置 → 插件」分区；
   - 会话头部常驻入口：`conversation.session.header.utilities`（会话右上角的图标按钮）；
   - **右侧栏 tab 不作为常驻入口**：右侧栏 tab 是按「文件类型 pattern / openTab(kind, params)」打开的文档页，不是常驻快捷入口；强行注册会污染「打开文件」流程。报告 §4.4 解释为什么不用。
4. **UI 直接复用 DSH 原生 primitives**：`require('@deepseek-ai/dsh-client-ui-primitives')` 可用（实测 310 个导出），`Button/Switch/Input/Modal/Toast/Tooltip/Tag/StateDot/Menu…` 都能用；颜色用 `--dsw-*` 令牌，亮/暗由 `body[data-ds-dark-theme]` 自动切换。这样「高级 UI」= 原生质感，不是另画一套皮。
5. **不要注册 `sidebar.toggle.badge`**：它是 `single` 槽且官方组合已有占用，第二方注册会抛错（实测异常，见 §5.6）。折叠态徽标改由 `sidebar.panellist` 图标自身承载。
6. 宿主不需要为客户端额外写任何服务端路由/注入：只要包的 `package.json` 有 `exports["./client"]` + `dsh.client.platform = "web"`，且它是**已启用的 Loader 条目**，`dsh-client-modules` 就会把它编进 boot graph，浏览器经 `/plugins` 组合 URL 取到 bundle。
7. 页面没有 URL 路由：`ctx.layout.selectPanel(id)` 是唯一页面切换 API；也不存在「深链接到面板」的官方路由（实测页面 URL 只有启动 token），入口只能靠上面这些注册点。

---

## 1. 手写客户端 bundle 的精确格式（已跑通）

### 1.1 文件形态

`lib/client.js` 是**普通脚本**（不是 ESM），执行时只做一件事：向 `window.__ModuleLoader__` 注册一个 CJS factory。**模块体（含 CSS 注入、React 组件）必须写在 factory 闭包里**——bundle 执行 ≠ 插件激活；factory 只在该包第一次被 import/materialize 时执行一次，并 memoize。

```js
/* eslint-disable */
window.__ModuleLoader__.load({
  id: 'dsh-mailbox', // 必须等于 npm 包名（boot graph 的 entry id）
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')                                   // 基线模块
    var P = require('@deepseek-ai/dsh-client-ui-primitives')       // 基线模块
    // …组件、常量、CSS 字符串…
    function apply(ctx) { /* 注册入口 / 页面 / 命令 / 设置页 */ }
    exports.name = 'mailbox'
    exports.inject = ['slots', 'locale', 'layout', 'commandUi']
    exports.apply = apply
    return module.exports
  },
})
```

要点：

- `id` 必须与 **包名**（`package.json.name`）一致；host 生成 boot row `{ id: <pkg>, url: 'plugins/??<pkg>/client.js&rev=<hash>' }`，loader 用 `id` 把 factory 归属到该行。
- 产物末尾**不要**再写 ESM `export`；`exports.apply/inject/name` 就是契约（与 dsh-drawai、全部官方 client 包一致）。
- 只能用 `require`，**不能** `import`；`require` 的解析顺序是：**基线模块表 → 已注册 factory → boot graph 行**，其它一律抛错。所以要么用基线模块，要么只 require 自己包内的东西（手写单文件时通常不需要）。
- 不要有顶层副作用（除了 `__ModuleLoader__.load` 调用本身）；CSS 注入要放在 `apply`/ `ctx.effect` 里，插件卸载时会随 effect 清理（参考 dsh-drawai 的 `<style data-plugin>` 模式）。
- 现有官方 bundle 用 `React.createElement` 或 `require('react/jsx-runtime').jsx` 都可以，两者都在基线表里。

### 1.2 package.json 声明

```json
{
  "name": "dsh-mailbox",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

`dsh.client` 合法字段（源码 `@deepseek-ai/dsh-client-modules` 的 `parseDshClient` 校验）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `platform` | string | ✅ | 写 `"web"`；缺失/非字符串直接报错 |
| `inject` | string[] | — | **其它客户端包名**依赖边（模块工厂到达顺序），不是 Cordis 服务注入 |
| `external` | string[] | — | 本包 require 的**非基线**模块说明符（每项由一个动态包提供或用静态表精确命中） |
| `immediately` | boolean | — | 启动阶段预取该 bundle（默认懒加载） |

> 注意：Cordis 服务注入写在 bundle 的 `exports.inject`（如 `['slots','locale']`），**不在 package.json**。两者同名但语义不同，别混。

本插件只需要 `{ "platform": "web" }`：bundle 只 require `react`（基线），服务通过 `exports.inject` 注入。**不需要**改 package.json 的 `dsh.client.inject`。

### 1.3 宿主如何服务 bundle（`/plugins`）

- 宿主半边 `dsh-client-modules` 扫描**已启用的 Loader 条目**，读包清单的 `dsh.client`，把有 `./client` 导出的包编成 boot graph，注入 `globalThis.__DSH_BOOT__`；浏览器模块系统先注册**组合脚本**里的所有 factory，再按 entry 懒加载。
- 实测 boot graph 行（`/tmp/index-token.html` 内 `globalThis["__DSH_BOOT__"]`）：

```json
{ "id": "dsh-mailbox-probe", "url": "plugins/??dsh-mailbox-probe/client.js&rev=1bb3aca355c6", "rev": "1bb3aca355c6" }
```

- 实际请求：`GET /plugins/??<pkg>/client.js&rev=<rev>`（组合 URL，多个包逗号/&连接）；`GET /plugins/<pkg>/client.<chunk>.js?rev=` 走异步 chunk；`GET /plugins/<pkg>/assets/<path>` 服务 `"./assets/*"` 导出（`require.asset(...)` 引用）。
- 这些路由与 Web UI 一样受**启动 token 的浏览器信任栅栏**保护：未鉴权 curl 直取 404/要求重开 URL（实测）。客户端里的同源 `fetch()` 自动带 cookie，无需额外 token 处理。
- 启用/停用是 Loader 层的能力（设置 → 插件里禁用 bundle / 从 profile 移除），客户端无需感知；插件卸载时 slot 注册与样式一并清理。
- 开发期不跑构建：直接改 `lib/client.js` 后刷新页面即可；文件 mtime/size 变化会推 HMR 让页面重载该 bundle（宿主侧 hash 组合 URL）。

---

## 2. 基线模块表（浏览器端可 `require` 的模块）

从 Web 壳构建产物（`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` 的 `PLATFORM_MODULES` 冻结表）与运行探针双向确认，**共 11 项**：

| 模块 id | 说明 |
|---|---|
| `react` | React 18（官方包共建同一实例） |
| `react/jsx-runtime` | JSX runtime（`jsx/jsxs`） |
| `react-dom` | ReactDOM |
| `react-dom/client` | createRoot |
| `@deepseek-ai/cordis` | Cordis 框架（Service/Context 等） |
| `zod` | Zod 校验库 |
| `@tanstack/react-virtual` | 虚拟滚动 |
| `@deepseek-ai/dsh-client-store` | 客户端 store 工具（`HostObservable` 等） |
| `@deepseek-ai/dsh-client-ui-slots` | 插槽系统类型/运行时工具 |
| `@deepseek-ai/dsh-client-ui-primitives` | **DSH 原生 UI 组件库（310 个导出）** |
| `@deepseek-ai/dsh-client-ui-dockkit` | 右栏 docking kit |

探针实测：`require('react')` 可用；`require('@deepseek-ai/dsh-client-ui-primitives')` 返回 310 个导出；运行时 `window.__MAILBOX_PROBE__.primitives === 310`。

**禁止**在 bundle 里 `import '@deepseek-ai/*'`（源码解析不稳定）；只 require 上表内的模块。

---

## 3. 服务注入与生命周期 API

客户端 apply 的 `ctx` 是 Cordis Context；用 `exports.inject` 声明依赖，服务就绪后 `apply(ctx)` 才执行。

```js
exports.inject = ['slots', 'locale', 'layout', 'commandUi']
exports.apply = (ctx) => { /* ... */ }
```

| API | 实测结论 |
|---|---|
| `ctx.effect(fn, label?)` | 注册资源并返回清理函数；`fn` 返回 disposer 或 `() => cleanup`。风格：每次注册都用 `ctx.effect(...)` 包一层。 |
| `ctx.slots.inject(name, cb)` | 等待某个插槽被声明后执行 `cb`；返回 disposer。`cb` 通常再调用 `ctx.slots.register(spec, Component)`。**所有 slots 注册都走这个模式**。 |
| `ctx.slots.register(spec, Component)` | 返回 disposer；spec 必须含 `name`（槽名）；`key`（keyed 槽）/`id`（list 槽）区分身份；`locale` 让组件 props 得到 `t`；`inject` 注入 props；`order` 控制排序；`label` 提供可见文案。 |
| `ctx.inject([...services], scope => ...)` | 可选依赖注入；服务齐全时回调执行。命令面板用它拿 `commandUi`。 |
| `ctx.get(name)` | 运行时取可选服务（官方包常用）。 |
| `ctx.locale.register(ns, {zh, en, ...})` | 注册字典；**对象形式必须同时给 `zh` 和 `en`**；返回 disposer。 |
| `ctx.locale.bind(ns)` | 拿到 `t(key, params?)`；`t` 是稳定引用。 |
| `ctx.layout.selectPanel(id)` | 切到已注册的 `main` 面板；未注册 id 会抛错。 |
| `ctx.layout.panelInfo` | `HostObservable<{activePanelId}>`（`getSnapshot()` / `subscribe()`）。 |
| `ctx.layout.beginNavigation()` | 异步导航取消信号（可选）。 |

> 注意 Cordis 插件有时用 generator apply（`function* apply(ctx) { yield ctx.slots.inject(...) }`）——两种写法都可以；手写 bundle 用普通函数 + `ctx.effect` 更直观（dsh-drawai 即此风格，已稳定运行）。

---

## 4. DSH 入口扩展点（全部实测）

### 4.1 左侧主导航「页面」（首选入口，已验证）

两个槽协作，**id/key 必须一致**：

```js
const PANEL_ID = 'mailbox'

function apply(ctx) {
  // ① 页面本体：root-scoped keyed 槽 'main'
  ctx.effect(() =>
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          locale: NS, // 组件 props 得到 t
          inject: () => ({ /* 页面需要的注入 props */ }),
        },
        MailboxPage,
      ),
    ),
  )

  // ② 左栏行：root-scoped list 槽 'sidebar.panellist'
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30, // 「插件」= 0，「自动化任务」= 10 附近；邮箱放其后
          locale: NS,
          label: () => t('panel'), // 可见文本 + 无障碍名 + 折叠态 tooltip
        },
        MailboxPanelIcon, // props: { size: 16|18, active: boolean }
      ),
    ),
  )

  // ③ 任何按钮都可以用 selectPanel 跳页
  const open = () => ctx.layout.selectPanel(PANEL_ID)
}
```

实测：

- 左栏出现「邮箱探针」行，图标渲染正常，点击后主列切换到页面（`data-testid` 命中断言 `PAGE_READY=true`）；
- 页面组件所在地是主列整块区域，组件需自己负责 `height:100%`、滚动、标题区上边距（官方页面样式：`padding-top:28px`；macOS 桌面再加 `var(--dsh-frame-top-clearance)`）；
- 侧栏行 props：`{ size, active }`；展开态 `size=16`、折叠态 `18`；图标槽外层 `aria-hidden="true"`，行文本标签是无障碍名来源。

**未读数字徽标**：`sidebar.panellist` 没有独立的 badge 字段，但图标组件内部可以渲染绝对定位的数字徽标（实测可见，见截图左栏「邮箱探针」图标右上角的红色 `3`）：

```js
function MailboxPanelIcon({ size, active }) {
  return h('span', { style: { position:'relative', display:'inline-flex' } },
    h(MailGlyph, { size }),
    unread > 0 ? h('span', { style:{ position:'absolute', top:-5, right:-7, minWidth:14, height:14, borderRadius:7, background:'var(--dsw-alias-state-error-primary)', color:'#fff', fontSize:9, lineHeight:'14px', textAlign:'center' } }, String(unread > 99 ? '99+' : unread)) : null)
}
```

徽标数据来源：客户端定期拉 `/dsh-mailbox/api?action=state`（或在页面里共享 store），只读、只用于显示；不要把它当作任何权限判断依据。

### 4.2 命令面板（已验证）

```js
ctx.inject(['commandUi'], (scope) => {
  scope.effect(
    () =>
      scope.commandUi.register({
        name: 'mailbox',                 // 不带 '/'；与宿主命令重名会抛错
        label: () => t('command.label'), // 菜单行标题
        description: () => t('command.desc'),
        available: () => true,           // (session) => boolean
        ui: { kind: 'action', run: () => ctx.layout.selectPanel(PANEL_ID) },
      }),
    'mailbox: /mailbox command',
  )
})
```

- `kind:'action'`：裸调用直接执行回调、不提交消息、不占草稿；
- 另一种 `kind:'popupSelect'` 用于带选项的弹层（`options(session, signal)` + `onSelect`），本期不需要；
- 也可以用 `ctx.commandUi.decorate(...)` 给已有宿主命令挂动作（例如给 `/model` 挂弹层）——不要用。
- 命令行的名字是英文小写单词最贴原生（`/mailbox`）；菜单标题走 locale 字典。

### 4.3 设置页入口（已验证）

```js
ctx.effect(() =>
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mailbox',
        order: 40,
        locale: NS,
        label: () => t('settings.label'),
      },
      MailboxSettingsPage,
    ),
  ),
)
```

- 页面组件收到 owner props `{ close }`（关闭设置面板用），外加注入 props 与 `t`；
- 位置在「设置 →（插件分区）」，与官方配置页同级；同一份设置面板组件与邮箱页面内设置页复用；
- 若要塞进「设置 → 内置插件」的 tab 行，用 `settings.plugins.tab`（`id/order/label`，无 owner props）——本插件用 `settings.section` 更显眼。

### 4.4 会话头部常驻入口（已验证；右侧栏不用）

```js
ctx.effect(() =>
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'mailbox',
        order: 10,
        locale: NS,
        inject: () => ({ openMailbox: () => ctx.layout.selectPanel(PANEL_ID) }),
      },
      MailboxHeaderAction, // 返回 null / 一个 28×28 的图标按钮
    ),
  ),
)
```

- 槽是 **session scope** 的 list：每个会话标题右侧一排工具按钮；组件可用 `props.sessionId` 与会话相关服务；
- 它让邮箱入口在「正在对话」时也常驻可见，作为左栏被折叠（窄屏）时的兜底；
- **右侧栏（right sidebar）不作为常驻入口**：`ctx.sidebarRightTabs.register({ id, kind, patterns, title, guide })` 是按文件 pattern 匹配打开文档页的 tab 类型；常驻面板需要伪造资源/pattern，会干涉「打开文件」流程，不是该槽的设计用途（api 见 dsh-drawai 实现）。快速查看类需求用 `ctx.sidebarRight.openTab(kind, { params })` 从入口按钮打开，也与「常驻 tab」语义不符。

### 4.5 其它可用但本期不用的槽

- `sidebar.panellist.actions`：左栏「更多」菜单里的自定义行（第三方面板可被 pin/打开）；邮箱已在主列表，不必再加。
- `shell.overlay`：整帧浮层（badge/toast 栈/状态球）；页面内 toast 足够，避免多一层。
- `conversation.session.header.corner`、`settings.plugins.tab`：可选，用于极简徽标/内置插件配置页。
- **`sidebar.toggle.badge`（collapsed 展开按钮上的通知）是 single 槽且官方组合已占用，第二方注册会抛错 —— 不要用**（实测异常见 §5.6）。

---

## 5. 运行验证记录（真实 DSH Web GUI）

### 5.1 环境

- 隔离 HOME：`DSH_HOME=/tmp/clientui-home`（自动生成的空白 web profile，绝不碰 3080 的 web profile）；
- 启动：`DSH_HOME=/tmp/clientui-home dsh --profile web --no-open --port 3099`（打印带 token 的 URL）；
- 探针包：`probes/client/probe/` 以 link 方式加入 profile 的 `dependencies` + `dsh.profile.bundles`，并 `ln -s` 进 `node_modules`（免 pnpm 联网）；
- 浏览器：真实 Chrome headless（`/usr/bin/google-chrome`），Node 24 全局 `WebSocket` 直连 CDP；脚本 `probes/client/cdp-check.mjs`。

### 5.2 启动与加载

- 宿主启动 20s 内就绪，`/` 返回 200（带 token/cookie）；boot graph 含 `dsh-mailbox-probe` 行；
- Chrome 打开页面后 `window.__MAILBOX_PROBE__` 出现且 `bundleExecuted: true`、`events: ['apply-started','apply-finished']`，说明 bundle 被真实加载、factory 被 materialize、apply 正常执行。

### 5.3 注册结果（`window.__MAILBOX_PROBE__.registered`）

```json
{
  "main": true,
  "sidebar.panellist": true,
  "settings.section": true,
  "header.utilities": true,
  "commandUi.register": true,
  "sidebar.toggle.badge": "skipped: single slot occupied by shipped composition"
}
```

`errors: []`（除 §5.6 那个已知占用槽异常）。

### 5.4 交互与截图

- 左栏行文本（DOM）：`{"text":"3邮箱探针","aria":"邮箱探针"}` —— 数字徽标在图标内渲染，行无障碍名保持「邮箱探针」；
- CDP 点击左栏行 → `PAGE_READY=true`（页面 `data-testid` 出现），截图见 `probes/client/screenshots/probe-page-light.png`；
- 手动切暗色（`body[data-ds-dark-theme]`）→ 页面与 DSH 同步换肤，截图见 `probes/client/screenshots/probe-page-dark.png`；
- 页面内 primitives 冒烟：`Button`（primary/outline）、`Tag`、`StateDot`、`Tooltip`、`Switch`、`Input`、`Modal` 全部正常渲染。

### 5.5 复现命令

```bash
# 1) 起隔离 profile（首次自动生成）
DSH_HOME=/tmp/clientui-home dsh --profile web --no-open --port 3099 &
# 2) 装探针（link）
ln -s "$PWD/probes/client/probe" /tmp/clientui-home/profiles/web/node_modules/dsh-mailbox-probe
#    profile/package.json: dependencies 加 link:…，dsh.profile.bundles 追加 "dsh-mailbox-probe"
# 3) 驱动 + 截图
node probes/client/cdp-check.mjs 'http://127.0.0.1:3099/?token=<启动日志里的 token>' --shot /tmp/probe.png
```

### 5.6 实测踩到的坑

| 现象 | 结论 |
|---|---|
| `single slot "sidebar.toggle.badge" already has a registration at priority 0` | 该槽被官方组合占用，第三方不要注册；折叠态徽标改为图标内徽标 |
| 直接 `GET /plugins/<pkg>/client.js` 404 | 正确入口是 boot graph 的组合 URL `plugins/??<pkg>/client.js&rev=<rev>`；单资源 URL 需要对应 revision（HMR chunk 用） |
| 未鉴权 curl 打开 `/` 返回 `dsh web authentication required` | 页面/插件路由都在启动 token 的信任栅栏后；浏览器同源 fetch 自动带 cookie |
| 新 profile 首屏有「预览版说明」欢迎弹层 | 来自 ui-settings-general 的 `welcomeNoticeVersion`；截图前需点「继续」或在测试 profile patch 里把版本配到最新 |
| 页面没有 URL 路由 | 入口跳转只能 `ctx.layout.selectPanel(id)`；外部深链到邮箱页不可行（如需，可在页面里自己维护 hash，但不要依赖宿主路由） |

---

## 6. 设计系统：主题令牌与 primitives

### 6.1 CSS 变量（注意前缀是 `--dsw-`，不是 `--dsh-`）

DSH 的颜色/材质令牌在 `body` 上按「亮/暗 palette」解析；暗色由 `body[data-ds-dark-theme]` 标记，**插件不要自己存主题状态**，直接用 `var()`。

| 类别 | 变量（示例） | 用途 |
|---|---|---|
| 背景 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-skeleton` | 页面底、卡片、浮层、骨架屏 |
| 文字 | `--dsw-alias-label-primary`、`-secondary`、`-tertiary`、`-caption`、`-dimmed` | 标题/正文/次要/说明/禁用 |
| 边框 | `--dsw-alias-border-l1/l2/l3/l4`、`--dsw-alias-border-inverted` | 1px/0.5px 分隔线 |
| 交互 | `--dsw-alias-interactive-bg-hover`、`-active`、`-hover-danger`、`-hover-accent` | 行 hover / 按下 |
| 按钮 | `--dsw-alias-button-primary-fill/-hover`、`-outline-fill`、`-ghost-active-fill` | 与 primitives Button 一致 |
| 状态 | `--dsw-alias-state-success-primary/secondary/tertiary`、`-warn-*`、`-error-primary/secondary`、`-business-primary`、`-idle-primary`、`-done-primary`（violet） | 状态灯/提示/成功/失败 |
| 材质 | `--dsw-alias-settings-card-fill`、`-settings-card-stroke`、`--dsw-alias-toast-bg`、`-toast-label` | 设置卡、toast |
| 圆角 | `--dsw-radius-xs/sm/md/lg/xl/panel` | 组件圆角（别硬编码 px 家族） |
| 阴影 | `--dsw-shadow-lv1/lv2/lv3`、`--dsw-elevation-*` | 卡片/弹层/浮起 |
| 焦点 | `--dsw-focus-ring-color`、`--dsw-focus-ring-width`（2px） | `:focus-visible` 统一环 |
| 字体 | `--dsw-font-family`、`--dsh-font-family-text/code`、`--dsh-content-font-size`、`--dsh-content-font-size-secondary`、`--dsh-code-font-size` | 正文字号跟随用户设置，不要写死 |
| 框架 | `--dsh-frame-top-clearance`（48px，macOS 桌面）、`--dsh-frame-leading-clearance` | 页面顶部/左上角避让 |
| 滚动条 | `--dsh-scrollbar-thumb`、`--dsh-scrollbar-width` | 与宿主一致 |

**用法原则**：新组件优先 `var(--dsw-…)`；字号用 `13px/20px` 与 `14px/22px` 两档（宿主设置区/列表的常用档），大标题 `20px/28px`、`500` 字重；间距用 4 的倍数（4/8/12/16/20/24/32/48）；圆角用 `--dsw-radius-*`；`focus-visible` 用统一环而不是 `outline` 自造。

### 6.2 primitives 组件清单（实测可 require）

共 310 个导出。按用途分组（名字即导出名）：

- **交互**：`Button`（`variant: 'primary'|'outline'|'ghost'`、`size:'sm'`）、`Input`（透传 input props，可带 `icon`）、`Switch`（`{checked,label,disabled,onChange}`）、`Checkbox`、`SegmentedControl`、`SegmentedTabs`、`Menu`/`MenuSurface`/`MenuGroup`/`MenuItemButton`、`Tooltip`（`{label,side,portal,delayMs,disabled}`）、`Modal`（`{open,title,description,closeLabel,onClose,footer,className,contentClassName,children}`）、`RiskConfirmation`、`Toast`（`{text,tone:'success'|…,icon,onDone}`）、`Tag`（`{tone:'info'|'success'|'warning'|'neutral'|'error'…}`）、`Pill`、`StateDot`（`{state:'ongoing'|'idle'|'error'|…}`）、`DisclosureRow`、`HoverCard`、`HoverCardGroup`、`ShortcutKeys`、`SettingsForm*`、`SettingsSecretField`、`SettingsValueField`。
- **展示**：`TextShimmer`、`MarkdownText`、`CodeBlock`、`DiffBlock`、`JsonTree`、`PathLabel`、`ReferenceChip`、`FileTypeIcon`、`GuideArtworkBrowser/Files`、`PluginArtwork*`、`FishLogo`、`BrandWordmark`、`ICON_SYMBOLS`。
- **图标**：`Icon*Regular/Medium`（约 120 个），例如 `IconSearchOutlineRegular`、`IconTrashOutlineRegular`、`IconPlusOutlineRegular`、`IconRefreshOutlineRegular`、`IconWarningOutlineRegular`、`IconCheckOutlineRegular`、`IconChevronDownOutlineRegular`、`IconCloseOutlineRegular`、`IconSettingsOutlineRegular`、`IconUserOutlineRegular`、`IconSendOutlineRegular`。**没有 mail/收件箱图标**，邮箱图标需自带 SVG（保持 24 viewBox、`strokeWidth:1.5`、`currentColor`，与官方线性图标同观感）。
- **工具函数**：`useAnchoredPosition`、`useDismissOnOutsidePointer`、`useModalLayer`、`closeTopModal`、`focusWithoutRing`、`relativeTime`、`rankByName`、`pointerModality`、`isMobileDevice`。
- 反例：`Skeleton`/`Spinner`/`EmptyState` 没有导出（骨架屏用 `--dsw-alias-bg-skeleton` 自己画），空状态用图标 + 文案 + CTA 自己组合。

> 图标属性：`{size?: number, className?, 'aria-hidden'?}`；官方用法 `size: 14/16/24`、`ICON_REGULAR_STROKE = 1.5`。

### 6.3 亮暗自适应

- 组件里**不要**读 `prefers-color-scheme`；用令牌即可自动切换（`body[data-ds-dark-theme]` 由 ui-layout 主题 presenter 维护）。
- 若必须按主题微调（例如自绘插画），用 `body[data-ds-dark-theme] .dsh-mailbox-xxx { … }` 选择器，不要 JS 判断。
- 页面根元素背景用 `var(--dsw-alias-bg-base)`，卡片用 `var(--dsw-alias-bg-layer-1)` + `var(--dsw-alias-border-l3)`；hover 用 `--dsw-alias-interactive-bg-hover`。

---

## 7. locale 使用方式

```js
const NS = 'mailbox' // 命名空间

exports.apply = (ctx) => {
  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        zh: { panel: '邮箱', inbox: '收件箱', /* …全部 key… */ },
        en: { panel: 'Mailbox', inbox: 'Inbox', /* …同 key … */ },
      }),
    'mailbox: dictionaries',
  )
  const t = ctx.locale.bind(NS) // t(key, params?) —— 用于注册选项的 label/description
}
```

- 注册项带 `locale: NS` 时，组件 props 里直接有 `t`（slot 框架注入的 locale seat）；组件内 `props.t('inbox')`。
- 对象形式注册**必须同时提供 `zh` 与 `en`**（其它语言包可选）；缺 key 时回退到 key 本身。
- `label`/`description` 传函数（每次渲染实时取值），切语言即时生效；注册时如果传的是常量，会停留在注册时的语言（官方 locale 文档明确指出该限制）。
- 语言偏好跟随 DSH「设置 → 通用 → 语言」，插件不要自己持久化。
- 本插件实现：字典**内嵌在 `lib/client.js`**（单文件 bundle 无构建步骤，无法 import JSON）；`locale/zh.json`、`locale/en.json` 作为同内容的导出副本给宿主/文档/测试用，`test/client-bundle.test.js` 断言两者一致，避免漂移。

---

## 8. 数据通道（客户端 ↔ 宿主半边）

- 客户端只走**同源 HTTP**：`fetch('/dsh-mailbox/api?action=…')`（GET）与 `fetch('/dsh-mailbox/api', { method:'POST', headers:{'content-type':'application/json','x-dsh-mailbox':'1'}, body: JSON.stringify({action, …}) })`。
- 宿主半边用 `ctx.webServer.register({ kind:'exact', path:'/dsh-mailbox/api', handler })` 注册（Lead 实现），受 §0 T4 栅栏保护：同源校验 + 自定义头 + JSON + 体积上限；**客户端不要绕过这些头**（它们是 CSRF 防护，不是累赘）。
- 启动 token 的浏览器信任栅栏由 Web 壳负责，同源 fetch 自动带 cookie；不需要在客户端保存 token。
- **不要用 ctx.remote**：SPEC 明确本插件 UI 数据走同源 HTTP（drawai 的 `fetch + x-dsh-mailbox` 模式已验证）。
- mock 预览模式：`window.__DSH_MAILBOX_UI_MOCK__ = true`（或 `?mock=1`）时，客户端用内置演示数据层，仅供开发截图/评审；生产不带该开关。此开关只在客户端存储层生效，不影响宿主。

---

## 9. 供实现使用的已确认事实清单（给 lib/client.js）

1. bundle id `dsh-mailbox`，`exports.inject = ['slots','locale','layout','commandUi']`（`commandUi` 可选时用 `ctx.inject` 包一层，避免服务缺失导致整个插件 pending）。
2. 右侧栏/页面切换只用 `ctx.layout.selectPanel('mailbox')`。
3. 页面注册：`main` keyed + `sidebar.panellist` list，id 都叫 `mailbox`。
4. 未读徽标画在 `sidebar.panellist` 图标组件内；不要用 `sidebar.toggle.badge`。
5. 设置页：`settings.section`，id `mailbox`，order 40 左右。
6. 会话头部：`conversation.session.header.utilities`，图标按钮 28×28。
7. 命令：`/mailbox`，`kind:'action'`，不提交消息。
8. CSS 注入 `<style data-plugin="dsh-mailbox">`，选择器全部 `dsh-mailbox-` 前缀。
9. 图标自己画（24 viewBox / stroke 1.5），其余交互控件尽量用 primitives。
10. 主题用 `--dsw-*` / `--dsh-*` 令牌；字号/圆角跟随令牌，不写死颜色。

## 10. 未决/风险

- **右侧栏常驻入口**：官方 API 不支持「常驻快捷 tab」（见 §4.4）；如用户强要求，备选是 `conversation.session.header.corner` 或 `shell.overlay` 放一个悬浮入口，需再评估视觉干扰。
- **页面无 URL 深链**：入口只靠注册点；如未来 DSH 增加路由，再跟进。
- **primitives 无 mail 图标**：自带 SVG 形状需人工对齐官方线性风格（已按 24/1.5 处理）。
- **bundle 体积**：手写单文件会到 ~100–200 KB 量级（纯文本），可接受；不做压缩构建，保持可评审。
- **HMR**：客户端半边改文件后由客户端 HMR 重载；宿主半边（index.js/lib/*.js）改动需要重启 `dsh web`（Lead 负责）。
- **测试 profile 端口**：本报告用 3099；host-api 若改用其它端口，按同样步骤可复现。

---

## 11. 实现定稿补充（2026-11-12 晚，真实 UI 联调后）

- 设置页最终形态：**分组 tab（快速开始 / 连接配置 / 通知与好友 / 高级设置）+ 四步进度 + 服务商卡片 + sticky 保存栏**；低频字段折叠进「高级设置」——解决「太繁杂、引导不足」的反馈（截图见 `probes/client/screenshots/real-ui/05a-05d`）。
- 收信通知默认目标改为 **`dedicated`**（宿主自建「邮箱通知」独立会话）；UI 设置页可选四项，并显示 `dedicatedSessionId`；「通知测试」不带 sessionId 时按目标解析，返回 `{delivered, sessionId}` 并就地显示。实测 `已投递到独立会话「邮箱通知」（8ea5f9ee）`。
- 写信/回复面板新增**附件选择器**：隐藏 `<input type=file multiple>` + 文件名/大小 chips + 移除；客户端预检（≤5 个、单文件 ≤8MB、总 ≤10MB、可执行/脚本/密钥/隐藏文件拒绝），发送时 `attachments:[{filename,contentType,base64}]` 进入 `mail.send`，不写 localStorage/日志。
- 静态测试 `node test/client-bundle.test.js`：6 项全绿，exit 0，约 0.22s；轮询 timer 用 `ctx.effect` 清理并在 Node 下 `unref`，测试不依赖 `process.exit`。
