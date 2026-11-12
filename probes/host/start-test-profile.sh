#!/usr/bin/env bash
# 在隔离测试 profile 里启动一个 **独立的 dsh web 进程**（默认端口 3099）。
#
# 安全：绝不碰 3080 端口与 ~/.dsh/profiles/web；DSH_HOME 强制在 /tmp 下；
# 启动后等待 "dsh web: <tokenized-url>" 出现，把 URL 写进 $TEST_HOME/logs/url.txt，
# 退出码非 0 表示启动失败（日志在 $TEST_HOME/logs/dsh-maildev.log）。
#
# 用法：
#   probes/host/start-test-profile.sh            # 后台启动（写 pid 文件）
#   PROFILE_NAME=maildev PORT=3099 ...           # 可覆盖
set -euo pipefail

DSH_BIN="${DSH_BIN:-/home/mzpr00/node-v24.22.2-linux-x64/bin/dsh}"
TEST_HOME="${TEST_HOME:-/tmp/dsh-maildev}"
PROFILE_NAME="${PROFILE_NAME:-maildev}"
PORT="${PORT:-3099}"
WORKDIR="${WORKDIR:-/tmp/dsh-maildev/workspace}"
LOG_DIR="$TEST_HOME/logs"
LOG_FILE="$LOG_DIR/dsh-$PROFILE_NAME.log"
URL_FILE="$LOG_DIR/url.txt"
PID_FILE="$TEST_HOME/dsh-$PROFILE_NAME.pid"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-120}"

case "$TEST_HOME" in
  /tmp/*) ;;
  *) echo "refusing TEST_HOME outside /tmp: $TEST_HOME" >&2; exit 3 ;;
esac
if [ ! -d "$TEST_HOME/profiles/$PROFILE_NAME" ]; then
  echo "missing test profile: $TEST_HOME/profiles/$PROFILE_NAME (run setup-test-profile.sh first)" >&2
  exit 4
fi
if [ "$PORT" = "3080" ]; then
  echo "refusing to start on 3080 (the live Web GUI)" >&2
  exit 3
fi
if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "test profile already running: pid $old_pid (stop with stop-test-profile.sh)" >&2
    exit 5
  fi
fi
# 端口占用检查：避免两次启动抢同一个端口、也避免误占 3099 上别人的进程。
if ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
  echo "port $PORT is already in use (not starting); pick another with PORT=<n>" >&2
  exit 5
fi

mkdir -p "$LOG_DIR" "$WORKDIR"
: > "$LOG_FILE"
: > "$URL_FILE"

echo "starting dsh --profile $PROFILE_NAME --port $PORT (DSH_HOME=$TEST_HOME)"
(
  cd "$WORKDIR"
  DSH_HOME="$TEST_HOME" telemetry_disable=1 \
    "$DSH_BIN" --profile "$PROFILE_NAME" --port "$PORT" --no-open >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE.pending"
)
pid="$(cat "$PID_FILE.pending")"
echo "pid $pid, log $LOG_FILE"

deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$PID_FILE.pending"
    echo "dsh exited before printing its URL; tail of log:" >&2
    tail -n 60 "$LOG_FILE" >&2
    exit 6
  fi
  if grep -q "dsh web: http" "$LOG_FILE" 2>/dev/null; then
    url="$(grep -o 'dsh web: http[^ ]*' "$LOG_FILE" | head -n1 | sed 's/^dsh web: //')"
    printf '%s\n' "$url" > "$URL_FILE"
    chmod 600 "$URL_FILE"
    mv -f "$PID_FILE.pending" "$PID_FILE"
    # 只把不带 token 的 origin 打到终端，token 留在 url.txt（600）。
    origin="$(printf '%s' "$url" | sed 's#\(http://[^/]*\).*#\1#')"
    echo "ready: $origin (tokenized URL in $URL_FILE)"
    exit 0
  fi
  if grep -qiE "error|failed|FAILED" "$LOG_FILE" 2>/dev/null && grep -qi "exit" "$LOG_FILE"; then
    :
  fi
  sleep 0.5
done

rm -f -- "$PID_FILE.pending"
kill -TERM "$pid" 2>/dev/null || true
echo "timed out after ${BOOT_TIMEOUT}s waiting for dsh web URL; tail of log:" >&2
tail -n 80 "$LOG_FILE" >&2
exit 7
