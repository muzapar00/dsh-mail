# probes/host — DSH 宿主插件 API 探针（host-api 调研产物）

配套报告：`docs/research/host-api.md`。这里的东西**只用于隔离测试 profile**，不要装进真实 profile。

## 一键流程

```bash
cd /home/mzpr00/root_workspace_for_deepseek_harness/dsh-mailbox

# 0) 清掉内存/端口占用（只按 pid 文件停自己的实例）
PORT=3101 probes/host/stop-test-profile.sh

# 1) 建隔离测试 home + profile（FORCE=1 重建；--with-mailbox 同时加载 dsh-mailbox）
FORCE=1 probes/host/setup-test-profile.sh --with-mailbox

# 2) 启动（DSH_HOME=/tmp/dsh-maildev, profile=maildev, 端口=3101）
PORT=3101 probes/host/start-test-profile.sh
#    → "ready: http://127.0.0.1:3101"
#    → 带登录 token 的入口写在 /tmp/dsh-maildev/logs/url.txt（600）

# 3) 跑 47 项 host-API 断言（鉴权/路由/工具/提示词/会话/通知）
PORT=3101 probes/host/http-probe.sh

# 4) 纯逻辑通知队列探针（不需要 IMAP / 活会话）
node probes/host/notify-queue-probe.mjs

# 5) 停
PORT=3101 probes/host/stop-test-profile.sh
```

## 端口 / 环境约定（避免碰撞）

| 用途 | DSH_HOME | profile | 端口 |
|---|---|---|---|
| **host-api 探针（本目录）** | `/tmp/dsh-maildev` | `maildev` | **3101** |
| client-ui 联调 | `/tmp/clientui-home` | — | 3099 |
| Lead 集成 | `/tmp/lead-maildev` | — | 3102 |
| **用户正在用的 Web GUI（绝不碰）** | `~/.dsh` | `web` | 3080 |

- HTTP、WebSocket、UI 共用**同一个** `--port`；没有第二个端口。
- `start-test-profile.sh` 会先检查端口占用，被占用直接拒绝（不会抢占 3099/3102）。
- 启动后宿主日志里的 `dsh web: http://127.0.0.1:<port>/?token=<launch-token>` 就是唯一带凭据的入口；
  用 `curl -c cookies.txt "$url"` 换取 `dsh-auth-*` HttpOnly cookie，之后 `/api/*` 请求带它即可。
  **token 只用于换 cookie，别写进日志/报告/bundle。**

## 文件

| 文件 | 说明 |
|---|---|
| `setup-test-profile.sh` | 建 `/tmp/dsh-maildev`：复制 web profile 清单（排除 node_modules）、node_modules 逐条符号链接回 web profile、拷 `.credentials.yaml`（600）、链入 `dsh-mailprobe`/`dsh-mailbox`、改 profile package.json 加 bundle。`--with-mailbox` 才把 dsh-mailbox 加进 bundles（插件缺 index.js 时不加，避免启动失败）。带安全闸：TEST_HOME 必须在 /tmp 下、拒绝真实 `~/.dsh`。 |
| `start-test-profile.sh` | 后台启动 `dsh --profile maildev --port $PORT --no-open`，等日志里出现 tokenized URL，写 `/tmp/dsh-maildev/logs/url.txt`（600）与 pid 文件。端口占用/启动失败会打印日志尾部并非零退出。 |
| `stop-test-profile.sh` | 按 pid 文件停，先 TERM 后 KILL；kill 前用 `/proc/<pid>/cmdline` 二次核对 profile 名，绝不按端口/进程名乱杀。 |
| `http-probe.sh` | 47 项 HTTP 断言：`webServer.register` 无鉴权证据、token→cookie、`/api` 精确路由 401/403/404、跨源围栏、body 上限、工具热切换、提示词 section 热切换、agents 会话注入/followup/prompt、notify E2E。PASS/FAIL 汇总，非零退出表示有回归。 |
| `notify-queue-probe.mjs` | 纯 Node：用假 store/host 验证"无活会话→落盘队列→有活会话→重投并出队"、"子代理会话不投递、宁排队"、"通知文本无 HTML 且声明非用户本人输入"。 |
| `probe-plugin/` | `dsh-mailprobe` 探针插件（bundle 形态，`cordis.patch.yml` + `index.js`）。端点见下。 |
| `evidence/` | 实跑证据：`http-probe-*.log`（47/47）、`diag-3101.json`（能力面）、`integration-3101.log`（dsh-mailbox 真实加载/鉴权/脱敏/开关/通知 E2E）。 |

## probe-plugin 端点（仅在测试 profile 生效）

| 端点 | 用途 |
|---|---|
| `GET /mailprobe/diag` | 全量诊断：服务面、timer、**服务读取规则对照**（`ctx.x` vs `ctx.get`）、工具注册表、注册契约探测结果 |
| `GET/POST /mailprobe/plain` | 裸 `ctx.webServer.register` 路由：报告 `requestRejection`/`admit` 判定、body 回显与 1MB 上限 |
| `GET /mailprobe/throw` | 故意抛错 → 观察宿主把 handler 异常映射成 HTTP 400 |
| `GET/POST /api/mailprobe` | `ctx.connection.fetch.register` 已鉴权路由（无 cookie 401，跨源 403，只有 owner 能到） |
| `POST /mailprobe/session` | `{"op":"create"\|"inject"\|"followup"\|"prompt"\|"list"\|"controller-list"\|"title"\|"eventlog"\|"dispose"}` 会话实验（followup/prompt 会先把模型路由指向不存在的 provider，避免真实 LLM 调用） |
| `GET /mailprobe/tool?on=1\|0\|dup` | `ctx.tools.register` 热注册/注销/重名冲突 |
| `GET /mailprobe/prompt?on=1\|0\|dup` | `ctx.systemPrompt.section` 热注册/注销/重名冲突 + `assemble()` 可见性 |

## 已知坑（脚本已处理，复用时注意）

1. **`$DSH_HOME/cordis.patch.yml` 必须是顶层 YAML 数组**；空文件会启动失败（脚本写 `[]`）。
2. profile 的 `node_modules` 是"符号链接拼装目录"，不是副本：web profile 升级/删包会影响它；重建跑 `FORCE=1 setup-test-profile.sh`。
3. 复制过来的 web profile 里仍有 legacy `dsh-user-contact` 与 `dsh-drawai`：前者会抢占 `send_email` 工具名（mailbox 的注册被 catch，只 warn）；最终 web profile 换 bundle 后消失。
4. 测试 home 里的 `.credentials.yaml` 是真实凭据副本（600，tmpfs）：**测完删除/重启清空**；不要把它提交到仓库。
5. 宿主默认没有 console log exporter：插件的 `ctx.logger.info/warn` 不进日志文件；验证加载状态请用 `/mailprobe/diag`、`/api/mailbox?action=diagnostics` 或 `console.info`。
6. 别用 `pkill -f dsh` 或按端口杀进程——本目录脚本只按 pid 文件 + 命令行核对停止自己的实例。
