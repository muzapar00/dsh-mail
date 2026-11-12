# 现场样例：落盘日志

以下逐行取自隔离测试 profile 的真实运行（`DSH_HOME=/tmp/dsh-maildev`，`dsh web --port 3101`），
不是编造，也不取自真事邮箱。几次运行分开标注；每段末尾一句说明它证明了什么。

## 1. 启动与配置（一次正常启动）

```json
{"ts":"2026-11-12T11:49:09.961Z","level":"info","event":"log","detail":"[dsh-mailbox] config issue: smtp.user: is not an email address"}
{"ts":"2026-11-12T11:49:09.963Z","level":"info","event":"log","detail":"[dsh-mailbox] config issue: imap.user: is not an email address"}
{"ts":"2026-11-12T11:49:10.277Z","level":"info","event":"ready","detail":"version=0.2.0"}
{"ts":"2026-11-12T11:49:10.278Z","level":"info","event":"config","detail":"config.json","data":{"source":"config.json","mtime":"2026-11-12T11:21:31.642Z"}}
```

启动行带版本；config 行带来源与文件修改时间；配置校验告警按 `event=log` 落盘。

## 2. 同步失败（未配置授权码，不触碰真实邮箱）

```json
{"ts":"2026-11-12T11:49:14.972Z","level":"info","event":"sync","detail":"[dsh-mailbox] sync failed: 未配置 IMAP 授权码：请在设置里填写"}
```

## 3. 热重载：旧实例卸载、新实例接上（另一次运行）

```json
{"ts":"2026-11-12T11:22:06.420Z","level":"info","event":"dispose"}
{"ts":"2026-11-12T11:22:06.672Z","level":"info","event":"ready","detail":"version=0.2.0"}
```

`dispose` 与 `ready` 相隔约 0.25 秒；两者拉开即说明重载卡在某一环——这是验收判据，不是巧合。

## 4. 断写权限后的恢复（另一次运行）

```json
{"ts":"2026-11-12T11:23:06.578Z","level":"info","event":"sync","detail":"[dsh-mailbox] sync failed: 未配置 IMAP 授权码：请在设置里填写"}
{"ts":"2026-11-12T11:23:06.580Z","level":"info","event":"log-recovered","data":{"dropped":1}}
```

先把当日文件置只读、让一轮写入失败，再恢复权限；下一行正常落下，紧随一行 `log-recovered` 报出丢失条数。

## 5. 卸载时仍是只读：降级到宿主日志（另一次运行）

```
[dsh-mailbox] event log degraded (not a failure): lost 1 line(s) since 2026-11-12T11:49:20.668Z (file log unavailable; host logger is the fallback)
```

文件写不了时把状态交给宿主日志；前缀固定、写明不是故障，方便 grep 与日后判读。

字段只含 `ts/level/event/detail` 与少量 `data` 键；`detail` 已脱敏，不含正文、附件名、授权码或邮箱地址。
