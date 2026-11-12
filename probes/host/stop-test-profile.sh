#!/usr/bin/env bash
# 停止 start-test-profile.sh 启动的隔离测试进程（按 pid 文件，先 TERM 后 KILL）。
# 只认 /tmp/dsh-maildev 下的 pid 文件；绝不按端口/进程名乱杀（避免误伤 3080）。
set -euo pipefail

TEST_HOME="${TEST_HOME:-/tmp/dsh-maildev}"
PROFILE_NAME="${PROFILE_NAME:-maildev}"
PID_FILE="$TEST_HOME/dsh-$PROFILE_NAME.pid"

case "$TEST_HOME" in
  /tmp/*) ;;
  *) echo "refusing TEST_HOME outside /tmp: $TEST_HOME" >&2; exit 3 ;;
esac

if [ ! -f "$PID_FILE" ]; then
  echo "no pid file: $PID_FILE"
  exit 0
fi
pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "process $pid not running; removing stale pid file"
  rm -f -- "$PID_FILE"
  exit 0
fi

# 再确认一次命令行确实是我们的测试 profile，避免 pid 复用误杀
cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
case "$cmdline" in
  *"$PROFILE_NAME"*) ;;
  *) echo "refusing to kill pid $pid: command line does not name profile $PROFILE_NAME: $cmdline" >&2; exit 4 ;;
esac

echo "stopping pid $pid ($PROFILE_NAME)"
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "stopped"
    rm -f -- "$PID_FILE"
    exit 0
  fi
  sleep 0.25
done
echo "still alive after 10s; sending KILL" >&2
kill -KILL "$pid" 2>/dev/null || true
rm -f -- "$PID_FILE"
exit 0
