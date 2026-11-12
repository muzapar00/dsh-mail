# 在不碰运行中插件的前提下验证落盘日志

目标：在**隔离的测试 profile** 里把 `event-log` 分支跑起来，验证 `ready` / `config` / `sync` / `dispose` 四条接线与降级链，
全程不碰你正在用的 DSH 与邮件。

## 一、Linux / macOS（仓库自带的探针脚本）

```bash
# 1. 建隔离 profile（DSH_HOME 强制在 /tmp 下，不会碰 ~/.dsh）
FORCE=1 TEST_HOME=/tmp/dsh-maildev bash probes/host/setup-test-profile.sh --with-mailbox

# 2. 让测试 profile 指向你要验的代码（默认指向本仓库，若是 clone 的工作树则无需这一步）
ln -sfn "$PWD" /tmp/dsh-maildev/profiles/maildev/node_modules/dsh-mailbox

# 3. 写一份只用于测试的邮箱配置（关键：imap 指向不可达地址，确保不会碰到真实邮箱）
mkdir -p /tmp/dsh-maildev/mailbox
python3 - <<'PY'
import json
cfg = json.load(open('/home/you/.dsh/mailbox/config.json'))   # 或从空配置起步
cfg['imap'].update({'enabled': True, 'host': '127.0.0.1', 'port': 9, 'security': 'none',
                    'user': 'test@localhost', 'authCode': '', 'authCodeFile': ''})
cfg['smtp'].update({'host': '127.0.0.1', 'port': 9, 'security': 'none', 'user': 'test@localhost'})
cfg['notify']['enabled'] = False          # 测试 profile 不投递通知
json.dump(cfg, open('/tmp/dsh-maildev/mailbox/config.json', 'w'))
PY

# 4. 起独立实例（端口别用 3080）
TEST_HOME=/tmp/dsh-maildev PORT=3101 bash probes/host/start-test-profile.sh
```

### 验什么

| 步骤 | 预期 |
| --- | --- |
| 启动后看 `/tmp/dsh-maildev/mailbox/logs/events-*.jsonl` | 有 `event=ready`（带 version）与 `event=config`（带 source/mtime） |
| 等首轮轮询（默认 120 秒，测试配置可调 30） | `event=sync`，失败时 detail 是原始错误行 |
| 改一处插件源码，再触发一次 profile 重组（改 `profiles/maildev/cordis.patch.yml` 加一行注释） | 旧实例先落 `event=dispose`，新实例再落 `ready`，两行时间差可作卡顿判据 |
| 把当日日志文件 `chmod 400`，等一轮轮询，再 `chmod 644` | 期间收发照旧、日志不增长；恢复后补一行 `log-recovered`（data.dropped） |
| 在卸载前保持只读（改源码触发重组） | 宿主日志出现 `[dsh-mailbox] event log degraded (not a failure): …` |

收尾：`TEST_HOME=/tmp/dsh-maildev bash probes/host/stop-test-profile.sh`。

## 二、Windows（没有 bash 探针脚本时）

1. 把仓库 clone 到工作目录，确认 `package.json` 的 `main` 指向 `index.js`。
2. 在**另一个** `DSH_HOME` 下建 profile：把现有 web profile 的 `package.json` + `cordis.patch.yml` 复制过去，
   `node_modules/dsh-mailbox` 用目录联接（junction）指向 clone 出的仓库：
   ```powershell
   cmd /c mklink /J "%TEST_HOME%\profiles\maildev\node_modules\dsh-mailbox" "D:\path\to\dsh-mailbox"
   ```
3. 用同一套 `config.json`（`imap` 指不可达地址、`notify.enabled=false`），`DSH_HOME=<测试目录>` 启动
   `dsh --profile maildev --port 3101`，其余验证条目与上表一致。
4. 结束即停该进程；不要把它设为常驻，也不要让它指向真实邮箱。

## 三、两种重启，判据不同

- 热重载（重组 profile）：`dispose` → `ready` 约 **0.25 秒**，时间差可作卡顿判据；
- 整机 / 服务重启（systemd 等）：`dispose` → `ready` 通常 **三秒上下**，秒数不是判据；判据是 `ready` 与 `config` 两行是否都落、顺序是否正确。

## 四、隔离实例上验失败路径（不动生产）

```bash
# 瞬态 systemd 实例，DSH_HOME 在 /tmp，端口避开 3080
systemd-run --user --collect --unit=dsh-evtest \
  --property=Environment=DSH_HOME=/tmp/dsh-maildev \
  --property=WorkingDirectory=/tmp/dsh-maildev/workspace \
  /home/你的/dsh --profile maildev --port 3101 --no-open

# 1) 启动行：events-*.jsonl 里应有 ready 与 config
# 2) 把当日日志文件 chmod 400，等一轮轮询；恢复 chmod 644，应补一行 log-recovered
# 3) 再 chmod 400，然后 systemctl --user stop dsh-evtest —— 卸载时仍只读，
#    journalctl --user --unit=dsh-evtest 应出现 "event log degraded (not a failure)"
```

`--collect` 让单位在退出后自动回收；`/tmp/dsh-maildev` 可留着复用，验完即拆不影响生产。

## 五、注意

- 测试 profile 里**不要**配置真实 SMTP/IMAP 授权码；`host` 指 `127.0.0.1:9` 即可，让同步自然失败，正好验失败路径。
- 端口避开 3080（正在用的 GUI）；用 3101 或其它空闲端口。
- 验完记得停进程、删测试目录；`/tmp` 下的东西重启即清。
- 若要在 CI 里验接线，需起真实 DSH 进程，代价大；当前用「单测 + 现场样例」两级证据（见 `docs/verification/`）。
